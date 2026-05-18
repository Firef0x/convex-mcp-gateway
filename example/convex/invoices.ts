import { v } from "convex/values";
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
 * Test-only fixture: always throws. Used by mcp.test.ts to verify that
 * the gateway returns tool execution failures as MCP `result.isError:
 * true` (not as a JSON-RPC error), and that the audit row captures
 * `outcome: "error"` with the message. Not registered by
 * `registerDefaults`; tests insert it via `replaceTools` directly.
 */
export const throwsAlways = query({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new Error("boom");
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
