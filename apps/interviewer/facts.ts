import type { Answers, AnswerValue, Question, QuestionId } from '../../packages/model/questions.ts';
import {
  answerSpecFor,
  answersToInput,
  describeAnswer,
  isQuestionId,
  personFromAnswers,
  questionById,
  questions,
  schoolAgeChildren,
  unansweredInOrder,
  validateAnswer,
} from '../../packages/model/questions.ts';

/**
 * The plan facts in the interviewer: the shared question set (`packages/model/questions.ts`) asked
 * after the money questions, by voice or in the guided interview, kept in one typed state.
 *
 * Nothing here touches the page. The answers live in this browser until the person, signed in on
 * the main ReloCat server, chooses to save the confirmed ones to their own profile; that goes
 * through `save_my_inputs` on the same origin, with the session cookie and nothing else.
 */

/** Answers by question id, in stored units. `null` is "I don't know"; a missing key was never answered. */
export type FactAnswers = Answers;

/**
 * Already asked by the interview's own money questions ("How much have you already set aside?"),
 * so it is not asked twice. The interview's figure is saved in its place when it is in euros.
 */
export const coveredByInterview: readonly QuestionId[] = ['purchaseSavings'];

/** The fact questions still to ask, in the order of the shared set, given the answers so far. */
export function factQuestionsToAsk(answers: FactAnswers, today: string): Question[] {
  return unansweredInOrder(answers, today, coveredByInterview);
}

/** What the page shows and the voice model is told about one question. No answer is in it. */
export function describeQuestion(question: Question, answers: FactAnswers, today: string) {
  const person = personFromAnswers(answers, today);
  return {
    id: question.id,
    question: question.question,
    why: question.why,
    help: question.help,
    sensitivity: question.sensitivity,
    allowUnknown: question.allowUnknown,
    answer: answerSpecFor(question, person, today),
  };
}

