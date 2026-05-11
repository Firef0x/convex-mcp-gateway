import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const toolKindValidator = v.union(
  v.literal("query"),
  v.literal("mutation"),
  v.literal("action"),
);

export default defineSchema({
  tools: defineTable({
    name: v.string(),
    description: v.string(),
    kind: toolKindValidator,
    functionHandle: v.string(),
    inputSchema: v.any(),
  }).index("by_name", ["name"]),

  /**
   * Singleton row holding the function handle of the host-registered
   * authorizer. Empty until the host calls `gateway.setAuthorizer`.
   *
   * A row exists at most once. We don't use an index because lookups always
   * fetch the single row.
   */
  config: defineTable({
    authorizerHandle: v.optional(v.string()),
  }),
});
