import type { Policy } from '../contracts/places.ts';
import type { FactConflict, KnownFact, NextQuestion, Person, Place, PlacePlan } from '../contracts/planner.ts';
import { person as personSchema, planAssumptions } from '../contracts/planner.ts';
import { defaultLocale, type Locale } from '../i18n/locales.ts';
import { type MessageValues, translator } from '../i18n/messages.ts';
import type { Question, QuestionId } from '../model/questions.ts';
import {
  answerSpecFor,
  appliesTo,
  childrenOf,
  describeAnswer,
  fieldOf,
  heldValue,
  questionById,
  questions,
  stateOf,
} from '../model/questions.ts';
import { localizePolicy } from '../places/policy-text.ts';
import { wording } from '../places/wording.ts';
import { factMessages } from './plan.messages.ts';
import type { Assumptions } from './plan.ts';
import { planPlaces, withDerivedAges } from './plan.ts';

/**
 * Which questions are still worth asking a person, for the places being compared.
 *
 * A question is worth asking when its answer could change the plan. That is measured with the
 * planner itself, never with a rule of thumb:
 *
 * 1. For each measure that reads an unanswered fact, the plan is recomputed with the unanswered
 *    facts of that measure assumed favourable. The difference with the plan as it stands (months of
 *    waiting, upfront cash) is what the measure could be worth to this person in each place. Only
 *    that one measure is allowed to change in the comparison: the other measures that read one of the
 *    assumed facts are switched off on both sides, so a fact is never credited with a measure it does
 *    not decide.
 * 2. For each of those facts the plan is recomputed once more with that fact unfavourable and the
 *    rest favourable. If the measure is then worth less, the fact decides it, and it carries the
 *    measure's value. A fact that decides nothing for these places is not asked: a tax base is never
 *    requested for a measure that cannot apply where the person is looking.
 *
 * The assumed values exist only inside this comparison. They never reach the plan that is returned,
 * and nothing about the person is inferred from them.
 *
 * Order of the result: what a timeline cannot do without (income, spending, savings, a price), then
 * the facts that decide a measure by months at stake, then by upfront cash, then the facts that only
 * move the Catalonia-wide baseline, then the defaults the plan is assuming (deposit, reserve).
 * A question already answered "I don't know" goes last: it is explained, not asked again as new.
 *
 * The comparisons above are numbers and run in English. Only what a person reads (labels, questions,
 * why, help, what an answer could change, where a fact came from) is written in `locale`.
 */

type Household = NonNullable<Person['household']>;
type Effect = NextQuestion['effect'];
/** What a hypothetical answer is worth in one place: months sooner, upfront cash lower, baseline lower. */
type Gain = { months: number; cents: number; baselineCents: number };

const screenedIntents = new Set<Policy['intent']>(['buy', 'move', 'rent']);
const required: QuestionId[] = ['monthlyIncome', 'monthlyExpenses', 'purchaseSavings', 'homeBudget', 'floorArea'];
const assumed: QuestionId[] = ['depositRate', 'emergencyReserve'];
const none: Gain = { months: 0, cents: 0, baselineCents: 0 };

/**
 * The answer that lets a measure apply, and the one that rules it out. A fact with no unfavourable
 * answer of its own (either type of tax return can qualify) is left unknown instead. The ages are
 * chosen to stay inside every limit for as long as a plan can run: an adult of 18, a child of 1.
 */
const hypothetical: Partial<Record<QuestionId, { favourable: unknown; unfavourable: unknown }>> = {
  primaryResidence: { favourable: true, unfavourable: false },
  birthDate: { favourable: 18, unfavourable: 60 },
  children: { favourable: [{ age: 1, inDesignatedSchool: true, meetsItpSchooling: true }], unfavourable: [] },
  childrenItpSchooling: { favourable: true, unfavourable: false },
  childrenIrpfSchooling: { favourable: true, unfavourable: false },
  itpTransaction: { favourable: true, unfavourable: false },
  itpOccupancy: { favourable: true, unfavourable: false },
  largeFamily: { favourable: true, unfavourable: false },
  singleParent: { favourable: true, unfavourable: false },
  disability65: { favourable: true, unfavourable: false },
  firstRuralMove: { favourable: true, unfavourable: false },
  ownsHomeInSpain: { favourable: false, unfavourable: true },
  incomeWithinFiveIprem: { favourable: true, unfavourable: false },
  filing: { favourable: 'joint', unfavourable: undefined },
  itpBuyerNetTaxBase: { favourable: 0, unfavourable: 10_000_000 },
  itpFamilyNetTaxBase: { favourable: 0, unfavourable: 10_000_000 },
  irpfNetTaxBase: { favourable: 0, unfavourable: 10_000_000 },
  irpfIndividualNetTaxBase: { favourable: 0, unfavourable: 10_000_000 },
};

