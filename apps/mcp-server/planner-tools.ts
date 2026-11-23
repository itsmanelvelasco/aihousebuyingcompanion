import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { goalSchema, stateSchema } from '../../packages/contracts/habits.ts';
import { safeId } from '../../packages/contracts/ids.ts';
import { inputSchema } from '../../packages/contracts/inputs.ts';
import { localeArgument } from '../../packages/contracts/locale.ts';
import type { Policy, Snapshot } from '../../packages/contracts/places.ts';
import { isoDate, municipalityCode } from '../../packages/contracts/places.ts';
import type { NextQuestion, Person, PlanResult } from '../../packages/contracts/planner.ts';
import {
  factConflict,
  habit as habitContract,
  knownFact,
  nextQuestion,
  person,
  personInput,
  place,
  placeQuestion,
  planInput,
  planResult,
} from '../../packages/contracts/planner.ts';
import { ApiError } from '../../packages/http/server.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { toolLocale } from '../../packages/i18n/server.ts';
import { bankSummaryInput, buildPerson, habitsFromState, inlinePerson } from '../../packages/model/person.ts';
import { buildPlace } from '../../packages/model/place.ts';
import { isQuestionId, questionById } from '../../packages/model/questions.ts';
import { normalizedName } from '../../packages/places/geography.ts';
import { factMessages } from '../../packages/planner/plan.messages.ts';
import { planForPlaces } from '../../packages/planner/plan.ts';
import type { Caller, PersonReader } from './identity.ts';
import { anonymous, ownPerson, security } from './identity.ts';
import { toolMessages } from './tools.messages.ts';

export type PlannerToolOptions = {
  snapshot: Snapshot;
  policies: Policy[];
  /** Clock for date-dependent rules; tests pin it. */
  today: () => string;
  /** Who is calling. Without it only inline persons can be planned. */
  caller?: Caller;
};

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };
/** Complete calendar months of bank movements averaged into a typical month. */
const bankMonths = 3;
const provenanceItem = z.object({ confirmed: z.boolean(), observedAt: z.string(), source: z.string().optional() });
const contextResult = z.object({
  resolved: z.object({
    data: z.record(z.string(), z.record(z.string(), z.unknown())),
    provenance: z.record(z.string(), z.array(provenanceItem)).optional(),
    // Answers that disagree: the person is shown both and picks; the plan uses neither.
    conflicts: z
      .array(z.object({ field: z.string(), candidates: z.array(provenanceItem.extend({ value: z.unknown() })) }))
      .optional(),
  }),
});

/**
 * How the model should use `nextQuestions`, said once and repeated by every tool that returns them.
 * The same rules hold for every surface: one question at a time, the most valuable first, a saved
 * answer only after the person confirmed it, and "I don't know" as an answer of its own.
 */
export const askingGuidance =
  'nextQuestions lists what is still worth asking, most valuable first; an empty list means nothing more can change the plan, so stop asking. Ask ONE question at a time, in that order, in the person’s language: say the question, then why it is asked (why) and what it could change (effect.text). Read help aloud when the person hesitates, and say sensitivity before a sensitive question. Never guess an answer, never infer a tax or family fact from age, income or household size, and never turn “I don’t know” into zero or no. After each answer call the tool again: the order changes with every answer. Signed in: repeat the answer back, and only after the person confirms it call save_my_inputs with confirmed:true, writing the value at the question’s inputPath (for example data.eligibility.birthDate; money at a finance or housing path is integer cents, a tax base is euros, housing.depositRate is a share such as 0.2); “I don’t know” is saved as null at that path. Children are saved as data.eligibility.children, one object per child with birthDate, plus meetsItpSchooling or inDesignatedSchool once those are answered; [] means no children. Not signed in: nothing is stored; add the answer to the inline person instead and plan again (a date of birth as person.born.self, children as person.born.children, any other eligibility field under person.household with the same name, the figures under person.finances and person.home), and say the answers live only in this conversation (sayNotStored is that sentence in the person’s language). The inline person may be partial: start with person:{} and add each answer; whatever is left out is unknown, never zero. municipalityCodes may be empty or left out while no place is chosen: the result then asks about the person, gives withoutPlace (what they would need anywhere in Catalonia, no benefit of a place) and placeQuestion; ask the figures a timeline needs first, then where they would like to live, offering recommend_towns, and call again with the codes chosen (signed in, save the choice as data.location.selectedMunicipalityCode; it is then used when municipalityCodes is empty). An upfront amount the person says they are aiming for is saved as data.finance.targetCashCents (inline: person.finances.targetCashCents); the plan shows it beside the upfront cash it computes and keeps using the computed figure. A question with state said_unknown was already answered “I don’t know”: explain where to find the figure instead of asking again. conflicts lists answers that disagree: show the candidates, let the person pick, and save the pick; never choose for them. knownFacts with a stale note may be out of date: say when the fact was given and ask whether it still holds.';

