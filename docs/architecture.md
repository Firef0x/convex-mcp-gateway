# Architecture

The gateway is a Convex component that sits between an MCP client and
your existing Convex functions. It owns its own HTTP route, its own
storage tables (registry, config, audit), and one piece of public
contract: the authorizer query you write.

## High-level

```mermaid
flowchart LR
  subgraph Client[" "]
    direction TB
    MCP["MCP client<br/>(Claude Desktop,<br/>Cursor, Inspector)"]
  end

  subgraph Convex["Convex deployment"]
    direction TB
    subgraph Host["Host app (your code)"]
      AuthCfg["auth.config.ts<br/>JWT issuer"]
      Authorizer["authorize<br/>internalQuery"]
      Tools["Tool functions<br/>query / mutation / action"]
      HostHttp["http.ts<br/>discovery route"]
    end
    subgraph Component["mcp-gateway component"]
      MCPHttp["/mcp/ HTTP route"]
      Dispatch["dispatch<br/>callTool / listVisibleTools"]
      Registry[("tools, config")]
      Audit[("audit")]
    end
  end

  MCP -->|POST /mcp/<br/>JSON-RPC + Bearer| MCPHttp
  MCP -->|GET /.well-known/...| HostHttp
  MCPHttp --> Dispatch
  Dispatch -->|runQuery| Registry
  Dispatch -->|runQuery handle| Authorizer
  Dispatch -->|run handle| Tools
  Dispatch -->|runMutation| Audit
  Authorizer -.->|reads identity| AuthCfg
```

The split is deliberate:

- **Component**: protocol surface (JSON-RPC, MCP versions, OAuth header
  semantics), registry of `(name → function handle)` mappings, and the
  audit pipeline. It has zero opinions about scopes, roles, or which
  tools are public.
- **Host**: the authorizer (one query that decides per call), the actual
  business-logic functions registered as tools, and the OAuth discovery
  route mounted at the RFC 9728 canonical path.

The component cannot reach the host's tables directly; everything goes
through `createFunctionHandle` references the host registers via
`gateway.register`. Conversely, the host never imports component
internals; it only sees `components.mcpGateway.<module>.<function>` plus
the `McpGateway` client class.

## Data model

```mermaid
erDiagram
  tools {
    string name "by_name index"
    string description
    string kind "query|mutation|action"
    string functionHandle
    any inputSchema
    any metadata "host-defined: scopes, roles, public, auditArgs"
  }
  config {
    string authorizerHandle "FunctionHandle to host's authorize query"
    string authServerUrl "OAuth IdP base URL"
    string resourceUrl "optional explicit resource URL"
  }
  audit {
    string toolName "by_toolName index"
    string toolKind
    any args "null when metadata.auditArgs === false"
    string outcome "by_outcome index: allowed|denied|error"
    string identitySubject
    number durationMs
    number errorCode
    string errorMessage
  }
```

Three tables, all owned by the component:

- `tools` is a per-tool row keyed by `name`. `functionHandle` is the
  opaque reference returned by `createFunctionHandle(fn)` and dispatched
  with `ctx.runQuery / runMutation / runAction`.
- `config` is a singleton row holding the authorizer handle and the
  OAuth metadata.
- `audit` grows linearly with `tools/call` traffic. Two indexes
  (`by_toolName`, `by_outcome`) keep the most common queries cheap.
- `sessions` is the MCP Streamable HTTP session table. One row per
  active client, keyed on the cryptographically random session id the
  server issued during `initialize`. The row also stores the
  negotiated protocol version and a `lastSeenAt` timestamp for
  idle-pruning via `gateway.pruneSessions` if the host wants it.

## MCP Streamable HTTP transport

The component implements MCP 2025-06-18 Streamable HTTP at the
`/mcp/` endpoint:

