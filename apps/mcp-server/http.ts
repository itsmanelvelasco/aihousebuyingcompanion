import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Policy, Snapshot } from "../../packages/contracts/places.ts";
import { snapshotInfo } from "../../packages/places/data.ts";
import { createMcpServer } from "./tools.ts";
import { registerBankTools } from "./bank-tools.ts";
import type { ListingSearchConfig } from "../../packages/listings/search.ts";
import type { BankToolConfig } from "./bank-tools.ts";

export function createHttpServer(
  snapshot: Snapshot,
  policies: Policy[],
  options: { allowedOrigins?: Set<string>; today?: () => string; bankApi?: BankToolConfig; listings?: ListingSearchConfig } = {},
) {
  return createServer(async (request, response) => {
    const path = request.url?.split("?")[0];
    if (path === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ status: "ok", snapshot: snapshotInfo(snapshot) }));
      return;
    }
    if (path !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !options.allowedOrigins?.has(origin)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Origin is not allowed" }, id: null }));
      return;
    }

    const server = createMcpServer(snapshot, policies, options.today, options.listings);
    if (options.bankApi) registerBankTools(server, options.bankApi);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error("MCP transport failed:", error instanceof Error ? error.name : "unknown error");
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      } else if (!response.writableEnded) {
        response.destroy();
      }
    } finally {
      await server.close();
    }
  });
}
