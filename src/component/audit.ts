import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { auditOutcomeValidator, toolKindValidator } from "./schema.js";

const auditEntryValidator = v.object({
  _id: v.id("audit"),
  _creationTime: v.number(),
  toolName: v.string(),
  toolKind: toolKindValidator,
  args: v.any(),
  outcome: auditOutcomeValidator,
  identitySubject: v.union(v.string(), v.null()),
  durationMs: v.number(),
  errorCode: v.optional(v.number()),
  errorMessage: v.optional(v.string()),
});

/**
 * Component-internal mutation that appends one row to the audit log.
 * Declared as `mutation` (not `internalMutation`) because anyApi-based
 * function references generated for components don't carry the
 * internal/public marker at runtime, so internal references inside the
 * same component fail to resolve. The component boundary still hides
 * this from the host's HTTP surface; only the host (which already
 * trusts itself) could call it via `components.mcpGateway.audit.recordEntry`.
 */
export const recordEntry = mutation({
  args: {
    toolName: v.string(),
    toolKind: toolKindValidator,
    args: v.any(),
    outcome: auditOutcomeValidator,
    identitySubject: v.union(v.string(), v.null()),
    durationMs: v.number(),
    errorCode: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.id("audit"),
  handler: async (ctx, entry) => {
    return await ctx.db.insert("audit", entry);
  },
});

/**
 * List audit entries newest first, optionally filtered by tool name or
 * outcome. `limit` defaults to 100, capped at 1000 to keep the host from
 * pulling unbounded history through `runQuery`.
 *
 * When both `toolName` and `outcome` are supplied, the iteration walks
 * the `by_toolName` index ordered desc and stops once `limit` matching
 * entries are collected. A naive `take(limit*N)` + JS post-filter would
 * silently miss matches when most of the recent prefix doesn't match the
 * outcome (e.g. lots of recent `allowed` entries hiding older `error`s).
 */
export const listEntries = query({
  args: {
    toolName: v.optional(v.string()),
    outcome: v.optional(auditOutcomeValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(auditEntryValidator),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 1000);

    if (args.toolName !== undefined && args.outcome !== undefined) {
      const out: Array<unknown> = [];
      for await (const entry of ctx.db
        .query("audit")
        .withIndex("by_toolName", (q) => q.eq("toolName", args.toolName!))
        .order("desc")) {
        if (entry.outcome === args.outcome) {
          out.push(entry);
          if (out.length >= limit) break;
        }
      }
      return out as never;
    }

    if (args.toolName !== undefined) {
      return await ctx.db
        .query("audit")
        .withIndex("by_toolName", (q) => q.eq("toolName", args.toolName!))
        .order("desc")
        .take(limit);
    }
    if (args.outcome !== undefined) {
      return await ctx.db
        .query("audit")
        .withIndex("by_outcome", (q) => q.eq("outcome", args.outcome!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("audit").order("desc").take(limit);
  },
});
