# Getting Started

This walks you through installing the gateway, registering a tool, and
calling it over MCP. Aim: working end-to-end in under five minutes against
a local Convex backend.

## Prerequisites

- A Convex project (`npx convex dev` works against your deployment)
- Node 20+
- Optional: an MCP client (Claude Desktop, MCP Inspector) to talk to the
  gateway interactively

## 1. Install

```sh
pnpm add @convex-dev/mcp-gateway
# or: npm install / yarn add
```

## 2. Mount the component

In your host's `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import mcpGateway from "@convex-dev/mcp-gateway/convex.config";

const app = defineApp();
app.use(mcpGateway, { httpPrefix: "/mcp" });
export default app;
```

`httpPrefix` is required, otherwise the component's `/mcp/` route is not
reachable. Pick whatever path you want; the rest of these docs assume
`/mcp`.

## 3. Make sure HTTP actions are enabled

Convex needs at least one route on the host's `httpRouter()` to enable
HTTP actions globally. If you don't already have a `convex/http.ts`, add
one (it can stay otherwise empty for now):

```ts
// convex/http.ts
import { httpRouter } from "convex/server";

const http = httpRouter();
export default http;
```

You will extend this file in step 6 to mount the OAuth discovery handler.

## 4. Define your authorizer

The gateway is **deny-by-default**. Until you register an authorizer,
every `tools/call` returns `-32011 No authorizer configured` and every
`tools/list` returns an empty catalog. The authorizer is a normal
`internalQuery` of yours, called once per dispatch:

```ts
// convex/mcp.ts
import {
  mcpAuthorizerArgs,
  mcpAuthorizerReturns,
  type McpAuthorizerHandler,
} from "@convex-dev/mcp-gateway";
import { internalQuery } from "./_generated/server.js";

export const authorize = internalQuery({
  args: mcpAuthorizerArgs,
  returns: mcpAuthorizerReturns,
  handler: (async (ctx, { toolName, toolMetadata }) => {
    // Public tools opt in via metadata.
    const meta = (toolMetadata ?? {}) as { public?: boolean };
    if (meta.public) return { allowed: true };

    // Everything else needs a Convex identity.
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { allowed: false, reason: "Unauthorized" };

    return { allowed: true };
  }) satisfies McpAuthorizerHandler,
});
```

`ctx.auth.getUserIdentity()` returns whatever Convex resolved from the
inbound `Authorization: Bearer ...` header against your `auth.config.ts`.
If your app already uses Clerk, Auth0, Pocket-ID or a JWT issuer, the
gateway picks up that same identity for free.

See [authorization.md](./authorization.md) for scope/role recipes.

## 5. Register tools

```ts
// convex/mcp.ts (continued)
import { v } from "convex/values";
import {
  McpGateway,
  defineMcpQuery,
  defineMcpMutation,
} from "@convex-dev/mcp-gateway";
import { api, components, internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

export const registerDefaults = internalMutation({
  args: {},
  handler: async (ctx) => {
    await gateway.setAuthorizer(ctx, internal.mcp.authorize);
    await gateway.register(
      ctx,
      [
        defineMcpQuery({
          name: "invoices.summary",
          description: "Total number of invoices. Public.",
          fn: api.invoices.summary,
          args: {},
          metadata: { public: true },
        }),
        defineMcpQuery({
          name: "invoices.list",
          description: "List invoices for the authenticated user.",
          fn: api.invoices.list,
          args: { status: v.optional(v.string()) },
        }),
        defineMcpMutation({
          name: "invoices.markPaid",
          description: "Mark an invoice as paid.",
          fn: api.invoices.markPaid,
          args: { id: v.id("invoices") },
        }),
      ],
      { replace: true },
    );
  },
});
```

`{ replace: true }` makes the registry mirror this list exactly: any tool
no longer in the array is removed in the same Convex mutation. Without
the flag, `register` is upsert-only and old tools survive.

`defineMcp{Query,Mutation,Action}` validates `args` against
`FunctionArgs<typeof fn>` at compile time. Passing the wrong validator or
the wrong function kind is a type error, not a runtime surprise.

Run it once after `convex dev`:

```sh
npx convex run mcp:registerDefaults
```

## 6. (Optional) Mount OAuth discovery

If you want MCP clients (Claude Desktop, Inspector) to discover your
authorization server automatically, configure it via the gateway and
mount the RFC 9728 discovery route on your host's `httpRouter`:

```ts
// convex/mcp.ts
await gateway.setOAuthConfig(ctx, {
  authServerUrl: "https://your-idp.example.com/",
});
```

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { McpGateway } from "@convex-dev/mcp-gateway";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);
const http = httpRouter();

http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "GET",
  handler: httpAction(async (ctx, request) =>
    gateway.serveProtectedResourceMetadata(ctx, request),
  ),
});

export default http;
```

The component cannot mount this route itself: RFC 9728 §3.1 mandates the
metadata at `<origin>/.well-known/oauth-protected-resource<path>`, which
lives outside the component's `httpPrefix`. Full guide:
[oauth.md](./oauth.md).

## 7. Talk to it

The gateway speaks **MCP 2025-06-18 Streamable HTTP**: every client
must first `initialize` to receive a session ID, then include it on
all subsequent requests via the `Mcp-Session-Id` header. JSON and SSE
responses are both supported; the server picks based on the client's
`Accept` header.

```sh
# 1. Initialize and capture the session id from the response header.
SESSION=$(curl -sSD - -X POST "$CONVEX_SITE_URL/mcp/" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  | tee /dev/stderr | awk '/^[Mm]cp-[Ss]ession-[Ii]d:/ {print $2}' | tr -d '\r')

# 2. Use the session for everything else.
curl -sS -X POST "$CONVEX_SITE_URL/mcp/" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. (Optional) DELETE explicitly when you're done.
curl -X DELETE "$CONVEX_SITE_URL/mcp/" -H "mcp-session-id: $SESSION"
```

Anonymous callers see only the public tools (`metadata.public: true` in
the authorizer above). Authenticated callers get the full catalog they
are allowed to invoke. Calling a private tool without a Bearer returns
HTTP 401 with a `WWW-Authenticate` header pointing at your discovery
endpoint, exactly what MCP clients expect.

Real MCP clients (Claude Desktop, MCP Inspector, Cursor) handle the
session handshake automatically; you only configure the URL.

## Local development

The repo ships a `pnpm local:start` script that downloads a pinned
`convex-local-backend` binary (no Docker), runs it on `127.0.0.1:3310/3311`
with public test credentials, and writes a matching `.env.local`. Useful
when you want to iterate without touching a real deployment:

```sh
pnpm local:start                      # in one shell
# in another shell:
npx convex dev --once
npx convex run mcp:registerDefaults
curl http://127.0.0.1:3311/mcp/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Where to go next

- [architecture.md](./architecture.md) — component model, data flow,
  identity propagation
- [authorization.md](./authorization.md) — scope/role recipes,
  `mode: "list"` vs `"call"`, audit-redaction
- [oauth.md](./oauth.md) — full OAuth 2.1 setup with discovery
- [audit-log.md](./audit-log.md) — reading and pruning the audit log
- [testing.md](./testing.md) — `convex-test` patterns for the gateway
