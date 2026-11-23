import { z } from 'zod';
import type { AnswerSpec, Person, PlanResult } from '../../packages/contracts/planner.ts';
import { nextQuestion as nextQuestionSchema, planResult } from '../../packages/contracts/planner.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import type { AnswerValue, QuestionId } from '../../packages/model/questions.ts';
import { isQuestionId, personFromAnswers, questionById } from '../../packages/model/questions.ts';
import { normalizedName } from '../../packages/places/geography.ts';
import type { CallTool, Extras, FactAnswers, ProfileAccess, SaveOutcome } from './facts.ts';
import {
  accessVia,
  applySpokenExtras,
  applySpokenFacts,
  describeQuestion,
  factQuestionsToAsk,
  inputFor,
  needsSignIn,
  saveVia,
  spokenExtras,
} from './facts.ts';
import { interview } from './messages.ts';
import { planForVoice, workspaceLink } from './plan.ts';

/**
 * One interview, whatever asks it: the voice session and the guided form call the same methods.
 * No DOM and no network of its own: every call to the ReloCat server goes through the injected
 * `CallTool`, so tests run it against a fake.
 *
 * - The questions are the shared set, in the order `get_next_questions` ranks them for this person
 *   and the towns chosen; without a server the set's own order is used.
 * - A confirmed answer is written to the shared input paths at once when the person is signed in
 *   (`save_my_inputs`), and kept on this device otherwise, with one notice that says so.
 * - The plan is `plan_home_savings` and nothing else.
 */

/** A town of the pilot the person chose: an exact match of `list_catalonia_municipalities`, confirmed. */
export type PlaceChoice = { code: string; name: string; comarca: string };

/** What the page keeps in this browser about the interview. */
export type Journey = {
  /** Answers by shared question id, in stored units; null is "I don't know". */
  answers: FactAnswers;
  extras: Extras;
  /** The towns compared, the one chosen last at the end. At most eight. */
  places: PlaceChoice[];
  /** What was answered here and is not in the profile yet: question ids, `householdSize`, `targetCash`, `place`. */
  unsaved: string[];
};
export const emptyJourney = (): Journey => ({ answers: {}, extras: {}, places: [], unsaved: [] });

export type ExtraId = 'place' | 'householdSize';
/** One question to ask now, with everything a surface needs to ask it. */
export type Asked = {
  id: QuestionId | ExtraId;
  question: string;
  why: string;
  help: string | null;
  sensitivity: string | null;
  allowUnknown: boolean;
  answer: AnswerSpec | { type: 'place' };
  /** What the answer could change, as the planner words it; null when no plan ranked the question. */
  effect: string | null;
  /** Without it no timeline can be computed. */
  required: boolean;
};

/** Where an answer went, as the voice model is told. `sayOnce` is a sentence for the person, said one time. */
export type Stored = { stored: 'profile' | 'device'; sayOnce?: string };

export type PlanOutcome = { status: 'ok'; result: PlanResult } | { status: 'standalone' | 'unavailable' };

const maxPlaces = 8;
/** Answers a timeline cannot do without, when no plan says so itself. */
const requiredLocally: readonly string[] = ['monthlyIncome', 'monthlyExpenses', 'purchaseSavings'];
const rankedQuestions = z.object({
  nextQuestions: z.array(nextQuestionSchema),
  /** Present while no town is chosen: the planner's own wording of the question that chooses one. */
  placeQuestion: z.object({ question: z.string(), why: z.string() }).optional(),
  /** The towns the questions were ranked for: for a signed-in person, the saved town when none is sent. */
  municipalityCodes: z.array(z.string()).optional(),
});
const townList = z.object({
  municipalities: z.array(z.object({ code: z.string().regex(/^\d{6}$/), name: z.string(), comarca: z.string() })),
});

