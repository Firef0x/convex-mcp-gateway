# Audit log

Every `tools/call` produces one row in the component's `audit` table.
The row records who called what, when, with which arguments, and what
the gateway decided. The audit pipeline is independent from the
dispatch outcome: a failed audit insert never alters the response the
caller sees.

## What gets written

| Field | Type | Notes |
|---|---|---|
| `_id` | `Id<"audit">` | Convex row id |
| `_creationTime` | `number` | ms since epoch, written by Convex |
| `toolName` | `string` | Registered tool name (indexed) |
| `toolKind` | `"query" \| "mutation" \| "action"` | |
| `args` | `any` | Caller args, or `null` if `metadata.auditArgs === false` on the tool |
| `outcome` | `"allowed" \| "denied" \| "error"` | (indexed) |
| `identitySubject` | `string \| null` | `ctx.auth.getUserIdentity().subject` or null for anonymous |
| `durationMs` | `number` | Wall-clock time from dispatch start to finish |
| `errorCode` | `number` (optional) | JSON-RPC code on `denied` / `error` outcomes |
| `errorMessage` | `string` (optional) | Human-readable reason |

Two indexes are pre-built: `by_toolName` and `by_outcome`. The query
helper iterates them; you don't need to add your own.

## What does NOT get written

- **Unknown-tool calls.** Anonymous callers can spam arbitrary tool
  names with arbitrary args; auditing them would let a drive-by
  attacker grow the table without bound. The gateway returns
  `-32602 Unknown tool` and skips the audit insert.
- **`tools/list` requests.** Listing is read-only and high-frequency;
  auditing it would dominate the table.
- **`initialize` and other JSON-RPC methods.** Same reasoning.

If you need request-level observability beyond `tools/call`, layer your
own logging in front of the gateway's HTTP route (or wait for the
roadmap item that adds an opt-in request log).

## Reading the log

The `McpGateway` client exposes a thin wrapper:

```ts
import { McpGateway } from "@convex-dev/mcp-gateway";
import { components } from "./_generated/api.js";
import { query } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

export const recentAudit = query({
  args: {},
  handler: async (ctx) => {
    return await gateway.listAuditEntries(ctx, { limit: 50 });
  },
});
```

Filters:

```ts
gateway.listAuditEntries(ctx, { toolName: "invoices.markPaid", limit: 100 });
gateway.listAuditEntries(ctx, { outcome: "denied", limit: 100 });
gateway.listAuditEntries(ctx, {
  toolName: "invoices.markPaid",
  outcome: "error",
  limit: 50,
});
```

Results are returned newest first. `limit` defaults to 100 and is
capped at 1000 server-side. With both `toolName` and `outcome` set, the
query iterates the `by_toolName` index until `limit` matching rows are
collected, so it doesn't silently miss matches even when most recent
entries are the wrong outcome.

## Redacting secret arguments

If a tool's argument schema can carry credentials or PII, opt out per
tool:

```ts
defineMcpMutation({
  name: "secrets.set",
  description: "Set a secret value.",
  fn: api.secrets.set,
  args: { name: v.string(), value: v.string() },
  metadata: { auditArgs: false },
}),
```

The audit row still records who called the tool, when, with what
outcome, and how long it took. Only `args` is replaced with `null`. This
applies to every code path: `allowed`, `denied`, `error`. The default
(no `auditArgs` key, or `auditArgs: true`) stores args verbatim.

A future iteration may add a per-field redaction hook; today it is all
or nothing per tool.

## Retention / pruning

The component does not prune the audit table on its own. For
production deployments, run a scheduled function that drops anything
older than a chosen retention window:

```ts
import { internalMutation } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { v } from "convex/values";

export const pruneAudit = internalMutation({
  args: { retainDays: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.retainDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    // Walk newest-first via the default index. Stop once we cross the cutoff.
    for await (const entry of ctx.runQuery(
      components.mcpGateway.audit.listEntries,
      { limit: 1000 },
    )) {
      // The component's listEntries returns rows; older ones come last in
      // pagination. For large tables, switch to a direct withIndex walk
      // on the component side via a custom internal query.
      if (entry._creationTime >= cutoff) continue;
      await ctx.runMutation(/* component-side delete; not currently exposed */);
      deleted++;
    }
    return { deleted };
  },
});
```

> **Note**: the public component API does not currently expose an audit
> delete mutation. Until it does, the easiest path is a one-time scripted
> cleanup using the dashboard or `npx convex run` against an internal
> deletion query the host adds. This is a known gap; track it in
> [the roadmap](https://dashboard.fohlmeister.org/kanban/task/mn7e33ettrsattthk5bdakgrj98666vj).

Schedule the cleanup with `convex/crons.ts`:

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.daily(
  "audit cleanup",
  { hourUTC: 3, minuteUTC: 0 },
  internal.audit.pruneAudit,
  { retainDays: 30 },
);
export default crons;
```

## Privacy considerations

- **Identity propagation**: `identitySubject` is the JWT `sub` claim.
  If your IdP rotates subjects, audit rows are tied to the value at
  time of write. They are not refreshed.
- **Anonymous calls**: stored as `identitySubject: null`. There is no
  IP, user-agent, or request fingerprint. If you need those, log them
  in front of the gateway.
- **Read access**: `gateway.listAuditEntries` is exposed only through
  whatever query you wrap it in. Hide it from public Convex queries
  (use `internalQuery` or a query that gates on `ctx.auth`) before
  going to production. The component itself does not enforce read
  authorization on the audit table.
- **GDPR / right-to-erasure**: subjects can request deletion of their
  audit history. Until a public delete API ships, run a one-off pruning
  query keyed on `identitySubject`.
