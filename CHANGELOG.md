# Changelog

## [0.7.0](https://github.com/Firef0x/convex-mcp-gateway/compare/v0.6.1...v0.7.0) (2026-08-12)


### Features

* add initialize instructions option ([ff1fc03](https://github.com/Firef0x/convex-mcp-gateway/commit/ff1fc03e64764e71c4a382774310a306eea99123))
* Add MCP resource support ([1fcb5fd](https://github.com/Firef0x/convex-mcp-gateway/commit/1fcb5fda9ae5463d3dde07ae9935d8bdab8d6139))
* add requireAuth to challenge anonymous requests with 401 ([d5e0af4](https://github.com/Firef0x/convex-mcp-gateway/commit/d5e0af4fc52b2bac4f8494adf6334244ec9e953b))
* apply 2026-05-18 code review fixes (security, MCP spec, scale) ([9473a03](https://github.com/Firef0x/convex-mcp-gateway/commit/9473a0302013a3d2370aa7b62a97f6bae3f8311f))
* audit pruning API, field-level redaction, authorizer-validator coverage ([906bc47](https://github.com/Firef0x/convex-mcp-gateway/commit/906bc4786144d1b2f37b1f906b6bd10e4e1eebbb))
* **bridge:** add `overrides` to serveAuthorizationServerMetadata ([6f1c4e2](https://github.com/Firef0x/convex-mcp-gateway/commit/6f1c4e203f65b56b17dedcca7d3e286f75ad6c62))
* **component:** audit log, scope-aware tools/list, OAuth discovery, replace mode ([90a66dc](https://github.com/Firef0x/convex-mcp-gateway/commit/90a66dcd018a7d41bd69de6d2bf3e78609955485))
* CORS support for browser MCP clients (claude.ai, web inspectors) ([bf694bc](https://github.com/Firef0x/convex-mcp-gateway/commit/bf694bcd9f212bdc328f83fba5887bff5647f248))
* declarative tools option with change-detected registry sync ([0ee32dd](https://github.com/Firef0x/convex-mcp-gateway/commit/0ee32ddca6095343141188f4f7f8308ed027352a))
* harden MCP OAuth and multi-round trips ([4075ce6](https://github.com/Firef0x/convex-mcp-gateway/commit/4075ce6b447252960f1934132fee107c792ea30d))
* inject caller identity into tools via identityArg ([7273255](https://github.com/Firef0x/convex-mcp-gateway/commit/72732551c8e5f09cff00ec5104d6ede47a071228))
* opt-in OIDC bridge mode (DCR + AS metadata + tokenValidator) ([b8c625b](https://github.com/Firef0x/convex-mcp-gateway/commit/b8c625bbbe78b9b6b1c49251d51140059e2c4ca0))
* optional `returns:` validator → outputSchema + structuredContent ([c58cc20](https://github.com/Firef0x/convex-mcp-gateway/commit/c58cc203845dfccf46e1be71141a43812844bb38))
* redact sensitive tool error messages from audit logs ([10d4061](https://github.com/Firef0x/convex-mcp-gateway/commit/10d4061fd7692d1cff95b2ec5dcdbcced50a8556))
* **security:** bind session DELETE to creator's identity (BREAKING) ([851fbe9](https://github.com/Firef0x/convex-mcp-gateway/commit/851fbe97b991dfef697b337d061c04bbaad8007a))
* **security:** sanitize wire error messages; ConvexError pass-through ([516229f](https://github.com/Firef0x/convex-mcp-gateway/commit/516229f7809aaeeaada3c5ff6a16b3bfd833b28c))
* support MCP 2026 stateless transport ([2b23232](https://github.com/Firef0x/convex-mcp-gateway/commit/2b232323109a5f55c36833848e11151143871106))
* **transport:** MCP 2025-06-18 Streamable HTTP with sessions and SSE ([3a13ef1](https://github.com/Firef0x/convex-mcp-gateway/commit/3a13ef1fa11fc9e9dd6cf404bb1f5ea048ed7565))


### Bug Fixes

* **ci:** allow esbuild postinstall under pnpm 11 ([a3cec35](https://github.com/Firef0x/convex-mcp-gateway/commit/a3cec3503b8bae2fafd955abd76c09f5443f5d8b))
* **component:** revert host-callable functions from internal* back to public ([c55b524](https://github.com/Firef0x/convex-mcp-gateway/commit/c55b524500e1d2bf54306261f56a0074e8447d18))
* defer MRTR until pre-call hooks are available ([e1910b4](https://github.com/Firef0x/convex-mcp-gateway/commit/e1910b480f9bc96a74d58957450a2afbf0e9faf7))
* don't 500 when ctx.auth.getUserIdentity throws on iss/aud mismatch ([bc3d76e](https://github.com/Firef0x/convex-mcp-gateway/commit/bc3d76e03ba4433b5e214ca3b36b1021ef6eb06d))
* don't audit anonymous resource denials (audit-table DoS) ([476dc14](https://github.com/Firef0x/convex-mcp-gateway/commit/476dc14fb3ebab76bd424f40f7d171a94be0606b))
* harden tool protocol metadata passthrough ([#16](https://github.com/Firef0x/convex-mcp-gateway/issues/16)) ([c5c6bbf](https://github.com/Firef0x/convex-mcp-gateway/commit/c5c6bbf4d282a8bcf991556dd1833caa18d31e98))
* keep accidental exception text off the MCP wire ([407fad2](https://github.com/Firef0x/convex-mcp-gateway/commit/407fad22c261fb65a91a3ed3fbaaaf3377a22942))
* **package:** correct author email in package.json ([0af24ac](https://github.com/Firef0x/convex-mcp-gateway/commit/0af24ac36be5fdaf17be94dbac7339365afbeca5))
* preserve tool protocol metadata ([#10](https://github.com/Firef0x/convex-mcp-gateway/issues/10)) ([6b1bde8](https://github.com/Firef0x/convex-mcp-gateway/commit/6b1bde812c041253109d87157a574792e939a21c))
* validate MCP tool names at registration (reject dotted names) ([3c10349](https://github.com/Firef0x/convex-mcp-gateway/commit/3c1034960dccada2009bda55b8513c15697380d8))

## [0.6.1](https://github.com/tfohlmeister/convex-mcp-gateway/compare/v0.6.0...v0.6.1) (2026-08-03)


### Bug Fixes

* harden tool protocol metadata passthrough ([#16](https://github.com/tfohlmeister/convex-mcp-gateway/issues/16)) ([c5c6bbf](https://github.com/tfohlmeister/convex-mcp-gateway/commit/c5c6bbf4d282a8bcf991556dd1833caa18d31e98))
* preserve tool protocol metadata ([#10](https://github.com/tfohlmeister/convex-mcp-gateway/issues/10)) ([6b1bde8](https://github.com/tfohlmeister/convex-mcp-gateway/commit/6b1bde812c041253109d87157a574792e939a21c))

## [0.6.0](https://github.com/tfohlmeister/convex-mcp-gateway/compare/v0.5.0...v0.6.0) (2026-07-28)


### Features

* redact sensitive tool error messages from audit logs ([10d4061](https://github.com/tfohlmeister/convex-mcp-gateway/commit/10d4061fd7692d1cff95b2ec5dcdbcced50a8556))


### Bug Fixes

* keep accidental exception text off the MCP wire ([407fad2](https://github.com/tfohlmeister/convex-mcp-gateway/commit/407fad22c261fb65a91a3ed3fbaaaf3377a22942))

## 0.5.0 (2026-06-24)

### Added

- **MCP resources.** First-class resource support alongside tools, with the
  same deny-by-default, host-owns-authorization model.
  - `defineMcpResource` (concrete `uri`) and `defineMcpResourceTemplate`
    (RFC 6570 `uriTemplate`) serve `resources/list`, `resources/read`, and
    `resources/templates/list`; raw `McpResourceProvider` objects stay
    supported as an escape hatch.
  - Resources and templates are persisted in the component registry and
    reconciled on `initialize` via change-detected fingerprints (mirroring
    the `tools` catalog), with imperative `registerResource(s)` /
    `registerResourceTemplate(s)` / `unregister*` / `clear*` APIs.
  - One central `authorizeResource` hook gates list / read / templates-list;
    resource reads require an authenticated caller.
  - Opt-in `auditResources` records `list` / `read` / `templates_list`
    operations (URI, operation, identity, outcome, duration) — never the
    resource contents.
  - Templates resolve `resources/read` server-side (concrete resources take
    precedence), with level-1 `{var}` matching validated at declaration time.
  - Opt-in resource-subscription capability: per-session, owner-bound
    `resources/subscribe` / `resources/unsubscribe` state plus notification
    builders, for hosts that front the gateway with a push-capable transport.
  - Resource/template types gain `title`, `annotations`, and `size`; provider
    output is runtime-validated and projected so malformed or stray data
    never reaches the client.
  - New `docs/resources.md` and a runnable, tested example under
    `example`.
- **`initializeInstructions` option.** Pass `initializeInstructions` to
  `handleMcpRequest` to populate the MCP `initialize` result's `instructions`
  field: server-level guidance the client can hand the LLM without touching
  individual tool descriptions. Omitted from the response when unset, so the
  default `initialize` shape is unchanged.

## 0.4.0 (2026-05-21)

### Added

- **Declarative `tools` option on `handleMcpRequest`.** Pass the tool
  catalog (the same `defineMcp*` array `register` takes) directly to
  `gateway.handleMcpRequest({ authorize, tools })` and the gateway
  reconciles the component registry on `initialize`, so editing the list
  in code takes effect on the next client connect with no separate
  registration mutation to run by hand. The reconcile is
  **change-detected**: the list is fingerprinted and the registry is only
  rewritten when something actually changed, so the steady-state cost per
  connection is a single cheap lookup, not a rewrite. The imperative
  `gateway.register(...)` / `registerTool(...)` path stays for
  dynamic/plugin catalogs. New exported type `McpToolRegistration` (and
  `McpToolFunctionReference`) to annotate an exported `tools` array
  against a Convex codegen circular-type error.

## 0.3.0 (2026-05-21)

### Added

- **`requireAuth` option for all-private servers.** New opt-in boolean
  on `HandleMcpRequestOptions`. When set, any anonymous POST (including
  `initialize` / `tools/list`) is answered with `401` +
  `WWW-Authenticate` instead of being let through. This is the trigger
  browser MCP clients (claude.ai) need to begin the OAuth flow: with no
  `public` tools, the default 200-empty `tools/list` makes such clients
  conclude "connected, no tools" and they never prompt a login. The
  header reuses the same RFC 6750 / RFC 9728 construction as the
  `tools/call` denial path and needs `setOAuthConfig`; without OAuth
  config the gate still returns 401 but omits the header and warns once.
  Default is `false`, mixed public/private servers keep the 200 +
  filtered-catalog behaviour unchanged. Applies to POST only (`GET`
  still 405s, `DELETE` stays identity-bound, `OPTIONS` preflight is
  untouched). Caller identity is now resolved once per request and
  threaded through the gate, audit, authorize input, and session
  binding, removing a duplicate userinfo round-trip on re-initialize.

## 0.2.0 (2026-05-20)

### Added

- **Caller-identity injection (`identityArg`).** A dispatched tool runs
  inside the component, where `ctx.auth` is unavailable. Tools can now
  opt in to receiving the authenticated caller: declare an argument with
  the new `mcpCallerValidator` (shape `{ subject, claims? }`) and name it
  in `identityArg`. The gateway fills that argument server-side with the
  identity resolved at the request boundary, removes it from the
  advertised `inputSchema` (clients never see it), strips any
  client-supplied value (no spoofing), and rejects calls with no resolved
  caller as `-32001 Unauthorized` (enforced both host-side and inside the
  component's `runTool`). The injected argument is stripped before the
  audit write, so the caller and its claims never reach the audit log;
  the subject is still recorded in the audit row's `identitySubject`
  column. New exports: `mcpCallerValidator`, `McpCaller`.

## 0.1.0 (2026-05-19) - initial version

First public version of `convex-mcp-gateway`. Implements
the MCP server side of the Convex+MCP integration: register Convex
functions as MCP tools, mount one `/mcp/` route in your host, plug
your existing OAuth / JWT issuer in via a callback. No prior release
to break, so the entries below describe the full surface area.

### What's in the package

- **Tool registration.** `defineMcpQuery` / `defineMcpMutation` /
  `defineMcpAction` declare a Convex function as an MCP tool with
  end-to-end-typed `args` and (optional) `returns` validators,
  drift between the registered Convex function and the tool
  descriptor surfaces as a `_typeMismatch` at compile time, never at
  runtime.
- **`McpGateway` client.** Host-side handle exposing `register`,
  `registerTool`, `unregisterTool`, `listTools`, `clearTools`,
  `setOAuthConfig`, `handleMcpRequest`, `serveProtectedResourceMetadata`,
  `serveAuthorizationServerMetadata`, `handleClientRegistration`,
  `pruneSessions`, `pruneAuditEntries`, `listAuditEntries`.
- **MCP 2025-06-18 Streamable HTTP transport.** Sessions (server-
  issued 128-bit hex `Mcp-Session-Id`), `Accept` header negotiation
  with both `application/json` and `text/event-stream`,
  `MCP-Protocol-Version` validation, single-frame SSE responses
  ready for future progress notifications, identity-bound `DELETE`,
  spec-compliant rejection of batched requests and missing-method
  envelopes (HTTP 400). Tool execution failures surface as
  `result.isError: true` (with `content`) so the model can react;
  `-32602 Unknown tool` stays a JSON-RPC error per spec.
- **Authorization is a JS callback** the host passes to
  `gateway.handleMcpRequest({ authorize })`, not a registered Convex
  query. Reason: Convex doesn't propagate `ctx.auth` into component
  code, so the policy decision must run host-side where
  `ctx.auth.getUserIdentity()` works. The same callback gates
  `tools/call` (`mode: "call"`) and filters `tools/list`
  (`mode: "list"`). Identity is resolved once at the request
  boundary and passed in as `args.identity`.
- **OAuth 2.1 protected-resource discovery (RFC 9728).** Configure
  with `gateway.setOAuthConfig({ authServerUrl, resourceUrl? })`;
  mount `serveProtectedResourceMetadata` at the well-known path.
  401 responses on `tools/call` carry
  `WWW-Authenticate: Bearer resource_metadata="..."` per RFC 6750.
- **OAuth bridge mode (opt-in).** For hosts whose upstream IdP
  doesn't support Dynamic Client Registration (Pocket-ID, plain
  OIDC providers, some Authentik/Keycloak setups):
  - `serveAuthorizationServerMetadata` wraps the upstream's
    openid-configuration with the host's own `registration_endpoint`
    (in-process 1-hour cache, SSRF-guarded, capped LRU).
  - `handleClientRegistration` returns a fixed pre-registered
    upstream `client_id` for every RFC 7591 request; required
    `allowedRedirectPatterns` prevents open-redirect abuse, and
    error responses truncate echoed payloads to bound size.
  - `resolveIdentity` callback replaces Convex's JWT validation for
    opaque tokens, typically a userinfo-endpoint fetch.
- **Audit log.** One row per `tools/call` capturing tool, kind,
  outcome (`allowed` / `denied` / `error`), identity subject,
  duration, args, and error detail. Filtered reads via
  `gateway.listAuditEntries({ toolName?, outcome?, limit? })`.
  Argument storage is controlled per-tool by `metadata.auditArgs`:
  - `true` (default): store verbatim
  - `false`: drop entirely
  - `{ redact: ["password", "credentials.token"] }`: dotted paths
    walk nested objects and replace the leaf with `"[redacted]"`.
- **Wire error sanitization.** A plain `throw new Error(...)` from
  a tool handler results in a generic `"Tool execution failed"` on
  the wire; the verbose message lands in the audit row only. Tools
  that want the LLM to see a specific message throw
  `ConvexError(...)`, the deliberate user-facing channel.
- **Sessions bound to creator's identity.** `sessions` rows record
  the `identitySubject` resolved at `initialize` time; `DELETE /mcp/`
  requires a matching subject and returns 403 otherwise, so a
  leaked session id alone cannot DoS an authenticated user's
  session. Pre-binding rows skip the check for forward-compat.
- **Bounded pruning.** `pruneAuditEntries` and `pruneSessions`
  delete at most 200 rows per call (ascending creation-time and
  `by_lastSeenAt` index respectively); callers loop until the
  return value is 0. Designed for `crons.daily(...)` from the host.
- **CORS.** `McpCorsOption` accepts `true`, an exact-match string,
  a `string[]` allowlist, or a function. JSDoc calls out the
  production risk of `cors: true` on auth-bearing endpoints.
- **Tool name validation.** `defineMcp{Query,Mutation,Action}` reject
  names that violate `^[a-zA-Z0-9_-]{1,64}$` at registration time
  rather than letting claude.ai's frontend reject the whole catalog
  later. Dotted names (`invoices.list`) are the common gotcha
  (mirroring `api.invoices.list` reference style); use
  `invoices_list` instead.
- **Component boundary.** The user-facing API is the host's
  `gateway.*` wrapper, never the raw `components.mcpGateway.*`
  functions. Inside the component, `audit.recordEntry` is the only
  `internalMutation` because only in-component `dispatch.runTool`
  writes audit rows; host-called functions (registry, sessions,
  `dispatch.runTool`, `dispatch.recordAuthDenial`) are public
  because Convex enforces the internal/public marker at the
  component boundary at runtime.

### Docs

`docs/getting-started.md`, `docs/architecture.md`,
`docs/authorization.md`, `docs/oauth.md`, `docs/oauth-bridge.md`,
`docs/audit-log.md`, `docs/testing.md`, plus editorial-styled SVG
sequence and data-flow diagrams under `docs/diagrams/`.

### CI / release

GitHub Actions workflows: build + typecheck + test + lint on every
PR, publish to npm on `v*` tag push. Local development against a
pinned `convex-local-backend` binary via `pnpm local:start`
(no Docker).
