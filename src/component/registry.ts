import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { toolKindValidator } from "./schema.js";

const toolReturnValidator = v.object({
  _id: v.id("tools"),
  _creationTime: v.number(),
  name: v.string(),
  description: v.string(),
  kind: toolKindValidator,
  functionHandle: v.string(),
  inputSchema: v.any(),
});

export const registerTool = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    kind: toolKindValidator,
    functionHandle: v.string(),
    inputSchema: v.any(),
  },
  returns: v.id("tools"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tools")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();

    if (existing) {
      await ctx.db.patch("tools", existing._id, args);
      return existing._id;
    }

    return await ctx.db.insert("tools", args);
  },
});

export const unregisterTool = mutation({
  args: { name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tools")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (!existing) return false;
    await ctx.db.delete("tools", existing._id);
    return true;
  },
});

export const listTools = query({
  args: {},
  returns: v.array(toolReturnValidator),
  handler: async (ctx) => {
    return await ctx.db.query("tools").collect();
  },
});

export const getTool = query({
  args: { name: v.string() },
  returns: v.union(toolReturnValidator, v.null()),
  handler: async (ctx, args) => {
    const tool = await ctx.db
      .query("tools")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    return tool ?? null;
  },
});

export const clearAll = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const tools = await ctx.db.query("tools").collect();
    for (const tool of tools) {
      await ctx.db.delete("tools", tool._id);
    }
    return null;
  },
});

/**
 * Register the host-side authorizer that decides per `tools/call` whether
 * the request may proceed. The authorizer is a Convex query handle (created
 * via `createFunctionHandle`) with the standardized args/returns contract
 * documented in the package's `shared` module.
 *
 * Calling this with `null` removes the registered authorizer, after which
 * every `tools/call` is rejected with `-32011 No authorizer configured`.
 * Deny-by-default: a fresh deployment must opt in to a policy.
 */
export const setAuthorizer = mutation({
  args: { authorizerHandle: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("config").unique();
    const handleOrUndefined =
      args.authorizerHandle === null ? undefined : args.authorizerHandle;
    if (existing) {
      await ctx.db.patch("config", existing._id, {
        authorizerHandle: handleOrUndefined,
      });
    } else {
      await ctx.db.insert("config", { authorizerHandle: handleOrUndefined });
    }
    return null;
  },
});

export const getAuthorizer = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const row = await ctx.db.query("config").unique();
    return row?.authorizerHandle ?? null;
  },
});
