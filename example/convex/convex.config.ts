import { defineApp } from "convex/server";
import mcpGateway from "@convex-dev/mcp-gateway/convex.config";

const app = defineApp();
// The component owns four storage tables (tools, config, sessions, audit).
// It does not mount HTTP routes; the host's http.ts mounts /mcp/ and the
// OAuth discovery route via gateway.handleMcpRequest / serveProtectedResourceMetadata.
app.use(mcpGateway);

export default app;
