# Security policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in
`@convex-dev/mcp-gateway`, **please do not open a public GitHub issue**.

Instead, email the maintainers at <thorben@fohlm.com> with:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The version (commit SHA or npm version) you observed it on
- Any deployment context that matters (Convex version, host JWT issuer,
  whether OAuth discovery is configured, etc.)

You will receive an acknowledgement within 72 hours. We aim to publish
a fix or mitigation within 30 days for high-severity issues; lower-
severity issues may take longer.

## Supported versions

This project is pre-1.0. Only the latest published version receives
security fixes. Once a 1.x release ships, we will support the current
major plus one prior major for security fixes.

## Threat model and known limits

The gateway is designed under the following assumptions, which are
worth understanding when evaluating its security posture:

- **The host application is trusted.** The component runs inside the
  same Convex deployment as the host, and the host can call any of the
  component's public mutations (e.g. `audit.recordEntry`,
  `registry.replaceTools`). The component does not defend against a
  malicious or buggy host.
- **The authorizer is the access boundary.** Until you register an
  authorizer via `gateway.setAuthorizer`, every call returns
  `-32011 No authorizer configured`. The component does not enforce
  any other policy. A wrong authorizer is a wide-open gateway.
- **JWT validation is Convex's job.** The gateway reads
  `ctx.auth.getUserIdentity()` and trusts whatever Convex resolved from
  your `auth.config.ts`. Misconfigured `auth.config.ts` (e.g. wrong
  issuer, no JWKS) makes every caller anonymous.
- **The audit log can carry secrets.** By default, `args` are stored
  verbatim. Use `metadata: { auditArgs: false }` on tools whose
  argument schema accepts credentials, tokens, or PII.
- **The audit log is unbounded.** No automatic retention. Add a cron
  job that prunes rows older than your retention window. See
  [docs/audit-log.md](./docs/audit-log.md).
- **Read access to the audit log is not enforced.**
  `gateway.listAuditEntries` is exposed only through whatever query you
  wrap it in; gate that wrapper with your own authorization checks.

## Known limitations vs. the MCP and OAuth specs

- **No authorization server is built in (yet).** Hosts BYO their AS for
  Bearer-token issuance. See [docs/oauth.md](./docs/oauth.md).
- **No streamable-HTTP transport (yet).** Only single-shot JSON-RPC
  POST is supported. SSE / `Mcp-Session-Id` are on the roadmap.
- **No rate limiting in the component.** Combine with
  [`@convex-dev/rate-limiter`](https://www.npmjs.com/package/@convex-dev/rate-limiter)
  in your authorizer for public tools.
