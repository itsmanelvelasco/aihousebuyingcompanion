import type { Person } from '../../packages/contracts/planner.ts';
import { type Locale, localeNames } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import type { Answers, AnswerValue, Question, QuestionId } from '../../packages/model/questions.ts';
import {
  answerSpecFor,
  answersToInput,
  answerToInput,
  describeAnswer,
  isQuestionId,
  personFromAnswers,
  questionById,
  questions,
  questionsIn,
  schoolAgeChildren,
  unansweredInOrder,
  validateAnswer,
} from '../../packages/model/questions.ts';
import { interview } from './messages.ts';

/**
 * The answers of the interview: the shared question set (`packages/model/questions.ts`), asked by
 * voice or in the guided interview and kept in one typed state, plus the few details of the page
 * that have an input path of their own (people in the home, the person's own cash target, the town).
 *
 * Nothing here touches the page. Signed in on the main ReloCat server, each confirmed answer goes to
 * the person's own profile through `save_my_inputs` on the same origin, with the session cookie and
 * nothing else; otherwise the answers stay in this browser.
 */

/** Answers by question id, in stored units. `null` is "I don't know"; a missing key was never answered. */
export type FactAnswers = Answers;

/** The questions still to ask, in the order of the shared set, when no plan can rank them. */
export function factQuestionsToAsk(answers: FactAnswers, today: string): Question[] {
  return unansweredInOrder(answers, today);
}

/**
 * What the page shows and the voice model is told about one question, worded in `locale`. No
 * answer is in it.
 */
export function describeQuestion(question: Question, answers: FactAnswers, today: string, locale: Locale = 'en') {
  const person = personFromAnswers(answers, today);
  const worded = questionById(question.id, locale);
  return {
    id: worded.id,
    question: worded.question,
    why: worded.why,
    help: worded.help,
    sensitivity: worded.sensitivity,
    allowUnknown: worded.allowUnknown,
    answer: answerSpecFor(worded, person, today, locale),
  };
}

/** The answered facts as label and value in words, for the review list. */
export function answeredFacts(
  answers: FactAnswers,
  today: string,
  locale: Locale = 'en',
): [label: string, value: string][] {
  return questionsIn(locale).flatMap((question): [string, string][] => {
    const value = answers[question.id];
    return value === undefined ? [] : [[question.label, describeAnswer(question.id, value, today, locale)]];
  });
}

// ------------------------------------------------------------------ voice

const unknownNote = 'Send null when the person says they do not know.';

/**
 * The parameters of the Realtime tool that captures spoken answers. Money is in euros as spoken
 * (the page converts it to the stored unit), a percentage as a number such as 20, a date as
 * YYYY-MM-DD. Every property is optional: the model sends only what the person confirmed.
 */
export function factToolParameters(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const question of questions) {
    const { kind } = question;
    const optional = question.allowUnknown ? ` ${unknownNote}` : '';
    const description = `${question.question}${optional}`;
    const nullable = (type: string) => (question.allowUnknown ? [type, 'null'] : type);
    switch (kind.type) {
      case 'boolean':
        properties[question.id] = { type: nullable('boolean'), description };
        break;
      case 'date':
        properties[question.id] = { type: 'string', description: `${description} Send it as YYYY-MM-DD.` };
        break;
      case 'money':
        properties[question.id] = { type: nullable('number'), description: `${description} In euros.` };
        break;
      case 'number':
        properties[question.id] = { type: 'number', description: `${description} In ${kind.unit}.` };
        break;
      case 'percent':
        properties[question.id] = { type: 'number', description: `${description} As a number from 0 to 100.` };
        break;
      case 'choice':
        properties[question.id] = {
          type: nullable('string'),
          enum: [...kind.options.map(option => option.value), ...(question.allowUnknown ? [null] : [])],
          description,
        };
        break;
      case 'children':
        properties[question.id] = {
          type: 'array',
          description: `${description} One entry per child; an empty list means no children.`,
          items: {
            type: 'object',
            properties: { birthDate: { type: 'string', description: 'Date of birth, YYYY-MM-DD' } },
            required: ['birthDate'],
            additionalProperties: false,
          },
        };
        break;
      case 'per_child':
        properties[question.id] = {
          type: 'array',
          description: `${description} One answer per child aged 16 or younger, in the order the children were given; null for “I don’t know”.`,
          items: { type: ['boolean', 'null'] },
        };
        break;
    }
  }
  return { type: 'object', properties, additionalProperties: false };
}

