import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { api } from "./_generated/api.js";

describe("registry", () => {
  test("registerTool inserts and is idempotent on name", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "invoices.list",
        description: "first",
        kind: "query",
        functionHandle: "fakehandle-1",
        inputSchema: { type: "object" },
      });

      let tools = await ctx.runQuery(api.registry.listTools, {});
      expect(tools).toHaveLength(1);
      expect(tools[0]!.description).toBe("first");

      await ctx.runMutation(api.registry.registerTool, {
        name: "invoices.list",
        description: "second",
        kind: "query",
        functionHandle: "fakehandle-2",
        inputSchema: { type: "object" },
      });

      tools = await ctx.runQuery(api.registry.listTools, {});
      expect(tools).toHaveLength(1);
      expect(tools[0]!.description).toBe("second");
      expect(tools[0]!.functionHandle).toBe("fakehandle-2");
    });
  });

  test("getTool returns null for unknown names", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const tool = await ctx.runQuery(api.registry.getTool, {
        name: "does-not-exist",
      });
      expect(tool).toBeNull();
    });
  });

  test("unregisterTool removes the row and reports whether it existed", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "tmp.tool",
        description: "tmp",
        kind: "mutation",
        functionHandle: "fakehandle",
        inputSchema: { type: "object" },
      });

      const removedExisting = await ctx.runMutation(
        api.registry.unregisterTool,
        { name: "tmp.tool" },
      );
      expect(removedExisting).toBe(true);

      const removedMissing = await ctx.runMutation(
        api.registry.unregisterTool,
        { name: "tmp.tool" },
      );
      expect(removedMissing).toBe(false);

      const tools = await ctx.runQuery(api.registry.listTools, {});
      expect(tools).toHaveLength(0);
    });
  });

  test("internalListTools is callable via internal", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "a",
        description: "a",
        kind: "query",
        functionHandle: "fakehandle",
        inputSchema: { type: "object" },
      });
      const tools = await ctx.runQuery(api.registry.listTools, {});
      expect(tools).toHaveLength(1);
    });
  });

  test("clearAll removes all tools", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const name of ["one", "two", "three"]) {
        await ctx.runMutation(api.registry.registerTool, {
          name,
          description: name,
          kind: "query",
          functionHandle: "fakehandle",
          inputSchema: { type: "object" },
        });
      }
      expect(await ctx.runQuery(api.registry.listTools, {})).toHaveLength(3);
      await ctx.runMutation(api.registry.clearAll, {});
      expect(await ctx.runQuery(api.registry.listTools, {})).toHaveLength(0);
    });
  });

  test("setAuthorizer persists a singleton config row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // unset by default
      let handle = await ctx.runQuery(
        api.registry.getAuthorizer,
        {},
      );
      expect(handle).toBeNull();

      await ctx.runMutation(api.registry.setAuthorizer, {
        authorizerHandle: "fake-authorizer-handle",
      });
      handle = await ctx.runQuery(api.registry.getAuthorizer, {});
      expect(handle).toBe("fake-authorizer-handle");

      // replace
      await ctx.runMutation(api.registry.setAuthorizer, {
        authorizerHandle: "second-handle",
      });
      handle = await ctx.runQuery(api.registry.getAuthorizer, {});
      expect(handle).toBe("second-handle");

      // clear
      await ctx.runMutation(api.registry.setAuthorizer, {
        authorizerHandle: null,
      });
      handle = await ctx.runQuery(api.registry.getAuthorizer, {});
      expect(handle).toBeNull();
    });
  });
});
