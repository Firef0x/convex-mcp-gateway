import { v } from "convex/values";
import {
  McpGateway,
  defineMcpMutation,
  defineMcpQuery,
  mcpAuthorizerArgs,
  mcpAuthorizerReturns,
  type McpAuthorizerHandler,
} from "@convex-dev/mcp-gateway";
import { api, components, internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

/**
 * Authorizer the example deployment installs at bootstrap. The component
 * calls this on every `tools/call`, with the resolved tool name + kind and
 * the raw caller-supplied arguments. The host decides whether to allow it
 * by whatever criteria it wants. Here we demonstrate three patterns:
 *
 *   1. Anonymous-allowed tool (`invoices.summary`) lets unauthenticated
 *      requests through.
 *   2. Authenticated tools require a Convex identity.
 *   3. The mutation `invoices.markPaid` additionally requires the caller
 *      to be on an internal allowlist surfaced via `identity.roles`.
 *
 * Everything below is host-defined application logic; the component has
 * no notion of scopes, roles, or public-vs-private tools. Swap this body
 * for whatever your app needs.
 */
export const authorize = internalQuery({
  args: mcpAuthorizerArgs,
  returns: mcpAuthorizerReturns,
  handler: (async (ctx, { toolName }) => {
    if (toolName === "invoices.summary") {
      return { allowed: true };
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { allowed: false, reason: "Unauthorized" };
    }

    if (toolName === "invoices.markPaid") {
      const roles =
        (identity as unknown as { roles?: unknown }).roles;
      const isAdmin =
        Array.isArray(roles) && roles.includes("finance.admin");
      if (!isAdmin) {
        return {
          allowed: false,
          reason: "Forbidden: finance.admin role required",
        };
      }
    }

    return { allowed: true };
  }) satisfies McpAuthorizerHandler,
});

/**
 * Test-only authorizer used to prove that the `mode` discriminator is
 * propagated correctly: it allows tools/list but denies tools/call.
 */
export const modeAssertingAuthorizer = internalQuery({
  args: mcpAuthorizerArgs,
  returns: mcpAuthorizerReturns,
  handler: (async (_ctx, { mode }) => {
    if (mode === "list") return { allowed: true };
    return { allowed: false, reason: `Forbidden in ${mode} mode` };
  }) satisfies McpAuthorizerHandler,
});

/**
 * Test-only authorizer used to prove that `toolMetadata` reaches the
 * authorizer intact. Allows only tools whose metadata has `allow: true`.
 */
export const metadataAssertingAuthorizer = internalQuery({
  args: mcpAuthorizerArgs,
  returns: mcpAuthorizerReturns,
  handler: (async (_ctx, { toolName, toolMetadata }) => {
    const meta = (toolMetadata ?? {}) as { allow?: boolean };
    if (meta.allow === true) return { allowed: true };
    return {
      allowed: false,
      reason: `tool ${toolName} has no allow flag in metadata`,
    };
  }) satisfies McpAuthorizerHandler,
});

/**
 * Test-only authorizer that always throws. Used to prove that
 * `dispatch.callTool` and `dispatch.listVisibleTools` isolate authorizer
 * failures rather than turning them into HTTP 500s.
 */
export const throwingAuthorizer = internalQuery({
  args: mcpAuthorizerArgs,
  returns: mcpAuthorizerReturns,
  handler: ((_ctx, _args) => {
    throw new Error("authorizer boom");
  }) satisfies McpAuthorizerHandler,
});

/**
 * Run once (or whenever the tool list / authorizer changes) to populate the
 * component registry and configure the authorizer.
 *
 * ```sh
 * npx convex run mcp:registerDefaults
 * ```
 */
export const registerDefaults = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await gateway.setAuthorizer(ctx, internal.mcp.authorize);

    await gateway.register(
      ctx,
      [
        defineMcpQuery({
          name: "invoices.list",
          description: "List invoices, optionally filtered by status.",
          fn: api.invoices.list,
          args: {
            status: v.optional(
              v.union(v.literal("open"), v.literal("paid")),
            ),
          },
        }),
        defineMcpMutation({
          name: "invoices.markPaid",
          description: "Mark an invoice as paid.",
          fn: api.invoices.markPaid,
          args: { id: v.id("invoices") },
        }),
        defineMcpQuery({
          name: "invoices.summary",
          description: "Return the total number of invoices. Public.",
          fn: api.invoices.summary,
          args: {},
        }),
      ],
      { replace: true },
    );
    return null;
  },
});
