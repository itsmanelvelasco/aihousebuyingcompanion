import { z } from 'zod';
import type { RecommendationInput } from '../../packages/contracts/places.ts';
import { municipalityListResult, recommendationResult } from '../../packages/contracts/places.ts';
import type { Habit, Person, PlanResult } from '../../packages/contracts/planner.ts';
import { planResult } from '../../packages/contracts/planner.ts';
import { defaultLocale, type Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import type { Subject } from './launch.ts';
import { workspaceLaunch } from './launch.ts';
import { errorMessages } from './messages/errors.messages.ts';

/**
 * Typed client for the MCP tools the workspace reads. It takes one `CallTool` function, so the same
 * code runs inside a chat host (`App.callServerTool`), on the standalone page (JSON-RPC to `/mcp`)
 * and against the fixture. A tool that is missing, fails or returns an unexpected shape becomes a
 * `ToolError`; nothing here falls back to sample data.
 */
export type ToolResult = { isError?: boolean; structuredContent?: unknown; content?: unknown };
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

/** `signin`: the tool needs the person to sign in (or to grant more) before it answers. */
export type ToolErrorKind = 'unavailable' | 'failed' | 'invalid' | 'signin';

export class ToolError extends Error {
  readonly tool: string;
  readonly kind: ToolErrorKind;
  constructor(tool: string, kind: ToolErrorKind, message: string) {
    super(message);
    this.name = 'ToolError';
    this.tool = tool;
    this.kind = kind;
  }
}

/**
 * A plan asked for with no place chosen that failed. A server from before plans without a place
 * refuses the empty list; that is "nothing to plan yet", not a failure to show. Only a request to
 * sign in is still passed on, because the person can act on it.
 */
export const isNoPlaceRefusal = (municipalityCodes: string[], error: ToolError) =>
  municipalityCodes.length === 0 && error.kind !== 'signin';

const count = z.number().int().nonnegative();
const cents = z.number().int();

export const bankEvent = z.object({
  sequence: count,
  occurredAt: z.string(),
  type: z.literal('bank.updated'),
  accountCount: count,
  transactionCount: count,
});
export const bankUpdates = z.object({
  synthetic: z.boolean(),
  events: z.array(bankEvent),
  latestRevision: count,
  nextCursor: count,
  requiresRefresh: z.boolean(),
  hasMore: z.boolean(),
});
export const bankRuntime = z.object({
  synthetic: z.boolean(),
  userId: z.string(),
  enabled: z.boolean(),
  intervalMs: count,
  lastTickAt: z.string().nullable(),
  lastError: z.string().nullable(),
  tickCount: count,
});
export const bankSummary = z.object({
  synthetic: z.boolean(),
  currency: z.literal('EUR'),
  from: z.string(),
  to: z.string(),
  monthCount: count,
  dataStatus: z.enum(['unknown', 'partial', 'observed']),
  transactionCount: count,
  incomeCents: cents,
  expenseCents: cents,
  netCashflowCents: cents,
  averageMonthlySavingsCents: cents.nullable(),
  excludedPendingCount: count,
  excludedInternalTransferCount: count,
  assumptions: z.array(z.string()),
  ledgerUpdatedAt: z.string().nullable().optional(),
});
export const savedInputs = z.object({ saved: z.boolean(), inputId: z.string(), inputCount: count });
export type BankEvent = z.infer<typeof bankEvent>;
export type BankUpdates = z.infer<typeof bankUpdates>;
export type BankRuntime = z.infer<typeof bankRuntime>;
export type BankSummary = z.infer<typeof bankSummary>;
export type Municipality = z.infer<typeof municipalityListResult>['municipalities'][number];
export type Recommendation = z.infer<typeof recommendationResult>;
/** What `recommend_towns` is asked: the screening criteria, without the language (the client states it). */
export type RecommendationRequest = Omit<RecommendationInput, 'locale'>;
/**
 * One habit as the form holds it. A saving of `null` means no monthly saving is assumed. With an
 * `id` the stored habit of that id is updated; without one `saveHabit` makes an id for a new habit.
 */
export type HabitDraft = Pick<Habit, 'title' | 'category' | 'monthlySavingCents'> & {
  id?: string;
  status: 'active' | 'paused';
  startedOn?: string;
};
/** The tool answers with the habit it stored; the workspace re-reads the plan and needs none of it. */
const savedHabit = z.looseObject({});

/**
 * The id of a new habit: the title in the characters an id may have, and a short suffix so that two
 * habits with the same title stay two habits (the tool updates the habit that has the same id).
 */
export function newHabitId(title: string, suffix: string = Date.now().toString(36)) {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${slug || 'habit'}-${suffix}`;
}

/** The arguments of `save_my_habit` for a habit of the form: `active` is how the tool says active or paused. */
export function saveHabitArguments(habit: HabitDraft, id = habit.id ?? newHabitId(habit.title)) {
  return {
    id,
    title: habit.title,
    category: habit.category,
    monthlySavingCents: habit.monthlySavingCents,
    active: habit.status === 'active',
    ...(habit.startedOn ? { startedOn: habit.startedOn } : {}),
  };
}

export type PlanAssumptionsInput = { includeProposedHabits: boolean; includeUnverifiedBenefits: boolean };
/**
 * A stored person (the signed-in one or a demo persona, named by `subject`, never by a user id),
 * or an edited person sent inline for a what-if.
 */
export type PlanRequest = { municipalityCodes: string[]; assumptions: PlanAssumptionsInput } & (
  | { subject: Subject; person?: undefined }
  | { person: Person; subject?: undefined }
);

/** The arguments that name a stored subject to a tool: `me: true`, or the demo persona. */
function subjectArgs(subject: Subject): Record<string, unknown> {
  if (subject.kind === 'demo') return { demoId: subject.demoId };
  if (subject.kind === 'inline') return { person: subject.person };
  return { me: true };
}

/** The bank tool for a subject: the personal tool for `me`, the read-only demo tool for a persona. */
function bankTool(subject: Subject, name: 'updates' | 'runtime' | 'summary') {
  return subject.kind === 'demo'
    ? { tool: `get_demo_bank_${name}`, args: { demoId: subject.demoId } }
    : { tool: `get_bank_${name}`, args: {} };
}

/** A tool result that says "sign in first": the server attaches the OAuth challenge to it. */
function needsSignIn(result: ToolResult) {
  const meta = (result as { _meta?: Record<string, unknown> })._meta;
  return Boolean(meta && 'mcp/www_authenticate' in meta);
}

function firstText(content: unknown) {
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') return block.text;
  }
  return '';
}

const missingTool = /not found|unknown tool|not available|disabled/i;

/**
 * Human-readable reason for a failed call, without leaking protocol noise. A reason the server
 * gave is shown as received; the workspace's own sentences are in the language asked for.
 */
export function describeFailure(
  tool: string,
  detail: string,
  locale: Locale = defaultLocale,
): { kind: ToolErrorKind; message: string } {
  const t = translator(errorMessages, locale);
  if (missingTool.test(detail) && detail.includes(tool))
    return { kind: 'unavailable', message: t('toolUnavailable', { tool }) };
  const text = detail.replace(/^MCP error -?\d+:\s*/i, '').trim();
  return { kind: 'failed', message: text ? text.slice(0, 280) : t('toolFailed', { tool }) };
}

async function read<T extends z.ZodType>(
  call: CallTool,
  tool: string,
  args: Record<string, unknown>,
  schema: T,
  locale: Locale,
) {
  const t = translator(errorMessages, locale);
  let result: ToolResult;
  try {
    result = await call(tool, args);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const failure = describeFailure(tool, error instanceof Error ? error.message : '', locale);
    throw new ToolError(tool, failure.kind, failure.message);
  }
  if (result.isError) {
    if (needsSignIn(result)) throw new ToolError(tool, 'signin', firstText(result.content) || t('signInToContinue'));
    const failure = describeFailure(tool, firstText(result.content), locale);
    throw new ToolError(tool, failure.kind, failure.message);
  }
  const parsed = schema.safeParse(result.structuredContent);
  if (!parsed.success) throw new ToolError(tool, 'invalid', t('toolInvalid', { tool }));
  return parsed.data as z.infer<T>;
}

/**
 * The tools of the workspace. With a `locale` the client states it to the tools that answer with
 * display text (`plan_home_savings`) and words its own error messages in it; without one nothing
 * is added to a call and the messages are English.
 */
export function createToolClient(call: CallTool, locale?: Locale) {
  const language = locale ?? defaultLocale;
  const ask = <T extends z.ZodType>(tool: string, args: Record<string, unknown>, schema: T) =>
    read(call, tool, args, schema, language);
  return {
    /** The language this client asks for and reports failures in. */
    locale: language,
    /** Ask the server whose plan to show: it answers `me` when signed in, the demo persona asked for, or nobody. */
    launch: (request: { demoId?: string; municipalityCodes: string[] }) =>
      ask('show_workspace', request, workspaceLaunch),
    plan: ({ subject, person, ...rest }: PlanRequest): Promise<PlanResult> =>
      ask(
        'plan_home_savings',
        { ...rest, ...(person ? { person } : subjectArgs(subject as Subject)), ...(locale ? { locale } : {}) },
        planResult,
      ),
    bankUpdates: (subject: Subject, after: number, limit = 50) => {
      const { tool, args } = bankTool(subject, 'updates');
      return ask(tool, { ...args, after, limit }, bankUpdates);
    },
    bankRuntime: (subject: Subject) => {
      const { tool, args } = bankTool(subject, 'runtime');
      return ask(tool, args, bankRuntime);
    },
    bankSummary: (subject: Subject, period: { from: string; to: string }) => {
      const { tool, args } = bankTool(subject, 'summary');
      return ask(tool, { ...args, ...period }, bankSummary);
    },
    /** Save details to the signed-in person's own profile. Only `me` can be written. */
    saveInputs: (
      data: Record<string, Record<string, unknown>>,
      confirmed: boolean,
      source: 'manual' | 'interview' = 'manual',
    ) => ask('save_my_inputs', { data, confirmed, source }, savedInputs),
    /** Create or update one habit of the signed-in person. Only `me` can be written. */
    saveHabit: (habit: HabitDraft) =>
      ask('save_my_habit', { ...saveHabitArguments(habit), ...(locale ? { locale } : {}) }, savedHabit),
    /**
     * Places screened and ranked by the server against what is asked. The hard filters run there;
     * the reasons, compromises and exclusions come back worded in the language of this client.
     */
    recommend: (request: RecommendationRequest): Promise<Recommendation> =>
      ask('recommend_towns', { ...request, ...(locale ? { locale } : {}) }, recommendationResult),
    municipalities: async () => (await ask('list_catalonia_municipalities', {}, municipalityListResult)).municipalities,
  };
}
export type ToolClient = ReturnType<typeof createToolClient>;

/**
 * `CallTool` for the standalone page: one stateless JSON-RPC `tools/call` per request to the MCP
 * endpoint on the same origin. No session and no SDK client, to keep the bundle small.
 */
export function httpCallTool(
  endpoint: string,
  fetcher: typeof fetch = fetch,
  locale: Locale = defaultLocale,
): CallTool {
  const t = translator(errorMessages, locale);
  let id = 0;
  return async (name, args) => {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      // The session cookie of this same origin is what makes a call "mine"; nothing else is sent.
      credentials: 'same-origin',
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(20_000),
    });
    // A personal tool without a session answers 401 or 403 and still carries the tool result that says why.
    if (!response.ok && response.status !== 401 && response.status !== 403)
      throw new ToolError(name, 'failed', t('httpStatus', { status: response.status }));
    const text = await response.text();
    // The server answers with JSON; an event stream carries the same message on a `data:` line.
    const body = response.headers.get('content-type')?.includes('text/event-stream')
      ? (text
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .at(-1)
          ?.slice(5) ?? '')
      : text;
    let message: { result?: ToolResult; error?: { message?: string } };
    try {
      message = JSON.parse(body);
    } catch {
      throw new ToolError(name, 'invalid', t('notJson'));
    }
    if (message.error || !message.result) {
      const failure = describeFailure(name, message.error?.message ?? '', locale);
      throw new ToolError(name, failure.kind, failure.message);
    }
    return message.result;
  };
}
