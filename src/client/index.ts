import {
  createFunctionHandle,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import type { ObjectType, PropertyValidators } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  buildResourceUrl,
  convexValidatorToJsonSchema,
  resourcePathFromWellKnownRequest,
  type McpToolDefinition,
  type McpToolKind,
} from "../shared.js";
import {
  handleMcpRequest as handleMcpRequestImpl,
  type HandleMcpRequestOptions,
} from "./mcp-handler.js";

export type {
  JsonSchema,
  McpAuthorizerArgs,
  McpAuthorizerDecision,
  McpAuthorizerHandler,
  McpToolDefinition,
  McpToolKind,
} from "../shared.js";
export type {
  HandleMcpRequestOptions,
  McpCorsOption,
  McpIdentityResolver,
} from "./mcp-handler.js";
export {
  buildProtectedResourceMetadataUrl,
  buildResourceUrl,
  convexValidatorToJsonSchema,
  resourcePathFromWellKnownRequest,
} from "../shared.js";

export type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<"query", "internal" | "public">>(
    query: Query,
    args: FunctionArgs<Query>,
  ) => Promise<FunctionReturnType<Query>>;
};

export type RunMutationCtx = RunQueryCtx & {
  runMutation: <
    Mutation extends FunctionReference<"mutation", "internal" | "public">,
  >(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
  ) => Promise<FunctionReturnType<Mutation>>;
};

type ToolFunctionReference<Kind extends McpToolKind> = FunctionReference<
  Kind,
  "internal" | "public",
  any,
  any
>;

type AnyToolFunctionReference = ToolFunctionReference<McpToolKind>;

/**
 * Args validators must produce exactly the function's expected args.
 * If they don't, TypeScript surfaces a `_typeMismatch` error on the config
 * object that makes the failing field obvious.
 */
type ValidateArgs<Ref extends AnyToolFunctionReference, ArgsV> =
  ArgsV extends PropertyValidators
    ? ObjectType<ArgsV> extends FunctionArgs<Ref>
      ? FunctionArgs<Ref> extends ObjectType<ArgsV>
        ? unknown
        : {
            _typeMismatch: "args validator does not match the function's expected arguments";
            expected: FunctionArgs<Ref>;
            received: ObjectType<ArgsV>;
          }
      : {
          _typeMismatch: "args validator does not match the function's expected arguments";
          expected: FunctionArgs<Ref>;
          received: ObjectType<ArgsV>;
        }
    : { _typeMismatch: "args must be a Convex property validators object" };

interface McpToolConfigBase<
  Ref extends AnyToolFunctionReference,
  ArgsV extends PropertyValidators,
> {
  name: string;
  description: string;
  fn: Ref;
  args: ArgsV;
  /**
   * Free-form metadata stored alongside the tool registration. The
   * component never inspects this; it is surfaced to the host's
   * authorize callback as `args.toolMetadata` so per-tool scope/role
   * checks stay declarative. Use whatever shape your callback expects,
   * e.g. `{ scopes: ["finance:read"], roles: [...] }`.
   */
  metadata?: Record<string, unknown>;
}

/**
 * MCP tool names must match `^[a-zA-Z0-9_-]{1,64}$` (letters, digits,
 * underscore, hyphen; 1-64 chars). Some clients — notably claude.ai's
 * frontend — reject the entire tool list with a validation error
 * when any single name violates this, even for tools the caller
 * never invokes. The MCP spec itself doesn't pin this regex, but
 * it's the de-facto-enforced pattern across the major clients.
 *
 * Common gotcha: dotted names like `notes.list` or `invoices.create`
 * (mirroring Convex's `api.notes.list` reference style) fail.
 * Use `notes_list` / `invoices_create` instead.
 */
const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function build<
  Kind extends McpToolKind,
  Ref extends ToolFunctionReference<Kind>,
  ArgsV extends PropertyValidators,