/** The question and its reason in English, for the summary the model reads. */
function englishOf(question: { id: string; question: string; label: string; why?: string }) {
  return isQuestionId(question.id) ? questionById(question.id, 'en') : question;
}

/** What answering could change, in English, from the figures of the effect (its `text` is in the person’s language). */
function englishEffect({ effect }: Pick<NextQuestion, 'effect'>): string {
  const euros = (cents: number) => `€${Math.round(cents / 100).toLocaleString('en-GB')}`;
  const where = effect.placeName ? ` in ${effect.placeName}` : '';
  if (effect.kind === 'required') return 'Needed before a timeline can be estimated.';
  if (effect.kind === 'assumption') return 'The plan is using a default in its place.';
  if (effect.kind === 'baseline')
    return `Could lower the transfer tax anywhere in Catalonia by up to ${euros(effect.upfrontCents ?? 0)}.`;
  const months = effect.months ? `shorten the wait by up to ${effect.months} month(s)${where}` : null;
  const cash = effect.upfrontCents ? `lower the upfront cash by up to ${euros(effect.upfrontCents)}${where}` : null;
  const parts = [months, cash].filter(part => part !== null);
  return parts.length ? `Could ${parts.join(' and ')}.` : 'Could change which measures apply.';
}

/**
 * One paragraph for the tool text: the question to ask now, or that there is none. Entirely in
 * English, because it is written for the model: the question, its reason and its effect are given
 * in their English wording here, and in the person’s language in `nextQuestions`.
 */
export function nextQuestionNote(plan: Pick<PlanResult, 'nextQuestions' | 'conflicts' | 'placeQuestion'>): string {
  const [first, ...rest] = (plan.nextQuestions ?? []).filter(question => question.state !== 'said_unknown');
  const conflicts = plan.conflicts?.length
    ? ` ${plan.conflicts.length} answer(s) disagree (${plan.conflicts.map(item => englishOf(item).label).join(', ')}): show the candidates and let the person pick.`
    : '';
  const ask = (question: NextQuestion, following: number) =>
    `Ask next, one question at a time: “${englishOf(question).question}” Why: ${englishOf(question).why} ${englishEffect(question)} ${following} more question(s) follow in nextQuestions; plan again after each answer, because the order changes. nextQuestions carries the same question in the person’s language.`;
  if (plan.placeQuestion) {
    const choose =
      'ask where in Catalonia they would like to live (placeQuestion has the wording in their language), offer recommend_towns to propose towns, and call again with municipalityCodes';
    // The figures a timeline needs come before the place; everything else waits for one.
    if (first?.effect.kind === 'required')
      return `No place is chosen yet. ${ask(first, rest.length)} Once the required figures are known, ${choose}.${conflicts}`;
    return `No place is chosen yet. Ask next: ${choose}. ${first ? `${rest.length + 1} question(s) about the person remain in nextQuestions.` : 'No further question about the person would change the plan.'}${conflicts}`;
  }
  if (!first) return `No further question would change this plan.${conflicts}`;
  return `${ask(first, rest.length)}${conflicts}`;
}

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent };
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** The last `count` complete calendar months before `today`, as first and last day. */
function completeMonths(today: string, count: number) {
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const day = (date: Date) => date.toISOString().slice(0, 10);
  return { from: day(new Date(Date.UTC(year, month - 1 - count, 1))), to: day(new Date(Date.UTC(year, month - 1, 0))) };
}

