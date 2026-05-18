import type { ComponentApi } from "../component/_generated/component.js";
import {
  buildProtectedResourceMetadataUrl,
  type McpAuthorizerArgs,
  type McpAuthorizerDecision,
  type McpAuthorizerHandler,
} from "../shared.js";

/**
 * Browser-based MCP clients (e.g. anything served from a webapp
 * origin) issue a CORS preflight before each `/mcp/` call. Set this
 * option to enable preflight handling and the matching response
 * headers; non-browser clients (CLIs, server-to-server) work without
 * it.
 *
 * - `true` — permissive: `Access-Control-Allow-Origin: *`,
 *   `Access-Control-Allow-Credentials: false` (the spec forbids
 *   credentials with the wildcard origin). Tokens are passed via
 *   `Authorization: Bearer ...` so this works for OAuth flows.
 * - `string` / `string[]` — exact-match allowlist of origins. The
 *   request's `Origin` header is echoed back if it matches, otherwise
 *   no CORS headers are emitted (the browser then blocks the call).
 * - `(origin: string) => boolean` — custom matcher for things like
 *   subdomain wildcards or per-tenant rules.
 *
 * `Mcp-Session-Id` is automatically exposed via
 * `Access-Control-Expose-Headers` so JS clients can read it after
 * `initialize`.
 */
export type McpCorsOption =
  | true
  | string
  | string[]
  | ((origin: string) => boolean);

/**
 * Optional Bearer-token validator for `handleMcpRequest`. When set,
 * the gateway calls this BEFORE `ctx.auth.getUserIdentity()` and uses
 * its return value as the identity for the audit row and as a hint
 * for the authorize callback (via `args.identity`).
 *
 * Useful when the upstream IdP issues opaque access tokens that
 * Convex's local JWT validation can't verify — typical pattern is
 * to call the IdP's userinfo endpoint:
 *
 * ```ts
 * resolveIdentity: async (token) => {
 *   const r = await fetch("https://id.example.com/api/oidc/userinfo", {
 *     headers: { Authorization: `Bearer ${token}` },
 *   });
 *   if (!r.ok) return null;
 *   const u = await r.json();
 *   return { subject: u.sub, claims: u };
 * }
 * ```
 *
 * Returning `null` means "token rejected" (treated identically to
 * "no token at all"). Throwing is treated as null with a warning
 * logged — rejection is not an error condition.
 *
 * When this option is omitted, the gateway falls back to
 * `ctx.auth.getUserIdentity()` (which only handles JWTs validated
 * by your `auth.config.ts`).
 */
export type McpIdentityResolver = (
  token: string,
) => Promise<{ subject: string; claims?: Record<string, unknown> } | null>;

/**
 * Options for `gateway.handleMcpRequest`. The host supplies an
 * `authorize` callback that decides allowed vs denied per
 * `tools/call` and per tool in a filtered `tools/list`. The callback
 * runs in the host's HTTP-action context, so it has the host's
 * `ctx.auth` and can call `ctx.auth.getUserIdentity()` directly.
 */
export interface HandleMcpRequestOptions {
  authorize: McpAuthorizerHandler;
  /** See `McpCorsOption`. Omit for non-browser-only deployments. */
  cors?: McpCorsOption;
  /**
   * See `McpIdentityResolver`. Omit to use Convex's built-in JWT
   * validation via `ctx.auth.getUserIdentity()`.
   */
  resolveIdentity?: McpIdentityResolver;
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

function resolveCorsOrigin(
  cors: McpCorsOption | undefined,
  requestOrigin: string | null,
): string | null {
  if (cors === undefined) return null;
  if (cors === true) return "*";
  if (!requestOrigin) return null;
  if (typeof cors === "string") {
    return cors === requestOrigin ? requestOrigin : null;
  }
  if (Array.isArray(cors)) {
    return cors.includes(requestOrigin) ? requestOrigin : null;
  }
  return cors(requestOrigin) ? requestOrigin : null;
}

function corsHeaders(
  cors: McpCorsOption | undefined,
  request: Request,
): Record<string, string> {
  const allowOrigin = resolveCorsOrigin(cors, request.headers.get("origin"));
  if (allowOrigin === null) return {};
  const headers: Record<string, string> = {
    "access-control-allow-origin": allowOrigin,
    "access-control-expose-headers": "mcp-session-id",
    vary: "Origin",
  };
  // The wildcard origin forbids credentials per spec; with an exact
  // origin we leave credentials off too because MCP carries auth via
  // Bearer tokens, not cookies.
  return headers;
}

function preflightResponse(
  cors: McpCorsOption | undefined,
  request: Request,
): Response {
  const baseHeaders = corsHeaders(cors, request);
  if (Object.keys(baseHeaders).length === 0) {
    // CORS not configured for this origin — let the browser block it.
    return new Response(null, { status: 204 });
  }
  const requestedHeaders =
    request.headers.get("access-control-request-headers") ??
    "content-type, authorization, mcp-session-id, accept";
  return new Response(null, {
    status: 204,
    headers: {
      ...baseHeaders,
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": requestedHeaders,
      "access-control-max-age": "86400",
    },
  });
}

function withCors(
  response: Response,
  cors: McpCorsOption | undefined,
  request: Request,
): Response {
  const extra = corsHeaders(cors, request);
  if (Object.keys(extra).length === 0) return response;
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) {
    merged.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

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
  if (request.method === "OPTIONS") {
    return preflightResponse(options.cors, request);
  }
  let response: Response;
  switch (request.method) {
    case "POST":
      response = await handlePost(ctx, request, component, options);
      break;
    case "GET":
      response = new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST, DELETE, OPTIONS" },
      });
      break;
    case "DELETE":
      response = await handleDelete(ctx, request, component);
      break;
    default:
      response = new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST, GET, DELETE, OPTIONS" },
      });
  }
  return withCors(response, options.cors, request);
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
  //
  // Resolution order:
  //   1. If a resolveIdentity is configured AND a Bearer is present,
  //      call it. Its result wins.
  //   2. Otherwise fall back to ctx.auth.getUserIdentity() (JWT
  //      validation against auth.config.ts).
  //
  // ctx.auth.getUserIdentity() THROWS on iss/aud mismatch. For a
  // gateway that may receive tokens from multiple clients (some of
  // whose IdPs we don't trust at the Convex layer), letting that
  // throw bubble out 500s the request. We catch and treat as null so
  // the authorize callback gets a chance to deny cleanly with -32001.
  let identity: {
    subject: string;
    claims?: Record<string, unknown>;
  } | null = null;
  if (options.resolveIdentity) {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7)
      : null;
    if (token) {
      try {
        identity = await options.resolveIdentity(token);
      } catch (err) {
        console.warn(
          `[mcp-gateway] resolveIdentity threw; treating as anonymous. ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  } else {
    try {
      const raw = (await ctx.auth.getUserIdentity()) as
        | { subject?: string; [k: string]: unknown }
        | null
        | undefined;
      if (raw && typeof raw.subject === "string") {
        identity = { subject: raw.subject, claims: raw };
      }
    } catch (err) {
      console.warn(
        `[mcp-gateway] ctx.auth.getUserIdentity() threw; treating as anonymous. ` +
          `Likely a Bearer token whose iss/aud doesn't match auth.config.ts. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
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
          identity,
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
        identity,
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