>(
  kind: Kind,
  config: McpToolConfigBase<Ref, ArgsV>,
): McpToolDefinition & { fn: Ref; kind: Kind } {
  if (!MCP_TOOL_NAME_PATTERN.test(config.name)) {
    throw new Error(
      `MCP tool name "${config.name}" violates the required pattern ` +
        `${MCP_TOOL_NAME_PATTERN.source}. Allowed: letters, digits, ` +
        `underscore, hyphen; 1-64 chars. Dotted names like ` +
        `"namespace.tool" are not allowed by most MCP clients — ` +
        `use "namespace_tool" instead.`,
    );
  }
  return {
    name: config.name,
    description: config.description,
    kind,
    fn: config.fn,
    functionReference: config.fn,
    inputSchema: convexValidatorToJsonSchema(config.args),
    ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
  } as McpToolDefinition & { fn: Ref; kind: Kind };
}

/**
 * Declare a Convex `query` function as an MCP tool. The `fn` reference must
 * point to a `query`; passing a mutation or action is a compile error.
 *
 * `args` is checked against `FunctionArgs<typeof fn>` at compile time, so a
 * drift between the registered Convex function and the tool descriptor
 * cannot ship undetected.
 *
 * Authorization is *not* configured per-tool. The host passes a single
 * `authorize` callback to `gateway.handleMcpRequest({ authorize })`; it
 * sees every `tools/call` (and every `tools/list` filter) and decides
 * whether to allow it.
 */
export function defineMcpQuery<
  Ref extends ToolFunctionReference<"query">,
  ArgsV extends PropertyValidators,
>(
  config: McpToolConfigBase<Ref, ArgsV> & ValidateArgs<Ref, ArgsV>,
): McpToolDefinition & { fn: Ref; kind: "query" } {
  return build("query", config as unknown as McpToolConfigBase<Ref, ArgsV>);
}

export function defineMcpMutation<
  Ref extends ToolFunctionReference<"mutation">,
  ArgsV extends PropertyValidators,
>(
  config: McpToolConfigBase<Ref, ArgsV> & ValidateArgs<Ref, ArgsV>,
): McpToolDefinition & { fn: Ref; kind: "mutation" } {
  return build("mutation", config as unknown as McpToolConfigBase<Ref, ArgsV>);
}

export function defineMcpAction<
  Ref extends ToolFunctionReference<"action">,
  ArgsV extends PropertyValidators,
>(
  config: McpToolConfigBase<Ref, ArgsV> & ValidateArgs<Ref, ArgsV>,
): McpToolDefinition & { fn: Ref; kind: "action" } {
  return build("action", config as unknown as McpToolConfigBase<Ref, ArgsV>);
}

/**
 * Host-app handle for the MCP gateway component.
 *
 * Authorization is **not** registered ahead of time as a Convex
 * function reference. Pass an `authorize` callback to
 * `gateway.handleMcpRequest` instead; it runs inside the host's
 * HTTP-action context where `ctx.auth.getUserIdentity()` works.
 *
 * Construct one with the generated `components.mcpGateway` and use it
 * to register typesafe tool descriptors:
 *
 * ```ts
 * import {
 *   McpGateway,
 *   defineMcpQuery,
 *   type McpAuthorizerHandler,
 * } from "@tfohlmeister/convex-mcp-gateway";
 * import { components, api } from "./_generated/api.js";
 * import { internalMutation } from "./_generated/server.js";
 *
 * const gateway = new McpGateway(components.mcpGateway);
 *
 * export const bootstrap = internalMutation({
 *   args: {},
 *   handler: async (ctx) => {
 *     await gateway.register(ctx, [defineMcpQuery({ ... })]);
 *   },
 * });
 *
 * export const authorize: McpAuthorizerHandler = async (ctx, args) => {
 *   const identity = await ctx.auth.getUserIdentity();
 *   if (!identity) return { allowed: false, reason: "Unauthorized" };
 *   return { allowed: true };
 * };
 * ```
 */
export class McpGateway {
  constructor(public component: ComponentApi) {}

  async registerTool(
    ctx: RunMutationCtx,
    tool: McpToolDefinition & { fn: AnyToolFunctionReference },
  ): Promise<void> {
    const handle = await createFunctionHandle(tool.fn as any);
    await ctx.runMutation(this.component.registry.registerTool, {
      name: tool.name,
      description: tool.description,
      kind: tool.kind,
      functionHandle: handle,
      inputSchema: tool.inputSchema,
      ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
    });
  }