export function createInterview(deps: {
  call: CallTool;
  today: () => string;
  locale: () => Locale;
  /** The stored journey; the page keeps it in its own state. */
  journey: Journey;
  /** Called after every change of the journey or of the access, so the page can store and redraw. */
  changed?: () => void;
  /**
   * How to find out whether somebody is signed in. Default `accessVia` (`show_workspace`), which a
   * page of this origin may call; the card embedded in a chat asks its own way.
   */
  access?: (call: CallTool) => Promise<ProfileAccess>;
  /**
   * The sentence said once when answers are not being saved, by where the interview runs. Default:
   * the page's own, which names its sign-in link.
   */
  notSavedNotice?: (access: Exclude<ProfileAccess, 'signed_in'>) => string;
}) {
  const { call, today, locale } = deps;
  let journey = deps.journey;
  let access: ProfileAccess = 'standalone';
  /** The stored person, from the last plan of a signed-in person. */
  let stored: Person | null = null;
  let lastPlan: PlanResult | null = null;
  let towns: PlaceChoice[] | null | undefined;
  /** The planner's wording of the town question, in the language it was last asked in. */
  let townQuestion: { question: string; why: string } | undefined;
  /** The planner already ranks for a town: the one sent, or the one saved in the profile. */
  let plannerHasTown = false;
  let noticeSaid = false;
  const skipped = new Set<string>();
  const changed = () => deps.changed?.();
  const t = () => translator(interview, locale());
  const codes = () => journey.places.map(place => place.code);

  /** The person an anonymous set of answers describes; sent inline, stored nowhere. */
  const localPerson = (): Person => {
    const person = personFromAnswers(journey.answers, today());
    const target = journey.extras.targetCashCents;
    return {
      ...person,
      householdSize: journey.extras.householdSize ?? null,
      // The person's own target is shown beside the upfront cash the plan computes; it never replaces it.
      finances: target === undefined ? person.finances : { ...person.finances, targetCashCents: target },
    };
  };
  /** Who a tool should plan for: the signed-in person, or the answers of this device sent inline. */
  const subject = () => (access === 'signed_in' ? { me: true } : { person: localPerson() });

  // ------------------------------------------------------------ questions

  const extraQuestion = (id: ExtraId): Asked =>
    id === 'place'
      ? {
          id,
          question: townQuestion?.question ?? t()('ask.place'),
          why: townQuestion?.why ?? t()('why.place'),
          help: null,
          sensitivity: null,
          allowUnknown: false,
          answer: { type: 'place' },
          effect: null,
          required: false,
        }
      : {
          id,
          question: t()('ask.householdSize'),
          why: t()('why.householdSize'),
          help: null,
          sensitivity: null,
          allowUnknown: false,
          answer: { type: 'number', unit: t()('unit.people'), min: 1, max: 30 },
          effect: null,
          required: false,
        };

  /** One question of the shared set, worded here: for a change of answer, and when no server ranks them. */
  function localQuestion(id: QuestionId): Asked {
    const asked = describeQuestion(questionById(id), journey.answers, today(), locale());
    return { ...asked, effect: null, required: requiredLocally.includes(id) };
  }

  /** The shared questions still open, most valuable first. */
  async function ranked(): Promise<Asked[]> {
    if (access !== 'standalone') {
      const answer = await call('get_next_questions', {
        ...subject(),
        municipalityCodes: codes(),
        locale: locale(),
      });
      const parsed = answer && !answer.isError ? rankedQuestions.safeParse(answer.structuredContent) : null;
      if (parsed?.success) {
        townQuestion = parsed.data.placeQuestion;
        plannerHasTown = (parsed.data.municipalityCodes?.length ?? 0) > 0;
      }
      if (parsed?.success)
        return parsed.data.nextQuestions.flatMap((question): Asked[] => {
          const id = question.id;
          if (!isQuestionId(id) || question.state === 'said_unknown') return [];
          // Answered here and still waiting to reach the profile: not asked twice.
          if (journey.answers[id] !== undefined && journey.unsaved.includes(id)) return [];
          return [
            {
              id,
              question: question.question,
              why: question.why,
              help: question.help,
              sensitivity: question.sensitivity,
              allowUnknown: question.allowUnknown,
              answer: question.answer,
              effect: question.effect.text || null,
              required: question.effect.kind === 'required',
            },
          ];
        });
    }
    // No server, or it could not rank them: the set in its own order.
    return factQuestionsToAsk(journey.answers, today()).map(question => localQuestion(question.id));
  }

  /**
   * The question to ask now: what a timeline needs first, then the town (it decides prices and aid),
   * then who will live there, then the rest in the planner's order. Null when nothing is left.
   */
  async function nextQuestion(): Promise<Asked | null> {
    const open = (await ranked()).filter(question => !skipped.has(question.id));
    const required = open.find(question => question.required);
    if (required) return required;
    if (!journey.places.length && !plannerHasTown && !skipped.has('place') && (await pilotTowns()))
      return extraQuestion('place');
    if (journey.extras.householdSize === undefined && !stored?.householdSize && !skipped.has('householdSize'))
      return extraQuestion('householdSize');
    return open[0] ?? null;
  }

  /** A question as the voice model is told it: its words and how to answer, never an answer. */
  const spoken = (asked: Asked | null) =>
    asked && {
      id: asked.id,
      question: asked.question,
      why: asked.why,
      effect: asked.effect,
      help: asked.help,
      sensitivity: asked.sensitivity,
      allowUnknown: asked.allowUnknown,
      answer: asked.answer,
      saveWith: asked.id === 'place' ? 'save_place' : 'save_interview_answers',
    };

  // --------------------------------------------------------------- saving

  /** Send what is not in the profile yet. Leaves it marked unsaved when the profile did not take it. */
  async function flush(): Promise<SaveOutcome> {
    const sent = [...journey.unsaved];
    const data = inputFor(sent, journey.answers, journey.extras, today(), stored ?? undefined);
    const outcome = await saveVia(call, data, locale());
    if (outcome.saved || outcome.reason === 'nothing') {
      journey = { ...journey, unsaved: journey.unsaved.filter(id => !sent.includes(id)) };
    } else if (outcome.reason === 'signed_out') access = 'signed_out';
    changed();
    return outcome;
  }

  /** Put confirmed answers where they belong and say where that was. */
  async function store(): Promise<Stored> {
    if (access === 'signed_in') {
      const outcome = await flush();
      if (outcome.saved) return { stored: 'profile' };
      return { stored: 'device', sayOnce: outcome.message };
    }
    if (noticeSaid) return { stored: 'device' };
    noticeSaid = true;
    return {
      stored: 'device',
      sayOnce: deps.notSavedNotice
        ? deps.notSavedNotice(access)
        : access === 'signed_out'
          ? t()('voice.signedOutNotice', { link: t()('signInToSave') })
          : t()('save.unavailable'),
    };
  }

  function keep(next: Partial<Journey>, ids: readonly string[]) {
    journey = { ...journey, ...next, unsaved: [...new Set([...journey.unsaved, ...ids])] };
    for (const id of ids) skipped.delete(id);
    changed();
  }

  /**
   * The voice tool `save_interview_answers`: figures in euros and facts as spoken, each validated with
   * the shared rules. What fails is reported and left out, so the model asks again.
   */
  async function saveSpoken(args: Record<string, unknown>) {
    const facts = applySpokenFacts(args, journey.answers, today(), {
      base: stored ?? undefined,
      handledElsewhere: spokenExtras,
    });
    const details = applySpokenExtras(args, journey.extras);
    const updated = [...facts.updated, ...details.updated];
    const rejected = [...facts.rejected, ...details.rejected];
    if (!updated.length) return { updated, rejected, nextQuestion: spoken(await nextQuestion()) };
    keep({ answers: facts.answers, extras: details.extras }, updated);
    const where = await store();
    return { updated, rejected, ...where, nextQuestion: spoken(await nextQuestion()) };
  }

  /** One typed answer of the guided interview, already in its stored unit and validated by the form. */
  async function answer(id: QuestionId | 'householdSize', value: AnswerValue | null): Promise<Stored> {
    if (id === 'householdSize') keep({ extras: { ...journey.extras, householdSize: value as number } }, [id]);
    else keep({ answers: { ...journey.answers, [id]: value } }, [id]);
    return store();
  }

  // ---------------------------------------------------------------- towns

  /** The towns of the pilot, read once; null when this origin has no list. */
  async function pilotTowns(): Promise<PlaceChoice[] | null> {
    if (towns !== undefined) return towns;
    if (access === 'standalone') return null;
    const parsed = townList.safeParse((await call('list_catalonia_municipalities', {}))?.structuredContent);
    // A failed read is tried again next time instead of being remembered as "no list".
    if (!parsed.success) return null;
    towns = parsed.data.municipalities.map(({ code, name, comarca }) => ({ code, name, comarca }));
    return towns;
  }

  /**
   * A spoken or typed town name as a pilot municipality. Only an exact name (accents, case and
   * punctuation aside) or its six-digit code resolves; anything else returns the similar names and
   * resolves nothing, so a town is never guessed.
   */
  async function resolveTown(name: string) {
    const list = await pilotTowns();
    if (!list) return { status: 'unavailable' as const };
    const wanted = normalizedName(name);
    const exact = wanted ? list.filter(town => normalizedName(town.name) === wanted || town.code === wanted) : [];
    if (exact.length === 1) return { status: 'exact' as const, town: exact[0] };
    const similar = exact.length
      ? exact
      : wanted
        ? list.filter(town => {
            const candidate = normalizedName(town.name);
            return candidate.includes(wanted) || wanted.includes(candidate);
          })
        : [];
    return { status: 'no_exact_match' as const, similar: similar.slice(0, 5) };
  }

  /**
   * The voice tool `save_place` and the guided town question. The town is stored, as
   * `location.selectedMunicipalityCode` and as a place to compare, only on an exact match that the
   * person confirmed.
   */
  async function savePlace(name: string, confirmed: boolean) {
    const found = await resolveTown(name);
    if (found.status === 'unavailable')
      return { saved: false as const, reason: 'unavailable' as const, similar: [] as PlaceChoice[] };
    if (found.status === 'no_exact_match')
      return { saved: false as const, reason: 'no_exact_match' as const, similar: found.similar };
    if (!confirmed) return { saved: false as const, reason: 'needs_confirmation' as const, match: found.town };
    const places = [...journey.places.filter(place => place.code !== found.town.code), found.town].slice(-maxPlaces);
    keep({ places, extras: { ...journey.extras, selectedMunicipalityCode: found.town.code } }, ['place']);
    const where = await store();
    return { saved: true as const, place: found.town, places: places.map(place => place.name), ...where };
  }

  /** `save_place` as the voice model reads it, with what to do next. */
  async function savePlaceSpoken(args: Record<string, unknown>) {
    const name = typeof args.name === 'string' ? args.name : '';
    const outcome = await savePlace(name, args.confirmed === true);
    if (outcome.saved) return { ...outcome, nextQuestion: spoken(await nextQuestion()) };
    const say = {
      unavailable: 'The list of towns cannot be read here, so no town can be chosen. Go on with the next question.',
      no_exact_match:
        'No town of the pilot has exactly this name, so nothing was stored. Read the similar names, if any, and ask which one they mean; otherwise say the town is not covered yet. Never pick one for them.',
      needs_confirmation:
        'Exact match found, nothing stored yet. Say the name and comarca of the match, and after the person confirms call save_place again with confirmed true.',
    }[outcome.reason];
    return { ...outcome, instruction: say };
  }

  async function removePlace(code: string) {
    const places = journey.places.filter(place => place.code !== code);
    keep({ places, extras: { ...journey.extras, selectedMunicipalityCode: places.at(-1)?.code ?? null } }, ['place']);
    if (access === 'signed_in') await flush();
  }

  // ----------------------------------------------------------------- plan

  /** The plan: `plan_home_savings` for this person and the towns chosen. Nothing is computed here. */
  async function plan(): Promise<PlanOutcome> {
    if (access === 'standalone') return { status: 'standalone' };
    const ask = () => call('plan_home_savings', { ...subject(), municipalityCodes: codes(), locale: locale() });
    let answer = await ask();
    if (answer?.isError && access === 'signed_in' && needsSignIn(answer)) {
      // The session ended: plan from the answers of this device, and say they are no longer being saved.
      access = 'signed_out';
      changed();
      answer = await ask();
    }
    const parsed = answer && !answer.isError ? planResult.safeParse(answer.structuredContent) : null;
    if (!parsed?.success) return { status: 'unavailable' };
    lastPlan = parsed.data;
    if (access === 'signed_in') stored = parsed.data.person;
    return { status: 'ok', result: parsed.data };
  }

  /**
   * The workspace with the towns of the plan: the ones chosen here, or, when none was chosen here, the
   * ones the last plan compared (a signed-in person's saved town).
   */
  const workspaceUrl = () =>
    workspaceLink(
      journey.places.length ? codes() : (lastPlan?.plans.map(plan => plan.place.municipalityCode) ?? []),
      locale(),
    );

  /** The voice tool `show_plan`: the plan as fields to read aloud, or why there is none. */
  async function planSpoken(given?: PlanOutcome) {
    const outcome = given ?? (await plan());
    if (outcome.status !== 'ok')
      return {
        shown: false,
        reason:
          outcome.status === 'standalone'
            ? 'This page runs without the ReloCat server, so there is no plan here. Say so; never work out a timeline yourself.'
            : 'The plan could not be computed right now. Say so and go on with the next question; never work out a timeline yourself.',
      };
    return {
      shown: true,
      plan: planForVoice(outcome.result),
      basedOn: access === 'signed_in' ? 'the saved profile' : 'the answers kept on this device (nothing stored)',
      workspaceLink: workspaceUrl(),
    };
  }

  /** The voice tool `save_to_profile`: everything answered here that the profile does not have yet. */
  async function saveAllSpoken() {
    if (access !== 'signed_in') return { saved: false, ...(await store()) };
    if (!journey.unsaved.length) return { saved: true, note: 'Every confirmed answer is already in the profile.' };
    const outcome = await flush();
    return outcome.saved ? { saved: true, stored: 'profile' } : { saved: false, sayOnce: outcome.message };
  }

  return {
    get journey() {
      return journey;
    },
    get access() {
      return access;
    },
    /** The last plan read, for the trail; null before the first one. */
    get lastPlan() {
      return lastPlan;
    },
    /** Start over with another stored journey (the page cleared its data). */
    reset(next: Journey) {
      journey = next;
      lastPlan = null;
      stored = null;
      noticeSaid = false;
      skipped.clear();
    },
    /**
     * Find out where the page runs. Answers given before signing in ("Sign in to save them") are
     * saved as soon as the person is back signed in.
     */
    async start() {
      access = await (deps.access ?? accessVia)(call);
      changed();
      const outcome = access === 'signed_in' && journey.unsaved.length ? await flush() : null;
      return { access, saved: outcome };
    },
    nextQuestion,
    /** A question by id, for changing an answer already given. */
    question: (id: QuestionId | ExtraId): Asked => (isQuestionId(id) ? localQuestion(id) : extraQuestion(id)),
    /** Leave a question for later in this visit; it stays unanswered, not "I don't know". */
    skip: (id: string) => void skipped.add(id),
    resumeSkipped: () => skipped.clear(),
    spoken,
    answer,
    saveSpoken,
    savePlace,
    savePlaceSpoken,
    removePlace,
    pilotTowns,
    plan,
    planSpoken,
    saveAllSpoken,
    flush,
    workspaceUrl,
  };
}
export type Interview = ReturnType<typeof createInterview>;
