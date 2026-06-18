import { ConvexError, v } from "convex/values";
import type { MutationCtx } from "./_generated/server.js";
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
  outputSchema: v.optional(v.any()),
  identityArg: v.optional(v.string()),
  metadata: v.optional(v.any()),
});

const resourceReturnValidator = v.object({
  _id: v.id("resources"),
  _creationTime: v.number(),
  uri: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  mimeType: v.optional(v.string()),
  metadata: v.optional(v.any()),
});

const resourceInputFields = {
  uri: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  mimeType: v.optional(v.string()),
  metadata: v.optional(v.any()),
};

const resourceInputValidator = v.object(resourceInputFields);

export const registerTool = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    kind: toolKindValidator,
    functionHandle: v.string(),
    inputSchema: v.any(),
    outputSchema: v.optional(v.any()),
    identityArg: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  returns: v.id("tools"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tools")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();

    if (existing) {
      // db.replace (not patch) so an upsert that omits an optional field
      // (e.g. `metadata`) clears any stale value rather than silently
      // preserving it. Stale `metadata` is load-bearing because it feeds
      // the host authorizer's scope/role decisions.
      await ctx.db.replace("tools", existing._id, args);
      return existing._id;
    }

    return await ctx.db.insert("tools", args);
  },
});

export const registerResource = mutation({
  args: resourceInputFields,
  returns: v.id("resources"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("resources")
      .withIndex("by_uri", (q) => q.eq("uri", args.uri))
      .unique();

    if (existing) {
      await ctx.db.replace("resources", existing._id, args);
      return existing._id;
    }

    return await ctx.db.insert("resources", args);
  },
});

export const unregisterResource = mutation({
  args: { uri: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("resources")
      .withIndex("by_uri", (q) => q.eq("uri", args.uri))
      .unique();
    if (!existing) return false;
    await ctx.db.delete("resources", existing._id);
    return true;
  },
});

export const listResources = query({
  args: {},
  returns: v.array(resourceReturnValidator),
  handler: async (ctx) => {
    return await ctx.db.query("resources").collect();
  },
});

export const getResource = query({
  args: { uri: v.string() },
  returns: v.union(resourceReturnValidator, v.null()),
  handler: async (ctx, args) => {
    const resource = await ctx.db
      .query("resources")
      .withIndex("by_uri", (q) => q.eq("uri", args.uri))
      .unique();
    return resource ?? null;
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

export const clearAllTools = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const tools = await ctx.db.query("tools").collect();
    for (const tool of tools) {
      await ctx.db.delete("tools", tool._id);
    }
    // Also drop the declarative fingerprint: otherwise a later
    // `initialize` would see a matching fingerprint and skip the sync,
    // leaving the registry permanently empty after a clear.
    const cfg = await ctx.db.query("config").unique();
    if (cfg && cfg.toolsFingerprint !== undefined) {
      await ctx.db.replace("config", cfg._id, {
        authServerUrl: cfg.authServerUrl,
        resourceUrl: cfg.resourceUrl,
        authorizerHandle: cfg.authorizerHandle,
        toolsFingerprint: undefined,
        resourcesFingerprint: cfg.resourcesFingerprint,
      });
    }
    return null;
  },
});

export const clearAllResources = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const resources = await ctx.db.query("resources").collect();
    for (const resource of resources) {
      await ctx.db.delete("resources", resource._id);
    }
    const cfg = await ctx.db.query("config").unique();
    if (cfg && cfg.resourcesFingerprint !== undefined) {
      await ctx.db.replace("config", cfg._id, {
        authServerUrl: cfg.authServerUrl,
        resourceUrl: cfg.resourceUrl,
        authorizerHandle: cfg.authorizerHandle,
        toolsFingerprint: cfg.toolsFingerprint,
        resourcesFingerprint: undefined,
      });
    }
    return null;
  },
});

