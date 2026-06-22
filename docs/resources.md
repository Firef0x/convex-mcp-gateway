# Resources & resource templates

MCP **resources** are read-only content the gateway exposes alongside
tools: a client lists them (`resources/list`) and reads them
(`resources/read`). The gateway supports two flavours:

- **Concrete resources** — a fixed URI (`docs://handbook`). Declare with
  `defineMcpResource`.
- **Resource templates** — a parameterized URI pattern
  (`weather://{city}/current`), advertised via `resources/templates/list`.
  Declare with `defineMcpResourceTemplate`.

Both run only for authenticated callers, flow through the same optional
`authorizeResource` hook, and can be audited via `auditResources`. See
[Authorization](./authorization.md) and [Audit log](./audit-log.md).

## When to use which

| Use a **concrete resource** when… | Use a **template** when… |
|---|---|
| The URI is fixed and known ahead of time | The URI is parameterized (an id, a city, a path) |
| You want it persisted in the registry and listed in `resources/list` | You want clients to discover the *shape* and expand it themselves |
| There's one (or a small fixed set of) document | There's an unbounded family of resources behind one pattern |

A template is not listed in `resources/list`; it appears only in
`resources/templates/list`. The client expands the template to a concrete
URI and reads it through the ordinary `resources/read`.

## Concrete resources

```ts
import { defineMcpResource } from "convex-mcp-gateway";

const handbook = defineMcpResource({
  uri: "docs://handbook",
  name: "Operator handbook",
  description: "Internal runbook",
  mimeType: "text/markdown",
  read: async (ctx, { uri, identity }) => [
    { uri, mimeType: "text/markdown", text: await loadHandbook(ctx, identity) },
  ],
});

// gateway.handleMcpRequest(ctx, req, { authorize, resources: [handbook] });
```

Concrete resources declared this way are also reconciled into the
component registry on `initialize` (change-detected), so `resources/list`
returns them even from a request that doesn't pass a provider. See the
registry-sync behaviour in [Architecture](./architecture.md).

## Resource templates

```ts
import { defineMcpResourceTemplate } from "convex-mcp-gateway";

const weather = defineMcpResourceTemplate({
  uriTemplate: "weather://{city}/current",
  name: "Current weather",
  description: "Live weather by city",
  mimeType: "application/json",
  // Optional: resolve matching reads server-side. Omit `read` for a
  // listing-only template (the client reads the expansion elsewhere).
  read: async (ctx, { uri, params, identity }) => [
    { uri, mimeType: "application/json", text: await fetchWeather(params.city) },
  ],
});

// gateway.handleMcpRequest(ctx, req, {
//   authorize,
//   resourceTemplates: [weather],
// });
```

### How template reads resolve

When `resources/read` receives a URI:

1. **Concrete providers run first.** A concrete resource always wins over
   a template that would also match the same URI, so dispatch is never
   ambiguous.
2. **Then templates** whose `uriTemplate` matches the URI are tried in
   order; the first template whose `read` returns content serves it. A
   template without a `read` handler is listing-only and is skipped here.
3. If nothing serves the URI, the read returns `Resource not found`
   (`-32602`). A provider/template that *throws* (rather than declining
   with `null`) is isolated and logged; it surfaces as an internal error
   (`-32603`) only if nothing else serves the URI.

### `uriTemplate` syntax (level 1)

Only **RFC 6570 level-1** simple placeholders are supported:
`{name}` where `name` is `A–Z a–z 0–9 _`. Each placeholder matches exactly
one URI path segment (it does not span `/`). The following throw at
declaration time so an unusable template fails loudly:

- operators — `{+var}`, `{#var}`, `{/var}`, `{.var}`, `{;var}`, `{?var}`,
  `{&var}`
- comma lists — `{a,b}`
- a template with no placeholder (use `defineMcpResource` instead)
- repeated variable names, unclosed `{`

> Persisting templates in the registry (with declarative fingerprint sync,
> mirroring concrete resources) is tracked as a separate follow-up; in this
> phase templates are resolved from the runtime `resourceTemplates` option.

## Auth & audit

`resources/templates/list` behaves like `resources/list`:

- It requires an authenticated identity.
- Each template is filtered through `authorizeResource` with
  `mode: "resource_templates_list"` (the template's `uriTemplate` is passed
  as `resourceUri`).
- It is audited when `auditResources` is `true` or
  `{ templatesList: true }`; the audit row's `resourceOperation` is
  `templates_list`. Reads that resolve through a template are audited under
  `resourceOperation: "read"`, exactly like concrete reads.

> **List-deny is not read-deny.** `resources/read` of a template-expanded
> URI is authorized under `mode: "resource_read"` with the *concrete*
> expanded URI (e.g. `weather://london/current`) and `resourceMetadata:
> null` — not under `resource_templates_list` with the `uriTemplate`. So
> hiding a template from `resources/templates/list` does **not** by itself
> block reads of its expansions. `resource_templates_list` controls catalog
> *visibility*; `resource_read` is the gate for every read. To deny reads of
> a template's URIs, match the URI shape in your `resource_read` branch
> and/or enforce the check inside the template's own `read` handler.
