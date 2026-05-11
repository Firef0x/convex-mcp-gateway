import { defineApp } from "convex/server";
import mcpGateway from "@convex-dev/mcp-gateway/convex.config";

const app = defineApp();
// `httpPrefix` mounts the component's `http.ts` routes under the host's
// site origin. Without it, the component's `/mcp` route is not reachable.
app.use(mcpGateway, { httpPrefix: "/mcp" });

export default app;
