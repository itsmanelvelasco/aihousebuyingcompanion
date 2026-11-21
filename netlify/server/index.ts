import { createHttpServer } from "../../apps/mcp-server/http.ts";
import { loadTownExplorerPage } from "../../apps/mcp-server/town-explorer.ts";
import { loadData } from "../../packages/places/data.ts";

// Netlify bundles the application at this depth. Asset paths resolve from the repository root.
const { snapshot, policies, travelEstimates } = loadData();
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean),
);

export default createHttpServer(snapshot, policies, {
  allowedOrigins,
  travelEstimates,
  townExplorerPage: loadTownExplorerPage(),
});