export const replaceResources = mutation({
  args: {
    resources: v.array(resourceInputValidator),
    fingerprint: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const incomingUris = new Set(args.resources.map((r) => r.uri));
    if (incomingUris.size !== args.resources.length) {
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const r of args.resources) {
        if (seen.has(r.uri)) dupes.push(r.uri);
        seen.add(r.uri);
      }
      throw new ConvexError(
        `replaceResources received duplicate resource URIs: ${dupes.join(", ")}`,
      );
    }

    const existing = await ctx.db.query("resources").collect();
    for (const resource of existing) {
      if (!incomingUris.has(resource.uri)) {
        await ctx.db.delete("resources", resource._id);
      }
    }
    for (const incoming of args.resources) {
      const existingRow = await ctx.db
        .query("resources")
        .withIndex("by_uri", (q) => q.eq("uri", incoming.uri))
        .unique();
      if (existingRow) {
        await ctx.db.replace("resources", existingRow._id, incoming);
      } else {
        await ctx.db.insert("resources", incoming);
      }
    }

    const cfg = await ctx.db.query("config").unique();
    if (cfg) {
      await ctx.db.replace("config", cfg._id, {
        authServerUrl: cfg.authServerUrl,
        resourceUrl: cfg.resourceUrl,
        authorizerHandle: cfg.authorizerHandle,
        toolsFingerprint: cfg.toolsFingerprint,
        resourcesFingerprint: args.fingerprint,
      });
    } else {
      await ctx.db.insert("config", {
        resourcesFingerprint: args.fingerprint,
      });
    }
    return null;
  },
});

/**
 * Replace the entire registry atomically: any tool currently in the table
 * whose name is not in `tools` is deleted, and the named tools are upserted.
 * Runs in one Convex mutation, so concurrent `tools/list` and `tools/call`
 * never observe a partial swap. db.replace ensures omitted optional fields
 * (e.g. `metadata`) are cleared rather than silently kept from a prior
 * registration.
 */
export const replaceTools = mutation({
  args: {
    tools: v.array(
      v.object({
        name: v.string(),
        description: v.string(),
        kind: toolKindValidator,
        functionHandle: v.string(),
        inputSchema: v.any(),
        outputSchema: v.optional(v.any()),
        identityArg: v.optional(v.string()),
        metadata: v.optional(v.any()),
      }),
    ),
    /**
     * Fingerprint of the declarative source list, stored so a later
     * `initialize` can skip re-syncing when nothing changed. Omitted by
     * the imperative `register` path, which clears it so a subsequent
     * declarative sync always re-applies.
     */
    fingerprint: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Reject duplicate names in the input array. Without this check,
    // a typo registering two tools with the same name silently
    // last-wins (the second overwrites the first), defeating the
    // declarative "this is the full registry" semantics this
    // mutation exists to provide.
    const incomingNames = new Set(args.tools.map((t) => t.name));
    if (incomingNames.size !== args.tools.length) {
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const t of args.tools) {
        if (seen.has(t.name)) dupes.push(t.name);
        seen.add(t.name);
      }
      throw new ConvexError(
        `replaceTools received duplicate tool names: ${dupes.join(", ")}`,
      );
    }
    const existing = await ctx.db.query("tools").collect();
    for (const tool of existing) {
      if (!incomingNames.has(tool.name)) {
        await ctx.db.delete("tools", tool._id);
      }
    }
    for (const incoming of args.tools) {
      const existingRow = await ctx.db
        .query("tools")
        .withIndex("by_name", (q) => q.eq("name", incoming.name))
        .unique();
      if (existingRow) {
        await ctx.db.replace("tools", existingRow._id, incoming);
      } else {
        await ctx.db.insert("tools", incoming);
      }
    }
    // Persist (or clear) the declarative fingerprint without disturbing
    // the OAuth fields on the singleton config row. `args.fingerprint`
    // being undefined clears it, that's the imperative-register path
    // invalidating any prior declarative sync.
    const cfg = await ctx.db.query("config").unique();
    if (cfg) {
      await ctx.db.replace("config", cfg._id, {
        authServerUrl: cfg.authServerUrl,
        resourceUrl: cfg.resourceUrl,
        authorizerHandle: cfg.authorizerHandle,
        toolsFingerprint: args.fingerprint,
        resourcesFingerprint: cfg.resourcesFingerprint,
      });
    } else {
      await ctx.db.insert("config", { toolsFingerprint: args.fingerprint });
    }
    return null;
  },
});

