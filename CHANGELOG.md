# Changelog

## Unreleased

### Breaking changes

- **Authorize is now a JS callback, not a registered Convex query.** The
  host passes an `authorize` function to `gateway.handleMcpRequest(ctx,
  request, { authorize })`; there is no `gateway.setAuthorizer`, no
  `mcpAuthorizerArgs` / `mcpAuthorizerReturns` validator, and no
  `internal*` query to register. Reason: Convex does not propagate
  `ctx.auth` into component code, so the policy decision must run
  inside the host's `httpAction` where `ctx.auth.getUserIdentity()`
  works. `McpAuthorizerHandler` is now a TypeScript-only signature.
- **Component no longer mounts `/mcp/` itself.** The host owns the
  HTTP route and calls `gateway.handleMcpRequest` from its own
  `httpAction`. The `app.use(mcpGateway, { httpPrefix: "/mcp" })`
  option is removed — `app.use(mcpGateway)` is enough. The OAuth
  discovery handler also moves to the host-mounted route, served via
  `gateway.serveProtectedResourceMetadata`.
- **`dispatch.callTool` and `dispatch.listVisibleTools` are gone.** The
  component now exposes only `dispatch.runTool({ name, args,
  auditIdentitySubject })` (post-authorization tool execution + audit
  write) and `dispatch.recordAuthDenial({...})` (audit-only hook the
  host calls when the authorize callback denies). The catalog filter
  for `tools/list` runs entirely host-side, calling the authorize
  callback per registered tool in parallel.
- The component's `config.authorizerHandle` field is preserved as a
  legacy optional for migration tolerance; it is dropped on the next
  `setOAuthConfig` call.

### Roadmap change

- Dropped the planned "Bridge-AS" (built-in OAuth authorization server)
  from the roadmap. The official position is **bring your own IdP**.
  Reasoning: building DCR + PKCE + token issuance + key rotation
  duplicates what every modern IdP does and would couple two
  security-critical surfaces into one component. The capability-token
  use case from that bullet survives as a much smaller standalone
  helper (`gateway.signCapabilityToken`) planned for Phase 2.

### Added

- **MCP 2025-06-18 Streamable HTTP transport.** The `/mcp/` endpoint
  now speaks Streamable HTTP per RFC: `POST` for client messages, `GET`
  returns `405 Method Not Allowed` (we don't push notifications yet),
  `DELETE` terminates a session. Sessions are mandatory after
  `initialize`: the server issues a 128-bit hex `Mcp-Session-Id` in
  the response header and rejects subsequent requests without it
  (`400`) or with a stale id (`404`). Content negotiation lets clients
  choose between `application/json` and `text/event-stream` responses;
  SSE responses are single-frame today, ready for progress
  notifications without a protocol change.
- `gateway.pruneSessions(ctx, idleMs)` for time-based session cleanup
  via cron.
- `gateway.pruneAuditEntries(ctx, retentionMs)` plus the underlying
  `audit.pruneOlderThan` mutation, replacing the placeholder retention
  recipe in the docs with a real public API.
- `metadata.auditArgs` now accepts `{ redact: ["field1", ...] }` for
  shallow field-level redaction (top-level keys only). The previous
  `auditArgs: false` (drop everything) and default (store verbatim)
  modes still work.
- `gateway.register(ctx, tools, { replace: true })` atomically mirrors
  the registry to the incoming list. Stale tools are removed in the
  same Convex mutation, no partial swaps visible to concurrent
  `tools/list` callers.
- Audit log: per-`tools/call` row with outcome (`allowed` / `denied` /
  `error`), identity subject, duration, and error code/message.
  Filtered reads via
  `gateway.listAuditEntries({ toolName?, outcome?, limit? })`.
- Per-tool `metadata.auditArgs: false` opts out of arg storage in the
  audit log (for tools whose argument schema can carry secrets/PII).
- Scope-aware `tools/list`: the catalog visible to a caller equals the
  set of tools they could actually invoke. The same authorize callback
  is invoked with `mode: "list"` for filtering and `mode: "call"` for
  dispatch.
- Per-tool free-form `metadata` (typically `{ scopes, roles, public }`)
  is stored on the tool row and surfaced to the authorize callback as
  `toolMetadata`. The component itself never inspects it.
- OAuth 2.1 protected-resource discovery: configure via
  `gateway.setOAuthConfig({ authServerUrl, resourceUrl? })`; mount the
  RFC 9728 metadata handler on the host's `httpRouter` via
  `gateway.serveProtectedResourceMetadata`. 401 responses on
  `tools/call` carry `WWW-Authenticate: Bearer resource_metadata="..."`
  per RFC 6750.
- Documentation site under `docs/`: getting-started, architecture (with
  editorial-styled SVG sequence/ER diagrams), authorization, OAuth,
  audit log, testing.
- `SECURITY.md`, GitHub issue/PR templates.

### Changed

- Audit-write semantics: writes happen *after* the tool handler returns,
  outside the handler's try/catch, and through `safeRecordAudit` which
  logs and swallows its own failures. A failing audit insert can no
  longer flip a successful tool result into an error response.
- Authorize-callback throws are caught and surfaced as `-32603`
  JSON-RPC errors with an audit `error` entry, instead of HTTP 500s
  without an envelope.
- Unknown-tool calls are no longer audited, to prevent unbounded audit
  table growth via unauthenticated drive-by spam.
- `setOAuthConfig` validates both URLs as absolute http/https URLs at
  write time. An invalid value throws `ConvexError` immediately rather
  than crashing the 401 path much later.
- `tools/list` is deny-by-default: without an `authorize` callback the
  HTTP handler cannot be constructed (TypeScript-enforced), so an
  unconfigured deployment cannot serve the catalog at all.
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
- JSON-RPC envelope for `initialize` / `tools/list` / `tools/call`.
- CI workflow runs build + typecheck + test + lint on every PR. Release
  workflow publishes on `v*` tags.
