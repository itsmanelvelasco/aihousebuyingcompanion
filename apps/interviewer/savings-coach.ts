import { readFile } from "node:fs/promises";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { savingsCoachOutput } from "./savings-contract.ts";
import type { SavingsCoach } from "./savings-contract.ts";
import { generateFirstScenario } from "./scenario.ts";

const uri = "ui://homebuying/savings-coach-v1.html";

async function demoPlan(): Promise<SavingsCoach> {
  const plan = { target: 30_000, saved: 20_000, monthly: 500, currency: "EUR" } as const;
  const scenario = await generateFirstScenario({ ...plan, useDemoBank: true });
  return { ...plan, ...scenario, fictional: true };
}

async function coachMarkup(demo?: SavingsCoach) {
  const [html, script] = await Promise.all([
    readFile(new URL("../../apps/interviewer/savings-coach.html", import.meta.url), "utf8"),
    readFile(new URL("../../apps/mcp-server/dist/savings-coach.js", import.meta.url), "utf8"),
  ]);
  const data = demo ? `<script id="savings-coach-data" type="application/json">${JSON.stringify(demo).replace(/</g, "\\u003c")}</script>` : "";
  return `${html}${data}<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`;
}

export async function savingsCoachDemoMarkup() {
  return coachMarkup(await demoPlan());
}

export function registerSavingsCoach(server: McpServer) {
  registerAppResource(server, "Relocat Savings Coach", uri, {}, async () => ({
    contents: [{
      uri,
      mimeType: RESOURCE_MIME_TYPE,
      text: `<!doctype html><html lang="en" data-savings-widget><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relocat Savings Coach</title></head><body>${await coachMarkup()}</body></html>`,
    }],
  }));
  registerAppTool(server, "show_savings_coach", {
    title: "Open the Relocat Savings Coach demo",
    description: "Open an interactive fictional home savings plan. Use when the user asks to see the Savings Coach demo or try a savings habit with fictional data. Compare extra monthly savings with the demo baseline.",
    inputSchema: z.object({}).strict(),
    outputSchema: savingsCoachOutput,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { ui: { resourceUri: uri, visibility: ["model"] } },
  }, async () => ({
    content: [{ type: "text", text: "Opened the Savings Coach with a fictional home purchase goal." }],
    structuredContent: await demoPlan(),
  }));
}