| Method | Purpose | Notes |
|---|---|---|
| `POST /mcp/` | Send a JSON-RPC message | First call must be `initialize`; subsequent calls require `Mcp-Session-Id` |
| `GET /mcp/` | Open server-initiated SSE channel | Returns `405 Method Not Allowed`; we don't push notifications yet |
| `DELETE /mcp/` | Terminate session | Drops the session row; subsequent requests with that id get `404` |

Two response shapes for `POST` are both supported. The server picks
based on the client's `Accept` header:

- `Accept: application/json` → JSON envelope (default, simplest)
- `Accept: text/event-stream` → single-frame SSE response with the same
  payload wrapped in an event. Used by clients that prefer streaming
  transport even for short responses; ready for future progress
  notifications without protocol change.

```mermaid
sequenceDiagram
  autonumber
  participant C as MCP Client
  participant H as POST /mcp/
  participant S as sessions table

  C->>H: initialize (no session id)
  H->>S: createSession(random128)
  H-->>C: 200 + Mcp-Session-Id: <id>
  Note over C: persists id for the conversation
  C->>H: tools/list (Mcp-Session-Id: <id>)
  H->>S: getSession + touch
  H-->>C: 200 result
  C->>H: DELETE / (Mcp-Session-Id: <id>)
  H->>S: deleteSession
  H-->>C: 200
  C->>H: tools/list (Mcp-Session-Id: <id>)
  H-->>C: 404 Not Found  (forces re-initialize)
```

Sessions are required after `initialize` (HTTP `400` on missing
header). The server may also terminate a session at any time; clients
that get `404` on a previously valid session id MUST start a fresh
`initialize`. The component never garbage-collects sessions on its own;
the host can schedule `gateway.pruneSessions(ctx, idleMs)` from a
cron if needed.

## Request flow: `tools/call`

```mermaid
sequenceDiagram
  autonumber
  participant C as MCP Client
  participant H as Component HTTP
  participant D as dispatch.callTool
  participant R as Registry
  participant A as Host authorizer
  participant T as Host tool fn
  participant L as Audit log

  C->>H: POST /mcp/ tools/call name=X
  H->>D: runAction(callTool, {name, args})
  D->>D: ctx.auth.getUserIdentity()
  D->>R: getTool(name)
  alt tool not registered
    R-->>D: null
    D-->>H: -32602 Unknown tool
    Note right of D: skipped audit (anti-DoS)
  else tool found
    D->>R: getAuthorizer()
    alt no authorizer set
      D->>L: outcome=error -32011
      D-->>H: -32011 No authorizer configured
    else authorizer set
      D->>A: runQuery(handle, {mode:"call", toolMetadata, args, ...})
      alt authorizer throws
        A-->>D: throw
        D->>L: outcome=error -32603
        D-->>H: -32603 Authorizer threw
      else allowed=false
        A-->>D: {allowed:false, reason}
        D->>L: outcome=denied
        D-->>H: -32001 / -32003 + WWW-Authenticate
      else allowed=true
        A-->>D: {allowed:true}
        D->>T: runQuery / runMutation / runAction(handle, args)
        T-->>D: result | throw
        D->>L: outcome=allowed | error -32000
        D-->>H: ok+data | error
      end
    end
  end
  H-->>C: HTTP response
```

A few invariants worth pointing out, because they were edge cases the
review caught:

- **Audit never alters the dispatch outcome.** Every audit write goes
  through `safeRecordAudit`, which logs and swallows its own failures.
  A successful tool mutation always returns `ok: true`, even if the
  audit row could not be inserted.
- **Audit is written *after* the tool handler returns**, outside the
  handler's try/catch, so a failing audit insert can never invert a
  committed mutation into a `-32000` error response.
- **Unknown-tool calls are not audited.** Anonymous callers can spam
  arbitrary names with arbitrary args; auditing them would let a
  drive-by attacker grow your `audit` table without bound.
- **Authorizer throws are isolated.** They become `-32603` JSON-RPC
  errors with an audit entry, not HTTP 500s. The MCP client can recover.

## Request flow: `tools/list`

