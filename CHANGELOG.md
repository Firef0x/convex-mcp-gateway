# Changelog

## Unreleased

- Initial skeleton: Convex component layout (rate-limiter convention),
  `McpGateway` client with `defineMcpQuery` / `defineMcpMutation` /
  `defineMcpAction` helpers, end-to-end-typed args validators against
  `FunctionArgs<typeof fn>`.
- `/mcp/` HTTP route owned by the component, JSON-RPC envelope for
  `initialize` / `tools/list` / `tools/call`.
- Generic per-request authorizer: host registers a single
  `internalQuery` via `gateway.setAuthorizer`; deny-by-default until
  configured.
- CI workflow runs build + typecheck + test + lint on every PR. Release
  workflow publishes on `v*` tags.
