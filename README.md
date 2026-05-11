# @convex-dev/mcp-gateway

> Auth-aware Convex component that exposes selected Convex functions as MCP tools.

A Convex component that owns its own `/mcp` HTTP route and dispatches `tools/list` / `tools/call` back into host-app functions through `createFunctionHandle`. The component keeps a persistent tool registry; the host app declares its tools typesafely against its own `api`.

> Status: pre-0.1. The HTTP route currently speaks MCP 2025-06-18 JSON-RPC without auth. OAuth bridging (Phase 2) and scope/role enforcement land later.

## Install

```sh
pnpm add @convex-dev/mcp-gateway
```

In your host app's `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import mcpGateway from "@convex-dev/mcp-gateway/convex.config";

const app = defineApp();
app.use(mcpGateway);
export default app;
```

## Wire up an authorizer

The component knows nothing about scopes, roles, JWT claims, IP ranges, or any other access policy. It calls a single host-side `internalQuery` for every `tools/call` and lets that function decide. Deny-by-default: until an authorizer is registered, every `tools/call` returns `-32011 No authorizer configured`.

```ts
import {
  mcpAuthorizerArgs,
  mcpAuthorizerReturns,
  type McpAuthorizerHandler,
} from "@convex-dev/mcp-gateway";
import { internalQuery } from "./_generated/server.js";

export const authorize = internalQuery({
  args: mcpAuthorizerArgs,
  returns: mcpAuthorizerReturns,
  handler: (async (ctx, { toolName }) => {
    if (toolName === "invoices.summary") {
      return { allowed: true }; // public
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { allowed: false, reason: "Unauthorized" };
    // ... your own role / scope / ABAC logic here
    return { allowed: true };
  }) satisfies McpAuthorizerHandler,
});
```

The component invokes this query via a `createFunctionHandle`. Convex propagates the JWT-validated identity through `ctx.runQuery`, so the authorizer (and the tool handler itself) can call `ctx.auth.getUserIdentity()` exactly like in any normal Convex query.

## Register tools typesafely

```ts
import { v } from "convex/values";
import { McpGateway, defineMcpQuery } from "@convex-dev/mcp-gateway";
import { api, components, internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

export const bootstrap = internalMutation({
  args: {},
  handler: async (ctx) => {
    await gateway.setAuthorizer(ctx, internal.mcp.authorize);
    await gateway.register(ctx, [
      defineMcpQuery({
        name: "invoices.list",
        description: "List invoices, optionally filtered by status.",
        fn: api.invoices.list,
        args: {
          status: v.optional(v.union(v.literal("open"), v.literal("paid"))),
        },
      }),
    ]);
  },
});
```

`defineMcpQuery` / `defineMcpMutation` / `defineMcpAction` constrain the `args` validator against the actual `FunctionArgs<typeof fn>` *and* enforce that the function reference matches the helper's kind. Passing a mutation to `defineMcpQuery` or a mismatched args validator is a compile error.

## Talk to it over MCP

The component owns the `/mcp/` HTTP route on the host's Convex HTTP endpoint. Note the trailing slash: with `httpPrefix: "/mcp"` plus a component-internal route at `/`, the deployed path is `/mcp/`.

```sh
curl -sS -X POST "$CONVEX_SITE_URL/mcp/" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`tools/call` dispatches the registered function handle and returns its result wrapped in MCP `content: [{type:"text", text: ...}]`.

## Local development

```sh
pnpm install
pnpm check                              # codegen + typecheck + tests
```

To iterate against a real local Convex backend (HTTP route reachable via curl):

```sh
pnpm local:start                        # downloads the pinned convex-local-backend binary
                                        # into .tools/, writes .env.local, runs the backend
                                        # on :3310 / :3311

# in another shell:
source .env.local && pnpm convex:codegen
source .env.local && npx convex dev --once
source .env.local && npx convex run mcp:registerDefaults
curl -sS -X POST http://127.0.0.1:3311/mcp/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The local backend boots with the upstream test fixture credentials checked into
`get-convex/convex-backend` (`crates/keybroker/dev/`), so there is no Docker step
and no admin-key derivation. Both the instance name and admin key are public
test fixtures, safe to commit.

## License

Apache-2.0
