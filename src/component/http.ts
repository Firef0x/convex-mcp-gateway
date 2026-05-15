import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { api } from "./_generated/api.js";
import {
  buildProtectedResourceMetadataUrl,
  buildResourceUrl,
} from "../shared.js";

const http = httpRouter();

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
};

type JsonRpcResult =
  | { kind: "result"; id: JsonRpcRequest["id"]; value: unknown }
  | {
      kind: "error";
      id: JsonRpcRequest["id"];
      code: number;
      message: string;
    }
  | { kind: "ack" }
  | { kind: "raw"; response: Response };

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_NAME = "convex-mcp-gateway";
const SERVER_VERSION = "0.0.0";

function generateSessionId(): string {
  // 128-bit random hex (32 chars). MCP spec requires globally unique +
  // visible ASCII only; lowercase hex satisfies both.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonRpcEnvelope(result: JsonRpcResult): {
  body: string;
  status: number;
  contentType: string;
} {
  switch (result.kind) {
    case "result":
      return {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: result.id ?? null,
          result: result.value,
        }),
        status: 200,
        contentType: "application/json",
      };
    case "error":
      return {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: result.id ?? null,
          error: { code: result.code, message: result.message },
        }),
        status: 200,
        contentType: "application/json",
      };
    case "ack":
    case "raw":
      // Caller handled the response itself; this branch is unreachable
      // because we short-circuit before reaching the envelope builder.
      throw new Error("ack/raw cannot be enveloped");
  }
}

/**
 * Wrap a JSON-RPC payload in a single SSE event and close the stream.
 * The MCP 2025-06-18 spec allows the server to choose between
 * `application/json` and `text/event-stream`; clients MUST support
 * both. We pick SSE only when the client explicitly accepts it, so
 * legacy non-streaming clients keep getting plain JSON.
 *
 * Each event carries a unique `id` so future Last-Event-ID resumability
 * stays an option without rewriting the producer.
 */
function sseEvent(id: number, payload: string): string {
  return `id: ${id}\nevent: message\ndata: ${payload}\n\n`;
}

function clientWantsSse(request: Request): boolean {
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  return accept.includes("text/event-stream");
}

function isJsonRpcRequest(message: JsonRpcRequest): boolean {
  return (
    message.method !== undefined &&
    message.id !== undefined &&
    message.id !== null
  );
}

function isJsonRpcNotificationOrResponse(message: JsonRpcRequest): boolean {
  // Notification: method present, no id. Response: id present, no method.
  // Either way the spec says: 202 Accepted with empty body.
  if (
    message.method !== undefined &&
    (message.id === undefined || message.id === null)
  ) {
    return true;
  }
  if (
    message.method === undefined &&
    message.id !== undefined &&
    message.id !== null
  ) {
    return true;
  }
  return false;
}

