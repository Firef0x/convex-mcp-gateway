import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const seed = mutation({
  args: {},
  returns: v.id("invoices"),
  handler: async (ctx) => {
    const existing = await ctx.db.query("invoices").first();
    if (existing) return existing._id;
    return await ctx.db.insert("invoices", { status: "open", amount: 42 });
  },
});

export const list = query({
  args: {
    status: v.optional(v.union(v.literal("open"), v.literal("paid"))),
  },
  handler: async (ctx, args) => {
    // Tools invoked via the MCP gateway run inside the component's dispatch
    // action; `ctx.auth` is NOT propagated across the component boundary.
    // `getUserIdentity()` returns null here even when the gateway's
    // authorize callback saw a valid JWT. If a tool needs the caller's
    // identity, pass relevant claims as explicit args from the authorize
    // callback. This example returns `caller: null` as the documented
    // behaviour.
    const identity = await ctx.auth.getUserIdentity();
    const invoices = await ctx.db.query("invoices").collect();
    const filtered = args.status
      ? invoices.filter((invoice) => invoice.status === args.status)
      : invoices;
    return { caller: identity?.subject ?? null, invoices: filtered };
  },
});

export const markPaid = mutation({
  args: { id: v.id("invoices") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("invoices", args.id, { status: "paid" });
    return null;
  },
});

/**
 * A public read-only summary that does not require authentication. The
 * example's authorize callback opts it out of authentication via
 * `metadata: { public: true }` in convex/mcp.ts.
 */
export const summary = query({
  args: {},
  returns: v.object({ total: v.number() }),
  handler: async (ctx) => {
    const invoices = await ctx.db.query("invoices").collect();
    return { total: invoices.length };
  },
});

/**
 * Test-only fixture: always throws a plain Error. The gateway treats
 * this as an unexpected internal failure — the wire response carries
 * a generic "Tool execution failed" message, while the audit row
 * keeps the verbose "boom" string for operator debugging.
 */
export const throwsAlways = query({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new Error("boom — should not reach the wire");
  },
});

/**
 * Test-only fixture: throws a `ConvexError`, the deliberate
 * user-facing error channel. The gateway forwards the message
 * verbatim to the wire (so the LLM can reason about the error) AND
 * to the audit row.
 */
export const throwsConvexError = query({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new ConvexError("Invoice not found");
  },
});

/**
 * Test-only fixture: accepts any payload under `args.payload`, returns
 * null. Lets redaction tests pass arbitrarily-shaped args without
 * tripping Convex's per-function arg validator.
 */
export const noopAny = query({
  args: { payload: v.optional(v.any()) },
  returns: v.null(),
  handler: async () => null,
});
