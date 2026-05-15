# Changelog

## Unreleased

### Added

- `gateway.register(ctx, tools, { replace: true })` atomically mirrors
  the registry to the incoming list. Stale tools are removed in the
  same Convex mutation, no partial swaps visible to concurrent
  `tools/list` callers.
- Audit log: per-`tools/call` row with outcome (`allowed` / `denied` /
  `error`), identity subject, duration, and error code/message.
  Filtered reads via `gateway.listAuditEntries({ toolName?, outcome?, limit? })`.
- Per-tool `metadata.auditArgs: false` opts out of arg storage in the
  audit log (for tools whose argument schema can carry secrets/PII).
- Scope-aware `tools/list`: the catalog visible to a caller equals the
  set of tools they could actually invoke. The same authorizer is
  invoked with `mode: "list"` for filtering and `mode: "call"` for
  dispatch.
- Per-tool free-form `metadata` (typically `{ scopes, roles, public }`)
  is stored on the tool row and surfaced to the authorizer as
  `toolMetadata`. The component itself never inspects it.
- OAuth 2.1 protected-resource discovery: configure via
  `gateway.setOAuthConfig({ authServerUrl, resourceUrl? })`; mount the
  RFC 9728 metadata handler on the host's `httpRouter` via
  `gateway.serveProtectedResourceMetadata`. 401 responses on
  `tools/call` carry `WWW-Authenticate: Bearer resource_metadata="..."`
  per RFC 6750.
- `dispatch.listVisibleTools` action exposes the same scope-aware
  catalog the HTTP route serves, for hosts that need it from their own
  code.
- Documentation site under `docs/`: getting-started, architecture (with
  Mermaid sequence diagrams), authorization, OAuth, audit log,
  testing.
- `SECURITY.md`, GitHub issue/PR templates.

### Changed

- `mcpAuthorizerArgs` gains `mode` (`"list" | "call"`) and
  `toolMetadata` (free-form). Existing host authorizers that
  destructure `{ toolName, toolKind, args }` keep working unchanged;
  reading the new fields is opt-in.
- `dispatch.callTool` audit-write semantics: writes happen *after* the
  tool handler returns, outside the handler's try/catch, and through
  `safeRecordAudit` which logs and swallows its own failures. A failing
  audit insert can no longer flip a successful tool result into an
  error response. (Critical fix from the pre-release code review.)
- Authorizer throws are caught and surfaced as `-32603` JSON-RPC errors
  with an audit `error` entry, instead of HTTP 500s without an envelope.
- Unknown-tool calls are no longer audited, to prevent unbounded audit
  table growth via unauthenticated drive-by spam.
- `setOAuthConfig` validates both URLs as absolute http/https URLs at
  write time. An invalid value throws `ConvexError` immediately rather
  than crashing the 401 path much later.
- `tools/list` is now deny-by-default: no authorizer configured returns
  an empty catalog (matching the `tools/call` behavior).
- `replaceTools` and `registerTool` use `db.replace` instead of
  `db.patch` so omitted optional fields (notably `metadata`) are
  cleared on re-register, instead of silently surviving.
- `initialize` reads `params.protocolVersion` from the JSON-RPC body
  per MCP 2025-06-18 lifecycle semantics, with negotiation fallback to
  the server's latest supported version.

### Initial release base

- Convex component layout (rate-limiter convention), `McpGateway` client
  with `defineMcpQuery` / `defineMcpMutation` / `defineMcpAction`
  helpers, end-to-end-typed args validators against
  `FunctionArgs<typeof fn>`.
- `/mcp/` HTTP route owned by the component, JSON-RPC envelope for
  `initialize` / `tools/list` / `tools/call`.
- Generic per-request authorizer: host registers a single
  `internalQuery` via `gateway.setAuthorizer`; deny-by-default until
  configured.
- CI workflow runs build + typecheck + test + lint on every PR. Release
  workflow publishes on `v*` tags.
