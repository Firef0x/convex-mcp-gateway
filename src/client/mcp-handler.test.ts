import { describe, expect, test } from "vitest";
import type { ComponentApi } from "../component/_generated/component.js";
import { defineMcpResource, McpGateway } from "./index.js";
import { handleMcpRequest, type McpResourceProvider } from "./mcp-handler.js";

function createComponent() {
  return {
    sessions: {
      createSession: Symbol("createSession"),
      getSession: Symbol("getSession"),
      touchSession: Symbol("touchSession"),
    },
    registry: {
      getOAuthConfig: Symbol("getOAuthConfig"),
      listTools: Symbol("listTools"),
      listResources: Symbol("listResources"),
      getResourcesFingerprint: Symbol("getResourcesFingerprint"),
      replaceResources: Symbol("replaceResources"),
    },
    audit: {
      recordResourceEntry: Symbol("recordResourceEntry"),
    },
  } as unknown as ComponentApi;
}

function createCtx(component: ComponentApi) {
  let resourcesFingerprint: string | null = null;
  let resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    metadata?: unknown;
  }> = [];
  const resourceAuditEntries: Record<string, unknown>[] = [];
  const sessions = new Map<
    string,
    {
      sessionId: string;
      protocolVersion: string;
      identitySubject: string | null;
    }
  >();

  return {
    sessions,
    ctx: {
      runQuery: async (ref: unknown, args: Record<string, unknown>) => {
        if (ref === component.sessions.getSession) {
          return sessions.get(String(args.sessionId)) ?? null;
        }
        if (ref === component.registry.getOAuthConfig) {
          return null;
        }
        if (ref === component.registry.listTools) {
          return [];
        }
        if (ref === component.registry.listResources) {
          return resources;
        }
        if (ref === component.registry.getResourcesFingerprint) {
          return resourcesFingerprint;
        }
        throw new Error("unexpected query");
      },
      runMutation: async (ref: unknown, args: Record<string, unknown>) => {
        if (ref === component.sessions.createSession) {
          sessions.set(String(args.sessionId), {
            sessionId: String(args.sessionId),
            protocolVersion: String(args.protocolVersion),
            identitySubject:
              typeof args.identitySubject === "string"
                ? args.identitySubject
                : null,
          });
          return args.sessionId;
        }
        if (ref === component.sessions.touchSession) {
          return sessions.has(String(args.sessionId));
        }
        if (ref === component.registry.replaceResources) {
          resources = (
            args.resources as Array<{
              uri: string;
              name: string;
              description?: string;
              mimeType?: string;
              metadata?: unknown;
            }>
          ).map((resource) => ({ ...resource }));
          resourcesFingerprint =
            typeof args.fingerprint === "string" ? args.fingerprint : null;
          return null;
        }
        if (ref === component.audit.recordResourceEntry) {
          resourceAuditEntries.push({ ...args });
          return "audit-id";
        }
        throw new Error("unexpected mutation");
      },
      runAction: async () => {
        throw new Error("unexpected action");
      },
      auth: {
        getUserIdentity: async () => ({
          subject: "user-1",
          email: "user@example.com",
        }),
      },
    },
    get resources() {
      return resources;
    },
    resourceAuditEntries,
  };
}

