import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";

const sessionValidator = v.object({
  _id: v.id("sessions"),
  _creationTime: v.number(),
  sessionId: v.string(),
  protocolVersion: v.string(),
  createdAt: v.number(),
  lastSeenAt: v.number(),
  identitySubject: v.optional(v.union(v.string(), v.null())),
});

/**
 * Create a fresh session for the negotiated protocol version. Called
 * from the HTTP handler after a successful `initialize`. The session ID
 * is generated server-side; never trust a client-supplied value.
 *
 * `identitySubject` is the JWT subject the gateway resolved at
 * `initialize` time (or `null` if the caller was anonymous). It binds
 * the session to a specific user so DELETE can verify the teardown
 * caller matches the creator.
 */
export const createSession = internalMutation({
  args: {
    sessionId: v.string(),
    protocolVersion: v.string(),
    identitySubject: v.union(v.string(), v.null()),
  },
  returns: v.id("sessions"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("sessions", {
      sessionId: args.sessionId,
      protocolVersion: args.protocolVersion,
      identitySubject: args.identitySubject,
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
 * Outcome of a session-delete attempt:
 *
 *   - `"deleted"`   — row existed and identity check passed
 *   - `"not_found"` — no row with that id (404 to the client)
 *   - `"forbidden"` — row exists but the caller's identitySubject
 *                     doesn't match what was bound at create time
 *                     (403 to the client, defends against
 *                     session-id-leak DoS)
 */
const deleteSessionResultValidator = v.union(
  v.literal("deleted"),
  v.literal("not_found"),
  v.literal("forbidden"),
);

/**
 * Terminate a session if the calling identity matches what was bound
 * at create time. The HTTP DELETE handler calls this; the
 * spec-required follow-up is HTTP 404 (no such session) or 403
 * (mismatch). Pre-binding session rows (no `identitySubject` field)
 * fall back to the legacy "delete anything you know the id of"
 * behaviour for forward-compat; new rows always have the field and
 * always check.
 */
export const deleteSession = internalMutation({
  args: {
    sessionId: v.string(),
    callerIdentitySubject: v.union(v.string(), v.null()),
  },
  returns: deleteSessionResultValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (!row) return "not_found";
    // Forward-compat: rows from before identity binding shipped have
    // no `identitySubject` field. Treat as "owner unknown, allow
    // delete" so existing in-flight sessions during the deploy
    // window don't get stuck.
    if (row.identitySubject !== undefined) {
      if (row.identitySubject !== args.callerIdentitySubject) {
        return "forbidden";
      }
    }
    await ctx.db.delete("sessions", row._id);
    return "deleted";
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