/**
 * Fingerprint of the declarative tool catalog last synced via the
 * `tools` option, or `null` if never synced that way. The host compares
 * it against the current list's fingerprint to decide whether an
 * `initialize` needs to rewrite the registry.
 */
export const getToolsFingerprint = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const row = await ctx.db.query("config").unique();
    return row?.toolsFingerprint ?? null;
  },
});

export const getResourcesFingerprint = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const row = await ctx.db.query("config").unique();
    return row?.resourcesFingerprint ?? null;
  },
});

/**
 * Singleton-config helper. Each field follows the same rule:
 *   undefined → don't change
 *   null      → clear
 *   value     → set
 *
 * Reads the current row, applies the patch, and writes via db.replace so
 * field-clearing is reliable (db.patch treats undefined as "no change",
 * which silently keeps stale values).
 */
async function patchConfigRow(
  ctx: MutationCtx,
  patch: {
    authServerUrl?: string | null;
    resourceUrl?: string | null;
  },
): Promise<void> {
  const existing = await ctx.db.query("config").unique();
  function apply<T>(
    supplied: T | null | undefined,
    current: T | undefined,
  ): T | undefined {
    if (supplied === undefined) return current;
    if (supplied === null) return undefined;
    return supplied;
  }
  const next = {
    authServerUrl: apply(patch.authServerUrl, existing?.authServerUrl),
    resourceUrl: apply(patch.resourceUrl, existing?.resourceUrl),
    // Preserve the declarative tool fingerprint across OAuth-config
    // writes so changing OAuth settings doesn't force a registry re-sync.
    toolsFingerprint: existing?.toolsFingerprint,
    resourcesFingerprint: existing?.resourcesFingerprint,
  };
  if (existing) {
    await ctx.db.replace("config", existing._id, next);
  } else {
    await ctx.db.insert("config", next);
  }
}

/**
 * Set or clear the OAuth 2.1 protected-resource metadata: the
 * authorization-server URL and (optionally) the canonical resource URL
 * exposed via the protected-resource discovery endpoint.
 *
 * `set` semantics: each call fully specifies the OAuth config.
 *   - `authServerUrl: null` disables OAuth entirely (also clears `resourceUrl`).
 *   - Omitted `resourceUrl` resets to "auto-derive from request".
 *
 * Both URLs are validated with `new URL(...)` at write time so a typo
 * fails loudly here instead of crashing the 401 path much later.
 */
export const setOAuthConfig = mutation({
  args: {
    authServerUrl: v.union(v.string(), v.null()),
    resourceUrl: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.authServerUrl !== null) {
      assertAbsoluteUrl("authServerUrl", args.authServerUrl);
    }
    if (args.resourceUrl !== undefined && args.resourceUrl !== null) {
      assertAbsoluteUrl("resourceUrl", args.resourceUrl);
    }

    if (args.authServerUrl === null) {
      // Clearing the auth server disables OAuth; resourceUrl alone is
      // meaningless and would surface stale config to the discovery
      // endpoint, so clear both.
      await patchConfigRow(ctx, {
        authServerUrl: null,
        resourceUrl: null,
      });
      return null;
    }

    await patchConfigRow(ctx, {
      authServerUrl: args.authServerUrl,
      // Omitted `resourceUrl` resets to auto-derive (cleared); explicit
      // null also clears; explicit value sets.
      resourceUrl:
        args.resourceUrl === undefined || args.resourceUrl === null
          ? null
          : args.resourceUrl,
    });
    return null;
  },
});

function assertAbsoluteUrl(field: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConvexError(
      `${field} must be a valid absolute URL, got: ${value}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConvexError(
      `${field} must use http or https, got: ${parsed.protocol}`,
    );
  }
}

export const getOAuthConfig = query({
  args: {},
  returns: v.union(
    v.object({
      authServerUrl: v.string(),
      resourceUrl: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const row = await ctx.db.query("config").unique();
    if (!row?.authServerUrl) return null;
    return {
      authServerUrl: row.authServerUrl,
      resourceUrl: row.resourceUrl ?? null,
    };
  },
});