  /**
   * Atomically replace the entire registry with the given list of
   * tools. Any tool currently in the registry whose name isn't in
   * `tools` is removed; named tools are upserted. Runs in a single
   * Convex mutation, so concurrent `tools/list` / `tools/call`
   * callers never observe a partial swap.
   *
   * Replace-always is the only semantics: an additive `register`
   * leaks stale registrations across deploys (the old tool stays
   * exposed forever unless you remember to call `unregisterTool`),
   * which is exactly the kind of silent drift this API exists to
   * prevent. If you need genuinely incremental upserts (e.g. plugin
   * systems that register tools at runtime from disjoint codepaths),
   * call `registerTool` directly per tool.
   */
  async register(
    ctx: RunMutationCtx,
    tools: Array<McpToolDefinition & { fn: AnyToolFunctionReference }>,
  ): Promise<void> {
    const resolved = await Promise.all(
      tools.map(async (tool) => ({
        name: tool.name,
        description: tool.description,
        kind: tool.kind,
        functionHandle: await createFunctionHandle(tool.fn as any),
        inputSchema: tool.inputSchema,
        ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
      })),
    );
    await ctx.runMutation(this.component.registry.replaceTools, {
      tools: resolved,
    });
  }

  async unregisterTool(ctx: RunMutationCtx, name: string): Promise<boolean> {
    return await ctx.runMutation(this.component.registry.unregisterTool, {
      name,
    });
  }

  async listTools(ctx: RunQueryCtx) {
    return await ctx.runQuery(this.component.registry.listTools, {});
  }

  /**
   * Inspect the audit log written by the component on every `tools/call`.
   * Returns newest entries first. Use `toolName` and/or `outcome` to filter;
   * `limit` defaults to 100 and is capped server-side at 1000.
   */
  async listAuditEntries(
    ctx: RunQueryCtx,
    args: {
      toolName?: string;
      outcome?: "allowed" | "denied" | "error";
      limit?: number;
    } = {},
  ) {
    return await ctx.runQuery(this.component.audit.listEntries, args);
  }

  /**
   * Drop MCP sessions that have not been touched within `idleMs`. The
   * component does not garbage-collect sessions on its own; schedule
   * this from `crons.ts` if you want time-based cleanup. Returns the
   * number of session rows deleted.
   */
  async pruneSessions(
    ctx: RunMutationCtx,
    idleMs: number,
  ): Promise<number> {
    return await ctx.runMutation(this.component.sessions.pruneSessions, {
      olderThanMs: idleMs,
    });
  }

  /**
   * Drop audit entries older than `retentionMs`. Returns the number of
   * rows deleted. Schedule from `crons.ts` for time-based retention:
   *
   * ```ts
   * crons.daily("audit cleanup", { hourUTC: 3, minuteUTC: 0 },
   *   internal.audit.runPrune, {});
   *
   * export const runPrune = internalMutation({
   *   args: {},
   *   handler: async (ctx) => gateway.pruneAuditEntries(ctx, 30 * 24 * 60 * 60 * 1000),
   * });
   * ```
   */
  async pruneAuditEntries(
    ctx: RunMutationCtx,
    retentionMs: number,
  ): Promise<number> {
    return await ctx.runMutation(this.component.audit.pruneOlderThan, {
      cutoffMs: Date.now() - retentionMs,
    });
  }

  async clearAll(ctx: RunMutationCtx): Promise<void> {
    await ctx.runMutation(this.component.registry.clearAll, {});
  }

