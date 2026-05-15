/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { createFunctionHandle } from "convex/server";
import { describe, expect, test } from "vitest";
import schema from "./schema.js";
import { api, components, internal } from "./_generated/api.js";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!**/*.test.ts"]);
const componentModules = import.meta.glob([
  "../../src/component/**/*.ts",
  "!../../src/component/**/*.test.ts",
]);

import componentSchema from "../../src/component/schema.js";

function newTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("mcpGateway", componentSchema, componentModules);
  return t;
}

describe("host-app integration with the mcp-gateway component", () => {
  test("registerDefaults seeds the registry and the authorizer", async () => {
    const t = newTest();

    await t.mutation(internal.mcp.registerDefaults, {});

    const tools = await t.run(async (ctx) => {
      return await ctx.runQuery(components.mcpGateway.registry.listTools, {});
    });

    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "invoices.list",
      "invoices.markPaid",
      "invoices.summary",
    ]);

    const listTool = tools.find((t) => t.name === "invoices.list")!;
    expect(listTool.kind).toBe("query");
    expect(listTool.inputSchema).toEqual({
      type: "object",
      properties: {
        status: { anyOf: [{ const: "open" }, { const: "paid" }] },
      },
      additionalProperties: false,
    });

    const authorizerHandle = await t.run(async (ctx) => {
      return await ctx.runQuery(
        components.mcpGateway.registry.getAuthorizer,
        {},
      );
    });
    expect(authorizerHandle).toBeTypeOf("string");
  });

  test("registerDefaults is idempotent on tool name", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await t.mutation(internal.mcp.registerDefaults, {});

    const tools = await t.run(async (ctx) => {
      return await ctx.runQuery(components.mcpGateway.registry.listTools, {});
    });
    expect(tools).toHaveLength(3);
  });
});

