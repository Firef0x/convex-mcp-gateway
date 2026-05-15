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
  const { toolName, toolMetadata, identity: validatorIdentity } = args;
  const meta = (toolMetadata ?? {}) as { public?: boolean };
  if (meta.public) return { allowed: true };

  // Prefer identity already resolved by the gateway (works for both
  // pure-JWT and tokenValidator/userinfo-bridge modes). Fall back to
  // ctx.auth.getUserIdentity() for backward compat.
  const identity =
    validatorIdentity ?? (await ctx.auth.getUserIdentity().catch(() => null));
  if (!identity) return { allowed: false, reason: "Unauthorized" };

  if (toolName === "invoices.markPaid") {
    const idObj = identity as { claims?: unknown; roles?: unknown };
    const claims = (idObj.claims ?? idObj) as { roles?: unknown };
    const roles = claims.roles;
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

// Test fixture for the userinfo-style tokenValidator path. Real hosts
// would call the upstream IdP's /userinfo endpoint here; the example
// uses an in-memory map so tests don't need a network.
const tokenValidator = async (token: string) => {
  if (token === "valid-userinfo-token") {
    return { subject: "validator-resolved-sub" };
  }
  return null;
};

const mcpHandler = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    cors: true,
    tokenValidator,
  }),
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

// OPT-IN bridge mode: AS metadata + DCR. Hosts whose upstream IdP
// supports DCR can skip these.
http.route({
  path: "/oauth/register",
  method: "POST",
  handler: httpAction(async (ctx, request) =>
    gateway.handleClientRegistration(ctx, request, {
      upstreamClientId: "upstream-client-id-fixed",
      allowedRedirectPatterns: [
        /^https:\/\/claude\.(ai|com)\//,
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//,
      ],
    }),
  ),
});
http.route({
  path: "/oauth/register",
  method: "OPTIONS",
  handler: httpAction(async (ctx, request) =>
    gateway.handleClientRegistration(ctx, request, {
      upstreamClientId: "upstream-client-id-fixed",
      allowedRedirectPatterns: [/^https:\/\/example\.com\//],
    }),
  ),
});

export default http;
