import { httpRouter } from "convex/server";
import {
  McpGateway,
  type McpAuthorizerHandler,
} from "@tfohlmeister/convex-mcp-gateway";
import { components } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

/**
 * Authorize callback used by the example host. Public tools opt in via
 * `metadata.public: true`; everything else needs an identity. The
 * `invoices.markPaid` mutation additionally requires the
 * `finance.admin` role to be present in the JWT claims.
 */
export const authorize: McpAuthorizerHandler = async (ctx, args) => {
  const { toolName, toolMetadata } = args;
  const meta = (toolMetadata ?? {}) as { public?: boolean };
  if (meta.public) return { allowed: true };

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return { allowed: false, reason: "Unauthorized" };

  if (toolName === "invoices.markPaid") {
    const roles = (identity as { roles?: unknown }).roles;
    const isAdmin =
      Array.isArray(roles) && roles.includes("finance.admin");
    if (!isAdmin) {
      return {
        allowed: false,
        reason: "Forbidden: finance.admin role required",
      };
    }
  }
  return { allowed: true };
};

const http = httpRouter();

const mcpHandler = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, { authorize, cors: true }),
);
http.route({ path: "/mcp/", method: "POST", handler: mcpHandler });
http.route({ path: "/mcp/", method: "GET", handler: mcpHandler });
http.route({ path: "/mcp/", method: "DELETE", handler: mcpHandler });
// CORS preflight: browser MCP clients (e.g. claude.ai) issue an
// OPTIONS request before each cross-origin call.
http.route({ path: "/mcp/", method: "OPTIONS", handler: mcpHandler });

const discoveryHandler = httpAction(async (ctx, request) =>
  gateway.serveProtectedResourceMetadata(ctx, request),
);
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "GET",
  handler: discoveryHandler,
});
http.route({
  path: "/.well-known/oauth-protected-resource/mcp",
  method: "OPTIONS",
  handler: discoveryHandler,
});

export default http;