/**
 * What is fictional and what is not, in one sentence for the model to repeat. The person and the
 * bank movements behind their figures are labelled separately: a real person can be connected to a
 * fictional bank, and then the profile is real and the movements are synthetic.
 */
export function provenanceNote(who: Person): string {
  const bank = who.finances.bankSynthetic;
  if (who.synthetic)
    return bank === false
      ? 'This is a fictional persona (synthetic: true), but the bank figures include real bank data.'
      : 'This is a fictional persona: every figure is synthetic demo data.';
  if (bank === true)
    return 'The profile is the person’s own (synthetic: false). The monthly figures observed in the bank come from a fictional bank feed (bankSynthetic: true), not from a real bank.';
  return bank === false
    ? 'The profile is the person’s own and the bank figures come from real bank data (synthetic: false).'
    : 'The profile is the person’s own (synthetic: false).';
}

/** A message that is safe to show: never an upstream body or a URL. */
class PersonUnavailable extends Error {}

/** What `get_next_questions` answers: the question list of a plan, without the timelines. */
export const nextQuestionsResult = z.object({
  asOf: z.string(),
  /** True when the answers belong to the signed-in person and can be saved; false for an inline person or a demo persona. */
  stored: z.boolean(),
  /** For an inline person: the sentence that says the answers live only in this conversation, in the person’s language. */
  sayNotStored: z.string().nullable(),
  /** The municipalities the questions were ranked for; empty when no place is chosen. */
  municipalityCodes: z.array(municipalityCode),
  /** Present when no place is chosen: the question that chooses one. */
  placeQuestion: placeQuestion.optional(),
  nextQuestions: z.array(nextQuestion),
  knownFacts: z.array(knownFact),
  conflicts: z.array(factConflict),
});

/** One habit as the habit tools return it: the planner's habit plus what the person agreed to do. */
const habitResult = habitContract
  .omit({ startedOn: true })
  .extend({ startedOn: isoDate.nullable(), action: z.string(), targetDaysPerWeek: z.number().int().min(1).max(7) })
  .strict();

/**
 * The person, place and plan tools. A stored person is reached only through the caller: `me` for
 * the signed-in person, or a read-only demo persona. No tool here accepts a user id.
 *
 * Returns `registerNextQuestions`, which adds the optional `get_next_questions` tool to the same
 * server. It is not registered by default: `createMcpServer` in `tools.ts` decides which tools exist,
 * and switches it on with `registerPlannerTools(server, options).registerNextQuestions()`.
 */