/** A spoken value in the unit it is stored in: euros to cents where the fact is kept in cents, 20 to 0.2. */
function stored(id: QuestionId, value: unknown): unknown {
  const { kind } = questionById(id);
  if (typeof value !== 'number') return value;
  if (kind.type === 'money' && kind.storedAs === 'cents') return Math.round(value * 100);
  return kind.type === 'percent' ? Math.round(value * 100) / 10_000 : value;
}

/**
 * Apply the arguments of the voice tool to the typed state. Each value is validated with the shared
 * rules; one that fails is left out and reported, so the model can ask again. Unknown names are ignored.
 */
export function applySpokenFacts(
  args: Record<string, unknown>,
  answers: FactAnswers,
  today: string,
  options: {
    /** The stored person, when the children a schooling answer is about are known only to the profile. */
    base?: Person;
    /** Argument names that are not questions and are handled elsewhere (`applySpokenExtras`). */
    handledElsewhere?: readonly string[];
  } = {},
) {
  let next: FactAnswers = { ...answers };
  const updated: QuestionId[] = [];
  const rejected: { id: string; reason: string }[] = [];
  // In the order of the set, so a schooling answer is checked against the children given with it.
  for (const question of questions) {
    if (!Object.hasOwn(args, question.id)) continue;
    const value = stored(question.id, args[question.id]);
    const perChild = question.kind.type === 'per_child';
    const childCount = perChild
      ? schoolAgeChildren(personFromAnswers(next, today, options.base), today).length
      : undefined;
    const problem =
      perChild && childCount === 0
        ? 'There is no child aged 16 or younger to answer this for.'
        : validateAnswer(question.id, value, { today, ...(childCount === undefined ? {} : { childCount }) });
    if (problem) rejected.push({ id: question.id, reason: problem });
    else {
      next = { ...next, [question.id]: value as AnswerValue | null };
      updated.push(question.id);
    }
  }
  for (const name of Object.keys(args))
    if (!isQuestionId(name) && !options.handledElsewhere?.includes(name))
      rejected.push({ id: name, reason: 'Unknown fact.' });
  return { answers: next, updated, rejected };
}

/**
 * What the voice session is told about the facts: which are answered (ids only, never a value) and
 * the question to ask next. Tax bases, disability and family status therefore reach OpenAI only if
 * the person says them aloud in the voice conversation itself.
 */
export function voiceFactContext(answers: FactAnswers, today: string, locale: Locale = 'en') {
  const [next] = factQuestionsToAsk(answers, today);
  return {
    answeredFactIds: questions.filter(question => answers[question.id] !== undefined).map(question => question.id),
    // Worded in the language of the conversation, so the model asks the reviewed wording, not its own translation.
    nextFactQuestion: next ? describeQuestion(next, answers, today, locale) : null,
  };
}

const spokenLanguages: Record<Locale, string> = { en: 'English', ca: 'Catalan', es: 'Spanish' };

/**
 * The line of the voice instructions that sets the language of the conversation. The instructions
 * themselves stay in English. With no language chosen the model follows the person, as before;
 * with Catalan or Spanish chosen on the page it speaks and listens in that language, and still
 * follows the person if they clearly switch.
 */
export function voiceLanguageInstruction(locale: Locale = 'en') {
  if (locale === 'en') return "Speak in the user's language and keep each spoken turn short.";
  const language = `${spokenLanguages[locale]} (${localeNames[locale]})`;
  return `Speak with the person in ${language}: they chose it for this page, so expect their answers in it, including “I don’t know” said in ${spokenLanguages[locale]}. Ask every question in ${spokenLanguages[locale]}; if they clearly switch to another language, follow them. Tool arguments and saved values keep their defined formats, whatever the language spoken. Keep each spoken turn short.`;
}

/** What to tell a live voice session when the person changes the page language. */
export function voiceLanguageChange(locale: Locale) {
  return `The person changed the page language to ${spokenLanguages[locale]} (${localeNames[locale]}). From now on speak with them in ${spokenLanguages[locale]}, and continue the interview where it was.`;
}

export const factInstructions = `Ask exactly the question in nextQuestion (first from the user data below, then from each tool
result), one per turn, in the wording given, and nothing before or after it. Its why and its effect are there for when
the person asks what the question is for or hesitates: then say one of them in one sentence; otherwise do not say them.
A sensitivity note is the one thing said before its question, in one short sentence. If the person does not know, that
is a valid answer where the question allows it: save null, never zero, never a
guess, and never work out a tax or family fact from age, income or household size. A figure stated plainly is saved at
once with save_interview_answers; a household or tax fact is read back and saved only after the person says yes. If the
tool rejects a value, say why in one sentence and ask again. When
nextQuestion is null, say that nothing more would change the plan and call show_plan. A tax base
is a figure from the income tax return, not a salary; read the help text when asked where to find it.`;

