import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

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
export const createSession = mutation({
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
export const getSession = query({
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
export const touchSession = mutation({
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
export const deleteSession = mutation({
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
 * Drop sessions whose `lastSeenAt` is older than the given cutoff. The
 * host invokes this from a cron when it cares about idle cleanup; the
 * component does not run any background work itself.
 */
export const pruneSessions = mutation({
  args: { olderThanMs: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.olderThanMs;
    let deleted = 0;
    for await (const row of ctx.db.query("sessions")) {
      if (row.lastSeenAt < cutoff) {
        await ctx.db.delete("sessions", row._id);
        deleted++;
      }
    }
    return deleted;
  },
});
