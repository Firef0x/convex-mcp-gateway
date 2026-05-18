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
 * `invoices_markPaid` mutation additionally requires the
 * `finance.admin` role to be present in the JWT claims.
 */
export const authorize: McpAuthorizerHandler = async (ctx, args) => {
  const { toolName, toolMetadata, identity: validatorIdentity } = args;
  const meta = (toolMetadata ?? {}) as { public?: boolean };
  if (meta.public) return { allowed: true };

  // Prefer identity already resolved by the gateway (works for both
  // pure-JWT and resolveIdentity/userinfo-bridge modes). Fall back to
  // ctx.auth.getUserIdentity() for backward compat.
  const identity =
    validatorIdentity ?? (await ctx.auth.getUserIdentity().catch(() => null));
  if (!identity) return { allowed: false, reason: "Unauthorized" };

  if (toolName === "invoices_markPaid") {
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

// Test fixture for the userinfo-style resolveIdentity path. Real hosts
// would call the upstream IdP's /userinfo endpoint here; the example
// uses an in-memory map so tests don't need a network.
const resolveIdentity = async (token: string) => {
  if (token === "valid-userinfo-token") {
    return { subject: "validator-resolved-sub" };
  }
  return null;
};

const mcpHandler = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    cors: true,
    resolveIdentity,
  }),
);
// Mount BOTH /mcp/ and /mcp (no trailing slash). claude.ai (and
// likely other clients) normalise the configured server URL by
// stripping the trailing slash before they POST, even when the user
// typed the slash explicitly. Convex's exact-path routing matches
// /mcp ≠ /mcp/, so a single-route deployment silently 404s those
// calls and the OAuth flow appears to complete but the connector
// "won't connect" — debugged the hard way.
for (const path of ["/mcp/", "/mcp"]) {
  http.route({ path, method: "POST", handler: mcpHandler });
  http.route({ path, method: "GET", handler: mcpHandler });
  http.route({ path, method: "DELETE", handler: mcpHandler });
  // CORS preflight for browser MCP clients.
  http.route({ path, method: "OPTIONS", handler: mcpHandler });
}

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
