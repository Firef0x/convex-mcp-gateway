import type { ComponentApi } from "../component/_generated/component.js";
import {
  buildProtectedResourceMetadataUrl,
  type McpAuthorizerArgs,
  type McpAuthorizerDecision,
  type McpAuthorizerHandler,
} from "../shared.js";

/**
 * Options for `gateway.handleMcpRequest`. The host supplies an
 * `authorize` callback that decides allowed vs denied per
 * `tools/call` and per tool in a filtered `tools/list`. The callback
 * runs in the host's HTTP-action context, so it has the host's
 * `ctx.auth` and can call `ctx.auth.getUserIdentity()` directly.
 */
export interface HandleMcpRequestOptions {
  authorize: McpAuthorizerHandler;
}

type HandlerCtx = {
  runQuery: (ref: any, args: any) => Promise<any>;
  runMutation: (ref: any, args: any) => Promise<any>;
  runAction: (ref: any, args: any) => Promise<any>;
  auth: { getUserIdentity: () => Promise<any> };
};

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
};

type RegisteredTool = {
  name: string;
  description: string;
  kind: "query" | "mutation" | "action";
  functionHandle: string;
  inputSchema: unknown;
  metadata?: unknown;
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_NAME = "convex-mcp-gateway";
const SERVER_VERSION = "0.0.0";

const UNAUTHORIZED = -32001;
const FORBIDDEN = -32003;
const INTERNAL_ERROR = -32603;

function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function clientWantsSse(request: Request): boolean {
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  return accept.includes("text/event-stream");
}

function isJsonRpcRequest(message: JsonRpcMessage): boolean {
  return (
    message.method !== undefined &&
    message.id !== undefined &&
    message.id !== null
  );
}

function isJsonRpcNotificationOrResponse(message: JsonRpcMessage): boolean {
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

function sseEvent(id: number, payload: string): string {
  return `id: ${id}\nevent: message\ndata: ${payload}\n\n`;
}

function jsonResultEnvelope(
  id: JsonRpcMessage["id"],
  value: unknown,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function jsonErrorEnvelope(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

function parseDecision(decision: unknown): McpAuthorizerDecision {
  if (
    typeof decision !== "object" ||
    decision === null ||
    typeof (decision as { allowed?: unknown }).allowed !== "boolean"
  ) {
    return {
      allowed: false,
      reason:
        "Authorizer returned an invalid shape. Expected `{ allowed: boolean, reason?: string }`.",
    };
  }
  const d = decision as { allowed: boolean; reason?: unknown };
  return {
    allowed: d.allowed,
    reason: typeof d.reason === "string" ? d.reason : undefined,
  };
}

async function safeAuthorize(
  authorize: McpAuthorizerHandler,
  ctx: HandlerCtx,
  args: McpAuthorizerArgs,
): Promise<{ decision: McpAuthorizerDecision; threw: boolean }> {
  try {
    const result = await authorize(ctx, args);
    return { decision: parseDecision(result), threw: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: { allowed: false, reason: `Authorizer threw: ${message}` },
      threw: true,
    };
  }
}

export async function handleMcpRequest(
  ctx: HandlerCtx,
  request: Request,
  component: ComponentApi,
  options: HandleMcpRequestOptions,
): Promise<Response> {
  switch (request.method) {
    case "POST":
      return handlePost(ctx, request, component, options);
    case "GET":
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST, DELETE" },
      });
    case "DELETE":
      return handleDelete(ctx, request, component);
    default:
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST, GET, DELETE" },
      });
  }
}

async function handleDelete(
  ctx: HandlerCtx,
  request: Request,
  component: ComponentApi,
): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    return new Response("Missing Mcp-Session-Id header", { status: 400 });
  }
  const deleted = await ctx.runMutation(component.sessions.deleteSession, {
    sessionId,
  });
  return new Response(null, { status: deleted ? 200 : 404 });
}

