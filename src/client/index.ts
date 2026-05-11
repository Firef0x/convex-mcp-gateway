import {
  createFunctionHandle,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import type { ObjectType, PropertyValidators } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  convexValidatorToJsonSchema,
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
  convexValidatorToJsonSchema,
  mcpAuthorizerArgs,
  mcpAuthorizerReturns,
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
    });
  }

  async register(
    ctx: RunMutationCtx,
    tools: Array<McpToolDefinition & { fn: AnyToolFunctionReference }>,
  ): Promise<void> {
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
}

export default McpGateway;
