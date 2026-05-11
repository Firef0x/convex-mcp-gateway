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
    // Tools exposed via the MCP gateway can rely on Convex's auth pipeline:
    // the gateway propagates the JWT-validated identity into this handler,
    // so `ctx.auth.getUserIdentity()` returns the same identity the gateway
    // already authorized against the tool's scope/role manifest.
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
 * A public read-only summary that does not require authentication. Used in
 * the example to demonstrate `requireAuth: false`.
 */
export const summary = query({
  args: {},
  returns: v.object({ total: v.number() }),
  handler: async (ctx) => {
    const invoices = await ctx.db.query("invoices").collect();
    return { total: invoices.length };
  },
});