async function handlePost(
  ctx: HandlerCtx,
  request: Request,
  component: ComponentApi,
  options: HandleMcpRequestOptions,
): Promise<Response> {
  let message: JsonRpcMessage;
  try {
    message = (await request.json()) as JsonRpcMessage;
  } catch {
    return new Response(
      jsonErrorEnvelope(null, -32700, "Parse error"),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const isInitialize = message.method === "initialize";

  // Session validation. Initialize creates a fresh session. All other
  // requests must carry a valid Mcp-Session-Id; missing is 400, unknown
  // is 404 (per MCP 2025-06-18 §Session Management).
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
    const session = await ctx.runQuery(component.sessions.getSession, {
      sessionId: headerSessionId,
    });
    if (!session) {
      return new Response("Unknown or terminated session", { status: 404 });
    }
    sessionId = headerSessionId;
    try {
      await ctx.runMutation(component.sessions.touchSession, {
        sessionId: headerSessionId,
      });
    } catch {
      /* best-effort */
    }
  }

  // Notifications / responses: 202 Accepted, no body.
  if (isJsonRpcNotificationOrResponse(message)) {
    const headers: Record<string, string> = {};
    if (issueSessionHeader) headers["mcp-session-id"] = sessionId;
    return new Response(null, { status: 202, headers });
  }

  if (!isJsonRpcRequest(message)) {
    return new Response(
      jsonErrorEnvelope(null, -32600, "Invalid Request: missing method or id"),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  // Read identity once at the boundary. Used both for the audit subject
  // and to pass into the authorize callback (the callback also has its
  // own ctx.auth, but reading once keeps audit and policy consistent
  // for a single request).
  const identity = (await ctx.auth.getUserIdentity()) as
    | { subject?: string }
    | null
    | undefined;
  const auditIdentitySubject = identity?.subject ?? null;

  let body: string;
  let raw: Response | null = null;

  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      const negotiated =
        typeof requested === "string" &&
        (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION;
      await ctx.runMutation(component.sessions.createSession, {
        sessionId,
        protocolVersion: negotiated,
      });
      body = jsonResultEnvelope(message.id, {
        protocolVersion: negotiated,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      });
      break;
    }

    case "tools/list": {
      // Filter the catalog through the authorize callback in mode "list".
      // Throwing authorizers are isolated per tool: a single buggy
      // decision hides only that tool, not the whole list.
      const allTools = (await ctx.runQuery(
        component.registry.listTools,
        {},
      )) as RegisteredTool[];
      const visible = [];
      for (const tool of allTools) {
        const { decision } = await safeAuthorize(options.authorize, ctx, {
          toolName: tool.name,
          toolKind: tool.kind,
          args: {},
          mode: "list",
          toolMetadata: tool.metadata ?? null,
        });
        if (decision.allowed) {
          visible.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
        }
      }
      body = jsonResultEnvelope(message.id, { tools: visible });
      break;
    }

    case "tools/call": {
      const name = message.params?.name;
      if (typeof name !== "string") {
        body = jsonErrorEnvelope(message.id, -32602, "Missing tool name");
        break;
      }
      const args = (message.params?.arguments ?? {}) as Record<
        string,
        unknown
      >;

      const tool = (await ctx.runQuery(component.registry.getTool, {
        name,
      })) as RegisteredTool | null;
      if (!tool) {
        // Anti-DoS: unknown-tool calls are not audited because anonymous
        // callers can spam arbitrary names with arbitrary args.
        body = jsonErrorEnvelope(
          message.id,
          -32602,
          `Unknown tool: ${name}`,
        );
        break;
      }

      const start = Date.now();
      const { decision, threw } = await safeAuthorize(options.authorize, ctx, {
        toolName: tool.name,
        toolKind: tool.kind,
        args,
        mode: "call",
        toolMetadata: tool.metadata ?? null,
      });

      if (!decision.allowed) {
        const reason = decision.reason ?? "Forbidden";
        const code = threw
          ? INTERNAL_ERROR
          : /^unauth/i.test(reason)
            ? UNAUTHORIZED
            : FORBIDDEN;
        // Record the rejection in the audit log so operators see who
        // tried what and was denied (or what made the authorizer throw).
        try {
          await ctx.runAction(component.dispatch.recordAuthDenial, {
            name: tool.name,
            args,
            auditIdentitySubject,
            outcome: threw ? "error" : "denied",
            errorCode: code,
            errorMessage: reason,
            durationMs: Date.now() - start,
          });
        } catch {
          /* audit best-effort */
        }
        // 401 + WWW-Authenticate per RFC 6750 + RFC 9728 when an OAuth
        // server is configured. Bypasses the JSON-RPC envelope and uses
        // HTTP status semantics so the MCP client begins discovery.
        if (code === UNAUTHORIZED) {
          const oauthConfig = await ctx.runQuery(
            component.registry.getOAuthConfig,
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
            raw = new Response(
              jsonErrorEnvelope(message.id, code, reason),
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
            );
            body = "";
            break;
          }
        }
        body = jsonErrorEnvelope(message.id, code, reason);
        break;
      }

      // Allowed: dispatch via the component, which runs the registered
      // handle and writes the audit entry.
      const dispatched = await ctx.runAction(component.dispatch.runTool, {
        name,
        args,
        auditIdentitySubject,
      });
      if (!dispatched.ok) {
        body = jsonErrorEnvelope(
          message.id,
          dispatched.error.code,
          dispatched.error.message,
        );
        break;
      }
      body = jsonResultEnvelope(message.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(dispatched.data, null, 2),
          },
        ],
        isError: false,
      });
      break;
    }

    default:
      body = jsonErrorEnvelope(
        message.id,
        -32601,
        `Unsupported method: ${message.method}`,
      );
  }

  if (raw) return raw;

  const headers: Record<string, string> = {};
  if (issueSessionHeader) headers["mcp-session-id"] = sessionId;

  if (clientWantsSse(request)) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(sseEvent(1, body)));
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

  return new Response(body, {
    status: 200,
    headers: {
      ...headers,
      "content-type": "application/json",
    },
  });
}