function jsonRpcRequest(
  body: Record<string, unknown>,
  sessionId?: string,
): Request {
  return new Request("https://app.example.com/mcp/", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
}

async function readJson(response: Response) {
  return (await response.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

describe("handleMcpRequest resources", () => {
  test("advertises resources capability and initialize instructions", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);

    const response = await handleMcpRequest(
      ctx,
      jsonRpcRequest({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [
          {
            name: "docs",
            list: async () => [],
            read: async () => null,
          },
        ],
        initializeInstructions: "Use resources/list to discover references.",
      },
    );

    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    const body = await readJson(response);
    expect(body.result?.capabilities).toEqual({
      tools: {},
      resources: {},
    });
    expect(body.result?.instructions).toBe(
      "Use resources/list to discover references.",
    );
  });

  test("serves resources/list and resources/read through providers", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const provider: McpResourceProvider = {
      name: "docs",
      list: async (_ctx, args) => [
        {
          uri: `skill://${args.identity.subject}/overview`,
          name: "Overview",
          description: "Tenant skill overview",
          mimeType: "application/json",
        },
      ],
      read: async (_ctx, args) =>
        args.uri === "skill://user-1/overview"
          ? [
              {
                uri: args.uri,
                mimeType: "application/json",
                text: JSON.stringify({ ok: true }),
              },
            ]
          : null,
    };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [provider],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [provider],
      },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "skill://user-1/overview",
            name: "Overview",
            description: "Tenant skill overview",
            mimeType: "application/json",
          },
        ],
      },
    });

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "skill://user-1/overview" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [provider],
      },
    );
    expect(await readJson(read)).toMatchObject({
      result: {
        contents: [
          {
            uri: "skill://user-1/overview",
            mimeType: "application/json",
            text: '{"ok":true}',
          },
        ],
      },
    });
  });

  test("serves resources declared with defineMcpResource", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://tenant-handbook",
      name: "Tenant Handbook",
      description: "Operator handbook",
      mimeType: "text/markdown",
      read: async (_ctx, args) => [
        {
          uri: args.uri,
          mimeType: "text/markdown",
          text: "# Tenant Handbook",
        },
      ],
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://tenant-handbook",
            name: "Tenant Handbook",
            description: "Operator handbook",
            mimeType: "text/markdown",
          },
        ],
      },
    });

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "docs://tenant-handbook" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    expect(await readJson(read)).toMatchObject({
      result: {
        contents: [
          {
            uri: "docs://tenant-handbook",
            mimeType: "text/markdown",
            text: "# Tenant Handbook",
          },
        ],
      },
    });
  });

  test("lists resources persisted in the registry", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const gateway = new McpGateway(component);

    const init = await gateway.handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [
          defineMcpResource({
            uri: "docs://registered",
            name: "Registered",
            read: async () => [
              { uri: "docs://registered", text: "registered" },
            ],
          }),
        ],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
      },
    );
    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://registered",
            name: "Registered",
          },
        ],
      },
    });

    const readWithoutProvider = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "docs://registered" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
      },
    );
    expect(await readJson(readWithoutProvider)).toMatchObject({
      error: { code: -32602, message: "Resource not found: docs://registered" },
    });
  });

  test("McpGateway declaratively syncs static resources on initialize", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);
    const resource = defineMcpResource({
      uri: "docs://synced",
      name: "Synced",
      description: "Synced docs",
      mimeType: "text/plain",
      read: async () => [{ uri: "docs://synced", text: "ok" }],
    });

    const response = await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );

    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    expect(state.resources).toEqual([
      {
        uri: "docs://synced",
        name: "Synced",
        description: "Synced docs",
        mimeType: "text/plain",
      },
    ]);
  });

  test("McpGateway clears stale declarative resources when resources is empty", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);

    await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [
          defineMcpResource({
            uri: "docs://stale",
            name: "Stale",
            read: async () => [{ uri: "docs://stale", text: "old" }],
          }),
        ],
      },
    );
    expect(state.resources).toHaveLength(1);

    await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [],
      },
    );

    expect(state.resources).toEqual([]);
  });

  test("authorizeResource filters resources/list per resource", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const gateway = new McpGateway(component);

    const init = await gateway.handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      {
        authorize: async () => ({ allowed: true }),
        resources: [
          defineMcpResource({
            uri: "docs://public",
            name: "Public",
            metadata: { scope: "public" },
            read: async () => [{ uri: "docs://public", text: "public" }],
          }),
          defineMcpResource({
            uri: "docs://private",
            name: "Private",
            metadata: { scope: "private" },
            read: async () => [{ uri: "docs://private", text: "private" }],
          }),
        ],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const seen: Array<{ uri: string; metadata: unknown }> = [];
    const list = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        authorizeResource: async (_ctx, args) => {
          seen.push({
            uri: args.resourceUri,
            metadata: args.resourceMetadata,
          });
          return {
            allowed:
              (args.resourceMetadata as { scope?: string } | null)?.scope !==
              "private",
          };
        },
      },
    );

    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://public",
            name: "Public",
          },
        ],
      },
    });
    expect(seen).toEqual([
      { uri: "docs://public", metadata: { scope: "public" } },
      { uri: "docs://private", metadata: { scope: "private" } },
    ]);
  });

  test("authorizeResource denies resources/read before provider execution", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    let readCalls = 0;
    const resource = defineMcpResource({
      uri: "docs://secret",
      name: "Secret",
      read: async () => {
        readCalls += 1;
        return [{ uri: "docs://secret", text: "secret" }];
      },
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://secret" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
        authorizeResource: async () => ({
          allowed: false,
          reason: "Forbidden: missing scope",
        }),
      },
    );

    expect(await readJson(read)).toMatchObject({
      error: { code: -32003, message: "Forbidden: missing scope" },
    });
    expect(readCalls).toBe(0);
  });

  test("authorizeResource throw hides only that resource during resources/list", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resources = [
      defineMcpResource({
        uri: "docs://ok",
        name: "OK",
        read: async () => [{ uri: "docs://ok", text: "ok" }],
      }),
      defineMcpResource({
        uri: "docs://throws",
        name: "Throws",
        read: async () => [{ uri: "docs://throws", text: "throws" }],
      }),
    ];

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
        authorizeResource: async (_ctx, args) => {
          if (args.resourceUri === "docs://throws") {
            throw new Error("policy failed");
          }
          return { allowed: true };
        },
      },
    );

    expect(await readJson(list)).toMatchObject({
      result: {
        resources: [
          {
            uri: "docs://ok",
            name: "OK",
          },
        ],
      },
    });
  });

  test("resource audit is opt-in and does not store read contents", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://audited",
      name: "Audited",
      read: async () => [
        {
          uri: "docs://audited",
          mimeType: "text/plain",
          text: "sensitive content",
        },
      ],
    });

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://audited" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    expect(state.resourceAuditEntries).toEqual([]);

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "docs://audited" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
        auditResources: { read: true },
      },
    );

    expect(state.resourceAuditEntries).toMatchObject([
      {
        resourceUri: "docs://audited",
        resourceOperation: "read",
        args: null,
        outcome: "allowed",
        identitySubject: "user-1",
      },
    ]);
    expect(JSON.stringify(state.resourceAuditEntries)).not.toContain(
      "sensitive content",
    );
  });

  test("resource audit records denied reads before provider execution", async () => {
    const component = createComponent();
    const state = createCtx(component);
    let readCalls = 0;
    const resource = defineMcpResource({
      uri: "docs://denied-audit",
      name: "Denied Audit",
      read: async () => {
        readCalls += 1;
        return [{ uri: "docs://denied-audit", text: "secret" }];
      },
    });

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://denied-audit" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
        auditResources: true,
        authorizeResource: async () => ({
          allowed: false,
          reason: "Forbidden: no scope",
        }),
      },
    );

    expect(readCalls).toBe(0);
    expect(state.resourceAuditEntries).toMatchObject([
      {
        resourceUri: "docs://denied-audit",
        resourceOperation: "read",
        args: null,
        outcome: "denied",
        identitySubject: "user-1",
        errorCode: -32003,
        errorMessage: "Forbidden: no scope",
      },
    ]);
  });

  test("resource audit records list summaries and read errors", async () => {
    const component = createComponent();
    const state = createCtx(component);
    const resources = [
      defineMcpResource({
        uri: "docs://one",
        name: "One",
        read: async () => {
          throw new Error("read failed");
        },
      }),
      defineMcpResource({
        uri: "docs://two",
        name: "Two",
        read: async () => [{ uri: "docs://two", text: "two" }],
      }),
    ];

    const init = await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
        auditResources: { list: true },
      },
    );

    await handleMcpRequest(
      state.ctx,
      jsonRpcRequest(
        {
          id: 3,
          method: "resources/read",
          params: { uri: "docs://one" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources,
        auditResources: { read: true },
      },
    );

    expect(state.resourceAuditEntries).toMatchObject([
      {
        resourceOperation: "list",
        args: { resourceCount: 2 },
        outcome: "allowed",
        identitySubject: "user-1",
      },
      {
        resourceUri: "docs://one",
        resourceOperation: "read",
        args: null,
        outcome: "error",
        identitySubject: "user-1",
        errorCode: -32603,
        errorMessage: "read failed",
      },
    ]);
  });

  test("returns a JSON-RPC error when a resource read handler throws", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const resource = defineMcpResource({
      uri: "docs://broken",
      name: "Broken",
      read: async () => {
        throw new Error("read failed");
      },
    });

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        {
          id: 2,
          method: "resources/read",
          params: { uri: "docs://broken" },
        },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [resource],
      },
    );
    expect(await readJson(read)).toMatchObject({
      error: { code: -32603, message: "read failed" },
    });
  });

  test("resources/list isolates a throwing provider from healthy ones", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const broken: McpResourceProvider = {
      name: "broken",
      list: async () => {
        throw new Error("provider exploded");
      },
      read: async () => null,
    };
    const healthy: McpResourceProvider = {
      name: "healthy",
      list: async () => [{ uri: "docs://ok", name: "OK" }],
      read: async () => null,
    };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [broken, healthy],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const list = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 2, method: "resources/list" }, sessionId!),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [broken, healthy],
      },
    );
    // The broken provider's throw must not collapse the whole catalog;
    // the healthy provider's resource is still listed.
    expect(await readJson(list)).toMatchObject({
      result: { resources: [{ uri: "docs://ok", name: "OK" }] },
    });
  });

  test("resources/read: a throwing provider does not mask a later provider", async () => {
    const component = createComponent();
    const { ctx } = createCtx(component);
    const broken: McpResourceProvider = {
      name: "broken",
      list: async () => [],
      read: async () => {
        throw new Error("provider exploded");
      },
    };
    const healthy: McpResourceProvider = {
      name: "healthy",
      list: async () => [],
      read: async (_ctx, args) =>
        args.uri === "docs://served"
          ? [{ uri: args.uri, text: "served" }]
          : null,
    };

    const init = await handleMcpRequest(
      ctx,
      jsonRpcRequest({ id: 1, method: "initialize" }),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [broken, healthy],
      },
    );
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const read = await handleMcpRequest(
      ctx,
      jsonRpcRequest(
        { id: 2, method: "resources/read", params: { uri: "docs://served" } },
        sessionId!,
      ),
      component,
      {
        authorize: async () => ({ allowed: true }),
        resources: [broken, healthy],
      },
    );
    // The first provider throwing must not abort the read: the second
    // provider still serves the resource.
    expect(await readJson(read)).toMatchObject({
      result: { contents: [{ uri: "docs://served", text: "served" }] },
    });
  });
});