  /**
   * Configure OAuth 2.1 protected-resource discovery so MCP clients can
   * find the authorization server that issues their Bearer tokens.
   *
   * Once set, `tools/call` responses with `-32001 Unauthorized` switch
   * to HTTP 401 with a `WWW-Authenticate: Bearer resource_metadata=...`
   * header. The host must additionally mount the discovery handler at
   * the canonical RFC 9728 path on its own `httpRouter`; see
   * `serveProtectedResourceMetadata`.
   *
   * `resourceUrl` is optional; when omitted the discovery handler
   * derives the resource from the inbound request URL, which is correct
   * for single-tenant deployments. Pass `authServerUrl: null` to disable
   * discovery again. Both URLs are validated as absolute http/https URLs
   * at write time; an invalid value throws `ConvexError` immediately.
   */
  async setOAuthConfig(
    ctx: RunMutationCtx,
    config: { authServerUrl: string | null; resourceUrl?: string | null },
  ): Promise<void> {
    await ctx.runMutation(this.component.registry.setOAuthConfig, {
      authServerUrl: config.authServerUrl,
      ...(config.resourceUrl !== undefined
        ? { resourceUrl: config.resourceUrl }
        : {}),
    });
  }

  /**
   * Handle an MCP HTTP request (POST/GET/DELETE on `/mcp/`). Hosts mount
   * this on their own `httpRouter`; the component's HTTP routes have no
   * `ctx.auth` per Convex's component-isolation model, so the protocol
   * surface lives here on the client side instead.
   *
   * The host supplies an `authorize` callback that runs in the host's
   * action context (so `ctx.auth.getUserIdentity()` works). The
   * callback decides per `tools/call` and per tool in `tools/list`.
   *
   * ```ts
   * import { httpRouter } from "convex/server";
   * import { httpAction } from "./_generated/server.js";
   * import { gateway } from "./mcp.js";
   * import { authorize } from "./authorize.js";
   *
   * const http = httpRouter();
   * const mcp = httpAction(async (ctx, req) =>
   *   gateway.handleMcpRequest(ctx, req, { authorize }),
   * );
   * http.route({ path: "/mcp/", method: "POST",   handler: mcp });
   * http.route({ path: "/mcp/", method: "GET",    handler: mcp });
   * http.route({ path: "/mcp/", method: "DELETE", handler: mcp });
   * export default http;
   * ```
   */
  async handleMcpRequest(
    ctx: RunMutationCtx & {
      runAction: (ref: any, args: any) => Promise<any>;
      auth: { getUserIdentity: () => Promise<any> };
    },
    request: Request,
    options: HandleMcpRequestOptions,
  ): Promise<Response> {
    return await handleMcpRequestImpl(ctx, request, this.component, options);
  }

