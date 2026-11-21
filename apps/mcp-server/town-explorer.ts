import { readFileSync } from "node:fs";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Snapshot } from "../../packages/contracts/places.ts";
import { getTown } from "../../packages/places/data.ts";
import { explorerInput, explorerResult } from "./town-explorer-contract.ts";
import { localizeMarkup } from "../../packages/site/language.ts";
import type { SiteLanguage } from "../../packages/site/language.ts";
import { explorerCopy } from "./town-explorer-copy.ts";

const widgetUri = "ui://relocat/town-explorer-v2.html";

export function loadTownExplorerPage(): Record<SiteLanguage, string> | undefined {
  let bundle: string;
  try {
    bundle = readFileSync(new URL("./dist/town-explorer.js", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const template = readFileSync(new URL("./town-explorer.html", import.meta.url), "utf8");
  const script = `<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>`;
  return {
    ca: localizeMarkup(template, explorerCopy, "ca").replace("<!-- WIDGET -->", () => script),
    en: localizeMarkup(template, explorerCopy, "en").replace("<!-- WIDGET -->", () => script),
  };
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
    description: "Open the Catalonia town map and cards. After recommend_towns or recommend_towns_for_profile, call this to visualize the shortlist using the same tool and its exact arguments. Without a recommendation, browse the pilot or open a specific town. Resolve town names with list_catalonia_municipalities first.",
    inputSchema: explorerInput,
    outputSchema: explorerResult,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: widgetUri, visibility: ["model"] } },
  }, ({ municipalityCode: code, recommendation }) => {
    const town = code === undefined ? null : getTown(snapshot, code);
    return {
      content: [{ type: "text", text: recommendation
        ? "Opened the Town Explorer map and cards for the supplied shortlist criteria."
        : town
        ? `Opened Relocat Town Explorer for ${town.name}. Use get_town_profile for the sourced profile in chat.`
        : "Opened Relocat Town Explorer. Pick any covered town, or use list_catalonia_municipalities for pilot coverage in chat." }],
      structuredContent: { municipalityCode: town?.code ?? null, ...(recommendation ? { recommendation } : {}) },
    };
  });
}
