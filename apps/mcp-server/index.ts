import { z } from "zod";
import { loadData } from "../../packages/places/data.ts";
import { createHttpServer } from "./http.ts";

const host = process.env.HOST ?? "127.0.0.1";
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? "8787");
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean));
const { snapshot, policies, travelEstimates } = loadData();
const bankApiUrl = process.env.BANK_API_URL;
const bankApiToken = process.env.BANK_API_TOKEN;
if (Boolean(bankApiUrl) !== Boolean(bankApiToken)) throw new Error("Set both BANK_API_URL and BANK_API_TOKEN to enable the synthetic bank bridge");
const bankApi = bankApiUrl && bankApiToken ? { baseUrl: bankApiUrl, token: bankApiToken } : undefined;
const server = createHttpServer(snapshot, policies, { allowedOrigins, bankApi, travelEstimates });
server.listen(port, host, () => {
  console.log(`relocat MCP listening on http://${host}:${port}/mcp · ${snapshot.version}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close());
}