  /**
   * Serve the RFC 9728 protected-resource metadata document. Hosts mount
   * this on their own `httpRouter` at the canonical well-known path:
   *
   * ```ts
   * import { httpRouter } from "convex/server";
   * import { httpAction } from "./_generated/server.js";
   * import { gateway } from "./mcp.js";  // or wherever you build it
   *
   * const http = httpRouter();
   * http.route({
   *   pathPrefix: "/.well-known/oauth-protected-resource",
   *   method: "GET",
   *   handler: httpAction(async (ctx, request) =>
   *     gateway.serveProtectedResourceMetadata(ctx, request),
   *   ),
   * });
   * export default http;
   * ```
   *
   * The host mounts this route alongside the `/mcp/` route from
   * `handleMcpRequest`; RFC 9728 §3.1 mandates the metadata at
   * `<origin>/.well-known/oauth-protected-resource<path>`. The
   * component itself does not own any HTTP routes (Convex does not
   * propagate `ctx.auth` into component code, so all routes live in
   * the host).
   *
   * Returns `404` when no OAuth config has been set via `setOAuthConfig`.
   */
  async serveProtectedResourceMetadata(
    ctx: RunQueryCtx,
    request: Request,
  ): Promise<Response> {
    // Discovery is read-only public metadata (RFC 9728 §3) and is
    // fetched cross-origin by every browser MCP client. Always
    // permissive CORS — no secrets here.
    const corsHeaders = {
      "access-control-allow-origin": "*",
      vary: "Origin",
    } as const;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers":
            request.headers.get("access-control-request-headers") ?? "*",
          "access-control-max-age": "86400",
        },
      });
    }
    const oauthConfig = await ctx.runQuery(
      this.component.registry.getOAuthConfig,
      {},
    );
    if (!oauthConfig) {
      return new Response("OAuth discovery not configured", {
        status: 404,
        headers: corsHeaders,
      });
    }
    const url = new URL(request.url);
    const resourcePath = resourcePathFromWellKnownRequest(url.pathname);
    const resource = buildResourceUrl(
      url.origin,
      resourcePath,
      oauthConfig.resourceUrl,
    );
    return new Response(
      JSON.stringify({
        resource,
        authorization_servers: [oauthConfig.authServerUrl],
        bearer_methods_supported: ["header"],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=3600",
          ...corsHeaders,
        },
      },
    );
  }

  // ---------------------------------------------------------------
  // OPTIONAL: OIDC-bridge mode
  //
  // The two methods below are opt-in helpers for hosts whose upstream
  // IdP doesn't support Dynamic Client Registration (RFC 7591) — e.g.
  // Pocket-ID 2.x — but who still want browser-based MCP clients
  // (which DO require DCR) to connect.
  //
  // Pattern: the host advertises ITSELF as the authorization server in
  // the protected-resource metadata, mounts these two helpers as
  // `/.well-known/oauth-authorization-server` and `/oauth/register`,
  // pre-registers ONE client with the upstream IdP, and configures
  // these helpers with that client's id. DCR requests from MCP clients
  // are answered with the same fixed client id; everything else (the
  // actual `authorize`, `token`, `userinfo` endpoints) flows directly
  // to the upstream.
  //
  // Hosts that don't need this can ignore both methods. The "dumb"
  // pass-through mode (the host owns auth entirely via its `authorize`
  // callback, with or without `setOAuthConfig` for plain RFC 9728
  // discovery) keeps working unchanged.
  // ---------------------------------------------------------------

  /**
   * Serve RFC 8414 OAuth Authorization Server Metadata, wrapping an
   * upstream IdP. Fetches the upstream's openid-configuration once
   * per process (in-memory cached), copies the relevant fields, and
   * substitutes our own `registration_endpoint` so MCP clients DCR
   * against `handleClientRegistration` instead of the upstream.
   *
   * Mount on the host:
   *
   * ```ts
   * http.route({
   *   path: "/.well-known/oauth-authorization-server",
   *   method: "GET",
   *   handler: httpAction(async (ctx, request) =>
   *     gateway.serveAuthorizationServerMetadata(ctx, request, {
   *       upstreamIssuer: "https://id.example.com",
   *     }),
   *   ),
   * });
   * ```
   */
  async serveAuthorizationServerMetadata(
    _ctx: unknown,
    request: Request,
    options: {
      upstreamIssuer: string;
      /** Path to your `handleClientRegistration` route. Default: `/oauth/register` */
      registrationPath?: string;
      /**
       * Fields to override in the bridged metadata. Useful for:
       *
       * - Removing `openid` from `scopes_supported` (when the client
       *   would otherwise request an `id_token` and reject it because
       *   the upstream's `iss` claim won't match the bridge's
       *   advertised `issuer`).
       * - Restricting `response_types_supported` to `["code"]` to
       *   force pure-OAuth code flow (no `id_token` hybrid).
       * - Setting `issuer` to the upstream issuer instead of the
       *   bridge origin, if the client refuses to accept the
       *   mismatch (technically violates RFC 8414 §2 but works with
       *   stricter clients).
       *
       * Any key set here replaces the bridged value verbatim. Keys
       * not set fall through to the upstream's value (or our default).
       */
      overrides?: Record<string, unknown>;
    },
  ): Promise<Response> {
    const corsHeaders = {
      "access-control-allow-origin": "*",
      vary: "Origin",
    } as const;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers":
            request.headers.get("access-control-request-headers") ?? "*",
          "access-control-max-age": "86400",
        },
      });
    }
    const url = new URL(request.url);
    const registrationPath = options.registrationPath ?? "/oauth/register";
    let upstream: Record<string, unknown>;
    try {
      upstream = await fetchOidcConfigCached(options.upstreamIssuer);
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "upstream_metadata_unreachable",
          error_description:
            err instanceof Error ? err.message : String(err),
        }),
        {
          status: 502,
          headers: { "content-type": "application/json", ...corsHeaders },
        },
      );
    }
    const body: Record<string, unknown> = {
      issuer: url.origin,
      authorization_endpoint: upstream.authorization_endpoint,
      token_endpoint: upstream.token_endpoint,
      userinfo_endpoint: upstream.userinfo_endpoint,
      jwks_uri: upstream.jwks_uri,
      scopes_supported: upstream.scopes_supported,
      response_types_supported: upstream.response_types_supported,
      grant_types_supported: upstream.grant_types_supported,
      code_challenge_methods_supported:
        upstream.code_challenge_methods_supported,
      // Public-client (PKCE) only at the bridge — secrets stay
      // upstream and never round-trip through here.
      token_endpoint_auth_methods_supported: ["none"],
      registration_endpoint: `${url.origin}${registrationPath}`,
      ...(options.overrides ?? {}),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
        ...corsHeaders,
      },
    });
  }

  /**
   * Serve RFC 7591 Dynamic Client Registration, returning a fixed
   * pre-registered upstream client id for every request. This is the
   * "fake DCR" that lets browser MCP clients (which insist on DCR)
   * connect to upstream IdPs that don't support DCR.
   *
   * **`allowedRedirectPatterns` is required** to prevent open-redirect
   * attacks: without it any caller could "register" a client with an
   * attacker-controlled `redirect_uri` and steal auth codes.
   *
   * Mount on the host:
   *
   * ```ts
   * http.route({
   *   path: "/oauth/register",
   *   method: "POST",
   *   handler: httpAction(async (ctx, request) =>
   *     gateway.handleClientRegistration(ctx, request, {
   *       upstreamClientId: "<your pre-registered id>",
   *       allowedRedirectPatterns: [
   *         /^https:\/\/claude\.ai\//,
   *         /^https:\/\/claude\.com\//,
   *         /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//,
   *       ],
   *     }),
   *   ),
   * });
   * ```
   */
  async handleClientRegistration(
    _ctx: unknown,
    request: Request,
    options: {
      upstreamClientId: string;
      allowedRedirectPatterns: RegExp[];
    },
  ): Promise<Response> {
    const corsHeaders = {
      "access-control-allow-origin": "*",
      vary: "Origin",
    } as const;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers":
            request.headers.get("access-control-request-headers") ??
            "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST, OPTIONS", ...corsHeaders },
      });
    }
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonError(400, "invalid_client_metadata", "Invalid JSON body", corsHeaders);
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as unknown[])
      : [];
    if (redirectUris.length === 0) {
      return jsonError(
        400,
        "invalid_redirect_uri",
        "redirect_uris is required and must be a non-empty array",
        corsHeaders,
      );
    }
    const invalid = redirectUris.filter((u) => {
      if (typeof u !== "string") return true;
      return !options.allowedRedirectPatterns.some((p) => p.test(u));
    });
    if (invalid.length > 0) {
      return jsonError(
        400,
        "invalid_redirect_uri",
        `One or more redirect_uris are not allowed: ${JSON.stringify(invalid)}`,
        corsHeaders,
      );
    }
    return new Response(
      JSON.stringify({
        client_id: options.upstreamClientId,
        client_name: body.client_name ?? "MCP Client",
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      {
        status: 201,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...corsHeaders,
        },
      },
    );
  }
}

// In-memory cache for upstream OIDC discovery docs. One Convex
// httpAction process serves many requests; refetching openid-config
// per call would add 100ms+ per AS-metadata request for no benefit
// (the doc is effectively static — TTL is 1 hour to recover from
// upstream config changes without a redeploy).
const oidcCache = new Map<
  string,
  { fetchedAt: number; doc: Record<string, unknown> }
>();
const OIDC_CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchOidcConfigCached(
  issuer: string,
): Promise<Record<string, unknown>> {
  const cached = oidcCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < OIDC_CACHE_TTL_MS) {
    return cached.doc;
  }
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Upstream OIDC discovery returned ${res.status} from ${url}`,
    );
  }
  const doc = (await res.json()) as Record<string, unknown>;
  oidcCache.set(issuer, { fetchedAt: Date.now(), doc });
  return doc;
}

function jsonError(
  status: number,
  error: string,
  description: string,
  extraHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: { "content-type": "application/json", ...extraHeaders },
    },
  );
}

export default McpGateway;
