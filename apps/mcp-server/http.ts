import { handleConnectPage } from "./connect-page.ts";
import { handleTestUi } from "./test-ui.ts";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Policy, Snapshot, TravelEstimateData } from "../../packages/contracts/places.ts";
import { snapshotInfo } from "../../packages/places/data.ts";
import { createMcpServer } from "./tools.ts";
import { registerBankTools } from "./bank-tools.ts";
import type { ListingSearchConfig } from "../../packages/listings/search.ts";
import type { BankToolConfig } from "./bank-tools.ts";
import { registerTownExplorer } from "./town-explorer.ts";

export function createHttpServer(
  snapshot: Snapshot,
  policies: Policy[],
  options: {
    allowedOrigins?: Set<string>;
    today?: () => string;
    bankApi?: BankToolConfig;
    travelEstimates?: TravelEstimateData;
    listings?: ListingSearchConfig;
    townExplorerPage?: string;
  } = {},
) {
  return createServer(async (request, response) => {
    const path = request.url?.split("?")[0];
    if (path === "/" && request.method === "GET") {
      response.writeHead(302, { Location: "/connect" }).end();
      return;
    }
    if (await handleConnectPage(request, response)) return;
    if (await handleTestUi(request, response, snapshot, policies, options.listings, options.travelEstimates)) return;
    if (path === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ status: "ok", snapshot: snapshotInfo(snapshot) }));
      return;
    }
    if (path === "/preview" && request.method === "GET" && options.townExplorerPage) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      }).end(options.townExplorerPage);
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

    const server = createMcpServer(snapshot, policies, options.today, options.travelEstimates, options.listings);
    if (options.townExplorerPage) registerTownExplorer(server, snapshot, options.townExplorerPage);
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
