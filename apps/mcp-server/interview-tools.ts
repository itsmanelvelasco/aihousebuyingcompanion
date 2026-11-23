import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { voiceUrlConfig } from '../../packages/config/env.ts';
import { widgetUri as productWidgetUri } from '../../packages/config/product.ts';
import { localeArgument } from '../../packages/contracts/locale.ts';
import { cashFlowStatements, compareSavings, summarizeCsv } from '../../packages/finance/csv.ts';
import { firstScenarioInput, firstScenarioOutput, generateFirstScenario } from '../../packages/finance/scenario.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { toolLocale } from '../../packages/i18n/server.ts';
import { loadCashFlowCard } from './cash-flow.ts';
import type { Caller } from './identity.ts';
import { interviewMessages } from './interview.messages.ts';
import { renderVoiceCard } from './voice-card.ts';

const widgetUri = productWidgetUri('cash-flow.html');
const voiceCardUri = productWidgetUri('start-talking.html');
const widgetType = 'text/html;profile=mcp-app';
const demoPath = new URL('../../data/demo-bank.csv', import.meta.url);
const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };
const cashSummary = z.object({
  /** Every month with at least one row. The monthly figures average `completeMonths` only. */
  observedMonths: z.array(z.string()),
  completeMonths: z.array(z.string()),
  partialMonths: z.array(z.string()),
  /**
   * `partial_months_only`: no month is fully covered, so the figures are a rough indication.
   * `period_too_short`: fewer than 28 days are covered; every monthly figure is null and none may be quoted.
   */
  averageBasis: z.enum(['complete_months', 'partial_months_only', 'period_too_short']),
  averagingNote: z.string(),
  coveredFrom: z.string().nullable(),
  coveredTo: z.string().nullable(),
  coveredDays: z.number().int().nonnegative(),
  /** Totals of the days covered. They are not monthly figures. */
  periodTotals: z.object({ inflows: z.number(), outflows: z.number(), net: z.number() }),
  transactionCount: z.number().int().nonnegative(),
  excludedTransfers: z.number().int().nonnegative(),
  estimatedMonthlySalary: z.number().nullable(),
  monthlyOtherIncome: z.number().nullable(),
  salaryMonths: z.number().int().nonnegative(),
  monthlyInflows: z.number().nullable(),
  monthlyCostOfLiving: z.number().nullable(),
  monthlyNetCashFlow: z.number().nullable(),
  monthlyExpenses: z.record(z.string(), z.number()),
});

const savingsResult = z.object({
  remaining: z.number().nonnegative(),
  baselineMonths: z.number().int().nonnegative().nullable(),
  withHabitMonths: z.number().int().nonnegative().nullable(),
});

