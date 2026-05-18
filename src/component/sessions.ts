import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";

const sessionValidator = v.object({
  _id: v.id("sessions"),
  _creationTime: v.number(),
  sessionId: v.string(),
  protocolVersion: v.string(),
  createdAt: v.number(),
  lastSeenAt: v.number(),
});

/**
 * Create a fresh session for the negotiated protocol version. Called
 * from the HTTP handler after a successful `initialize`. The session ID
 * is generated server-side; never trust a client-supplied value.
 */
export const createSession = internalMutation({
  args: {
    sessionId: v.string(),
    protocolVersion: v.string(),
  },
  returns: v.id("sessions"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("sessions", {
      sessionId: args.sessionId,
      protocolVersion: args.protocolVersion,
      createdAt: now,
      lastSeenAt: now,
    });
  },
});

/**
 * Look up a session by its public id. Returns null if unknown or
 * already terminated; the HTTP handler responds with 404 in that case
 * so the client knows to start a new session per MCP 2025-06-18.
 */
export const getSession = internalQuery({
  args: { sessionId: v.string() },
  returns: v.union(sessionValidator, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    return row ?? null;
  },
});

/**
 * Mark the session as recently seen so a future timeout-based pruner
 * can distinguish active from idle sessions. Best-effort: failures are
 * non-fatal and the HTTP handler swallows them.
 */
export const touchSession = internalMutation({
  args: { sessionId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (!row) return false;
    await ctx.db.patch("sessions", row._id, { lastSeenAt: Date.now() });
    return true;
  },
});

/**
 * Terminate a session. The HTTP DELETE handler calls this; the
 * spec-required follow-up is HTTP 404 to subsequent requests carrying
 * that session id.
 */
export const deleteSession = internalMutation({
  args: { sessionId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (!row) return false;
    await ctx.db.delete("sessions", row._id);
    return true;
  },
});

/**
 * Drop sessions whose `lastSeenAt` is older than the given cutoff.
 * Bounded per-call: up to `PRUNE_BATCH` rows are deleted in one
 * mutation, so very busy deployments don't hit Convex's per-mutation
 * read/write limits. Callers loop until the return value is `0` to
 * fully drain. The host invokes this from a cron when it cares about
 * idle cleanup; the component runs no background work itself.
 */
const PRUNE_BATCH = 200;

export const pruneSessions = internalMutation({
  args: { olderThanMs: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.olderThanMs;
    // The `by_lastSeenAt` index lets us fetch exactly the eligible
    // rows in one indexed read instead of scanning the full table.
    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_lastSeenAt", (q) => q.lt("lastSeenAt", cutoff))
      .take(PRUNE_BATCH);
    let deleted = 0;
    for (const row of rows) {
      await ctx.db.delete("sessions", row._id);
      deleted++;
    }
    return deleted;
  },
});