export function registerPlannerTools(server: McpServer, options: PlannerToolOptions) {
  let registerQuestionTool: () => unknown = () => undefined;
  const { snapshot, policies, today } = options;
  const caller = options.caller ?? anonymous;
  const demoIds = caller.demo?.ids ?? [];
  /** Only the configured demo personas can be named; any other id fails validation before a handler runs. */
  const demoId = z.enum((demoIds.length ? demoIds : ['none']) as [string, ...string[]]);

  /**
   * Assemble a person from a handle that is already bound to one id. The context is required; bank
   * movements and habits are optional evidence, and each one that could not be read is reported
   * instead of being silently dropped.
   */
  async function loadPerson(
    reader: PersonReader,
    locale: Locale = 'en',
  ): Promise<{ person: Person; notes: string[]; selectedCode: string | null }> {
    // The notes join the limitations a person reads, so they are written in the language of the result.
    const t = translator(factMessages, locale);
    const raw = await reader.context().catch(() => {
      throw new PersonUnavailable('The stored profile is unavailable right now.');
    });
    if (!raw) throw new PersonUnavailable('No stored person was found.');
    const context = contextResult.parse(raw);
    const notes: string[] = [];
    const period = completeMonths(today(), bankMonths);
    const bankSummary = await reader
      .bankSummary(period)
      .then(value => bankSummaryInput.parse(value))
      .catch(() => {
        notes.push(t('bankUnreadable'));
        return null;
      });
    const habitState = await reader
      .habits()
      .then(value => stateSchema.parse(value))
      .catch(() => {
        notes.push(t('habitsUnreadable'));
        return null;
      });
    const name = context.resolved.data.location?.currentMunicipality;
    const current =
      typeof name === 'string'
        ? snapshot.municipalities.find(town => normalizedName(town.name) === normalizedName(name))
        : undefined;
    // The place the person chose, when it was saved and the snapshot covers it.
    const chosen = context.resolved.data.location?.selectedMunicipalityCode;
    const selectedCode =
      typeof chosen === 'string' && snapshot.municipalities.some(town => town.code === chosen) ? chosen : null;
    return {
      selectedCode,
      person: buildPerson({
        userId: reader.userId,
        // Fictional for a demo persona, real for a person who belongs to an account: stated by the handle.
        synthetic: reader.synthetic,
        context,
        bankSummary: bankSummary ?? undefined,
        habitState: habitState ?? undefined,
        currentMunicipalityCode: current?.code ?? null,
      }),
      notes,
    };
  }

  /** The read-only handle of a demo persona; a tool error when the demo is off or the id is not allowed. */
  function demoPerson(id: string) {
    const reader = caller.demo?.open(id);
    if (!reader) throw new PersonUnavailable('That demo persona is not available on this server.');
    return reader;
  }

  /** Run a tool body and turn every failure into a tool error that carries no upstream detail. */
  async function guarded(run: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PersonUnavailable) return failure(error.message);
      if (error instanceof z.ZodError) return failure('The request or the stored data did not match the contract.');
      const outside = error instanceof Error && error.message.startsWith('Municipality ');
      return failure(outside ? (error as Error).message : 'The plan could not be computed.');
    }
  }

  const planToolInput = z
    .object({
      /** A person sent inline, for a what-if or an anonymous estimate. It may be partial, even empty. */
      person: personInput
        .optional()
        .describe('An inline person; every field is optional and what is left out is unknown, never zero'),
      /** Plan for the signed-in person. There is no user id argument: the server knows who is calling. */
      me: z.literal(true).optional(),
      demoId: demoId.optional().describe('A fictional demo persona, read-only'),
      municipalityCodes: planInput.shape.municipalityCodes,
      assumptions: planInput.shape.assumptions,
      locale: localeArgument,
    })
    .strict();

  type PlanToolInput = z.infer<typeof planToolInput>;
  /**
   * Who a plan tool call is about and for which places. Exactly one of `me`, `person` and `demoId`;
   * none at all is an empty inline person, the start of a conversation. With no municipality in the
   * call, the place a stored person saved (`location.selectedMunicipalityCode`) is used.
   */
  type Subject = {
    person: Person;
    notes: string[];
    selectedCode: string | null;
    stored: boolean;
    sayNotStored: string | null;
    codes: string[];
    fromProfile: boolean;
  };
  async function subject(input: PlanToolInput, locale: Locale): Promise<Subject | { error: CallToolResult }> {
    const chosen = [input.person, input.me, input.demoId].filter(value => value !== undefined);
    if (chosen.length > 1) return { error: failure('Provide only one of me:true, person or demoId.') };
    const say = translator(toolMessages, locale);
    let loaded: { person: Person; notes: string[]; selectedCode: string | null };
    let stored = false;
    let sayNotStored: string | null = null;
    if (input.me) {
      const own = ownPerson(caller, 'person:read', locale);
      if ('error' in own) return { error: own.error };
      loaded = await loadPerson(own.me, locale);
      stored = true;
    } else if (input.demoId !== undefined) loaded = await loadPerson(demoPerson(input.demoId), locale);
    else {
      loaded = { person: inlinePerson(input.person ?? {}), notes: [], selectedCode: null };
      sayNotStored = say(caller.challenge ? 'sayNotStored' : 'sayNotStoredNoAccounts');
    }
    const stated = [...new Set(input.municipalityCodes)];
    const codes = stated.length || !loaded.selectedCode ? stated : [loaded.selectedCode];
    return { ...loaded, stored, sayNotStored, codes, fromProfile: !stated.length && codes.length > 0 };
  }

  /** In English, for the model: where the answers of this call live. */
  const storageNote = (who: { stored: boolean; sayNotStored: string | null }) =>
    who.stored
      ? ''
      : who.sayNotStored
        ? ' Inline person: nothing was saved. Tell the person their answers live only in this conversation and how to connect their account (sayNotStored is that sentence in their language); keep adding each answer to person.'
        : '';

  server.registerTool(
    'plan_home_savings',
    {
      title: 'The plan: months of saving to buy in each place',
      description: `The plan of ReloCat, the one answer to “when can I buy?”. For one person and up to eight municipalities, compute the upfront cash to buy (deposit, transfer tax, purchase fees) and the months of saving needed: with current savings, with the person’s habits, and with the benefits each place offers. Pass one of: me:true for the signed-in person (needs sign-in), an inline person (partial is fine), or demoId for a fictional demo persona. There is no user id argument. Benefits are counted only when eligibility is confirmed unless includeUnverifiedBenefits is set; closed calls are never counted. A benefit stays needs_verification until the facts that decide it are known. ${askingGuidance} habits says for each habit whether it was counted and why: say so instead of assuming an active habit was counted. A benefit with a null amountCents and an ineligible status brings the person nothing; nominalAmountCents is only what it is worth to someone who qualifies. person.synthetic and person.finances.bankSynthetic say separately whether the person and the bank movements are fictional: repeat them as given. This is arithmetic on supplied figures: it is not mortgage approval and no aid is guaranteed. Present assumptions, dataMissing and limitations with the result, then offer show_workspace to see it.`,
      inputSchema: planToolInput,
      outputSchema: planResult,
      annotations: readOnly,
      _meta: security('either'),
    },
    (input, extra) =>
      guarded(async () => {
        // The language of every sentence in the result; the summary for the model stays in English.
        const locale = toolLocale(input.locale, extra._meta);
        const who = await subject(input, locale);
        if ('error' in who) return who.error;
        const places = who.codes.map(code => buildPlace(snapshot, code, locale));
        const plan = planForPlaces(who.person, places, policies, input.assumptions, today(), locale);
        const finite = plan.plans.filter(item => item.withPlaceBenefits?.months != null);
        const best = finite[0];
        const anywhere = plan.withoutPlace;
        const summary = anywhere
          ? anywhere.withHabits?.months != null
            ? `Anywhere in Catalonia, before the benefits of any place: about ${anywhere.withHabits.months} months of saving. An arithmetic estimate, not mortgage approval or guaranteed aid.`
            : 'No timeline can be estimated yet; withoutPlace.dataMissing says what is missing.'
          : best
            ? `Shortest estimate: ${best.withPlaceBenefits?.months} months of saving for ${best.place.name}. An arithmetic estimate, not mortgage approval or guaranteed aid.`
            : 'No finite savings timeline could be estimated; see status and dataMissing for each place.';
        const profilePlace = who.fromProfile ? ' Planned for the place saved in the profile.' : '';
        const target = [...plan.plans, ...(anywhere ? [anywhere] : [])].find(item => item.upfrontTarget)?.upfrontTarget;
        const targetNote = target
          ? ' The person stated an upfront target: it is shown beside the computed upfront cash (upfrontTarget and the assumptions), and every timeline uses the computed figure.'
          : '';
        const withheld = (plan.habits ?? []).filter(
          effect => effect.reason === 'inside_bank_figures' || effect.reason === 'start_unknown',
        ).length;
        const habitNote = withheld
          ? ` ${withheld} active habit(s) are shown but not counted; habits says why for each.`
          : '';
        return result(
          `${summary}${profilePlace}${targetNote}${habitNote} ${nextQuestionNote(plan)}${storageNote(who)} ${provenanceNote(plan.person)}`,
          {
            ...plan,
            limitations: [...plan.limitations, ...who.notes],
            stored: who.stored,
            sayNotStored: who.sayNotStored,
          },
        );
      }),
  );

  server.registerTool(
    'get_person',
    {
      title: 'Read my person: finances, home needs and habits',
      description:
        'Assemble the signed-in person from their saved inputs, recent bank cash flow and habit goals. Takes no arguments: it always reads the caller’s own person and needs sign-in. Unknown facts are null, not zero. finances.basis says whether figures were declared or observed in bank movements; finances.bankSynthetic says whether those movements come from a fictional bank feed, which is separate from the person being real (synthetic: false). Savings for the purchase are only what the person declared: a bank balance is never used for them.',
      inputSchema: z.object({}).strict(),
      outputSchema: person,
      annotations: readOnly,
      _meta: security('personal'),
    },
    (_input, extra) =>
      guarded(async () => {
        const own = ownPerson(caller, 'person:read', toolLocale(undefined, extra._meta));
        if ('error' in own) return own.error;
        const loaded = await loadPerson(own.me);
        return result(
          ['Your person, assembled from your saved inputs.', provenanceNote(loaded.person), ...loaded.notes].join(' '),
          loaded.person,
        );
      }),
  );

  server.registerTool(
    'get_my_inputs',
    {
      title: 'Read what I have saved',
      description:
        'Return the signed-in person’s saved input records and the resolved context built from them (which value wins per field, its source, and unresolved conflicts). Each record carries synthetic: false for what the person stated, true only for a record derived from a fictional source. bankSnapshot, when present, is an account balance kept as its own unconfirmed fact: it is not savings for the purchase. Takes no arguments and needs sign-in.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        inputCount: z.number().int().nonnegative(),
        inputs: z.array(z.record(z.string(), z.unknown())),
        resolved: z.record(z.string(), z.unknown()),
        recommendation: z.record(z.string(), z.unknown()).nullable(),
        warnings: z.array(z.string()),
        bankSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
      annotations: readOnly,
      _meta: security('personal'),
    },
    (_input, extra) =>
      guarded(async () => {
        const own = ownPerson(caller, 'person:read', toolLocale(undefined, extra._meta));
        if ('error' in own) return own.error;
        const context = await own.me.context();
        if (!context) throw new PersonUnavailable('No stored person was found.');
        const stored = z.object({ inputs: z.array(z.record(z.string(), z.unknown())) }).parse(await own.me.inputs());
        return result(`${stored.inputs.length} saved input records.`, {
          inputCount: stored.inputs.length,
          // Each record carries its own flag: false for what the person stated, true for a fabricated source.
          inputs: stored.inputs,
          resolved: (context.resolved ?? {}) as Record<string, unknown>,
          recommendation: (context.recommendation ?? null) as Record<string, unknown> | null,
          warnings: Array.isArray(context.warnings) ? (context.warnings as string[]) : [],
          bankSnapshot: (context.bankSnapshot ?? null) as Record<string, unknown> | null,
        });
      }),
  );

  server.registerTool(
    'save_my_inputs',
    {
      title: 'Save details to my profile',
      description:
        'Save facts the signed-in person stated about their household, housing needs, schools, transport, finances (integer cents: finance.monthlyIncomeCents, finance.monthlyExpensesCents, finance.currentSavingsCents, finance.emergencyReserveCents, finance.targetCashCents for an upfront target, housing.budgetCents), where they want to live (location.selectedMunicipalityCode) or eligibility. This is the one store of answers: the plan reads them from here. Needs sign-in with write permission; it always writes to the caller’s own person. Save an answer to one of the plan’s nextQuestions at its inputPath, one answer per call, and only after repeating it back and hearing the person confirm it: then confirmed:true. An unconfirmed household fact is stored but never used to count a benefit. “I don’t know” is saved as null at the same path, which records that the person was asked; never save zero, false or a guess in its place. eligibility.birthDate is the buyer’s date of birth (preferred over eligibility.age, which goes out of date); eligibility.children is the whole list of children, each with birthDate (or birthYear or age) and, once answered, meetsItpSchooling and inDesignatedSchool; [] means no children. Tax bases are euros from the tax return, never a salary. Each call adds one dated record; earlier records are kept. An answer that contradicts an earlier confirmed one from another source is reported as a conflict by plan_home_savings and get_my_inputs and is not silently preferred.',
      inputSchema: z
        .object({
          data: inputSchema.shape.data,
          confirmed: z.boolean(),
          source: z.enum(['interview', 'manual']).default('interview'),
          locale: localeArgument,
        })
        .strict(),
      outputSchema: z.object({ saved: z.boolean(), inputId: z.string(), inputCount: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: security('personal', ['person:write']),
    },
    (input, extra) =>
      guarded(async () => {
        const own = ownPerson(caller, 'person:write', toolLocale(input.locale, extra._meta));
        if ('error' in own) return own.error;
        const inputId = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        await own.me.saveInputs([
          {
            id: inputId,
            source: input.source,
            observedAt: new Date().toISOString(),
            confirmed: input.confirmed,
            // What a signed-in person states about themselves is real; the handle knows which it is.
            synthetic: own.me.synthetic,
            data: input.data,
          },
        ]);
        const stored = z.object({ inputs: z.array(z.unknown()) }).parse(await own.me.inputs());
        return result('Saved to your profile.', { saved: true, inputId, inputCount: stored.inputs.length });
      }),
  );

  registerQuestionTool = () =>
    server.registerTool(
      'get_next_questions',
      {
        title: 'What to ask this person next',
        description: `For one person and up to eight municipalities (none while no place is chosen), return only the questions worth asking next, the facts already known with their source, and any answers that disagree. It is the same list plan_home_savings returns, without the timelines: use it between answers of an interview. Pass one of me:true (needs sign-in), an inline person (partial is fine; person:{} to start), or demoId. ${askingGuidance}`,
        inputSchema: planToolInput,
        outputSchema: nextQuestionsResult,
        annotations: readOnly,
        _meta: security('either'),
      },
      (input, extra) =>
        guarded(async () => {
          const locale = toolLocale(input.locale, extra._meta);
          const who = await subject(input, locale);
          if ('error' in who) return who.error;
          const places = who.codes.map(code => buildPlace(snapshot, code, locale));
          const plan = planForPlaces(who.person, places, policies, input.assumptions, today(), locale);
          return result(`${nextQuestionNote(plan)}${storageNote(who)}`, {
            asOf: plan.asOf,
            stored: who.stored,
            sayNotStored: who.sayNotStored,
            municipalityCodes: who.codes,
            ...(plan.placeQuestion ? { placeQuestion: plan.placeQuestion } : {}),
            nextQuestions: plan.nextQuestions ?? [],
            knownFacts: plan.knownFacts ?? [],
            conflicts: plan.conflicts ?? [],
          });
        }),
    );

  // ---------------------------------------------------------------- habits
  type StoredGoal = z.infer<typeof goalSchema>;
  /** The habits of a stored state as the tools return them: the planner's reading plus the agreed action. */
  const habitsOf = (state: z.infer<typeof stateSchema>) => {
    const read = habitsFromState(state);
    return state.goals.map((goal, index) => ({
      ...read[index],
      startedOn: goal.startedOn,
      action: goal.action,
      targetDaysPerWeek: goal.targetDaysPerWeek,
    }));
  };

  server.registerTool(
    'list_my_habits',
    {
      title: 'Read my saving habits',
      description:
        'List the signed-in person’s habits: what each one is, the monthly saving the person attached to it (integer cents; null when none), whether it is active or paused, the day it started and the share of check-ins kept. Takes no user id and needs sign-in. Whether a habit shortens the plan is decided by plan_home_savings, which says so habit by habit.',
      inputSchema: z.object({ locale: localeArgument }).strict(),
      outputSchema: z.object({ habits: z.array(habitResult) }),
      annotations: readOnly,
      _meta: security('personal'),
    },
    (input, extra) =>
      guarded(async () => {
        const own = ownPerson(caller, 'person:read', toolLocale(input.locale, extra._meta));
        if ('error' in own) return own.error;
        const habits = habitsOf(stateSchema.parse(await own.me.habits()));
        return result(`${habits.length} habit(s). plan_home_savings says which ones count and why.`, { habits });
      }),
  );

  server.registerTool(
    'save_my_habit',
    {
      title: 'Create or update one of my saving habits',
      description:
        'Create a habit of the signed-in person, or update the one with the same id: something they do repeatedly that changes how much they save each month (cooking at home, cancelling a subscription). Needs sign-in with write permission and always writes to the caller’s own person. Save it only after the person agreed to the habit and to the monthly saving they expect from it; monthlySavingCents is their own estimate in integer cents, and null means no saving is assumed (never invent one). A new active habit starts today unless startedOn says another day (never a future one); when updating, fields left out keep their stored value, and active:false pauses the habit. Then call plan_home_savings: a habit counts on top of declared spending, and on top of spending observed in bank movements only when it started after the observed period, because an older habit is already inside those figures. The plan says for each habit whether it was counted and why.',
      inputSchema: z
        .object({
          id: safeId.describe('Stable id of the habit, such as cook-at-home; the same id updates it'),
          title: goalSchema.shape.title,
          category: goalSchema.shape.category,
          action: goalSchema.shape.action.optional().describe('What the person will do, in one sentence'),
          monthlySavingCents: z.number().int().safe().nonnegative().max(100_000_000_000).nullable().optional(),
          targetDaysPerWeek: z.number().int().min(1).max(7).optional(),
          active: z.boolean().optional(),
          startedOn: isoDate.optional(),
          locale: localeArgument,
        })
        .strict(),
      outputSchema: z.object({ saved: z.boolean(), created: z.boolean(), habit: habitResult }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: security('personal', ['person:write']),
    },
    (input, extra) =>
      guarded(async () => {
        const locale = toolLocale(input.locale, extra._meta);
        const say = translator(toolMessages, locale);
        const own = ownPerson(caller, 'person:write', locale);
        if ('error' in own) return own.error;
        if (!own.me.saveHabit) return failure(say('habitStoreMissing'));
        const before = stateSchema.parse(await own.me.habits());
        const existing: StoredGoal | undefined = before.goals.find(goal => goal.id === input.id);
        const goal = {
          id: input.id,
          title: input.title,
          category: input.category,
          action: input.action ?? existing?.action ?? input.title,
          targetDaysPerWeek: input.targetDaysPerWeek ?? existing?.targetDaysPerWeek ?? 7,
          plannedMonthlySavingCents:
            input.monthlySavingCents === undefined
              ? (existing?.plannedMonthlySavingCents ?? null)
              : input.monthlySavingCents,
          active: input.active ?? existing?.active ?? true,
          // Left out, the store decides: today for a new or reactivated habit, the stored day otherwise.
          startedOn: input.startedOn ?? null,
        };
        try {
          await own.me.saveHabit(goal, existing !== undefined);
        } catch (error) {
          if (error instanceof ApiError && error.status === 400) return failure(say('habitFuture'));
          if (error instanceof z.ZodError) return failure(say('habitLimit'));
          throw error;
        }
        const saved = habitsOf(stateSchema.parse(await own.me.habits())).find(item => item.id === input.id);
        if (!saved) return failure('The habit could not be read back.');
        return result(
          `Habit ${existing ? 'updated' : 'created'}${saved.startedOn ? `, started on ${saved.startedOn}` : ''}. Call plan_home_savings to see its effect: habits says whether it was counted and why.`,
          { saved: true, created: !existing, habit: saved },
        );
      }),
  );

  if (demoIds.length)
    server.registerTool(
      'get_demo_person',
      {
        title: 'Read a fictional demo persona',
        description:
          'Read one of the fictional demo personas (synthetic: true): invented household, finances and habits used to show the product. Read-only; it can never address a real person.',
        inputSchema: z.object({ demoId }).strict(),
        outputSchema: person,
        annotations: readOnly,
        _meta: security('public'),
      },
      ({ demoId: id }) =>
        guarded(async () => {
          const loaded = await loadPerson(demoPerson(id));
          return result([provenanceNote(loaded.person), ...loaded.notes].join(' '), loaded.person);
        }),
    );

  server.registerTool(
    'get_place',
    {
      title: 'Read a place: indicators and services',
      description:
        'Return one municipality as a place node: rural category, centre, sourced population, density, foreign-population share, resale price and rent, and service counts. Missing figures are null and named in dataMissing; a comarca figure used as a proxy is marked geography: comarca.',
      inputSchema: z.object({ municipalityCode, locale: localeArgument }).strict(),
      outputSchema: place,
      annotations: readOnly,
    },
    ({ municipalityCode: code, locale }, extra) =>
      guarded(() => {
        const node = buildPlace(snapshot, code, toolLocale(locale, extra._meta));
        return result(`${node.name}, ${node.comarca} · place node from the ${snapshot.generatedOn} snapshot.`, node);
      }),
  );
  return { registerNextQuestions: () => void registerQuestionTool() };
}
