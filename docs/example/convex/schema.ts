import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  invoices: defineTable({
    status: v.union(v.literal("open"), v.literal("paid")),
    amount: v.number(),
  }),
});