// --------------------------------------------------------- page details

/**
 * What the page keeps besides the shared questions, each with an input path of its own:
 * `household.size`, `finance.targetCashCents` and `location.selectedMunicipalityCode`.
 */
export type Extras = {
  householdSize?: number;
  /** The person's own cash target, in integer euro cents. */
  targetCashCents?: number;
  /** The town chosen last, as a six-digit municipality code: an exact, confirmed match of the pilot only. */
  selectedMunicipalityCode?: string | null;
};
/** The names the voice tool uses for the first two; the town has its own tool. */
export const spokenExtras = ['householdSize', 'targetCash'] as const;
const maxCashEur = 50_000_000;

/** The parameters the voice tool adds to the shared questions. */
export function extraToolParameters(): Record<string, unknown> {
  return {
    householdSize: {
      type: 'integer',
      minimum: 1,
      maximum: 30,
      description: 'How many people will live in the home, including the person.',
    },
    targetCash: {
      type: 'number',
      minimum: 0,
      description:
        'The person’s own figure for the cash they want to set aside for the purchase. In euros. Only when they state one.',
    },
  };
}

/** Apply the page details of a voice tool call. A value that fails is left out and reported. */
export function applySpokenExtras(args: Record<string, unknown>, extras: Extras) {
  const next: Extras = { ...extras };
  const updated: string[] = [];
  const rejected: { id: string; reason: string }[] = [];
  if (Object.hasOwn(args, 'householdSize')) {
    const size = args.householdSize;
    if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 1 && size <= 30) {
      next.householdSize = size;
      updated.push('householdSize');
    } else rejected.push({ id: 'householdSize', reason: 'Give a whole number of people from 1 to 30.' });
  }
  if (Object.hasOwn(args, 'targetCash')) {
    const target = args.targetCash;
    if (typeof target === 'number' && Number.isFinite(target) && target >= 0 && target <= maxCashEur) {
      next.targetCashCents = Math.round(target * 100);
      updated.push('targetCash');
    } else rejected.push({ id: 'targetCash', reason: 'Give an amount in euros that is not negative.' });
  }
  return { extras: next, updated, rejected };
}

export type InputData = Record<string, Record<string, unknown>>;
function merge(into: InputData, from: InputData) {
  for (const [group, fields] of Object.entries(from)) into[group] = { ...into[group], ...fields };
  return into;
}

/** The page details as input fields. Only what is present is written. */
export function extrasToInput(extras: Extras): InputData {
  const data: InputData = {};
  if (extras.householdSize !== undefined) data.household = { size: extras.householdSize };
  if (extras.targetCashCents !== undefined) data.finance = { targetCashCents: extras.targetCashCents };
  if (extras.selectedMunicipalityCode !== undefined)
    data.location = { selectedMunicipalityCode: extras.selectedMunicipalityCode };
  return data;
}

// --------------------------------------------------------- save to profile

/**
 * The input record for the person's profile: every answer, in the shared input paths, plus the page
 * details. Returns null when there is nothing to save.
 */
export function profileData(answers: FactAnswers, extras: Extras, today: string) {
  const data = merge(answersToInput(answers, today), extrasToInput(extras));
  return Object.keys(data).length ? data : null;
}

const schooling = ['childrenItpSchooling', 'childrenIrpfSchooling'] as const;
const isSchooling = (id: string): id is (typeof schooling)[number] => (schooling as readonly string[]).includes(id);

/**
 * The input record for some of the answers: the ones just confirmed. The list of children is always
 * written whole, with both schooling answers on it, because the flags live on each child. When the
 * children are known only to the stored profile (`base`), a schooling answer is written onto those.
 */
export function inputFor(
  ids: readonly string[],
  answers: FactAnswers,
  extras: Extras,
  today: string,
  base?: Person,
): InputData | null {
  const subset: Record<string, AnswerValue | null> = {};
  for (const id of ids) {
    const value = isQuestionId(id) && !isSchooling(id) ? answers[id] : undefined;
    if (value !== undefined) subset[id] = value;
  }
  const asked = ids.filter(isSchooling).filter(id => answers[id] !== undefined);
  const ownChildren = Array.isArray(answers.children);
  if (ownChildren && (asked.length || ids.includes('children')))
    for (const id of ['children', ...schooling] as const) {
      const value = answers[id];
      if (value !== undefined) subset[id] = value;
    }
  const data = answersToInput(subset as FactAnswers, today);
  if (!ownChildren && base) {
    const person = personFromAnswers(answers, today, base);
    for (const id of asked) merge(data, answerToInput(id, answers[id] as AnswerValue | null, { person, day: today }));
  }
  const details: Extras = {};
  if (ids.includes('householdSize') && extras.householdSize !== undefined) details.householdSize = extras.householdSize;
  if (ids.includes('targetCash') && extras.targetCashCents !== undefined)
    details.targetCashCents = extras.targetCashCents;
  if (ids.includes('place') && extras.selectedMunicipalityCode !== undefined)
    details.selectedMunicipalityCode = extras.selectedMunicipalityCode;
  merge(data, extrasToInput(details));
  return Object.keys(data).length ? data : null;
}