```mermaid
sequenceDiagram
  autonumber
  participant C as MCP Client
  participant H as Component HTTP
  participant D as dispatch.listVisibleTools
  participant R as Registry
  participant A as Host authorizer

  C->>H: POST /mcp/ tools/list
  H->>D: runAction(listVisibleTools)
  D->>R: listTools()
  D->>R: getAuthorizer()
  alt no authorizer
    D-->>H: []  (deny-by-default)
  else authorizer set
    par for each tool (in parallel)
      D->>A: runQuery(handle, {mode:"list", toolMetadata, args:{}, ...})
      A-->>D: {allowed:true|false} | throw
    end
    D-->>H: tools where allowed=true
  end
  H-->>C: {tools: [{name, description, inputSchema}, ...]}
```

The catalog visible to a caller is exactly the set of tools the
authorizer would let them call. This means an unauthenticated client
sees only public tools, and an authenticated user without a particular
role never even sees the role-gated mutations in their tool list.

The authorizer is invoked once per registered tool, in parallel via
`Promise.all`. For 5 to 20 tools that is a non-issue; if your registry
grows large, you can move expensive checks into `metadata` (which the
authorizer receives without needing to re-read the registry).

## Identity propagation

Convex validates the inbound `Authorization: Bearer <jwt>` header
against your `auth.config.ts` before any function runs. The component's
`callTool` action calls `ctx.auth.getUserIdentity()` once at the top
and reuses the result; the same Convex auth context propagates through
`ctx.runQuery(authorizerHandle, ...)` and `ctx.runQuery / Mutation /
Action(toolHandle, ...)`, so:

- The authorizer can call `ctx.auth.getUserIdentity()` and see the
  caller, exactly as in any other Convex query.
- The tool handler sees the same identity via the same call.
- The audit row stores `identity.subject` (or `null` for anonymous).

There is no special MCP-vs-HTTP distinction. Whatever JWT issuer you
already use (Clerk, Auth0, Pocket-ID, custom) keeps working without
glue code.

## Why some component functions are `mutation` not `internalMutation`

If you read the source you will notice that `audit.recordEntry`,
`registry.*`, and `dispatch.*` are declared as `mutation` / `query` /
`action` rather than the `internal*` variants. This is intentional and
specific to Convex components.

Generated component API references (`api`, `internal` exported from
`_generated/api.ts`) are both backed by `anyApi` at runtime, which
strips the public/internal marker. A component that calls its own
`internalMutation` via `internal.audit.recordEntry` fails at runtime
with `Couldn't resolve api.audit.recordEntry`. Declaring the function as
public `mutation` fixes the resolution; the component boundary still
prevents external callers from invoking it (only the host can reach
`components.mcpGateway.audit.recordEntry`, and the host already trusts
itself).

## Failure modes summary

| Failure | What the gateway does |
|---|---|
| Tool not registered | `-32602 Unknown tool` (no audit row) |
| No authorizer configured | `-32011 No authorizer configured` (audit `error`) |
| Authorizer returns `allowed: false` | `-32001 Unauthorized` if reason starts `Unauth*`, else `-32003 Forbidden`. 401 also gets `WWW-Authenticate`. (audit `denied`) |
| Authorizer throws | `-32603 Authorizer threw: ...` (audit `error`) |
| Authorizer returns malformed shape | Treated as `allowed: false` with explanatory reason (audit `denied`) |
| Tool handler throws | `-32000` with the error message (audit `error`) |
| Audit-write fails | Logged via `console.error`, swallowed. Dispatch outcome unchanged. |

## Going deeper

- [authorization.md](./authorization.md) for the authorizer contract,
  modes, and metadata-driven scope/role recipes
- [oauth.md](./oauth.md) for the OAuth 2.1 protected-resource discovery
  flow
- [audit-log.md](./audit-log.md) for audit reading, redaction, and
  pruning
- [testing.md](./testing.md) for `convex-test` patterns specific to this
  component
