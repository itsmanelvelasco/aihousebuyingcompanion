import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Policy, Snapshot, TravelEstimateData } from "../../packages/contracts/places.ts";
import type { ListingSearchConfig } from "../../packages/listings/search.ts";
import { createMcpServer } from "./tools.ts";

const html = readFileSync(new URL("./test-ui.html", import.meta.url), "utf8");
const allowedTools = new Set(["get_town_profile", "recommend_towns", "search_homes", "list_catalonia_municipalities"]);
export async function handleTestUi(req: IncomingMessage, res: ServerResponse, snapshot: Snapshot, policies: Policy[],
  listings: ListingSearchConfig = { token: process.env.TREG_TOKEN, org: process.env.TREG_ORG }, travelEstimates: TravelEstimateData = {}) {
  const path = req.url?.split("?")[0];
  if (!["/test", "/test/config", "/test/run", "/workspace/tools"].includes(path ?? "")) return false;
  const send = (status: number, body: unknown, isHtml = false) => {
    res.writeHead(status, {
      "Content-Type": isHtml ? "text/html; charset=utf-8" : "application/json",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    }).end(isHtml ? body as string : JSON.stringify(body));
  };
  // A local testing surface, not an unauthenticated paid-search API for tunnels or deployments.
  const host = req.headers.host ?? "";
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  const localPeer = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  if (!localHost || !localPeer || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    send(403, { error: "This test page is available only from localhost." }); return true;
  }
  if (req.method === "GET" && path === "/test") { send(200, html, true); return true; }
  if (req.method === "GET" && path === "/test/config") {
    send(200, { towns: snapshot.municipalities.map(t => ({ code: t.code, name: t.name, recommendable: t.recommendable })),
      liveSearchConfigured: Boolean(listings.token?.trim()), snapshotDate: snapshot.generatedOn }); return true;
  }
  if (req.method !== "POST" || !["/test/run", "/workspace/tools"].includes(path ?? "")) { send(405, { error: "Unsupported request." }); return true; }
  if (!req.headers["content-type"]?.startsWith("application/json")) { send(415, { error: "Expected JSON." }); return true; }
  let client: Client | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) { send(413, { error: "Test input is too large." }); return true; }
      chunks.push(chunk);
    }
    const { tool, args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!allowedTools.has(tool)) { send(400, { error: "Choose one of the available tests." }); return true; }
    client = new Client({ name: "relocat-test-ui", version: "1.0.0" });
    server = createMcpServer(snapshot, policies, undefined, travelEstimates, listings);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    send(200, result);
  } catch {
    send(400, { error: "The test could not run. Check the inputs and try again." });
  } finally { await client?.close(); await server?.close(); }
  return true;
}