export type ToolAnswer = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
  _meta?: Record<string, unknown>;
};
/**
 * One call to a tool of the ReloCat server. Null when the origin has no such endpoint (the
 * interviewer running on its own port) or does not answer with a tool result. Tests inject a fake.
 */
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolAnswer | null>;

/**
 * `CallTool` over HTTP: one stateless JSON-RPC `tools/call` to the MCP endpoint of this same origin,
 * exactly as the workspace's standalone page makes it (`apps/web/client.ts`): the session cookie is
 * what makes the call "mine", and nothing else identifies the person.
 */
export function toolCaller(fetcher: typeof fetch, endpoint: string): CallTool {
  return async (name, args) => {
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        credentials: 'same-origin',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return null;
    }
    // A personal tool without a session answers 401 or 403 and still carries the tool result that says why.
    if (!response.ok && response.status !== 401 && response.status !== 403) return null;
    const text = await response.text();
    const body = response.headers.get('content-type')?.includes('text/event-stream')
      ? (text
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .at(-1)
          ?.slice(5) ?? '')
      : text;
    try {
      const message = JSON.parse(body) as { result?: ToolAnswer };
      return message.result ?? null;
    } catch {
      return null;
    }
  };
}

/** A tool result that says "sign in first": the server attaches the OAuth challenge to it. */
export const needsSignIn = (answer: ToolAnswer) => Boolean(answer._meta && 'mcp/www_authenticate' in answer._meta);

/**
 * Where this page is running, for the person:
 * - `signed_in`: on the main server with a session; each confirmed answer is saved to the profile.
 * - `signed_out`: on the main server without a session; the answers stay on this device.
 * - `standalone`: no ReloCat account service on this origin; the answers stay on this device.
 */
export type ProfileAccess = 'signed_in' | 'signed_out' | 'standalone';

/** Ask the server whether somebody is signed in. It reads no personal data. */
export async function accessVia(call: CallTool): Promise<ProfileAccess> {
  const answer = await call('show_workspace', {});
  const launch = answer?.structuredContent as { signedIn?: unknown } | undefined;
  if (!answer || answer.isError || typeof launch?.signedIn !== 'boolean') return 'standalone';
  return launch.signedIn ? 'signed_in' : 'signed_out';
}
export const profileAccess = (fetcher: typeof fetch, endpoint: string) => accessVia(toolCaller(fetcher, endpoint));

export type SaveOutcome =
  | { saved: true; inputId: string }
  | { saved: false; reason: 'nothing' | 'signed_out' | 'unavailable' | 'failed'; message: string };

/**
 * Save confirmed interview answers to the signed-in person's own profile through `save_my_inputs`
 * (source `interview`, confirmed). The person gave and confirmed each answer in the interview.
 */
export async function saveVia(call: CallTool, data: InputData | null, locale: Locale = 'en'): Promise<SaveOutcome> {
  const t = translator(interview, locale);
  const failed = { saved: false, reason: 'failed', message: t('save.failed') } as const;
  if (!data) return { saved: false, reason: 'nothing', message: t('save.nothing') };
  const answer = await call('save_my_inputs', { data, confirmed: true, source: 'interview' });
  if (!answer) return { saved: false, reason: 'unavailable', message: t('save.unavailable') };
  if (answer.isError)
    return needsSignIn(answer) ? { saved: false, reason: 'signed_out', message: t('save.signed_out') } : failed;
  const result = answer.structuredContent as { saved?: unknown; inputId?: unknown } | undefined;
  return result?.saved === true && typeof result.inputId === 'string'
    ? { saved: true, inputId: result.inputId }
    : failed;
}
export const saveToProfile = (
  data: InputData | null,
  fetcher: typeof fetch,
  endpoint: string,
  locale: Locale = 'en',
): Promise<SaveOutcome> => saveVia(toolCaller(fetcher, endpoint), data, locale);