function result(data: object, guidance?: string | null): CallToolResult {
  return {
    structuredContent: { ...data },
    // Guidance comes first, in plain words, so it is read before any number.
    content: [
      ...(guidance ? [{ type: 'text' as const, text: guidance }] : []),
      { type: 'text', text: JSON.stringify(data) },
    ],
  };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * The tools of the one planner flow, in the order a home purchase conversation uses them. The
 * server instructions and `start_homebuying_interview` both name them, and nothing else is the plan.
 */
export const plannerFlow = ['get_next_questions', 'save_my_inputs', 'plan_home_savings', 'show_workspace'] as const;

export const interviewerRouting =
  'When ReloCat is invoked and the user starts a home purchase journey (for example, “I want to buy a new home”, “Quiero comprar una vivienda” or “Vull comprar un habitatge”), call start_homebuying_interview before asking any questions about location, budget or home type. The tool opens the Start talking card, supplies the opening question about bank data, and returns the steps of the one planner flow: get_next_questions for the next question (one at a time, most valuable first), save_my_inputs after the person confirms an answer (not signed in: keep the answers in the inline person and say so), plan_home_savings for the plan, and show_workspace to see it. Use town or listing tools directly for specific requests about a town, property or incentive.';

/**
 * How the whole conversation runs, for the server instructions: the planner flow is the product,
 * the two savings calculators are what-ifs, and it works the same when spoken.
 */
export const plannerFlowGuidance =
  'The plan is plan_home_savings and nothing else: it joins the person (figures, household facts, habits) with places (prices, transfer tax, aid) into months of saving, and every surface shows that same plan. Never answer “when can I buy?” from your own arithmetic or from another tool. Ask only the questions get_next_questions or plan_home_savings return, one at a time, in the person’s language; with no place chosen yet pass no municipalityCodes, and once the required figures are known ask where they would like to live and offer recommend_towns. Signed in (me:true works): repeat each answer back and save it with save_my_inputs only after the person confirms; a habit they agree to adopt is saved with save_my_habit, and list_my_habits reads them. Not signed in: keep the answers in the inline person argument, tell the person they live only in this conversation, and when a personal tool answers that sign-in is needed, say the sentence it gives about connecting the account. Say which aid was counted and which is not yet verified, with the question that would verify it. generate_home_savings_scenario and compare_home_savings are what-if calculators for a round savings target with no place, no aid and nothing saved: use them only when the person asks for that sum, and never present their result as the plan. In voice mode the flow is the same: say one question, wait, repeat the answer back, and read amounts and months aloud as words.';

export type InterviewerOptions = {
  /** Who is calling, so the first step can say whether answers can be saved. Omitted: nobody is signed in. */
  caller?: Caller;
  /** Where the Start talking card leads; omitted, `voiceUrlConfig()` (`RELOCAT_VOICE_URL`, else `<PUBLIC_ORIGIN>/interview/`). */
  voiceUrl?: string | null;
};

export function registerInterviewerTools(server: McpServer, options: InterviewerOptions = {}) {
  const launchHref = options.voiceUrl === undefined ? voiceUrlConfig() : options.voiceUrl;
  const launchUrl = launchHref ? (URL.parse(launchHref) ?? undefined) : undefined;
  const signedIn = Boolean(options.caller?.me);
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
            ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
            ...(launchUrl && { 'openai/widgetCSP': { redirect_domains: [launchUrl.origin] } }),
          },
        },
      ],
    }),
  );

  server.registerTool(
    'start_homebuying_interview',
    {
      title: 'Start the homebuying interview',
      description:
        interviewerRouting +
        ' If the user requests voice from a text chat, share voiceSetup and, when voiceUrl is not null, the link to ReloCat’s own voice page. Otherwise ask the returned opening question, wait for the user to choose where their figures come from, and follow nextSteps: they are the planner flow, the only way to the plan.',
      annotations: readOnly,
      _meta: { ui: { resourceUri: voiceCardUri } },
      inputSchema: z.object({ locale: localeArgument }).strict(),
      outputSchema: z.object({
        /** In the person's language: say it as it is. */
        openingQuestion: z.string(),
        /** In the person's language: how to start ChatGPT's voice mode with ReloCat. */
        voiceSetup: z.string(),
        /** ReloCat's own voice page, or null when this server has no public address. */
        voiceUrl: z.url().nullable(),
        /** True when the caller is signed in, so confirmed answers can be saved with save_my_inputs. */
        signedIn: z.boolean(),
        sources: z.object({
          demo: z.string(),
          csv: z.string(),
          estimates: z.string(),
        }),
        /** The tools of the planner flow, in order. */
        flow: z.array(z.string()),
        nextSteps: z.array(z.string()),
      }),
    },
    (input, extra) => {
      const say = translator(interviewMessages, toolLocale(input.locale, extra._meta));
      return result({
        openingQuestion: say('openingQuestion'),
        voiceSetup: say('voiceSetup'),
        voiceUrl: launchHref,
        signedIn,
        sources: {
          demo: 'Call sample_cash_flow when the person chooses the fictional transactions. Its figures are fictional: say so, and use them only in the inline person of get_next_questions and plan_home_savings (monthlyInflows as person.finances.monthlyIncomeCents and monthlyCostOfLiving as person.finances.monthlyExpensesCents, euros times 100). Never save fictional figures to a real profile with save_my_inputs.',
          csv: 'Ask the person to attach a CSV with date, description, and amount, with account identifiers removed. Call summarize_bank_csv only with CSV text they explicitly share and that you can access. Read the monthly income and cost of living back; once confirmed they are the answers to the first two questions of get_next_questions (finance.monthlyIncomeCents and finance.monthlyExpensesCents, in cents). Signed in, preview_statement_import and confirm_statement_import keep the statement in the person’s own ledger instead.',
          estimates:
            'Go straight to get_next_questions: its first questions are monthly income, monthly spending and savings for the purchase. Identify the figures as estimates.',
        },
        flow: [...plannerFlow],
        nextSteps: [
          `Call get_next_questions${signedIn ? ' with me:true' : ' with person:{} (nobody is signed in, so the answers go in the inline person)'}; municipalityCodes may be left out until a place is chosen. Ask the first question it returns, in the person’s language, one question per turn. Do not ask questions of your own in its place.`,
          'After each answer, repeat it back. Signed in: once the person confirms, call save_my_inputs with confirmed:true, writing the value at the question’s inputPath. Not signed in: add the answer to the inline person, and tell the person once that the answers live only in this conversation and how to connect their account (sayNotStored). Then call get_next_questions again: the order changes with every answer.',
          'Once the figures a timeline needs are known, ask where they would like to live (placeQuestion) and offer recommend_towns; pass the chosen municipality codes from then on.',
          'Call plan_home_savings with the same person and places. It is the plan: present its timelines, the aid that was counted, the aid that is not yet verified with the question that would verify it, and its assumptions and limitations. Keep asking its nextQuestions while they could change the plan.',
          'Offer show_workspace so the person can see the plan. A habit they agree to adopt is saved with save_my_habit when signed in, or added to person.habits, and the plan is computed again.',
          'generate_home_savings_scenario and compare_home_savings are what-if calculators for a round savings target. Use them only when the person asks for that sum; never present their result as the plan.',
        ],
      });
    },
  );

  server.registerResource(
    'Homebuying cash flow',
    widgetUri,
    {
      mimeType: widgetType,
      description: 'Monthly income and spending for the fictional homebuying demo.',
    },
    () => ({
      contents: [{ uri: widgetUri, mimeType: widgetType, text: loadCashFlowCard() }],
    }),
  );

  server.registerTool(
    'sample_cash_flow',
    {
      description:
        'Summarize the fictional bank statement of the homebuying demo. Monthly figures average its complete calendar months only; completeMonths, partialMonths and averagingNote say which months were used and which were left out.',
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
        'Summarize CSV text the user explicitly chooses to share with ChatGPT. Use date, description, amount headers, ISO dates and signed amounts. Remove identifiers before sharing. Monthly figures average complete calendar months only; when averageBasis is partial_months_only no month is fully covered, so present the figures as a rough indication and relay averagingNote. When averageBasis is period_too_short the statement covers less than a month: every monthly figure is null, so say the period is too short for a monthly figure and ask for a statement covering at least one complete calendar month; never present periodTotals as monthly amounts. For browser-only CSV parsing, use the local voice demo.',
      annotations: readOnly,
      inputSchema: { csv: z.string().min(1).max(100000) },
      outputSchema: cashSummary,
    },
    ({ csv }) => {
      try {
        const summary = summarizeCsv(csv);
        // Nothing for complete months, a caution for a rough indication, a refusal when the period is too short.
        return result(summary, cashFlowStatements(summary, String).guidance);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : 'The CSV could not be summarized.');
      }
    },
  );

  server.registerTool(
    'generate_home_savings_scenario',
    {
      title: 'What-if: months to a round savings target',
      description:
        "A what-if calculator, not the plan: months to reach a savings target the person names, from an amount saved and a monthly contribution. It knows no place, no transfer tax, no aid and no household fact, and it saves nothing. Use it only when the person asks for that sum; the plan is plan_home_savings. No habit input is required. For the fictional demo account, include optional suggestions from the habits agent's rules, with no projected savings attached to them.",
      annotations: readOnly,
      inputSchema: firstScenarioInput,
      outputSchema: firstScenarioOutput,
    },
    async input => result(await generateFirstScenario(input)),
  );

  server.registerTool(
    'compare_home_savings',
    {
      title: 'What-if: a savings target with and without one habit',
      description:
        'A what-if calculator, not the plan: compare baseline and habit-adjusted months to a cash savings goal the person names. It knows no place and no aid and saves nothing; the plan, with the person’s stored habits, is plan_home_savings. All values must use the same currency. Monthly contribution can be negative.',
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
