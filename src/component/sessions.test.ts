import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { internal } from "./_generated/api.js";

describe("sessions", () => {
  test("createSession + getSession round-trip", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const id = await ctx.runMutation(internal.sessions.createSession, {
        sessionId: "deadbeef",
        protocolVersion: "2025-06-18",
      });
      expect(id).toBeTypeOf("string");

      const session = await ctx.runQuery(internal.sessions.getSession, {
        sessionId: "deadbeef",
      });
      expect(session?.sessionId).toBe("deadbeef");
      expect(session?.protocolVersion).toBe("2025-06-18");
      expect(session?.createdAt).toBe(session?.lastSeenAt);
    });
  });

  test("getSession returns null for unknown ids", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      expect(
        await ctx.runQuery(internal.sessions.getSession, {
          sessionId: "nope",
        }),
      ).toBeNull();
    });
  });

  test("touchSession updates lastSeenAt and reports presence", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // Establish a session, then advance the wall clock and touch it.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      await ctx.runMutation(internal.sessions.createSession, {
        sessionId: "s1",
        protocolVersion: "2025-06-18",
      });
      const before = await ctx.runQuery(internal.sessions.getSession, {
        sessionId: "s1",
      });

      vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
      const touched = await ctx.runMutation(internal.sessions.touchSession, {
        sessionId: "s1",
      });
      expect(touched).toBe(true);

      const after = await ctx.runQuery(internal.sessions.getSession, {
        sessionId: "s1",
      });
      expect(after?.lastSeenAt).toBeGreaterThan(before!.lastSeenAt);
      expect(after?.createdAt).toBe(before!.createdAt);
      vi.useRealTimers();

      // Touching an unknown session is a no-op that reports false.
      expect(
        await ctx.runMutation(internal.sessions.touchSession, {
          sessionId: "ghost",
        }),
      ).toBe(false);
    });
  });

  test("deleteSession removes the row and reports whether it existed", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.sessions.createSession, {
        sessionId: "tmp",
        protocolVersion: "2025-06-18",
      });
      expect(
        await ctx.runMutation(internal.sessions.deleteSession, {
          sessionId: "tmp",
        }),
      ).toBe(true);
      expect(
        await ctx.runQuery(internal.sessions.getSession, { sessionId: "tmp" }),
      ).toBeNull();
      expect(
        await ctx.runMutation(internal.sessions.deleteSession, {
          sessionId: "tmp",
        }),
      ).toBe(false);
    });
  });

  test("pruneSessions deletes rows older than the cutoff and keeps newer ones", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      await ctx.runMutation(internal.sessions.createSession, {
        sessionId: "old",
        protocolVersion: "2025-06-18",
      });

      // Advance 2 hours; 'old' is now stale, create a 'fresh' session.
      vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
      await ctx.runMutation(internal.sessions.createSession, {
        sessionId: "fresh",
        protocolVersion: "2025-06-18",
      });

      // Prune anything older than 1 hour.
      const deleted = await ctx.runMutation(internal.sessions.pruneSessions, {
        olderThanMs: 60 * 60 * 1000,
      });
      expect(deleted).toBe(1);
      expect(
        await ctx.runQuery(internal.sessions.getSession, { sessionId: "old" }),
      ).toBeNull();
      expect(
        await ctx.runQuery(internal.sessions.getSession, { sessionId: "fresh" }),
      ).not.toBeNull();
      vi.useRealTimers();
    });
  });
});