/** The answered facts as label and value in words, for the review list. */
export function answeredFacts(answers: FactAnswers, today: string): [label: string, value: string][] {
  return questions.flatMap((question): [string, string][] => {
    const value = answers[question.id];
    return value === undefined ? [] : [[question.label, describeAnswer(question.id, value, today)]];
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
    if (coveredByInterview.includes(question.id)) continue;
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
export function applySpokenFacts(args: Record<string, unknown>, answers: FactAnswers, today: string) {
  let next: FactAnswers = { ...answers };
  const updated: QuestionId[] = [];
  const rejected: { id: string; reason: string }[] = [];
  // In the order of the set, so a schooling answer is checked against the children given with it.
  for (const question of questions) {
    if (!Object.hasOwn(args, question.id) || coveredByInterview.includes(question.id)) continue;
    const value = stored(question.id, args[question.id]);
    const perChild = question.kind.type === 'per_child';
    const childCount = perChild ? schoolAgeChildren(personFromAnswers(next, today), today).length : undefined;
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
  for (const name of Object.keys(args)) if (!isQuestionId(name)) rejected.push({ id: name, reason: 'Unknown fact.' });
  return { answers: next, updated, rejected };
}

/**
 * What the voice session is told about the facts: which are answered (ids only, never a value) and
 * the question to ask next. Tax bases, disability and family status therefore reach OpenAI only if
 * the person says them aloud in the voice conversation itself.
 */
export function voiceFactContext(answers: FactAnswers, today: string) {
  const [next] = factQuestionsToAsk(answers, today);
  return {
    answeredFactIds: questions.filter(question => answers[question.id] !== undefined).map(question => question.id),
    nextFactQuestion: next ? describeQuestion(next, answers, today) : null,
  };
}

export const factInstructions = `After the savings figures are confirmed, ask the plan facts: the facts that decide which
tax measures and aids apply. Ask exactly the question in nextFactQuestion (first from the user data below, then from each
save_plan_facts result), one per turn, in the user's language. Say in one short sentence why it is asked (its why). If it has
a sensitivity note, say it before asking. If the person does not know, that is a valid answer: save null, never zero, never a
guess, and never work out a tax or family fact from age, income or household size. Repeat the answer back and call
save_plan_facts only after the person confirms it. If the tool rejects a value, say why and ask again. When nextFactQuestion
is null, say the plan facts are complete and that they can be reviewed and, when signed in, saved under Your plan. A tax base
is a figure from the income tax return, not a salary; read the help text when asked where to find it.`;

// --------------------------------------------------------- save to profile

export type InterviewFigures = {
  /** Currency of the interview's savings figures. Only euros are saved: nothing is converted. */
  currency: string;
  saved?: number;
  target?: number;
  householdSize?: number;
};

/**
 * The input record for the person's profile: every answered plan fact, plus the interview's own
 * savings figures when they are in euros. Returns null when there is nothing to save.
 */
export function profileData(answers: FactAnswers, figures: InterviewFigures, today: string) {
  const data = answersToInput(answers, today);
  const cents = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : undefined;
  if (figures.currency === 'EUR') {
    const [saved, target] = [cents(figures.saved), cents(figures.target)];
    const finance = {
      ...(saved === undefined ? {} : { currentSavingsCents: saved }),
      ...(target === undefined ? {} : { targetCashCents: target }),
    };
    if (Object.keys(finance).length) data.finance = { ...finance, ...data.finance };
  }
  if (Number.isSafeInteger(figures.householdSize) && (figures.householdSize ?? 0) >= 1)
    data.household = { size: figures.householdSize };
  return Object.keys(data).length ? data : null;
}

type ToolAnswer = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
  _meta?: Record<string, unknown>;
};

/**
 * One stateless JSON-RPC `tools/call` to the MCP endpoint of this same origin, exactly as the
 * workspace's standalone page makes it (`apps/web/client.ts`): the session cookie is what makes the
 * call "mine", and nothing else identifies the person. Returns null when the origin has no such
 * endpoint (the interviewer running on its own port) or does not answer with a tool result.
 */
async function callOwnTool(
  name: string,
  args: Record<string, unknown>,
  fetcher: typeof fetch,
  endpoint: string,
): Promise<ToolAnswer | null> {
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
}

/**
 * Where this page is running, for the person:
 * - `signed_in`: on the main server with a session; the answers can be saved to the profile.
 * - `signed_out`: on the main server without a session; the answers stay on this device.
 * - `standalone`: no ReloCat account service on this origin; the answers stay on this device.
 */
export type ProfileAccess = 'signed_in' | 'signed_out' | 'standalone';

/** Ask the same-origin server whether somebody is signed in. It reads no personal data. */
export async function profileAccess(fetcher: typeof fetch, endpoint: string): Promise<ProfileAccess> {
  const answer = await callOwnTool('show_workspace', {}, fetcher, endpoint);
  const launch = answer?.structuredContent as { signedIn?: unknown } | undefined;
  if (!answer || answer.isError || typeof launch?.signedIn !== 'boolean') return 'standalone';
  return launch.signedIn ? 'signed_in' : 'signed_out';
}

export type SaveOutcome =
  | { saved: true; inputId: string }
  | { saved: false; reason: 'nothing' | 'signed_out' | 'unavailable' | 'failed'; message: string };

/**
 * Save the confirmed interview answers to the signed-in person's own profile through
 * `save_my_inputs` (source `interview`, confirmed). The person gave and confirmed each answer in the
 * interview; this is called only when they press the button that says so.
 */
export async function saveToProfile(
  data: Record<string, Record<string, unknown>> | null,
  fetcher: typeof fetch,
  endpoint: string,
): Promise<SaveOutcome> {
  if (!data) return { saved: false, reason: 'nothing', message: 'There are no answers to save yet.' };
  const answer = await callOwnTool('save_my_inputs', { data, confirmed: true, source: 'interview' }, fetcher, endpoint);
  if (!answer)
    return {
      saved: false,
      reason: 'unavailable',
      message: 'This page is not connected to a ReloCat account, so the answers stay on this device.',
    };
  if (answer.isError) {
    const signIn = Boolean(answer._meta && 'mcp/www_authenticate' in answer._meta);
    return signIn
      ? { saved: false, reason: 'signed_out', message: 'Sign in to save. The answers are still on this device.' }
      : { saved: false, reason: 'failed', message: 'The answers could not be saved. They are still on this device.' };
  }
  const result = answer.structuredContent as { saved?: unknown; inputId?: unknown } | undefined;
  return result?.saved === true && typeof result.inputId === 'string'
    ? { saved: true, inputId: result.inputId }
    : { saved: false, reason: 'failed', message: 'The answers could not be saved. They are still on this device.' };
}
