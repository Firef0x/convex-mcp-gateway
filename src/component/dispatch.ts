import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { action } from "./_generated/server.js";
import { api } from "./_generated/api.js";

const dispatchResultValidator = v.union(
  v.object({ ok: v.literal(true), data: v.any() }),
  v.object({
    ok: v.literal(false),
    error: v.object({ code: v.number(), message: v.string() }),
  }),
);

const authorizerReturnValidator = v.object({
  allowed: v.boolean(),
  reason: v.optional(v.string()),
});

const UNAUTHORIZED = -32001;
const FORBIDDEN = -32003;
const NOT_CONFIGURED = -32011;

/**
 * Dispatch a single MCP `tools/call`: look up the registered tool, consult
 * the host-registered authorizer, and invoke the registered function handle.
 *
 * The component intentionally does not know what authorization model the
 * host uses. It only enforces three rules:
 *
 *   1. The tool must be registered.
 *   2. An authorizer must be configured. If none is set, all calls are
 *      rejected with `-32011 No authorizer configured`. This is
 *      deny-by-default and forces the host to opt in to a policy.
 *   3. The authorizer must return `allowed: true`. Otherwise the call is
 *      rejected with `-32003 Forbidden` (or with `-32001 Unauthorized` if
 *      the authorizer's `reason` starts with "Unauth", as a hint for
 *      JSON-RPC clients that distinguish 401 vs 403 semantics).
 *
 * Identity propagates through `ctx.runQuery(authorizerHandle, ...)`
 * automatically: the authorizer can call `ctx.auth.getUserIdentity()` and
 * sees the same identity that was on the inbound HTTP request.
 *
 * Exposed as `internalAction` so it can be invoked from the component's
 * HTTP route and from convex-test (which can drive auth via
 * `t.withIdentity`).
 */
export const callTool = action({
  args: {
    name: v.string(),
    args: v.any(),
  },
  returns: dispatchResultValidator,
  handler: async (ctx, request) => {
    const tool = await ctx.runQuery(api.registry.getTool, {
      name: request.name,
    });
    if (!tool) {
      return {
        ok: false as const,
        error: { code: -32602, message: `Unknown tool: ${request.name}` },
      };
    }

    const authorizerHandle = await ctx.runQuery(
      api.registry.getAuthorizer,
      {},
    );
    if (!authorizerHandle) {
      return {
        ok: false as const,
        error: {
          code: NOT_CONFIGURED,
          message:
            "No authorizer configured for the MCP gateway. Register one via " +
            "`McpGateway#setAuthorizer` before calling tools.",
        },
      };
    }

    const decision = await ctx.runQuery(
      authorizerHandle as FunctionHandle<"query">,
      {
        toolName: tool.name,
        toolKind: tool.kind,
        args: request.args,
      },
    );
    const parsed = parseAuthorizerDecision(decision);
    if (!parsed.allowed) {
      const reason = parsed.reason ?? "Forbidden";
      const code = /^unauth/i.test(reason) ? UNAUTHORIZED : FORBIDDEN;
      return { ok: false as const, error: { code, message: reason } };
    }

    try {
      const handle = tool.functionHandle as FunctionHandle<
        "query" | "mutation" | "action"
      >;
      let data: unknown;
      switch (tool.kind) {
        case "query":
          data = await ctx.runQuery(
            handle as FunctionHandle<"query">,
            request.args,
          );
          break;
        case "mutation":
          data = await ctx.runMutation(
            handle as FunctionHandle<"mutation">,
            request.args,
          );
          break;
        case "action":
          data = await ctx.runAction(
            handle as FunctionHandle<"action">,
            request.args,
          );
          break;
      }
      return { ok: true as const, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false as const,
        error: { code: -32000, message },
      };
    }
  },
});

function parseAuthorizerDecision(decision: unknown): {
  allowed: boolean;
  reason?: string;
} {
  // The handle is opaque so we can't statically type the return. Validate
  // shape at runtime; reject anything else as a misconfigured authorizer.
  const parsed = authorizerReturnValidator;
  void parsed;
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
