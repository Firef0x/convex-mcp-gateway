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

const visibleToolValidator = v.object({
  name: v.string(),
  description: v.string(),
  kind: v.union(
    v.literal("query"),
    v.literal("mutation"),
    v.literal("action"),
  ),
  inputSchema: v.any(),
});

type RegisteredTool = {
  name: string;
  description: string;
  kind: "query" | "mutation" | "action";
  functionHandle: string;
  inputSchema: unknown;
  metadata?: unknown;
};

const UNAUTHORIZED = -32001;
const FORBIDDEN = -32003;
const INTERNAL_ERROR = -32603;
const NOT_CONFIGURED = -32011;

/**
 * Return the catalog visible to the current caller: every registered tool
 * for which the host's authorizer says `allowed: true` in `mode: "list"`.
 *
 * Deny-by-default: with no authorizer configured this returns an empty
 * array, mirroring the `-32011` behavior on `tools/call`. Used by the
 * component's `tools/list` HTTP route and exposed so hosts can compute
 * the same filtered catalog from their own code.
 *
 * Authorizer throws are isolated per tool: one buggy decision does not
 * take down the whole listing. A throwing authorizer is treated as deny
 * for the affected tool only.
 */
export const listVisibleTools = action({
  args: {},
  returns: v.array(visibleToolValidator),
  handler: async (ctx) => {
    const tools = (await ctx.runQuery(
      api.registry.listTools,
      {},
    )) as RegisteredTool[];
    const authorizerHandle = await ctx.runQuery(
      api.registry.getAuthorizer,
      {},
    );
    if (!authorizerHandle) return [];

    const handle = authorizerHandle as FunctionHandle<"query">;
    const decisions = await Promise.all(
      tools.map(async (tool) => {
        try {
          return await ctx.runQuery(handle, {
            toolName: tool.name,
            toolKind: tool.kind,
            args: {},
            mode: "list",
            toolMetadata: tool.metadata ?? null,
          });
        } catch {
          return null;
        }
      }),
    );
    return tools
      .filter((_, i) => {
        const d = decisions[i] as { allowed?: unknown } | null | undefined;
        return d != null && d.allowed === true;
      })
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        kind: tool.kind,
        inputSchema: tool.inputSchema,
      }));
  },
});

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
 * Exposed as a public `action` (not `internalAction`) because component
 * function references generated via `anyApi` strip the public/internal
 * marker at runtime; see `audit.ts` for the same rationale.
 */
