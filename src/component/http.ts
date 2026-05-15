import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { api } from "./_generated/api.js";
import {
  buildProtectedResourceMetadataUrl,
  buildResourceUrl,
} from "../shared.js";

const http = httpRouter();

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

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
        // MCP 2025-06-18 lifecycle: the version the client requests lives
        // in `params.protocolVersion`. The `MCP-Protocol-Version` header
        // is for follow-up requests after initialize, not for initialize
        // itself. If the server can't speak the requested version, it
        // returns its latest supported version instead.
        const requested = message.params?.protocolVersion;
        const negotiated =
          typeof requested === "string" &&
          (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION;
        return jsonRpcResult(message.id, {
          protocolVersion: negotiated,
          serverInfo: { name: "convex-mcp-gateway", version: "0.0.0" },
          capabilities: { tools: {} },
        });
      }

      case "tools/list": {
        // The listing is filtered through the same authorizer that gates
        // `tools/call`, in `mode: "list"`, via `dispatch.listVisibleTools`.
        // The contract is "the catalog visible to a caller equals the set
        // of tools they could actually invoke", so an unauthenticated
        // client never sees a tool whose call would be rejected.
        const visible = (await ctx.runAction(
          api.dispatch.listVisibleTools,
          {},
        )) as Array<{
          name: string;
          description: string;
          inputSchema: unknown;
        }>;
        return jsonRpcResult(message.id, {
          tools: visible.map((tool) => ({
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
          // Per MCP 2025-06-18, an authentication failure on a protected
          // resource is signalled with HTTP 401 + `WWW-Authenticate: Bearer
          // resource_metadata="<url>"` (RFC 6750 + RFC 9728), so the MCP
          // client knows where to fetch the auth-server discovery doc.
          // Other JSON-RPC errors stay HTTP 200 with an error envelope.
          if (dispatched.error.code === -32001) {
            const oauthConfig = await ctx.runQuery(
              api.registry.getOAuthConfig,
              {},
            );
            if (oauthConfig) {
              const requestUrl = new URL(request.url);
              const mcpPath = requestUrl.pathname.replace(/\/+$/, "") || "/";
              // The metadata URL is the RFC 9728 path-prefix variant:
              // `<origin>/.well-known/oauth-protected-resource<mcpPath>`,
              // which the host must mount on its own httpRouter (the
              // component cannot serve outside its `httpPrefix`).
              const metadataUrl = buildProtectedResourceMetadataUrl(
                requestUrl.origin,
                mcpPath,
              );
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id ?? null,
                  error: {
                    code: dispatched.error.code,
                    message: dispatched.error.message,
                  },
                }),
                {
                  status: 401,
                  headers: {
                    "content-type": "application/json",
                    "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
                  },
                },
              );
            }
          }
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

// Helper re-exports so tests can import the URL builders without pulling
// in the http router itself. Buildable in pure JS contexts.
export { buildProtectedResourceMetadataUrl, buildResourceUrl };
