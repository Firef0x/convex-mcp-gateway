import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const toolKindValidator = v.union(
  v.literal("query"),
  v.literal("mutation"),
  v.literal("action"),
);

export const auditOutcomeValidator = v.union(
  v.literal("allowed"),
  v.literal("denied"),
  v.literal("error"),
);

export default defineSchema({
  tools: defineTable({
    name: v.string(),
    description: v.string(),
    kind: toolKindValidator,
    functionHandle: v.string(),
    inputSchema: v.any(),
    metadata: v.optional(v.any()),
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
    /**
     * Issuer URL of the OAuth 2.1 authorization server that hands out
     * Bearer tokens for this MCP gateway. Surfaced via
     * `/.well-known/oauth-protected-resource` so MCP clients can discover
     * the AS automatically. Empty until the host calls
     * `gateway.setOAuthConfig`.
     */
    authServerUrl: v.optional(v.string()),
    /**
     * Canonical resource URL for this MCP server, returned in the
     * protected-resource metadata. Optional: when unset, the discovery
     * endpoint derives it from the inbound request URL (without the
     * `/.well-known/...` suffix), which is correct for single-tenant
     * deployments.
     */
    resourceUrl: v.optional(v.string()),
  }),

  /**
   * One row per `tools/call` dispatch. Captures who called what, the
   * authorizer's verdict, and how long the underlying function ran. Args
   * and the identity subject are stored verbatim; sensitive payloads must
   * be filtered out by the host (e.g. by stripping fields before they
   * reach the tool, or by wrapping `dispatch.callTool` in a redacting
   * middleware in a future iteration).
   */
  audit: defineTable({
    toolName: v.string(),
    toolKind: toolKindValidator,
    args: v.any(),
    outcome: auditOutcomeValidator,
    identitySubject: v.union(v.string(), v.null()),
    durationMs: v.number(),
    errorCode: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_toolName", ["toolName"])
    .index("by_outcome", ["outcome"]),
});