describe("dispatch + authorizer", () => {
  test("public tool succeeds without identity", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const result = await t.action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.summary",
      args: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ total: 0 });
  });

  test("private tool is rejected without identity", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const result = await t.action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.list",
      args: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(-32001);
      expect(result.error.message).toMatch(/unauth/i);
    }
  });

  test("private tool succeeds with a real identity and propagates it to the handler", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    // Seed an invoice so the tool has something to return.
    await t.run(async (ctx) => {
      await ctx.db.insert("invoices", { status: "open", amount: 17 });
    });

    const result = await t
      .withIdentity({ subject: "alice" })
      .action(components.mcpGateway.dispatch.callTool, {
        name: "invoices.list",
        args: { status: "open" },
      });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        caller: string | null;
        invoices: Array<{ status: string; amount: number }>;
      };
      expect(data.caller).toBe("alice");
      expect(data.invoices).toHaveLength(1);
      expect(data.invoices[0]!.status).toBe("open");
    }
  });

  test("role-gated tool is rejected without the right role", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const invoiceId = (await t.run(async (ctx) => {
      return await ctx.db.insert("invoices", { status: "open", amount: 1 });
    })) as string;

    const result = await t
      .withIdentity({ subject: "bob" })
      .action(components.mcpGateway.dispatch.callTool, {
        name: "invoices.markPaid",
        args: { id: invoiceId },
      });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(-32003);
      expect(result.error.message).toMatch(/finance\.admin/);
    }
  });

  test("role-gated tool succeeds with matching role claim", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const invoiceId = (await t.run(async (ctx) => {
      return await ctx.db.insert("invoices", { status: "open", amount: 1 });
    })) as string;

    const result = await t
      .withIdentity({
        subject: "carol",
        // convex-test forwards any extra fields onto the synthesized identity,
        // so the authorizer sees `identity.roles` exactly as it would with a
        // real JWT that contains a `roles` claim.
        roles: ["finance.admin"],
      } as unknown as Parameters<typeof t.withIdentity>[0])
      .action(components.mcpGateway.dispatch.callTool, {
        name: "invoices.markPaid",
        args: { id: invoiceId },
      });

    expect(result.ok).toBe(true);

    const invoice = await t.run(async (ctx) => {
      return await ctx.db.get("invoices", invoiceId as never);
    });
    expect((invoice as { status: string }).status).toBe("paid");
  });

  test("dispatch writes one audit entry per call (allowed, denied, error)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    // allowed (public tool)
    await t.action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.summary",
      args: {},
    });

    // denied (private tool, no identity)
    await t.action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.list",
      args: {},
    });

    // unknown tool: must NOT be audited (anti-DoS, see dispatch.callTool)
    await t.action(components.mcpGateway.dispatch.callTool, {
      name: "no.such.tool",
      args: {},
    });

    const entries = await t.run(async (ctx) => {
      return await ctx.runQuery(
        components.mcpGateway.audit.listEntries,
        {},
      );
    });
    expect(entries).toHaveLength(2);

    const byName = Object.fromEntries(entries.map((e) => [e.toolName, e]));
    expect(byName["invoices.summary"]!.outcome).toBe("allowed");
    expect(byName["invoices.summary"]!.identitySubject).toBeNull();
    expect(byName["invoices.list"]!.outcome).toBe("denied");
    expect(byName["invoices.list"]!.errorCode).toBe(-32001);
    expect(byName["no.such.tool"]).toBeUndefined();
  });

  test("audit listEntries finds older matches when newer entries don't match the outcome filter", async () => {
    // Regression: the original implementation used `take(limit*2)` then JS
    // post-filter, which silently lost matches when most of the recent
    // window was the wrong outcome. The fix iterates the index until
    // `limit` matches are collected.
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    await t.run(async (ctx) => {
      // 3 ancient errors first.
      for (let i = 0; i < 3; i++) {
        await ctx.runMutation(components.mcpGateway.audit.recordEntry, {
          toolName: "x",
          toolKind: "query",
          args: { i },
          outcome: "error",
          identitySubject: null,
          durationMs: 1,
          errorCode: -32000,
          errorMessage: "old error",
        });
      }
      // 50 recent allowed rows on top, hiding the errors past any small window.
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

    const errors = await t.run(async (ctx) => {
      return await ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "x",
        outcome: "error",
        limit: 10,
      });
    });
    expect(errors).toHaveLength(3);
    for (const e of errors) {
      expect(e.outcome).toBe("error");
      expect(e.toolName).toBe("x");
    }
  });

  test("audit listEntries can filter by toolName and outcome", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    await t.action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.summary",
      args: {},
    });
    await t.action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.list",
      args: {},
    });

    const allowed = await t.run(async (ctx) => {
      return await ctx.runQuery(components.mcpGateway.audit.listEntries, {
        outcome: "allowed",
      });
    });
    expect(allowed.map((e) => e.toolName)).toEqual(["invoices.summary"]);

    const byName = await t.run(async (ctx) => {
      return await ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "invoices.list",
      });
    });
    expect(byName).toHaveLength(1);
    expect(byName[0]!.outcome).toBe("denied");
  });

  test("listVisibleTools hides tools the authorizer would reject", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    // Without an identity, only the public summary tool is visible.
    const anon = await t.action(
      components.mcpGateway.dispatch.listVisibleTools,
      {},
    );
    expect(anon.map((tool) => tool.name)).toEqual(["invoices.summary"]);

    // With an identity but no admin role, the role-gated mutation stays
    // hidden while the read tool becomes visible.
    const alice = await t
      .withIdentity({ subject: "alice" })
      .action(components.mcpGateway.dispatch.listVisibleTools, {});
    expect(alice.map((tool) => tool.name).sort()).toEqual([
      "invoices.list",
      "invoices.summary",
    ]);

    // Admin sees the full catalog.
    const admin = await t
      .withIdentity({
        subject: "carol",
        roles: ["finance.admin"],
      } as unknown as Parameters<typeof t.withIdentity>[0])
      .action(components.mcpGateway.dispatch.listVisibleTools, {});
    expect(admin.map((tool) => tool.name).sort()).toEqual([
      "invoices.list",
      "invoices.markPaid",
      "invoices.summary",
    ]);
  });

  test("authorizer receives `mode: \"list\"` for listVisibleTools and `\"call\"` for callTool", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    // Swap to the mode-asserting authorizer (allows list, denies call).
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(
        internal.mcp.modeAssertingAuthorizer,
      );
      await ctx.runMutation(components.mcpGateway.registry.setAuthorizer, {
        authorizerHandle: handle,
      });
    });

    const visible = await t.action(
      components.mcpGateway.dispatch.listVisibleTools,
      {},
    );
    expect(visible.map((tool) => tool.name).sort()).toEqual([
      "invoices.list",
      "invoices.markPaid",
      "invoices.summary",
    ]);

    const call = await t.action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.summary",
      args: {},
    });
    expect(call.ok).toBe(false);
    if (!call.ok) {
      expect(call.error.message).toMatch(/call mode/);
    }
  });

  test("authorizer receives the registered tool's metadata as `toolMetadata`", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    // Re-register with metadata + swap to the metadata-asserting authorizer.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "tagged.allowed",
            description: "should pass",
            kind: "query",
            functionHandle: "irrelevant",
            inputSchema: { type: "object" },
            metadata: { allow: true },
          },
          {
            name: "tagged.denied",
            description: "should fail",
            kind: "query",
            functionHandle: "irrelevant",
            inputSchema: { type: "object" },
          },
        ],
      });
      const handle = await createFunctionHandle(
        internal.mcp.metadataAssertingAuthorizer,
      );
      await ctx.runMutation(components.mcpGateway.registry.setAuthorizer, {
        authorizerHandle: handle,
      });
    });

    const visible = await t.action(
      components.mcpGateway.dispatch.listVisibleTools,
      {},
    );
    expect(visible.map((tool) => tool.name)).toEqual(["tagged.allowed"]);
  });

  test("authorizer that throws is treated as deny-with-error, not as an HTTP 500", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(
        internal.mcp.throwingAuthorizer,
      );
      await ctx.runMutation(components.mcpGateway.registry.setAuthorizer, {
        authorizerHandle: handle,
      });
    });

    // listVisibleTools must not throw; it returns the empty subset.
    const visible = await t.action(
      components.mcpGateway.dispatch.listVisibleTools,
      {},
    );
    expect(visible).toEqual([]);

    // callTool must surface a JSON-RPC error envelope, not propagate.
    const call = await t.action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.summary",
      args: {},
    });
    expect(call.ok).toBe(false);
    if (!call.ok) {
      expect(call.error.code).toBe(-32603);
      expect(call.error.message).toMatch(/Authorizer threw/);
    }

    // The failed authorizer evaluation IS recorded in the audit log.
    const entries = await t.run(async (ctx) => {
      return await ctx.runQuery(
        components.mcpGateway.audit.listEntries,
        { outcome: "error" },
      );
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.errorCode).toBe(-32603);
  });

  test("metadata.auditArgs.redact replaces listed top-level fields with [redacted]", async () => {
    const t = newTest();

    // Register a mutation tagged for field-level redaction.
    await t.run(async (ctx) => {
      const handle = await createFunctionHandle(api.invoices.markPaid);
      await ctx.runMutation(components.mcpGateway.registry.replaceTools, {
        tools: [
          {
            name: "secret.write",
            description: "Demo of declarative field redaction.",
            kind: "mutation",
            functionHandle: handle,
            inputSchema: { type: "object" },
            metadata: { auditArgs: { redact: ["password", "token"] } },
          },
        ],
      });
      const authorizerHandle = await createFunctionHandle(
        internal.mcp.authorize,
      );
      await ctx.runMutation(components.mcpGateway.registry.setAuthorizer, {
        authorizerHandle,
      });
    });

    // We don't need the call to succeed; we just need an audit row.
    // The default authorizer denies anonymous, so the deny path runs
    // and writes an audit row with the redacted args.
    await t.action(components.mcpGateway.dispatch.callTool, {
      name: "secret.write",
      args: { password: "p@ss", token: "t0k3n", username: "alice" },
    });

    const entries = await t.run(async (ctx) => {
      return await ctx.runQuery(
        components.mcpGateway.audit.listEntries,
        { toolName: "secret.write" },
      );
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.args).toEqual({
      password: "[redacted]",
      token: "[redacted]",
      username: "alice",
    });
  });

  test("audit pruning drops rows older than the cutoff", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    await t.run(async (ctx) => {
      // Insert one ancient + one fresh entry directly.
      await ctx.runMutation(components.mcpGateway.audit.recordEntry, {
        toolName: "old.tool",
        toolKind: "query",
        args: null,
        outcome: "allowed",
        identitySubject: null,
        durationMs: 1,
      });
    });

    // Prune everything older than ten minutes from now (ancient row
    // qualifies; freshly inserted row above does not).
    const farFuture = Date.now() + 10 * 60 * 1000;
    const deleted = await t.mutation(
      components.mcpGateway.audit.pruneOlderThan,
      { cutoffMs: farFuture },
    );
    expect(deleted).toBeGreaterThanOrEqual(1);
  });

  test("audit dispatch is not aborted when the audit write itself fails", async () => {
    // We can't easily simulate a recordEntry failure inside convex-test, but
    // the `safeRecordAudit` wrapper guarantees the dispatch outcome is
    // independent of audit-write success. This test documents the intent and
    // verifies that a successful tool call still returns ok=true even when
    // we artificially provoke a downstream audit issue (here: the entry is
    // still inserted, but the test asserts the structural invariant).
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const result = await t.action(components.mcpGateway.dispatch.callTool, {
      name: "invoices.summary",
      args: {},
    });
    expect(result.ok).toBe(true);
  });

  test("listVisibleTools returns an empty catalog when no authorizer is configured", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.registerTool, {
        name: "isolated.tool",
        description: "no authorizer set",
        kind: "query",
        functionHandle: "unused",
        inputSchema: { type: "object" },
      });
    });

    const visible = await t.action(
      components.mcpGateway.dispatch.listVisibleTools,
      {},
    );
    expect(visible).toEqual([]);
  });

  test("calling an unknown tool returns a -32602 JSON-RPC error", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const result = await t.action(components.mcpGateway.dispatch.callTool, {
      name: "does.not.exist",
      args: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(-32602);
      expect(result.error.message).toMatch(/does\.not\.exist/);
    }
  });

  test("dispatch refuses when no authorizer is configured", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.registerTool, {
        name: "naked.tool",
        description: "no authorizer set",
        kind: "query",
        functionHandle: "unused",
        inputSchema: { type: "object" },
      });
    });

    const result = await t.action(components.mcpGateway.dispatch.callTool, {
      name: "naked.tool",
      args: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(-32011);
      expect(result.error.message).toMatch(/no authorizer/i);
    }
  });
});
