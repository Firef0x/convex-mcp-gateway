import { describe, expect, test } from "vitest";
import type { ComponentApi } from "../component/_generated/component.js";
import { handleMcpRequest, inputRequired } from "./mcp-handler.js";

const tool = {
  name: "confirm-delete",
  description: "Deletes after confirmation",
  kind: "mutation" as const,
  functionHandle: "function-handle",
  inputSchema: { type: "object" },
  mrtrArgs: {
    state: "continuationState",
    inputResponses: "continuationResponses",
    idempotencyKey: "continuationKey",
  },
};

function component() {
  return {
    registry: { getTool: Symbol("getTool") },
    dispatch: { runTool: Symbol("runTool") },
  } as unknown as ComponentApi;
}

function request(id: number, params: Record<string, unknown>): Request {
  return new Request("https://gateway.example/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "confirm-delete",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: tool.name,
        arguments: { file: "report.txt" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
        ...params,
      },
    }),
  });
}

describe("MRTR", () => {
  test("binds a retry to the caller, tool, and original arguments", async () => {
    const api = component();
    const received: Record<string, unknown>[] = [];
    let subject: string | null = "user-1";
    const ctx = {
      runQuery: async (ref: unknown) => {
        if (ref === api.registry.getTool) return tool;
        throw new Error("unexpected query");
      },
      runMutation: async () => null,
      runAction: async (ref: unknown, args: Record<string, unknown>) => {
        expect(ref).toBe(api.dispatch.runTool);
        received.push(args);
        if (!(args.args as Record<string, unknown>).continuationState) {
          return {
            ok: true as const,
            data: inputRequired(
              {
                confirm: {
                  method: "elicitation/create",
                  params: { message: "Delete report.txt?" },
                },
              },
              { operation: "delete" },
            ),
          };
        }
        return { ok: true as const, data: { deleted: true } };
      },
      auth: {
        getUserIdentity: async () => (subject ? { subject } : null),
      },
    };
    const options = {
      authorize: async () => ({ allowed: true }),
      mrtr: { secret: "x".repeat(32) },
    };

    const first = await handleMcpRequest(
      ctx,
      request(1, {
        arguments: {
          file: "report.txt",
          continuationState: { operation: "forged" },
          continuationResponses: { confirm: { action: "accept" } },
          continuationKey: "forged",
        },
      }),
      api,
      options,
    );
    const firstBody = (await first.json()) as {
      result: { resultType: string; requestState: string };
    };
    expect(firstBody.result.resultType).toBe("input_required");
    expect(received[0]!.args).not.toHaveProperty("continuationState");
    expect(received[0]!.args).not.toHaveProperty("continuationResponses");
    expect(received[0]!.args).not.toHaveProperty("continuationKey");

    const retry = await handleMcpRequest(
      ctx,
      request(2, {
        requestState: firstBody.result.requestState,
        inputResponses: { confirm: { action: "accept", content: true } },
      }),
      api,
      options,
    );
    expect((await retry.json()) as unknown).toMatchObject({
      result: { isError: false },
    });
    const retryArgs = received.at(-1)!.args as Record<string, unknown>;
    expect(retryArgs).toMatchObject({
      continuationState: { operation: "delete" },
      continuationResponses: { confirm: { action: "accept", content: true } },
    });
    expect(typeof retryArgs.continuationKey).toBe("string");

    const missingResponses = await handleMcpRequest(
      ctx,
      request(3, { requestState: firstBody.result.requestState }),
      api,
      options,
    );
    expect(await missingResponses.json()).toMatchObject({
      error: { code: -32602 },
    });
    expect(received).toHaveLength(2);

    const alteredArguments = await handleMcpRequest(
      ctx,
      request(4, {
        arguments: { file: "another-report.txt" },
        requestState: firstBody.result.requestState,
        inputResponses: { confirm: { action: "accept", content: true } },
      }),
      api,
      options,
    );
    expect(await alteredArguments.json()).toMatchObject({
      error: { code: -32602 },
    });
    expect(received).toHaveLength(2);

    const duplicate = await handleMcpRequest(
      ctx,
      request(5, {
        requestState: firstBody.result.requestState,
        inputResponses: { confirm: { action: "accept", content: true } },
      }),
      api,
      options,
    );
    expect(await duplicate.json()).toMatchObject({
      result: { isError: false },
    });
    expect(
      (received.at(-1)!.args as Record<string, unknown>).continuationKey,
    ).toBe(retryArgs.continuationKey);

    subject = null;
    const anonymous = await handleMcpRequest(ctx, request(6, {}), api, options);
    expect(await anonymous.json()).toMatchObject({
      error: { code: -32001 },
    });
    expect(received).toHaveLength(3);

    subject = "user-2";
    const replay = await handleMcpRequest(
      ctx,
      request(7, {
        requestState: firstBody.result.requestState,
        inputResponses: { confirm: { action: "accept", content: true } },
      }),
      api,
      options,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      error: { code: -32602 },
    });
  });
});