http.route({
  path: "/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let message: JsonRpcRequest;
    try {
      message = (await request.json()) as JsonRpcRequest;
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const isInitialize = message.method === "initialize";

    // === Session validation ===
    // Initialize creates a fresh session. All other requests must carry
    // a valid Mcp-Session-Id; missing → 400 Bad Request, unknown → 404
    // Not Found (per MCP 2025-06-18 §Session Management).
    let sessionId: string;
    let issueSessionHeader = false;

    if (isInitialize) {
      sessionId = generateSessionId();
      issueSessionHeader = true;
    } else {
      const headerSessionId = request.headers.get("mcp-session-id");
      if (!headerSessionId) {
        return new Response("Missing Mcp-Session-Id header", { status: 400 });
      }
      const session = await ctx.runQuery(api.sessions.getSession, {
        sessionId: headerSessionId,
      });
      if (!session) {
        return new Response("Unknown or terminated session", { status: 404 });
      }
      sessionId = headerSessionId;
      // Touch best-effort. A failure here must never block dispatch, so
      // we swallow; lastSeenAt drift only affects idle-pruning accuracy.
      try {
        await ctx.runMutation(api.sessions.touchSession, {
          sessionId: headerSessionId,
        });
      } catch {
        /* noop */
      }
    }

    // === Notifications / responses: 202 Accepted, no body ===
    if (isJsonRpcNotificationOrResponse(message)) {
      const headers: Record<string, string> = {};
      if (issueSessionHeader) {
        headers["mcp-session-id"] = sessionId;
      }
      return new Response(null, { status: 202, headers });
    }

    if (!isJsonRpcRequest(message)) {
      // Neither a request nor a recognised notification: treat as parse-
      // level malformed.
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Invalid Request: missing method or id",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // === Dispatch the JSON-RPC request to the matching handler ===
    let result: JsonRpcResult;
    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        const negotiated =
          typeof requested === "string" &&
          (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
            requested,
          )
            ? requested
            : DEFAULT_PROTOCOL_VERSION;
        // Persist the freshly issued session with the negotiated
        // protocol version. The session row exists from this point on
        // until the client DELETEs it or it ages out.
        await ctx.runMutation(api.sessions.createSession, {
          sessionId,
          protocolVersion: negotiated,
        });
        result = {
          kind: "result",
          id: message.id,
          value: {
            protocolVersion: negotiated,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: {} },
          },
        };
        break;
      }

      case "tools/list": {
        const visible = (await ctx.runAction(
          api.dispatch.listVisibleTools,
          {},
        )) as Array<{
          name: string;
          description: string;
          inputSchema: unknown;
        }>;
        result = {
          kind: "result",
          id: message.id,
          value: {
            tools: visible.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        };
        break;
      }

      case "tools/call": {
        const name = message.params?.name;
        if (typeof name !== "string") {
          result = {
            kind: "error",
            id: message.id,
            code: -32602,
            message: "Missing tool name",
          };
          break;
        }
        const args = (message.params?.arguments ?? {}) as Record<
          string,
          unknown
        >;
        const dispatched = await ctx.runAction(api.dispatch.callTool, {
          name,
          args,
        });
        if (!dispatched.ok) {
          // 401 with WWW-Authenticate is the spec-mandated response for
          // unauthenticated access to a protected resource (RFC 6750 +
          // RFC 9728). It bypasses the JSON-RPC envelope and uses HTTP
          // status semantics, so the MCP client can begin OAuth
          // discovery from the header.
          if (dispatched.error.code === -32001) {
            const oauthConfig = await ctx.runQuery(
              api.registry.getOAuthConfig,
              {},
            );
            if (oauthConfig) {
              const requestUrl = new URL(request.url);
              const mcpPath =
                requestUrl.pathname.replace(/\/+$/, "") || "/";
              const metadataUrl = buildProtectedResourceMetadataUrl(
                requestUrl.origin,
                mcpPath,
              );
              result = {
                kind: "raw",
                response: new Response(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: message.id ?? null,
                    error: {
                      code: dispatched.error.code,
                      message: dispatched.error.message,
                    },
                  }),
                  {
                    status: 401,
                    headers: {
                      "content-type": "application/json",
                      "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
                      ...(issueSessionHeader
                        ? { "mcp-session-id": sessionId }
                        : {}),
                    },
                  },
                ),
              };
              break;
            }
          }
          result = {
            kind: "error",
            id: message.id,
            code: dispatched.error.code,
            message: dispatched.error.message,
          };
          break;
        }
        result = {
          kind: "result",
          id: message.id,
          value: {
            content: [
              {
                type: "text",
                text: JSON.stringify(dispatched.data, null, 2),
              },
            ],
            isError: false,
          },
        };
        break;
      }

      default:
        result = {
          kind: "error",
          id: message.id,
          code: -32601,
          message: `Unsupported method: ${message.method}`,
        };
    }

    // Raw response (e.g. 401): caller already constructed it.
    if (result.kind === "raw") {
      return result.response;
    }

    // === Content negotiation: SSE vs JSON ===
    const envelope = jsonRpcEnvelope(result);
    const wantsSse = clientWantsSse(request);

    const headers: Record<string, string> = {};
    if (issueSessionHeader) {
      headers["mcp-session-id"] = sessionId;
    }

    if (wantsSse) {
      // Single-frame SSE: emit one event with the JSON-RPC payload, then
      // close. This is fully spec-compliant Streamable HTTP without
      // requiring a long-running stream. When we add progress
      // notifications, the producer can yield additional events here
      // before the final response without breaking the protocol.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(sseEvent(1, envelope.body)));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          ...headers,
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
        },
      });
    }

    return new Response(envelope.body, {
      status: envelope.status,
      headers: {
        ...headers,
        "content-type": envelope.contentType,
      },
    });
  }),
});

/**
 * GET on the MCP endpoint would open a long-lived SSE stream that the
 * server uses for unprompted notifications/requests. We don't yet have
 * any to send (no progress notifications, no cancellation pushes), so
 * we follow the spec's allowance to return 405 instead. The `Allow`
 * header tells the client which methods we do support.
 */
http.route({
  path: "/",
  method: "GET",
  handler: httpAction(async () => {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST, DELETE" },
    });
  }),
});

/**
 * DELETE explicitly terminates a session. Per MCP 2025-06-18 §Session
 * Management, the server MAY refuse with 405; we accept since dropping
 * a session row is cheap and clients benefit from clean termination.
 */
http.route({
  path: "/",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    const sessionId = request.headers.get("mcp-session-id");
    if (!sessionId) {
      return new Response("Missing Mcp-Session-Id header", { status: 400 });
    }
    const deleted = await ctx.runMutation(api.sessions.deleteSession, {
      sessionId,
    });
    return new Response(null, { status: deleted ? 200 : 404 });
  }),
});

export default http;

// Helper re-exports for unit tests.
export { buildProtectedResourceMetadataUrl, buildResourceUrl };
