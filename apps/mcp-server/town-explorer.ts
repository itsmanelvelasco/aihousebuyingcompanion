import { readFileSync } from "node:fs";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { municipalityCode } from "../../packages/contracts/places.ts";
import type { Snapshot } from "../../packages/contracts/places.ts";
import { getTown } from "../../packages/places/data.ts";

const widgetUri = "ui://relocat/town-explorer-v1.html";

export function loadTownExplorerPage() {
  let bundle: string;
  try {
    bundle = readFileSync(new URL("./dist/town-explorer.js", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const template = readFileSync(new URL("./town-explorer.html", import.meta.url), "utf8");
  return template.replace("<!-- WIDGET -->", () => `<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`);
}

export function registerTownExplorer(server: McpServer, snapshot: Snapshot, page: string) {
  registerAppResource(server, "Relocat Town Explorer", widgetUri, {}, async () => ({
    contents: [{
      uri: widgetUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: page,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
    }],
  }));

  registerAppTool(server, "show_town_explorer", {
    title: "Show Relocat Town Explorer",
    description: "Open an interactive view of the Catalonia pilot to browse towns and inspect sourced housing indicators, travel estimates, schools and housing measures. Optionally open a specific town. Resolve town names with list_catalonia_municipalities first.",
    inputSchema: z.object({ municipalityCode: municipalityCode.optional() }).strict(),
    outputSchema: z.object({ municipalityCode: municipalityCode.nullable() }),
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: widgetUri, visibility: ["model"] } },
  }, ({ municipalityCode: code }) => {
    const town = code === undefined ? null : getTown(snapshot, code);
    return {
      content: [{ type: "text", text: town
        ? `Opened Relocat Town Explorer for ${town.name}. Use get_town_profile for the sourced profile in chat.`
        : "Opened Relocat Town Explorer. Pick any covered town, or use list_catalonia_municipalities for pilot coverage in chat." }],
      structuredContent: { municipalityCode: town?.code ?? null },
    };
  });
}
