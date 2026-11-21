import { z } from "zod";
import { loadData } from "../../packages/places/data.ts";
import { createHttpServer } from "./http.ts";

const host = process.env.HOST ?? "127.0.0.1";
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? "8787");
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean));
const { snapshot, policies } = loadData();
const server = createHttpServer(snapshot, policies, { allowedOrigins });
server.listen(port, host, () => {
  console.log(`relocat MCP listening on http://${host}:${port}/mcp · ${snapshot.version}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close());
}
