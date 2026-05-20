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
    /**
     * Optional MCP `outputSchema` (JSON Schema). When set, tools/list
     * advertises it and tools/call wraps results in `structuredContent`
     * alongside the text-JSON `content`. Pre-existing rows without the
     * column stay valid courtesy of `v.optional`.
     */
    outputSchema: v.optional(v.any()),
    /**
     * Name of the tool-function argument the gateway fills with the
     * resolved caller identity before dispatch. Excluded from the
     * advertised inputSchema and stripped from caller args. Optional;
     * unset means the tool takes no injected identity. Pre-existing rows
     * without the column stay valid courtesy of `v.optional`.
     */
    identityArg: v.optional(v.string()),
    metadata: v.optional(v.any()),
  }).index("by_name", ["name"]),

  /**
   * Singleton row holding the OAuth 2.1 protected-resource metadata.
   * Empty until the host calls `gateway.setOAuthConfig`.
   *
   * Authorization itself is **not** stored here: it lives in the host
   * as a regular JS callback passed to `gateway.handleMcpRequest`,
   * because Convex doesn't propagate `ctx.auth` into component code.
   *
   * A row exists at most once. We don't use an index because lookups
   * always fetch the single row.
   */
  config: defineTable({
    /**
     * Issuer URL of the OAuth 2.1 authorization server that hands out
     * Bearer tokens for this MCP gateway. Surfaced via
     * `/.well-known/oauth-protected-resource` so MCP clients can discover
     * the AS automatically.
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
    /**
     * Legacy field from the pre-callback authorizer model. Tolerated
     * here so old deployments deploy cleanly; the new `setOAuthConfig`
     * uses `db.replace` and silently drops it. Will be removed in a
     * future release.
     */
    authorizerHandle: v.optional(v.string()),
  }),

  /**
   * MCP Streamable HTTP sessions. Created on `initialize` if the client
   * negotiated session-aware transport, looked up on every subsequent
   * request, and deleted on explicit `DELETE` or after a server-side
   * timeout (managed by the host via a cron, not the component).
   *
   * `sessionId` is a 128-bit cryptographically random hex string,
   * matching the MCP 2025-06-18 requirement that it be globally unique
   * and consist of visible ASCII characters only.
   *
   * `identitySubject` records the JWT `sub` claim that initialised the
   * session (or `null` for anonymous initialisation). It is set at
   * create time and never changes; `DELETE /mcp/` requires the same
   * subject to authorise teardown, so a leaked session id alone
   * cannot DoS an authenticated user's session. Optional for
   * forward-compat with pre-binding session rows: such rows skip the
   * identity check on DELETE.
   */
  sessions: defineTable({
    sessionId: v.string(),
    protocolVersion: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    identitySubject: v.optional(v.union(v.string(), v.null())),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_lastSeenAt", ["lastSeenAt"]),

  /**
   * One row per `tools/call` dispatch. Captures who called what, the
   * outcome, and how long the underlying function ran. `identitySubject`
   * is supplied by the host (resolved from `ctx.auth.getUserIdentity()`)
   * and forwarded into `dispatch.runTool`; the component never reads
   * identity directly. Arg storage respects `metadata.auditArgs`: full
   * record by default, `null` when set to `false`, top-level keys
   * replaced with `"[redacted]"` when set to `{ redact: [...] }`.
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
