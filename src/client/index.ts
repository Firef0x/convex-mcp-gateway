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

export type {
  JsonSchema,
  McpAuthorizerArgs,
  McpAuthorizerDecision,
  McpAuthorizerHandler,
  McpToolDefinition,
  McpToolKind,
} from "../shared.js";
export {
  buildProtectedResourceMetadataUrl,
  buildResourceUrl,
  convexValidatorToJsonSchema,
  mcpAuthorizerArgs,
  mcpAuthorizerReturns,
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
   * component never inspects this; it is forwarded to the host's
   * authorizer (via `mcpAuthorizerArgs.toolMetadata`) so per-tool
   * scope/role checks can stay declarative. Use whatever shape your
   * authorizer expects, e.g. `{ scopes: ["finance:read"], roles: [...] }`.
   */
  metadata?: Record<string, unknown>;
}

function build<
  Kind extends McpToolKind,
  Ref extends ToolFunctionReference<Kind>,
  ArgsV extends PropertyValidators,
>(
  kind: Kind,
  config: McpToolConfigBase<Ref, ArgsV>,
): McpToolDefinition & { fn: Ref; kind: Kind } {
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
 * Authorization is *not* configured per-tool. The host registers a single
 * authorizer via `McpGateway#setAuthorizer`; it sees every `tools/call` and
 * decides whether to allow it.
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
 * Reference to the host's authorizer query. The query must have the
 * standardized signature
 *   `args: { toolName, toolKind, args }`, `returns: { allowed, reason? }`.
 *
 * Build it with `mcpAuthorizerArgs` + `mcpAuthorizerReturns` to get the
 * types right; the constraint here is just a sanity check (`AuthorizerRef`
 * is loose because the actual signature is enforced by the validators on
 * both sides).
 */
export type AuthorizerRef = FunctionReference<
  "query",
  "internal" | "public",
  any,
  any
>;

/**
 * Host-app handle for the MCP gateway component.
 *
 * Construct one with the generated `components.mcpGateway` and use it to
 * register typesafe tool descriptors plus an authorizer:
 *
 * ```ts
 * import {
 *   McpGateway,
 *   defineMcpQuery,
 *   mcpAuthorizerArgs,
 *   mcpAuthorizerReturns,
 * } from "@convex-dev/mcp-gateway";
 * import { components, api, internal } from "./_generated/api.js";
 * import { internalMutation, internalQuery } from "./_generated/server.js";
 *
 * const gateway = new McpGateway(components.mcpGateway);
 *
 * export const authorize = internalQuery({
 *   args: mcpAuthorizerArgs,
 *   returns: mcpAuthorizerReturns,
 *   handler: async (ctx) => {
 *     const identity = await ctx.auth.getUserIdentity();
 *     if (!identity) return { allowed: false, reason: "Unauthorized" };
 *     return { allowed: true };
 *   },
 * });
 *
 * export const bootstrap = internalMutation({
 *   args: {},
 *   handler: async (ctx) => {
 *     await gateway.setAuthorizer(ctx, internal.mcp.authorize);
 *     await gateway.register(ctx, [defineMcpQuery({ ... })]);
 *   },
 * });
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

  async register(
    ctx: RunMutationCtx,
    tools: Array<McpToolDefinition & { fn: AnyToolFunctionReference }>,
    options?: { replace?: boolean },
  ): Promise<void> {
    if (options?.replace) {
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
      return;
    }
    for (const tool of tools) {
      await this.registerTool(ctx, tool);
    }
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
   * Register (or replace) the authorizer that decides whether a `tools/call`
   * may proceed. Pass `null` to clear the configured authorizer; in that
   * state every call is rejected with `-32011 No authorizer configured`.
   */
  async setAuthorizer(
    ctx: RunMutationCtx,
    authorizer: AuthorizerRef | null,
  ): Promise<void> {
    const handle =
      authorizer === null
        ? null
        : await createFunctionHandle(authorizer as any);
    await ctx.runMutation(this.component.registry.setAuthorizer, {
      authorizerHandle: handle,
    });
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
   * The component cannot mount this route itself: Convex components only
   * own routes under their own `httpPrefix` (e.g. `/mcp`), but RFC 9728
   * §3.1 mandates the metadata at `<origin>/.well-known/oauth-protected-resource<path>`,
   * which lives outside the component's prefix.
   *
   * Returns `404` when no OAuth config has been set via `setOAuthConfig`.
   */
  async serveProtectedResourceMetadata(
    ctx: RunQueryCtx,
    request: Request,
  ): Promise<Response> {
    const oauthConfig = await ctx.runQuery(
      this.component.registry.getOAuthConfig,
      {},
    );
    if (!oauthConfig) {
      return new Response("OAuth discovery not configured", { status: 404 });
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
        },
      },
    );
  }
}

export default McpGateway;
