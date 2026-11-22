import type { Policy } from '../contracts/places.ts';
import type { FactConflict, KnownFact, NextQuestion, Person, Place, PlacePlan } from '../contracts/planner.ts';
import { person as personSchema, planAssumptions } from '../contracts/planner.ts';
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

function euros(cents: number): string {
  return `€${(cents / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

const monthsText = (months: number) => `${months} ${months === 1 ? 'month' : 'months'}`;
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

function effectText(kind: Effect['kind'], gain: Gain, placeName: string, title: string, alsoNeeds: string[]) {
  const more = alsoNeeds.length ? ` It also depends on: ${alsoNeeds.join(', ').toLowerCase()}.` : '';
  if (kind === 'baseline')
    return `Could lower the transfer tax you would pay anywhere in Catalonia by up to ${euros(gain.baselineCents)} (${title}). The estimate for ${placeName} stays as it is, because a lower rate is already counted there.${more}`;
  const cash = gain.cents > 0 ? `lower the upfront cash by up to ${euros(gain.cents)}` : '';
  const head =
    gain.months > 0
      ? `Could shorten the wait by up to ${monthsText(gain.months)} in ${placeName}${cash ? ` and ${cash}` : ''}`
      : `Could ${cash} in ${placeName}`;
  return `${head}, through “${title}”.${more}`;
}

const sourceText: Record<string, string> = {
  profile: 'your saved profile',
  interview: 'the interview',
  manual: 'typed in by you',
  bank: 'bank movements',
  listing: 'a listing',
  what_if: 'this estimate only, not saved',
};

/** Why a stored answer may no longer hold on the plan date, or null. */
function staleness(question: Question, person: Person, observedAt: string | undefined, asOf: string): string | null {
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
    return stated && days > 31
      ? `Given as an age on ${given}. An age goes out of date with a birthday: give the date of birth instead.`
      : null;
  }
  if (question.goesStale === 'tax_year')
    return given.slice(0, 4) < asOf.slice(0, 4)
      ? `Given on ${given}, in an earlier year. It belongs to one tax return and a newer one probably exists: check it.`
      : null;
  if (question.goesStale === 'school_year') {
    const year = Number(asOf.slice(0, 4)) - (asOf.slice(5) < '09-01' ? 1 : 0);
    return given < `${year}-09-01`
      ? `Given on ${given}, before the current school year began. Check that it still holds.`
      : null;
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
 */
export function factsOf(
  who: Person,
  places: Place[],
  policies: Policy[],
  options: Assumptions,
  asOf: string,
  current: PlacePlan[],
): PersonFacts {
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
      label: question.label,
      value: describeAnswer(question.id, value, asOf),
      ...(fromBank ? { source: 'bank' as const } : answer?.source ? { source: answer.source } : {}),
      observedAt,
      confirmed: fromBank ? null : (answer?.confirmed ?? null),
      usedByPlan,
      stale: fromBank ? null : staleness(question, who, answer?.observedAt, asOf),
    });
  }
  const relied = knownFacts.filter(fact => fact.usedByPlan && questionById(fact.id as QuestionId).group !== 'plan');
  const reliedOn = relied.length
    ? `Facts about you this plan relied on: ${relied
        .map(fact => {
          const from = fact.source ? sourceText[fact.source] : 'stated with this request';
          const when = fact.observedAt ? `, given ${fact.observedAt.slice(0, 10)}` : '';
          const sure = fact.confirmed === true ? ', confirmed' : fact.confirmed === false ? ', not confirmed' : '';
          return `${fact.label.toLowerCase()}: ${fact.value} (${from}${when}${sure}${fact.stale ? '; possibly out of date' : ''})`;
        })
        .join('; ')}.`
    : null;

  // ------------------------------------------------------------- conflicts
  const conflicts: FactConflict[] = [];
  for (const question of questions) {
    const answer = who.answers?.[question.id];
    if (answer?.status !== 'conflict' || conflicts.some(item => item.inputPath === question.path)) continue;
    conflicts.push({
      id: question.id,
      inputPath: question.path,
      label: question.label,
      question: question.question,
      candidates: (answer.candidates ?? []).map(candidate => ({
        ...candidate,
        text: describeAnswer(question.id, candidate.value, asOf),
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
      text: price
        ? 'Needed to price the home: without a budget or a size, no upfront cash can be computed for any place.'
        : 'Needed before any timeline can be estimated.',
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
        const alsoNeeds = deciding.filter(other => other !== question).map(other => other.label);
        const candidate: Effect = {
          kind,
          months: gain.months,
          upfrontCents: kind === 'baseline' ? gain.baselineCents : gain.cents,
          municipalityCode: places[best].municipalityCode,
          placeName: places[best].name,
          policyIds: [...new Set([...(previous?.policyIds ?? []), policy.id])],
          alsoNeeds,
          text: effectText(kind, gain, places[best].name, policy.title, alsoNeeds),
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
          ? `The plan assumes a deposit of ${Math.round(who.home.depositRate * 100)}% of the price. Your own figure changes the upfront cash directly.`
          : 'The plan sets no emergency reserve aside, so all your savings count towards the purchase. A reserve is taken off them first.',
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
          label: question.label,
          question: question.question,
          why: question.why,
          help: question.help,
          sensitivity: question.sensitivity,
          answer: answerSpecFor(question, who, asOf),
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
): NextQuestion[] {
  const options = planAssumptions.parse(assumptions ?? {});
  const date = options.asOf ?? asOf;
  const who = withDerivedAges(personSchema.parse(person), date);
  const current = planPlaces(who, places, policies, options, date).plans;
  return factsOf(who, places, policies, options, date, current).nextQuestions;
}
