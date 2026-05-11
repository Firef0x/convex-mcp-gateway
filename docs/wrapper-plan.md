# Simple Wrapper Plan

## Goal

Build the smallest useful `mcpQuery` / `mcpMutation` layer before starting the OAuth bridge. The wrapper should prove that Convex validators, explicit tool metadata, scope requirements, and registry generation fit together cleanly.

## MVP Slice

1. Define explicit wrappers:
   - `mcpQuery({ ref, args, meta })`
   - `mcpMutation({ ref, args, meta })`
   - No `mcpAction` in the first slice.

2. Convert Convex validators to MCP-compatible JSON Schema:
   - Support `string`, `number`, `boolean`, `null`, `id`, `literal`, `array`, `object`, `union`, `record`, `int64`, `bytes`, and `any`.
   - Preserve `v.id("table")` as `format: "convex-id"` plus `x-convex-table`.

3. Build a registry:
   - Reject duplicate tool names.
   - Keep explicit metadata: `name`, `description`, `scopes`, `roles`, `destructive`, `idempotent`.
   - Do not auto-discover public Convex functions.

4. Add MCP endpoint in the next implementation slice:
   - `tools/list` returns filtered tools.
   - `tools/call` dispatches to Convex query/mutation references.
   - Initial auth may be a local bearer-token interface, but the public API should already model scopes and roles.

5. Defer until after wrapper proof:
   - Dynamic Client Registration.
   - PKCE authorization code flow.
   - Refresh-token rotation.
   - Capability tokens.
   - Reverse-direction MCP client support.

## Differentiation Check

Existing NPM packages already expose Convex functions as MCP tools. This project should not compete as another thin wrapper. The first public positioning should be:

> Auth-aware Convex MCP component with explicit scopes, roles, audit trail, and a path to OAuth-capability tokens.

That makes the wrapper API a foundation for the auth model, not the whole product.
