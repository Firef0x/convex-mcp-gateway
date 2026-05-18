import { v } from "convex/values";
import {
  McpGateway,
  defineMcpMutation,
  defineMcpQuery,
} from "@tfohlmeister/convex-mcp-gateway";
import { api, components } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const gateway = new McpGateway(components.mcpGateway);

/**
 * Run once (or whenever the tool list changes) to populate the
 * component registry. The authorize callback lives in `http.ts`
 * because it needs `ctx.auth` from the host's HTTP-action context.
 *
 * ```sh
 * npx convex run mcp:registerDefaults
 * ```
 */
export const registerDefaults = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await gateway.register(
      ctx,
      [
        defineMcpQuery({
          name: "invoices_list",
          description: "List invoices, optionally filtered by status.",
          fn: api.invoices.list,
          args: {
            status: v.optional(
              v.union(v.literal("open"), v.literal("paid")),
            ),
          },
        }),
        defineMcpMutation({
          name: "invoices_markPaid",
          description: "Mark an invoice as paid.",
          fn: api.invoices.markPaid,
          args: { id: v.id("invoices") },
        }),
        defineMcpQuery({
          name: "invoices_summary",
          description: "Return the total number of invoices. Public.",
          fn: api.invoices.summary,
          args: {},
          // The host's authorize callback in http.ts treats `public:
          // true` as the opt-in for unauthenticated calls.
          metadata: { public: true },
        }),
      ],
      { replace: true },
    );
    return null;
  },
});
