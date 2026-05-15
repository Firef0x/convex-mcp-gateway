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

// =================================================================
// Component-level tests: dispatch.runTool runs whatever you give it
// (no auth in the component; auth lives in the host's HTTP handler).
// =================================================================

describe("dispatch.runTool", () => {
  test("runs a registered tool and returns its data", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await t.run(async (ctx) => {
      await ctx.db.insert("invoices", { status: "open", amount: 7 });
    });

    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices.summary",
      args: {},
      auditIdentitySubject: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ total: 1 });
  });

  test("unknown tool returns -32602 and writes no audit row", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const result = await t.action(components.mcpGateway.dispatch.runTool, {
      name: "no.such.tool",
      args: {},
      auditIdentitySubject: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(-32602);
      expect(result.error.message).toMatch(/no\.such\.tool/);
    }

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    expect(entries.find((e) => e.toolName === "no.such.tool")).toBeUndefined();
  });

  test("writes audit row with auditIdentitySubject for allowed calls", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    await t.action(components.mcpGateway.dispatch.runTool, {
      name: "invoices.summary",
      args: {},
      auditIdentitySubject: "alice",
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    const row = entries.find((e) => e.toolName === "invoices.summary");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("allowed");
    expect(row?.identitySubject).toBe("alice");
  });

  test("metadata.auditArgs.redact replaces listed top-level fields", async () => {
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
    });

    // The dispatch will fail because invoices.markPaid expects an `id`,
    // but the audit row is written either way. We're testing redaction,
    // not success.
    await t.action(components.mcpGateway.dispatch.runTool, {
      name: "secret.write",
      args: { password: "p@ss", token: "t0k3n", username: "alice" },
      auditIdentitySubject: null,
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "secret.write",
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.args).toEqual({
      password: "[redacted]",
      token: "[redacted]",
      username: "alice",
    });
  });
});

// =================================================================
// dispatch.recordAuthDenial: hosts call this when the authorize
// callback returns allowed=false so the audit log captures rejections.
// =================================================================

describe("dispatch.recordAuthDenial", () => {
  test("writes a denied audit row for a known tool", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    await t.action(components.mcpGateway.dispatch.recordAuthDenial, {
      name: "invoices.list",
      args: { status: "open" },
      auditIdentitySubject: null,
      outcome: "denied",
      errorCode: -32001,
      errorMessage: "Unauthorized",
      durationMs: 3,
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    expect(entries.find((e) => e.toolName === "invoices.list")).toMatchObject({
      outcome: "denied",
      errorCode: -32001,
      errorMessage: "Unauthorized",
      identitySubject: null,
    });
  });
});

// =================================================================
// End-to-end via t.fetch through the host's http.ts. Verifies the
// integrated Streamable-HTTP flow including session lifecycle,
// content negotiation, and the host's authorize callback.
// =================================================================

async function initialize(t: ReturnType<typeof newTest>): Promise<string> {
  const res = await t.fetch("/mcp/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function rpc(
  t: ReturnType<typeof newTest>,
  sessionId: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await t.fetch("/mcp/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("HTTP envelope (host-mounted /mcp/)", () => {
  test("POST without session id returns 400", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("initialize returns Mcp-Session-Id header", async () => {
    const t = newTest();
    const session = await initialize(t);
    expect(session).toMatch(/^[0-9a-f]{32}$/);
  });

  test("DELETE terminates session, subsequent request returns 404", async () => {
    const t = newTest();
    const session = await initialize(t);
    const del = await t.fetch("/mcp/", {
      method: "DELETE",
      headers: { "mcp-session-id": session },
    });
    expect(del.status).toBe(200);

    const next = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/list",
    });
    expect(next.status).toBe(404);
  });

  test("GET /mcp/ returns 405 with allow header", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  test("OPTIONS preflight returns CORS headers when cors: true", async () => {
    const t = newTest();
    const res = await t.fetch("/mcp/", {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "content-type",
    );
    expect(res.headers.get("access-control-expose-headers")).toContain(
      "mcp-session-id",
    );
  });

  test("POST responses include CORS headers when cors: true", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://claude.ai",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toContain(
      "mcp-session-id",
    );
  });

  test("Accept: text/event-stream returns SSE-framed response", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    const res = await rpc(
      t,
      session,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "invoices.summary", arguments: {} },
      },
      { accept: "application/json, text/event-stream" },
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toMatch(/^id: 1\nevent: message\ndata: /);
    expect(text).toContain('"jsonrpc":"2.0"');
  });
});

