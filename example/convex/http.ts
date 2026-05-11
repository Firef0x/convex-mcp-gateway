import { httpRouter } from "convex/server";

// The `mcpGateway` component owns the actual `/mcp` route; this host-level
// `httpRouter()` is empty but required so the deployment turns on HTTP actions
// at all (otherwise any request through the site proxy returns
// "This Convex deployment does not have HTTP actions enabled").
const http = httpRouter();

export default http;