export const callTool = action({
  args: {
    name: v.string(),
    args: v.any(),
  },
  returns: dispatchResultValidator,
  handler: async (ctx, request) => {
    const start = Date.now();
    const identity = await ctx.auth.getUserIdentity();
    const identitySubject = identity?.subject ?? null;

    const tool = (await ctx.runQuery(api.registry.getTool, {
      name: request.name,
    })) as RegisteredTool | null;
    if (!tool) {
      // Intentionally not audited: an unauthenticated caller can spam
      // arbitrary tool names with arbitrary args, and this would let them
      // grow the audit table without bound.
      return {
        ok: false as const,
        error: { code: -32602, message: `Unknown tool: ${request.name}` },
      };
    }

    const auditArgs = shouldAuditArgs(tool) ? request.args : null;

    const authorizerHandle = await ctx.runQuery(
      api.registry.getAuthorizer,
      {},
    );
    if (!authorizerHandle) {
      const error = {
        code: NOT_CONFIGURED,
        message:
          "No authorizer configured for the MCP gateway. Register one via " +
          "`McpGateway#setAuthorizer` before calling tools.",
      };
      await safeRecordAudit(ctx, {
        toolName: tool.name,
        toolKind: tool.kind,
        args: auditArgs,
        outcome: "error",
        identitySubject,
        durationMs: Date.now() - start,
        errorCode: error.code,
        errorMessage: error.message,
      });
      return { ok: false as const, error };
    }

    let decision: unknown;
    try {
      decision = await ctx.runQuery(
        authorizerHandle as FunctionHandle<"query">,
        {
          toolName: tool.name,
          toolKind: tool.kind,
          args: request.args,
          mode: "call",
          toolMetadata: tool.metadata ?? null,
        },
      );
    } catch (err) {
      // Authorizer threw. Treat as internal failure (not as deny), so
      // operators see -32603 instead of a confusing 401/403, and we still
      // keep an audit trail of the failed evaluation.
      const message = err instanceof Error ? err.message : String(err);
      await safeRecordAudit(ctx, {
        toolName: tool.name,
        toolKind: tool.kind,
        args: auditArgs,
        outcome: "error",
        identitySubject,
        durationMs: Date.now() - start,
        errorCode: INTERNAL_ERROR,
        errorMessage: `Authorizer threw: ${message}`,
      });
      return {
        ok: false as const,
        error: {
          code: INTERNAL_ERROR,
          message: `Authorizer threw: ${message}`,
        },
      };
    }

    const parsed = parseAuthorizerDecision(decision);
    if (!parsed.allowed) {
      const reason = parsed.reason ?? "Forbidden";
      const code = /^unauth/i.test(reason) ? UNAUTHORIZED : FORBIDDEN;
      await safeRecordAudit(ctx, {
        toolName: tool.name,
        toolKind: tool.kind,
        args: auditArgs,
        outcome: "denied",
        identitySubject,
        durationMs: Date.now() - start,
        errorCode: code,
        errorMessage: reason,
      });
      return { ok: false as const, error: { code, message: reason } };
    }

    let data: unknown;
    let toolError: { code: number; message: string } | null = null;
    try {
      const handle = tool.functionHandle as FunctionHandle<
        "query" | "mutation" | "action"
      >;
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
    } catch (err) {
      toolError = {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // Audit happens AFTER the handler resolves and OUTSIDE the tool's
    // try/catch, so an audit-write failure can never invert a successful
    // tool result into an error response (and vice versa). `safeRecordAudit`
    // additionally swallows its own errors; loss of an audit row is the
    // accepted failure mode here.
    await safeRecordAudit(ctx, {
      toolName: tool.name,
      toolKind: tool.kind,
      args: auditArgs,
      outcome: toolError ? "error" : "allowed",
      identitySubject,
      durationMs: Date.now() - start,
      ...(toolError
        ? { errorCode: toolError.code, errorMessage: toolError.message }
        : {}),
    });

    if (toolError) {
      return { ok: false as const, error: toolError };
    }
    return { ok: true as const, data };
  },
});

/**
 * Hosts opt out of arg storage by setting `metadata.auditArgs = false` on
 * a tool definition. Useful for tools whose argument schema can carry
 * secrets (API keys, tokens, PII): the audit row still records the call,
 * but `args` is stored as `null`.
 */
function shouldAuditArgs(tool: RegisteredTool): boolean {
  const meta = tool.metadata as { auditArgs?: unknown } | null | undefined;
  return meta?.auditArgs !== false;
}

async function safeRecordAudit(
  ctx: { runMutation: (...args: any[]) => Promise<unknown> },
  entry: {
    toolName: string;
    toolKind: "query" | "mutation" | "action";
    args: unknown;
    outcome: "allowed" | "denied" | "error";
    identitySubject: string | null;
    durationMs: number;
    errorCode?: number;
    errorMessage?: string;
  },
): Promise<void> {
  try {
    await ctx.runMutation(api.audit.recordEntry, entry);
  } catch (err) {
    // Audit must never alter the dispatch outcome. Surface the failure to
    // the deployment log so operators can investigate, then swallow.
    console.error(
      "[mcp-gateway] failed to record audit entry",
      entry.toolName,
      entry.outcome,
      err,
    );
  }
}

function parseAuthorizerDecision(decision: unknown): {
  allowed: boolean;
  reason?: string;
} {
  // The handle is opaque so we can't statically type the return. Validate
  // shape at runtime; reject anything else as a misconfigured authorizer.
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
