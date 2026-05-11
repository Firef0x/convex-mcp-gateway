/**
 * Convex auth configuration for the example app.
 *
 * The provider listed here is the deployment's JWT contract: Convex validates
 * inbound `Authorization: Bearer <jwt>` headers against this issuer's JWKS
 * before any function (including the gateway's HTTP route) sees the request.
 *
 * For real apps, swap this for whatever you actually use: Clerk, Auth0,
 * Pocket-ID, Auth.js with a JWT strategy, or a self-issued signer. The
 * gateway component reads only `ctx.auth.getUserIdentity()`, so the provider
 * choice is fully generic.
 *
 * In unit tests, convex-test bypasses this config entirely and synthesizes
 * the identity via `t.withIdentity({...})`, so we can verify auth flows
 * without a real signing key.
 */
// Hardcoded placeholder so `convex deploy` does not error out on missing
// `process.env.*` lookups. Override the issuer and audience for your real
// provider; convex-test bypasses this config entirely.
export default {
  providers: [
    {
      domain: "https://example.invalid/",
      applicationID: "convex-mcp-gateway-example",
    },
  ],
};
