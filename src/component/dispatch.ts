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

type RegisteredTool = {
  name: string;
  description: string;
  kind: "query" | "mutation" | "action";
  functionHandle: string;
  inputSchema: unknown;
  metadata?: unknown;
};

/**
 * Run a registered tool by name. Looks up the function handle from the
 * registry, invokes it with the caller-supplied args, and writes one
 * audit row per call.
 *
 * The component intentionally does **not** authorize. Authorization
 * lives entirely host-side in `gateway.handleMcpRequest({ authorize })`,
 * because Convex does not propagate `ctx.auth` into component code (see
 * the Convex authoring docs). The host calls the host-side authorize
 * function before delegating to this action; by the time the call
 * arrives here, the request is already approved.
 *
 * `auditIdentitySubject` is the only piece of identity the host
 * forwards: a string subject for audit attribution, or null for
 * anonymous calls. Nothing about the policy decision crosses the
 * component boundary.
 */
export const runTool = action({
  args: {
    name: v.string(),
    args: v.any(),
    auditIdentitySubject: v.union(v.string(), v.null()),
  },
  returns: dispatchResultValidator,
  handler: async (ctx, request) => {
    const start = Date.now();

    const tool = (await ctx.runQuery(api.registry.getTool, {
      name: request.name,
    })) as RegisteredTool | null;
    if (!tool) {
      // Intentionally not audited: an unauthenticated caller can spam
      // arbitrary tool names with arbitrary args, and this would let
      // them grow the audit table without bound.
      return {
        ok: false as const,
        error: { code: -32602, message: `Unknown tool: ${request.name}` },
      };
    }

    const auditArgs = redactArgsForAudit(tool, request.args);
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
    // try/catch, so an audit-write failure can never invert a
    // successful tool result into an error response (and vice versa).
    // `safeRecordAudit` additionally swallows its own errors; loss of
    // an audit row is the accepted failure mode here.
    await safeRecordAudit(ctx, {
      toolName: tool.name,
      toolKind: tool.kind,
      args: auditArgs,
      outcome: toolError ? "error" : "allowed",
      identitySubject: request.auditIdentitySubject,
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
 * Record a deny/error decision the host's authorizer made before
 * delegating. Hosts call this when their authorize callback returns
 * `allowed: false` so the audit log captures the rejection (not just
 * the allowed dispatches). Returning the audit id lets the host
 * include it in error responses if they want correlation.
 */
export const recordAuthDenial = action({
  args: {
    name: v.string(),
    args: v.any(),
    auditIdentitySubject: v.union(v.string(), v.null()),
    outcome: v.union(v.literal("denied"), v.literal("error")),
    errorCode: v.number(),
    errorMessage: v.string(),
    durationMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, request) => {
    const tool = (await ctx.runQuery(api.registry.getTool, {
      name: request.name,
    })) as RegisteredTool | null;
    // If the tool doesn't exist we still record an audit entry: this is
    // a denied call to a known-by-the-caller name, not the anonymous
    // unknown-tool spam path we skip elsewhere.
    const toolKind = tool?.kind ?? "query";
    const auditArgs = tool ? redactArgsForAudit(tool, request.args) : null;
    await safeRecordAudit(ctx, {
      toolName: request.name,
      toolKind,
      args: auditArgs,
      outcome: request.outcome,
      identitySubject: request.auditIdentitySubject,
      durationMs: request.durationMs,
      errorCode: request.errorCode,
      errorMessage: request.errorMessage,
    });
    return null;
  },
});

/**
 * Hosts shape what gets stored in the audit log via `metadata.auditArgs`:
 *
 *   - `auditArgs: true`              (or omitted) → store args verbatim
 *   - `auditArgs: false`                          → store `null`
 *   - `auditArgs: { redact: [...] }`              → store args with the
 *     listed paths replaced by the string `"[redacted]"`
 *
 * Each entry in `redact` is a dotted path: `"token"` redacts a
 * top-level key, `"credentials.token"` redacts a nested key inside
 * `credentials`. Arrays and missing intermediate keys are passed
 * through unchanged (no insertion). Returned objects are fresh
 * shallow clones at each touched level, so the caller's args object
 * is never mutated.
 */
function redactArgsForAudit(tool: RegisteredTool, args: unknown): unknown {
  const meta = tool.metadata as
    | { auditArgs?: false | true | { redact?: string[] } }
    | null
    | undefined;
  const setting = meta?.auditArgs;

  if (setting === false) return null;
  if (setting === undefined || setting === true) return args;

  const redactList = setting.redact ?? [];
  if (redactList.length === 0) return args;

  let out = args;
  for (const field of redactList) {
    out = applyRedactionPath(out, field.split("."));
  }
  return out;
}

function applyRedactionPath(value: unknown, path: string[]): unknown {
  if (path.length === 0) return "[redacted]";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const [head, ...rest] = path;
  const obj = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, head)) return value;
  return { ...obj, [head]: applyRedactionPath(obj[head], rest) };
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
    // Audit must never alter the dispatch outcome. Surface the failure
    // to the deployment log so operators can investigate, then swallow.
    console.error(
      "[mcp-gateway] failed to record audit entry",
      entry.toolName,
      entry.outcome,
      err,
    );
  }
}

// Single source of truth lives in `src/shared.ts` so both the host's
// `mcp-handler` and this component module can defend against malformed
// authorize-callback return values without keeping two copies in sync.
// Re-export keeps `dispatch.test.ts` and any host that imports it stable.
export { parseAuthorizerDecision } from "../shared.js";