describe("authorize callback (host's http.ts)", () => {
  test("anonymous tools/list shows only public tools", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "invoices.summary",
    ]);
  });

  test("anonymous tools/call on a public tool succeeds", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "invoices.summary", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: unknown } };
    expect(body.result.content).toBeDefined();
  });

  test("anonymous tools/call on a private tool returns 401 + WWW-Authenticate", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    // Configure OAuth so the 401 carries the discovery header.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.registry.setOAuthConfig, {
        authServerUrl: "https://idp.example.com/",
      });
    });

    const session = await initialize(t);
    const res = await rpc(t, session, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "invoices.list", arguments: {} },
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toMatch(/^Bearer resource_metadata="/);
  });

  test("authenticated tools/list shows the full catalog the user can call", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});

    const session = await initialize(
      t.withIdentity({ subject: "alice" }) as ReturnType<typeof newTest>,
    );
    const res = await (t.withIdentity({ subject: "alice" }) as ReturnType<
      typeof newTest
    >).fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
      }),
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    // alice has no admin role → markPaid is hidden, list + summary visible.
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "invoices.list",
      "invoices.summary",
    ]);
  });

  test("admin sees the full catalog including the role-gated mutation", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const tWithRoles = t.withIdentity({
      subject: "carol",
      roles: ["finance.admin"],
    } as unknown as Parameters<typeof t.withIdentity>[0]) as ReturnType<
      typeof newTest
    >;

    const session = await initialize(tWithRoles);
    const res = await tWithRoles.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
      }),
    });
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "invoices.list",
      "invoices.markPaid",
      "invoices.summary",
    ]);
  });

  test("audit log records denied calls (subject + reason)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);

    await rpc(t, session, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "invoices.list", arguments: {} },
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    const denied = entries.find(
      (e) => e.toolName === "invoices.list" && e.outcome === "denied",
    );
    expect(denied).toBeDefined();
    expect(denied?.errorCode).toBe(-32001);
    expect(denied?.identitySubject).toBeNull();
  });

  test("audit log skips unknown-tool calls (anti-DoS)", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);

    await rpc(t, session, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "does.not.exist", arguments: {} },
    });

    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    expect(
      entries.find((e) => e.toolName === "does.not.exist"),
    ).toBeUndefined();
  });
});

describe("OAuth bridge mode (DCR + AS metadata + tokenValidator)", () => {
  test("handleClientRegistration returns the configured upstream client_id", async () => {
    const t = newTest();
    const res = await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "claude.ai",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; redirect_uris: string[] };
    expect(body.client_id).toBe("upstream-client-id-fixed");
    expect(body.redirect_uris).toEqual([
      "https://claude.ai/api/mcp/auth_callback",
    ]);
  });

  test("handleClientRegistration rejects redirect_uris outside the allowlist", async () => {
    const t = newTest();
    const res = await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "evil",
        redirect_uris: ["https://attacker.example.com/callback"],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  test("tokenValidator path: identity from validator, not Convex auth", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    const session = await initialize(t);
    // The host's mcpHandler routes through `tokenValidator` when a Bearer
    // is present. The example wires it to accept the literal token
    // "valid-userinfo-token" → subject "validator-resolved-sub".
    const res = await t.fetch("/mcp/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": session,
        authorization: "Bearer valid-userinfo-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "invoices.list", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    const entries = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {}),
    );
    const row = entries.find((e) => e.toolName === "invoices.list");
    expect(row?.identitySubject).toBe("validator-resolved-sub");
  });
});

describe("audit listEntries (filter regression coverage)", () => {
  test("finds older matches when newer entries don't match the outcome filter", async () => {
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
      // 50 recent allowed rows hide the errors past any small window.
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

    const errors = await t.run(async (ctx) =>
      ctx.runQuery(components.mcpGateway.audit.listEntries, {
        toolName: "x",
        outcome: "error",
        limit: 10,
      }),
    );
    expect(errors).toHaveLength(3);
  });

  test("audit pruning drops rows older than the cutoff", async () => {
    const t = newTest();
    await t.mutation(internal.mcp.registerDefaults, {});
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcpGateway.audit.recordEntry, {
        toolName: "old.tool",
        toolKind: "query",
        args: null,
        outcome: "allowed",
        identitySubject: null,
        durationMs: 1,
      });
    });
    const farFuture = Date.now() + 10 * 60 * 1000;
    const deleted = await t.mutation(
      components.mcpGateway.audit.pruneOlderThan,
      { cutoffMs: farFuture },
    );
    expect(deleted).toBeGreaterThanOrEqual(1);
  });
});