/** The same day `years` earlier; 29 February becomes 28 February. */
function yearsBefore(day: string, years: number): string {
  const monthDay = day.slice(5) === '02-29' ? '02-28' : day.slice(5);
  return `${String(Number(day.slice(0, 4)) - years).padStart(4, '0')}-${monthDay}`;
}

/**
 * The person with one fact assumed. Only a fact the person has not answered is ever assumed. An
 * assumed age is written both as an age and as the date of birth that gives it on the plan date, so
 * the comparison screens later days exactly as the real plan does.
 */
function assume(person: Person, question: Question, value: unknown, asOf: string): Person {
  if (value === undefined) return person;
  const household: Household = { ...person.household };
  if (question.id === 'birthDate')
    return {
      ...person,
      household: { ...household, age: value as number },
      born: { ...person.born, self: yearsBefore(asOf, value as number) },
    };
  if (question.id === 'children') {
    const children = value as NonNullable<Household['children']>;
    return {
      ...person,
      household: { ...household, children },
      born: {
        ...person.born,
        children: children.map(({ age, ...flags }) => ({ ...flags, birthDate: yearsBefore(asOf, age) })),
      },
    };
  }
  if (question.kind.type === 'per_child') {
    const flag = question.kind.flag;
    const fill = <Child extends { inDesignatedSchool?: boolean; meetsItpSchooling?: boolean }>(child: Child): Child =>
      child[flag] === undefined ? { ...child, [flag]: value } : child;
    return {
      ...person,
      household: { ...household, children: household.children?.map(fill) },
      ...(person.born?.children ? { born: { ...person.born, children: person.born.children.map(fill) } } : {}),
    };
  }
  return { ...person, household: { ...household, [fieldOf(question)]: value } };
}

/**
 * The same measure, in force only in the past: it is screened as ended, unverified or closed, so it
 * is never counted and never becomes the baseline, while the general tariff it states stays readable.
 */
function switchedOff(policy: Policy): Policy {
  const past = { opensOn: '1900-01-01', closesOn: '1900-01-02' };
  return { ...policy, effectiveFrom: past.opensOn, effectiveThrough: past.closesOn, callWindow: past };
}

type FactMessage = keyof (typeof factMessages)['en'];

