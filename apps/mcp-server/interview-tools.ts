import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { widgetUri as productWidgetUri } from '../../packages/config/product.ts';
import { compareSavings, summarizeCsv } from '../../packages/finance/csv.ts';
import { firstScenarioInput, firstScenarioOutput, generateFirstScenario } from '../../packages/finance/scenario.ts';
import { inlineUi } from '../../packages/ui/inline.ts';
import { renderVoiceCard } from './voice-card.ts';

const widgetUri = productWidgetUri('cash-flow.html');
const voiceCardUri = productWidgetUri('start-talking.html');
const widgetType = 'text/html;profile=mcp-app';
const widgetPath = new URL('./cash-flow-widget.html', import.meta.url);
const demoPath = new URL('../../data/demo-bank.csv', import.meta.url);
const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };
const cashSummary = z.object({
  observedMonths: z.array(z.string()),
  transactionCount: z.number().int().nonnegative(),
  excludedTransfers: z.number().int().nonnegative(),
  estimatedMonthlySalary: z.number().nullable(),
  monthlyOtherIncome: z.number(),
  salaryMonths: z.number().int().nonnegative(),
  monthlyInflows: z.number(),
  monthlyCostOfLiving: z.number(),
  monthlyNetCashFlow: z.number(),
  monthlyExpenses: z.record(z.string(), z.number()),
});
const savingsResult = z.object({
  remaining: z.number().nonnegative(),
  baselineMonths: z.number().int().nonnegative().nullable(),
  withHabitMonths: z.number().int().nonnegative().nullable(),
});

function result(data: object): CallToolResult {
  return {
    structuredContent: { ...data },
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

export const interviewerRouting =
  'When ReloCat is invoked and the user starts a home purchase journey (for example, “I want to buy a new home”, “Quiero comprar una vivienda” or “Vull comprar un habitatge”), call start_homebuying_interview before asking any questions about location, budget or home type. The tool opens the Start talking card and supplies the bank-first question. Use town or listing tools directly for specific requests about a town, property or incentive.';

export function registerInterviewerTools(server: McpServer) {
  let launchUrl: URL | undefined;
  if (process.env.RELOCAT_VOICE_URL) {
    const candidate = URL.parse(process.env.RELOCAT_VOICE_URL);
    if (
      candidate?.protocol === 'https:' &&
      !candidate.username &&
      !candidate.password &&
      !candidate.search &&
      !candidate.hash
    ) {
      launchUrl = candidate;
    }
  }
  const launchHref = launchUrl?.href ?? null;
  server.registerResource(
    'ReloCat Start talking',
    voiceCardUri,
    {
      mimeType: widgetType,
      description: 'Green voice interview card for starting the ReloCat homebuying interview.',
    },
    () => ({
      contents: [
        {
          uri: voiceCardUri,
          mimeType: widgetType,
          text: renderVoiceCard(launchHref),
          _meta: {
            ui: { prefersBorder: true },
            ...(launchUrl && { 'openai/widgetCSP': { redirect_domains: [launchUrl.origin] } }),
          },
        },
      ],
    }),
  );

  server.registerTool(
    'start_homebuying_interview',
    {
      title: 'Start the bank-first homebuying interview',
      description:
        interviewerRouting +
        ' If the user requests voice from a text chat, share voiceSetup. Otherwise ask the returned opening question and wait for the user to choose a transaction source.',
      annotations: readOnly,
      _meta: { ui: { resourceUri: voiceCardUri } },
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        openingQuestion: z.string(),
        voiceSetup: z.string(),
        voiceUrl: z.url().nullable(),
        sources: z.object({
          demo: z.string(),
          csv: z.string(),
          estimates: z.string(),
        }),
        nextSteps: z.array(z.string()),
      }),
    },
    () =>
      result({
        openingQuestion:
          'Would you like to start with a bank CSV, use the fictional demo bank account, or tell me your rough monthly income and spending?',
        voiceSetup:
          'Select the Voice icon in ChatGPT to start Live, then say: Use ReloCat Team to start my homebuying interview.',
        voiceUrl: launchHref,
        sources: {
          demo: 'Call sample_cash_flow when the user chooses fictional transactions.',
          csv: 'Ask the user to attach a CSV with date, description, and amount. Call summarize_bank_csv only with CSV text they explicitly share and that you can access. Ask them to remove account identifiers.',
          estimates:
            'Ask for rough monthly take-home income and then spending. Ask one question at a time and identify the figures as estimates.',
        },
        nextSteps: [
          'Ask the actual next unanswered question in each turn. If the user gives their income while choosing spoken estimates, ask for monthly spending directly. Confirm whether income and spending reflect a typical month.',
          'Ask how many people will live in the home, including the user. Confirm the total household size before asking about the home type.',
          'Ask about the area, home type, and must-have amenities one question at a time.',
          'Confirm the savings target, amount already saved, monthly contribution, and currency. Immediately call generate_home_savings_scenario with those inputs. Set useDemoBank only if the user selected the fictional sample. Present the first scenario and any returned review suggestions. Do not ask the user to choose a habit or estimate extra savings during onboarding.',
        ],
      }),
  );

  server.registerResource(
    'Homebuying cash flow',
    widgetUri,
    {
      mimeType: widgetType,
      description: 'Monthly income and spending for the fictional homebuying demo.',
    },
    async () => ({
      contents: [{ uri: widgetUri, mimeType: widgetType, text: inlineUi(await readFile(widgetPath, 'utf8')) }],
    }),
  );

  server.registerTool(
    'sample_cash_flow',
    {
      description: 'Summarize three months of fictional bank transactions for the homebuying demo.',
      annotations: readOnly,
      inputSchema: z.object({}).strict(),
      outputSchema: cashSummary,
      _meta: { ui: { resourceUri: widgetUri } },
    },
    async () => {
      try {
        return result(summarizeCsv(await readFile(demoPath, 'utf8')));
      } catch {
        return errorResult('The fictional bank transactions are unavailable.');
      }
    },
  );

  server.registerTool(
    'summarize_bank_csv',
    {
      description:
        'Summarize CSV text the user explicitly chooses to share with ChatGPT. Use date, description, amount headers, ISO dates and signed amounts. Remove identifiers before sharing. For browser-only CSV parsing, use the local voice demo.',
      annotations: readOnly,
      inputSchema: { csv: z.string().min(1).max(100000) },
      outputSchema: cashSummary,
    },
    ({ csv }) => {
      try {
        return result(summarizeCsv(csv));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : 'The CSV could not be summarized.');
      }
    },
  );

  server.registerTool(
    'generate_home_savings_scenario',
    {
      title: 'Generate the first home savings scenario',
      description:
        "Generate the first scenario after onboarding, using confirmed savings inputs. No habit input is required. For the fictional demo account, include optional suggestions from the habits agent's rules, with no projected savings attached to them.",
      annotations: readOnly,
      inputSchema: firstScenarioInput,
      outputSchema: firstScenarioOutput,
    },
    async input => result(await generateFirstScenario(input)),
  );

  server.registerTool(
    'compare_home_savings',
    {
      description:
        'Compare baseline and habit-adjusted months to a confirmed cash savings goal. All values must use the same currency. Monthly contribution can be negative.',
      annotations: readOnly,
      inputSchema: {
        target: z.number().positive(),
        saved: z.number().nonnegative(),
        monthly: z.number(),
        habit: z.number().nonnegative(),
      },
      outputSchema: savingsResult,
    },
    input => result(compareSavings(input)),
  );
}
