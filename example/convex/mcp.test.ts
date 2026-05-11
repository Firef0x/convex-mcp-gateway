/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema.js";
import { components, internal } from "./_generated/api.js";

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