/** The sentences of one language and how it writes an amount and a date in them. */
function wordsFor(locale: Locale) {
  const write = wording(locale);
  return {
    locale,
    t: translator(factMessages, locale) as (key: FactMessage, values?: MessageValues) => string,
    /** Whole euros: what an answer could be worth is an estimate, never stated to the cent. */
    euros: (cents: number) =>
      write.euros(
        Math.round(cents / 100) * 100,
        `€${(cents / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,
      ),
    date: write.date,
    percent: write.percent,
  };
}
type Words = ReturnType<typeof wordsFor>;

const better = (a: Gain, b: Gain) =>
  a.months !== b.months
    ? a.months > b.months
    : a.cents !== b.cents
      ? a.cents > b.cents
      : a.baselineCents > b.baselineCents;
const positive = (gain: Gain) => gain.months > 0 || gain.cents > 0 || gain.baselineCents > 0;

/** How much shorter and cheaper `other` is than `current`, place by place. Nothing is compared against an unknown. */
function gains(current: PlacePlan[], other: PlacePlan[]): Gain[] {
  return current.map((plan, index) => {
    const [before, after] = [plan.withPlaceBenefits, other[index].withPlaceBenefits];
    const [baseBefore, baseAfter] = [plan.baseline, other[index].baseline];
    return {
      months: before?.months != null && after?.months != null ? Math.max(0, before.months - after.months) : 0,
      cents: before && after ? Math.max(0, before.upfrontCashCents - after.upfrontCashCents) : 0,
      baselineCents:
        baseBefore && baseAfter ? Math.max(0, baseBefore.upfrontCashCents - baseAfter.upfrontCashCents) : 0,
    };
  });
}

/** A label inside a list, as the language writes it: English lowers it whole, the others keep an acronym. */
function inList(label: string, locale: Locale) {
  if (locale === defaultLocale) return label.toLowerCase();
  return /^\p{Lu}\p{Ll}/u.test(label) ? label.charAt(0).toLocaleLowerCase(locale) + label.slice(1) : label;
}

/** What an answer could change, as one or two whole sentences. */
function effectText(
  kind: Effect['kind'],
  gain: Gain,
  placeName: string,
  title: string,
  alsoNeeds: string[],
  words: Words,
) {
  const { t, euros, locale } = words;
  const place = placeName;
  const head =
    kind === 'baseline'
      ? t('effectBaseline', { amount: euros(gain.baselineCents), title, place })
      : gain.months > 0
        ? gain.cents > 0
          ? t('effectMonthsAndCash', { months: gain.months, place, amount: euros(gain.cents), title })
          : t('effectMonths', { months: gain.months, place, title })
        : t('effectCash', { amount: euros(gain.cents), place, title });
  return alsoNeeds.length
    ? `${head} ${t('alsoDependsOn', { list: alsoNeeds.map(label => inList(label, locale)).join(', ') })}`
    : head;
}

/** Why a stored answer may no longer hold on the plan date, or null. */
function staleness(
  question: Question,
  person: Person,
  observedAt: string | undefined,
  asOf: string,
  words: Words,
): string | null {
  const { t, date } = words;
  if (!observedAt) return null;
  const given = observedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(given) || given >= asOf) return null;
  if (question.goesStale === 'age') {
    // An age derived from a date of birth is recomputed for every plan; only a stated age can go stale.
    const stated =
      question.id === 'birthDate'
        ? person.born?.self === undefined
        : (childrenOf(person) ?? []).some(child => child.birthDate === undefined && child.birthYear === undefined);
    const days = (Date.parse(asOf) - Date.parse(given)) / 86_400_000;
    return stated && days > 31 ? t('staleAge', { given: date(given) }) : null;
  }
  if (question.goesStale === 'tax_year')
    return given.slice(0, 4) < asOf.slice(0, 4) ? t('staleTaxYear', { given: date(given) }) : null;
  if (question.goesStale === 'school_year') {
    const year = Number(asOf.slice(0, 4)) - (asOf.slice(5) < '09-01' ? 1 : 0);
    return given < `${year}-09-01` ? t('staleSchoolYear', { given: date(given) }) : null;
  }
  return null;
}

export type PersonFacts = {
  nextQuestions: NextQuestion[];
  knownFacts: KnownFact[];
  conflicts: FactConflict[];
  /** One sentence for the plan's assumptions: the household facts it relied on and where each came from. */
  reliedOn: string | null;
};

/**
 * Everything the plan says about the person's facts: what is known and from where, what disagrees,
 * and what to ask next. `current` is the plan already computed for `places`, in the same order.
 * Labels, questions and sentences are in `locale`; ids, input paths, states and amounts are not.
 */
export function factsOf(
  who: Person,
  places: Place[],
  policies: Policy[],
  options: Assumptions,
  asOf: string,
  current: PlacePlan[],
  locale: Locale = defaultLocale,
): PersonFacts {
  const words = wordsFor(locale);
  const { t, date, percent } = words;
  /** The same question in the language of the result. */
  const worded = (question: Question) => questionById(question.id, locale);
  const considered = policies.filter(policy => screenedIntents.has(policy.intent));
  const screenedIds = new Set(considered.map(policy => policy.id));
  const priceFromBudget = who.home.budgetCents !== null;

  // ------------------------------------------------------------ what is known
  const knownFacts: KnownFact[] = [];
  for (const question of questions) {
    if (stateOf(who, question.id, asOf) !== 'known') continue;
    const value = heldValue(who, question.id, asOf);
    const answer = who.answers?.[question.id];
    // A monthly figure observed in the bank is not the declaration its provenance entry describes.
    const fromBank =
      (question.id === 'monthlyIncome' && who.finances.incomeBasis === 'bank_observed') ||
      (question.id === 'monthlyExpenses' && who.finances.expensesBasis === 'bank_observed');
    const observedAt = fromBank ? who.finances.asOf : (answer?.observedAt ?? null);
    const usedByPlan =
      question.group === 'plan'
        ? question.id === 'floorArea'
          ? !priceFromBudget
          : true
        : question.decides.some(id => screenedIds.has(id));
    knownFacts.push({
      id: question.id,
      inputPath: question.path,
      label: worded(question).label,
      value: describeAnswer(question.id, value, asOf, locale),
      ...(fromBank ? { source: 'bank' as const } : answer?.source ? { source: answer.source } : {}),
      observedAt,
      confirmed: fromBank ? null : (answer?.confirmed ?? null),
      usedByPlan,
      stale: fromBank ? null : staleness(question, who, answer?.observedAt, asOf, words),
    });
  }
  const relied = knownFacts.filter(fact => fact.usedByPlan && questionById(fact.id as QuestionId).group !== 'plan');
  const reliedOn = relied.length
    ? t('reliedOn', {
        facts: relied
          .map(fact => {
            // Where the fact came from, when, and how sure it is: attributes listed in brackets.
            const details = [
              t(fact.source ? `source.${fact.source}` : 'source.request'),
              ...(fact.observedAt ? [t('reliedGiven', { date: date(fact.observedAt.slice(0, 10)) })] : []),
              ...(fact.confirmed === true
                ? [t('reliedConfirmed')]
                : fact.confirmed === false
                  ? [t('reliedNotConfirmed')]
                  : []),
            ].join(', ');
            return t('reliedFact', {
              label: inList(fact.label, locale),
              value: fact.value,
              details: fact.stale ? `${details}; ${t('reliedStale')}` : details,
            });
          })
          .join('; '),
      })
    : null;

  // ------------------------------------------------------------- conflicts
  const conflicts: FactConflict[] = [];
  for (const question of questions) {
    const answer = who.answers?.[question.id];
    if (answer?.status !== 'conflict' || conflicts.some(item => item.inputPath === question.path)) continue;
    conflicts.push({
      id: question.id,
      inputPath: question.path,
      label: worded(question).label,
      question: worded(question).question,
      candidates: (answer.candidates ?? []).map(candidate => ({
        ...candidate,
        text: describeAnswer(question.id, candidate.value, asOf, locale),
      })),
    });
  }

  // ------------------------------------------------------------ what to ask
  const open = questions.filter(
    question => stateOf(who, question.id, asOf) !== 'known' && appliesTo(who, question.id, asOf),
  );
  const isOpen = (id: QuestionId) => open.some(question => question.id === id);
  const effects = new Map<QuestionId, Effect>();

  const unpriced = current.some(plan => plan.priceBasis === 'unknown');
  for (const id of required) {
    if (!isOpen(id)) continue;
    const price = id === 'homeBudget' || id === 'floorArea';
    // A budget is needed only while some place has no price: a size prices a place that publishes an average.
    if (id === 'homeBudget' && !unpriced) continue;
    effects.set(id, {
      kind: 'required',
      months: null,
      upfrontCents: null,
      municipalityCode: null,
      placeName: null,
      policyIds: [],
      alsoNeeds: [],
      text: price ? t('requiredPrice') : t('requiredTimeline'),
    });
  }

  const unanswered = open.filter(question => hypothetical[question.id]);
  /** The plans with some facts assumed (those in `unfavourable` against the person) and some measures switched off. */
  const trial = (off: Set<Policy['id']>, list: Question[] = [], unfavourable: Question[] = []) => {
    let person = who;
    // The set is in order, so the children are assumed before a schooling flag is written onto them.
    for (const question of list) {
      const values = hypothetical[question.id];
      if (!values) continue;
      person = assume(
        person,
        question,
        unfavourable.includes(question) ? values.unfavourable : values.favourable,
        asOf,
      );
    }
    const trialPolicies = policies.map(policy => (off.has(policy.id) ? switchedOff(policy) : policy));
    return planPlaces(person, places, trialPolicies, options, asOf).plans;
  };
  // Without a timeline for any place there is nothing to compare an answer against yet.
  if (current.some(plan => plan.status !== 'insufficient_data')) {
    for (const policy of considered) {
      const facts = unanswered.filter(question => question.decides.includes(policy.id));
      if (!facts.length) continue;
      // Only this measure may change: every other measure that reads an assumed fact is off on both sides.
      const off = new Set(
        considered
          .filter(other => other.id !== policy.id && facts.some(question => question.decides.includes(other.id)))
          .map(other => other.id),
      );
      const before = off.size ? trial(off) : current;
      const possible = gains(before, trial(off, facts));
      if (!possible.some(positive)) continue;
      const deciding = facts.filter(question => {
        const alternatives = facts.filter(other => question.alternatives?.includes(other.id));
        const without = gains(before, trial(off, facts, [question, ...alternatives]));
        return possible.some((gain, index) => better(gain, without[index]));
      });
      const best = possible.reduce((top, gain, index) => (better(gain, possible[top]) ? index : top), 0);
      const gain = possible[best] ?? none;
      const kind: Effect['kind'] = gain.months > 0 || gain.cents > 0 ? 'benefit' : 'baseline';
      for (const question of deciding) {
        const previous = effects.get(question.id);
        if (previous?.kind === 'required') continue;
        const alsoNeeds = deciding.filter(other => other !== question).map(other => worded(other).label);
        const candidate: Effect = {
          kind,
          months: gain.months,
          upfrontCents: kind === 'baseline' ? gain.baselineCents : gain.cents,
          municipalityCode: places[best].municipalityCode,
          placeName: places[best].name,
          policyIds: [...new Set([...(previous?.policyIds ?? []), policy.id])],
          alsoNeeds,
          text: effectText(kind, gain, places[best].name, localizePolicy(policy, locale).title, alsoNeeds, words),
        };
        const previousGain: Gain | null = previous
          ? {
              months: previous.months ?? 0,
              cents: previous.kind === 'baseline' ? 0 : (previous.upfrontCents ?? 0),
              baselineCents: previous.kind === 'baseline' ? (previous.upfrontCents ?? 0) : 0,
            }
          : null;
        // A fact shared by several measures carries the largest effect, and names every measure.
        effects.set(
          question.id,
          previousGain && previous && !better(gain, previousGain)
            ? { ...previous, policyIds: candidate.policyIds }
            : candidate,
        );
      }
    }
  }

  for (const id of assumed) {
    if (!isOpen(id) || effects.has(id)) continue;
    effects.set(id, {
      kind: 'assumption',
      months: null,
      upfrontCents: null,
      municipalityCode: null,
      placeName: null,
      policyIds: [],
      alsoNeeds: [],
      text:
        id === 'depositRate'
          ? t('assumedDeposit', { rate: percent(Math.round(who.home.depositRate * 100) / 100) })
          : t('assumedReserve'),
    });
  }

  const rank = { required: 0, benefit: 1, baseline: 2, assumption: 3 } as const;
  const nextQuestions: NextQuestion[] = open
    .flatMap(question => {
      const effect = effects.get(question.id);
      if (!effect) return [];
      const status = stateOf(who, question.id, asOf);
      return [
        {
          id: question.id,
          inputPath: question.path,
          label: worded(question).label,
          question: worded(question).question,
          why: worded(question).why,
          help: worded(question).help,
          sensitivity: worded(question).sensitivity,
          answer: answerSpecFor(question, who, asOf, locale),
          allowUnknown: question.allowUnknown,
          state: status === 'known' ? ('missing' as const) : status,
          effect,
        },
      ];
    })
    .map((question, index) => ({ question, index }))
    .sort((a, b) => {
      const [left, right] = [a.question, b.question];
      const asked = Number(left.state === 'said_unknown') - Number(right.state === 'said_unknown');
      if (asked) return asked;
      const kind = rank[left.effect.kind] - rank[right.effect.kind];
      if (kind) return kind;
      const months = (right.effect.months ?? 0) - (left.effect.months ?? 0);
      if (months) return months;
      const cents = (right.effect.upfrontCents ?? 0) - (left.effect.upfrontCents ?? 0);
      return cents || a.index - b.index;
    })
    .map(({ question }) => question);

  return { nextQuestions, knownFacts, conflicts, reliedOn };
}

/**
 * The facts whose absence could still change the plan of this person for these places, most valuable
 * first (see the top of this file). Each carries its question, why it is asked, how it is answered
 * and what it could change: "Could shorten the wait by up to 14 months in Talarn". An empty list
 * means nothing more is worth asking.
 */
export function missingFacts(
  person: Person,
  places: Place[],
  policies: Policy[],
  asOf: string,
  assumptions?: Parameters<typeof planAssumptions.parse>[0],
  locale: Locale = defaultLocale,
): NextQuestion[] {
  const options = planAssumptions.parse(assumptions ?? {});
  const date = options.asOf ?? asOf;
  const who = withDerivedAges(personSchema.parse(person), date);
  const current = planPlaces(who, places, policies, options, date).plans;
  return factsOf(who, places, policies, options, date, current, locale).nextQuestions;
}
