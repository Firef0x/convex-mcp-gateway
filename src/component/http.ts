import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { api } from "./_generated/api.js";

const http = httpRouter();

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
};

const PROTOCOL_VERSION = "2025-06-18";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonRpcResult(id: JsonRpcRequest["id"], value: unknown) {
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function jsonRpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
) {
  return jsonResponse({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

// Mounted under whatever `httpPrefix` the host passes to `app.use(mcpGateway, ...)`.
// The component itself routes only the relative path `/`.
http.route({
  path: "/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let message: JsonRpcRequest;
    try {
      message = (await request.json()) as JsonRpcRequest;
    } catch {
      return jsonRpcError(null, -32700, "Parse error");
    }

    switch (message.method) {
      case "initialize": {
        const requested =
          request.headers.get("mcp-protocol-version") ?? PROTOCOL_VERSION;
        return jsonRpcResult(message.id, {
          protocolVersion: requested,
          serverInfo: { name: "convex-mcp-gateway", version: "0.0.0" },
          capabilities: { tools: {} },
        });
      }

      case "tools/list": {
        // No auth check on tools/list itself, but the listing only exposes
        // public metadata (name + description + inputSchema), never function
        // handles. Per-tool scopes/roles are *not* filtered server-side here
        // yet, so clients see the full catalog. Scope-aware filtering is a
        // Phase 2 item.
        const tools = await ctx.runQuery(
          api.registry.listTools,
          {},
        );
        return jsonRpcResult(message.id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
      }

      case "tools/call": {
        const name = message.params?.name;
        if (typeof name !== "string") {
          return jsonRpcError(message.id, -32602, "Missing tool name");
        }

        const args = (message.params?.arguments ?? {}) as Record<
          string,
          unknown
        >;

        const dispatched = await ctx.runAction(api.dispatch.callTool, {
          name,
          args,
        });

        if (!dispatched.ok) {
          return jsonRpcError(
            message.id,
            dispatched.error.code,
            dispatched.error.message,
          );
        }

        return jsonRpcResult(message.id, {
          content: [
            { type: "text", text: JSON.stringify(dispatched.data, null, 2) },
          ],
          isError: false,
        });
      }

      default:
        return jsonRpcError(
          message.id,
          -32601,
          `Unsupported method: ${message.method}`,
        );
    }
  }),
});

export default http;
