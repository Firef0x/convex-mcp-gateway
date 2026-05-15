# Testing

The gateway is fully exercisable from `convex-test` without spinning up
a real backend. This doc shows the patterns specific to the component;
for general convex-test usage, see the
[convex-test docs](https://www.npmjs.com/package/convex-test).

## Setup

The component lives in your host's `node_modules` so its modules need to
be registered alongside your own:

```ts
// example/convex/mcp.test.ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema.js";
import componentSchema from "@convex-dev/mcp-gateway/_generated/component";
import { components, internal } from "./_generated/api.js";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!**/*.test.ts"]);
const componentModules = import.meta.glob([
  "../../node_modules/@convex-dev/mcp-gateway/dist/component/**/*.js",
]);

function newTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("mcpGateway", componentSchema, componentModules);
  return t;
}
```

> Inside this monorepo the test imports from `../../src/component/...`
> instead of `node_modules`, but the pattern is the same.

## Identities

Use `t.withIdentity({ subject, ... })` to synthesize the JWT-validated
identity that `ctx.auth.getUserIdentity()` returns. Any extra fields are
forwarded onto the identity, so role/scope claims work without setting
up a real signer:

```ts
test("private tool succeeds with a real identity", async () => {
  const t = newTest();
  await t.mutation(internal.mcp.registerDefaults, {});

  const result = await t
    .withIdentity({ subject: "alice" })
    .action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.list",
      args: {},
    });

  expect(result.ok).toBe(true);
});

test("role-gated mutation requires the matching role", async () => {
  const t = newTest();
  await t.mutation(internal.mcp.registerDefaults, {});

  const result = await t
    .withIdentity({
      subject: "carol",
      roles: ["finance.admin"],
    } as unknown as Parameters<typeof t.withIdentity>[0])
    .action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.markPaid",
      args: { id: "..." },
    });

  expect(result.ok).toBe(true);
});
```

The `as unknown as ...` cast is a convex-test typing quirk: the public
identity type doesn't include arbitrary claims, but the runtime
forwards them. They show up on `identity.roles` etc. just like a real
JWT claim would.

## Calling the component directly vs. via HTTP

`convex-test`'s `t.fetch` only routes the **host's** `http.ts`. It does
not currently route component-mounted HTTP routes (the gateway's `/mcp/`
endpoint). To test gateway behavior, drive the underlying actions
directly:

```ts
// instead of: t.fetch("/mcp/", { method: "POST", body: JSON.stringify({ method: "tools/list", ... }) })
const visible = await t.action(
  components.mcpGateway.dispatch.listVisibleTools,
  {},
);

// instead of: t.fetch("/mcp/", { method: "POST", body: JSON.stringify({ method: "tools/call", ... }) })
const result = await t.action(components.mcpGateway.dispatch.callTool, {
  name: "invoices.list",
  args: {},
});
```

These are the same code paths the JSON-RPC handler invokes, just
without the JSON-RPC envelope. The HTTP wrapper itself is a few lines
of envelope handling; the heavy lifting lives in the dispatch actions
and is fully testable.

End-to-end coverage of the JSON-RPC envelope is best done via curl
against a local backend (`pnpm local:start`) or in CI integration
tests, not in unit tests.

## Swapping the authorizer per test

For tests that need a specific authorizer behavior (e.g. one that
throws, one that asserts on `mode`, one that always denies), define
extra internal queries in your test fixture and swap them in via
`setAuthorizer`:

```ts
// example/convex/mcp.ts
export const modeAssertingAuthorizer = internalQuery({
  args: mcpAuthorizerArgs,
  returns: mcpAuthorizerReturns,
  handler: (async (_ctx, { mode }) => {
    if (mode === "list") return { allowed: true };
    return { allowed: false, reason: `Forbidden in ${mode} mode` };
  }) satisfies McpAuthorizerHandler,
});
```

```ts
// in the test
import { createFunctionHandle } from "convex/server";

await t.run(async (ctx) => {
  const handle = await createFunctionHandle(internal.mcp.modeAssertingAuthorizer);
  await ctx.runMutation(components.mcpGateway.registry.setAuthorizer, {
    authorizerHandle: handle,
  });
});

// Now listVisibleTools allows everything, callTool denies.
```

This is the same mechanism the production setup uses; the
gateway has no special test-mode hook because none is needed.

## Asserting on the audit log

The audit log is a regular Convex query, so you can read it inside a
test:

```ts
const entries = await t.run(async (ctx) => {
  return await ctx.runQuery(components.mcpGateway.audit.listEntries, {});
});
expect(entries).toHaveLength(2);
expect(entries[0]!.outcome).toBe("denied");
```

To force-write rows (e.g. for testing the combined-filter behavior
under high volume), call `recordEntry` directly:

```ts
await t.run(async (ctx) => {
  for (let i = 0; i < 50; i++) {
    await ctx.runMutation(components.mcpGateway.audit.recordEntry, {
      toolName: "x",
      toolKind: "query",
      args: { i },
      outcome: "allowed",
      identitySubject: null,
      durationMs: 1,
    });
  }
});
```

## Real-client smoke test (MCP Inspector)

`convex-test` exercises the dispatch and registry actions, but it does
not run the component's HTTP route or the Streamable HTTP envelope. To
verify the protocol surface end-to-end, drive the gateway with the
official [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
in CLI mode against the local backend.

```sh
# Terminal 1: local backend (in this repo)
pnpm local:start
# Terminal 2: deploy your tools + register defaults (in your host repo)
npx convex dev --once
npx convex run mcp:registerDefaults
# Terminal 3: smoke tests
npx @modelcontextprotocol/inspector --cli \
  http://127.0.0.1:3311/mcp/ \
  --transport http \
  --method tools/list

npx @modelcontextprotocol/inspector --cli \
  http://127.0.0.1:3311/mcp/ \
  --transport http \
  --method tools/call \
  --tool-name notes.count
```

What to verify:

- `tools/list` returns the catalog the **anonymous** authorizer
  permits (Inspector does not pass any Bearer token by default).
- `tools/call` on a public tool returns `content: [{type:"text", ...}]`.
- `tools/call` on a private tool fails with `-32001 Unauthorized` (and
  the underlying HTTP response carries `WWW-Authenticate` if OAuth
  discovery is configured).
- `tools/call` on an unknown name fails with `-32602 Unknown tool` and
  no audit row is written for it.
- Inspector handles the `initialize` handshake and `Mcp-Session-Id`
  lifecycle automatically; you only see the application-level results.

For a UI-based test, run Inspector without `--cli`; it opens a web
console where you can browse tools, edit args, and watch each
JSON-RPC frame.

## Real-client smoke test (Claude Desktop)

For an interactive smoke test against Anthropic's own client:

1. Deploy the playground (or your host) to a Convex project that has a
   reachable HTTPS URL (`npx convex deploy`).
2. Configure Claude Desktop's MCP server config (Settings →
   Developer → Edit Config) with an HTTP-transport entry pointing at
   `https://<your-deployment>.convex.site/mcp/`.
3. Restart Claude Desktop. The configured tools appear under the
   integrations panel; calling them goes through the full session +
   authorizer + audit pipeline.

If your deployment requires OAuth, Claude Desktop follows the
`WWW-Authenticate` header to your authorization server and runs the
PKCE flow. Make sure your `auth.config.ts` issuer matches what you
configured via `gateway.setOAuthConfig`.

## Common pitfalls

- **Forgetting `registerComponent`.** Without it, `components.mcpGateway`
  resolves to `undefined` and tests fail with "Cannot read property
  'dispatch' of undefined".
- **Calling `t.fetch("/mcp/", ...)`.** Returns `404 No HttpAction routed
  for /mcp/`. Use `t.action(components.mcpGateway.dispatch.callTool, ...)`
  instead.
- **Asserting on identity propagation through HTTP.** Identity in
  `convex-test` flows through `t.withIdentity(...)` regardless of the
  request transport. The HTTP layer doesn't need to be involved for
  the authorizer to see the synthesized identity.
- **Stale registry between tests.** Convex-test gives each test a fresh
  in-memory database, so this isn't an issue inside a single test file.
  But registering tools across tests in the same `describe` block needs
  `gateway.register(ctx, [...], { replace: true })` to avoid cross-test
  contamination.
