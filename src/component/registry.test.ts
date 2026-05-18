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
        name: "invoices_list",
        description: "first",
        kind: "query",
        functionHandle: "fakehandle-1",
        inputSchema: { type: "object" },
      });

      let tools = await ctx.runQuery(api.registry.listTools, {});
      expect(tools).toHaveLength(1);
      expect(tools[0]!.description).toBe("first");

      await ctx.runMutation(api.registry.registerTool, {
        name: "invoices_list",
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

  test("replaceTools rejects duplicate names in the input array", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await expect(
        ctx.runMutation(api.registry.replaceTools, {
          tools: [
            {
              name: "dup",
              description: "first",
              kind: "query",
              functionHandle: "handle-a",
              inputSchema: { type: "object" },
            },
            {
              name: "dup",
              description: "second",
              kind: "mutation",
              functionHandle: "handle-b",
              inputSchema: { type: "object" },
            },
          ],
        }),
      ).rejects.toThrow(/duplicate tool names/);
    });
  });

  test("clearAllTools removes all tools", async () => {
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
      await ctx.runMutation(api.registry.clearAllTools, {});
      expect(await ctx.runQuery(api.registry.listTools, {})).toHaveLength(0);
    });
  });

  test("registerTool clears metadata when the upsert omits it (db.replace, not patch)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.registerTool, {
        name: "scoped",
        description: "with scopes",
        kind: "query",
        functionHandle: "h",
        inputSchema: { type: "object" },
        metadata: { scopes: ["finance:read"] },
      });
      let tool = await ctx.runQuery(api.registry.getTool, { name: "scoped" });
      expect(tool?.metadata).toEqual({ scopes: ["finance:read"] });

      // Re-register the same name without metadata: the prior scopes must
      // not silently survive (regression for db.patch ignoring missing fields).
      await ctx.runMutation(api.registry.registerTool, {
        name: "scoped",
        description: "no longer scoped",
        kind: "query",
        functionHandle: "h",
        inputSchema: { type: "object" },
      });
      tool = await ctx.runQuery(api.registry.getTool, { name: "scoped" });
      expect(tool?.description).toBe("no longer scoped");
      expect(tool?.metadata).toBeUndefined();
    });
  });

  test("replaceTools round-trips metadata and clears it when omitted", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(api.registry.replaceTools, {
        tools: [
          {
            name: "x",
            description: "v1",
            kind: "query",
            functionHandle: "h",
            inputSchema: { type: "object" },
            metadata: { scopes: ["s"], roles: ["r"] },
          },
        ],
      });
      let row = await ctx.runQuery(api.registry.getTool, { name: "x" });
      expect(row?.metadata).toEqual({ scopes: ["s"], roles: ["r"] });

      // Re-register x without metadata: db.replace must clear it.
      await ctx.runMutation(api.registry.replaceTools, {
        tools: [
          {
            name: "x",
            description: "v2",
            kind: "query",
            functionHandle: "h",
            inputSchema: { type: "object" },
          },
        ],
      });
      row = await ctx.runQuery(api.registry.getTool, { name: "x" });
      expect(row?.description).toBe("v2");
      expect(row?.metadata).toBeUndefined();
    });
  });

  test("replaceTools deletes tools not in the incoming set and upserts the rest", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const name of ["alpha", "beta", "gamma"]) {
        await ctx.runMutation(api.registry.registerTool, {
          name,
          description: "stale",
          kind: "query",
          functionHandle: "stale-handle",
          inputSchema: { type: "object" },
        });
      }
      expect(await ctx.runQuery(api.registry.listTools, {})).toHaveLength(3);

      await ctx.runMutation(api.registry.replaceTools, {
        tools: [
          {
            name: "beta",
            description: "fresh-beta",
            kind: "mutation",
            functionHandle: "fresh-handle",
            inputSchema: { type: "object" },
          },
          {
            name: "delta",
            description: "fresh-delta",
            kind: "query",
            functionHandle: "fresh-handle-2",
            inputSchema: { type: "object" },
          },
        ],
      });

      const after = await ctx.runQuery(api.registry.listTools, {});
      const names = after.map((t) => t.name).sort();
      expect(names).toEqual(["beta", "delta"]);
      const beta = after.find((t) => t.name === "beta")!;
      expect(beta.description).toBe("fresh-beta");
      expect(beta.kind).toBe("mutation");
      expect(beta.functionHandle).toBe("fresh-handle");
    });
  });

  test("setOAuthConfig writes the issuer + optional resource into config", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(
        await ctx.runQuery(api.registry.getOAuthConfig, {}),
      ).toBeNull();

      await ctx.runMutation(api.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
      });
      const justAS = await ctx.runQuery(api.registry.getOAuthConfig, {});
      expect(justAS).toEqual({
        authServerUrl: "https://idp.example.com/",
        resourceUrl: null,
      });

      await ctx.runMutation(api.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
        resourceUrl: "https://app.example.com/mcp/",
      });
      const both = await ctx.runQuery(api.registry.getOAuthConfig, {});
      expect(both).toEqual({
        authServerUrl: "https://idp.example.com/",
        resourceUrl: "https://app.example.com/mcp/",
      });

      // Disable discovery again.
      await ctx.runMutation(api.registry.setOAuthConfig, {
        authServerUrl: null,
      });
      expect(
        await ctx.runQuery(api.registry.getOAuthConfig, {}),
      ).toBeNull();

      // Re-enabling without resourceUrl must NOT resurrect the previously
      // set resourceUrl (regression for db.patch ignoring undefined).
      await ctx.runMutation(api.registry.setOAuthConfig, {
        authServerUrl: "https://idp2.example.com/",
      });
      const reEnabled = await ctx.runQuery(api.registry.getOAuthConfig, {});
      expect(reEnabled).toEqual({
        authServerUrl: "https://idp2.example.com/",
        resourceUrl: null,
      });
    });
  });

  test("setOAuthConfig rejects non-URL strings instead of failing later", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await expect(
        ctx.runMutation(api.registry.setOAuthConfig, {
          authServerUrl: "not-a-url",
        }),
      ).rejects.toThrow(/authServerUrl/);

      await expect(
        ctx.runMutation(api.registry.setOAuthConfig, {
          authServerUrl: "https://idp.example.com/",
          resourceUrl: "also-bad",
        }),
      ).rejects.toThrow(/resourceUrl/);

      // Non-http schemes are also rejected.
      await expect(
        ctx.runMutation(api.registry.setOAuthConfig, {
          authServerUrl: "javascript:alert(1)",
        }),
      ).rejects.toThrow(/http or https/);
    });
  });

});
