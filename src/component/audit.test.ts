import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { api, internal } from "./_generated/api.js";

describe("audit", () => {
  test("records and filters resource audit entries", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.runMutation(internal.audit.recordResourceEntry, {
        resourceUri: "docs://one",
        resourceOperation: "read",
        args: null,
        outcome: "allowed",
        identitySubject: "user-1",
        durationMs: 12,
      });
      await ctx.runMutation(internal.audit.recordResourceEntry, {
        resourceUri: "docs://one",
        resourceOperation: "read",
        args: null,
        outcome: "error",
        identitySubject: "user-1",
        durationMs: 7,
        errorCode: -32603,
        errorMessage: "read failed",
      });
      await ctx.runMutation(internal.audit.recordResourceEntry, {
        resourceUri: "docs://two",
        resourceOperation: "list",
        args: { resourceCount: 2 },
        outcome: "allowed",
        identitySubject: "user-1",
        durationMs: 3,
      });

      const docsOne = await ctx.runQuery(api.audit.listEntries, {
        resourceUri: "docs://one",
      });
      expect(docsOne).toHaveLength(2);
      expect(docsOne.map((entry) => entry.resourceUri)).toEqual([
        "docs://one",
        "docs://one",
      ]);

      const resourceErrors = await ctx.runQuery(api.audit.listEntries, {
        entryType: "resource",
        outcome: "error",
      });
      expect(resourceErrors).toMatchObject([
        {
          entryType: "resource",
          resourceUri: "docs://one",
          resourceOperation: "read",
          outcome: "error",
          errorMessage: "read failed",
        },
      ]);
    });
  });
});
