import type { z } from 'zod';
import type { eligibility, Municipality, Policy } from '../contracts/places.ts';
import type {
  AnywherePlan,
  HabitEffect,
  Person,
  PersonInput,
  Place,
  PlaceBenefit,
  PlacePlan,
  PlanResult,
} from '../contracts/planner.ts';
import { planAssumptions, planResult } from '../contracts/planner.ts';
import { maxPlanningMonths, monthsToTarget } from '../finance/savings.ts';
import { defaultLocale, type Locale } from '../i18n/locales.ts';
import { type MessageValues, translator } from '../i18n/messages.ts';
import { inlinePerson } from '../model/person.ts';
import { ageOn, childAgeOn } from '../model/questions.ts';
import { callStatusOn, evaluateIncentives } from '../places/eligibility.ts';
import { wording } from '../places/wording.ts';
import { factsOf } from './next-questions.ts';
import { planMessages } from './plan.messages.ts';

/**
 * The plan that joins a person and a place: how many months until the person has the upfront cash
 * to buy there, and how many fewer because of their habits and of what the place offers.
 *
 * Money is integer EUR cents. Each product of a rate and an amount is rounded once, to the nearest
 * cent, where it is computed. Unknown inputs produce `null` timelines, never a guessed number.
 *
 * The baseline transfer tax is what this person would pay anywhere in Catalonia: the general tariff,
 * or the lowest reduced rate of a Catalonia-wide policy (`territory: 'catalonia'`) whose every
 * condition is verified. A place only gets credit for the difference between that baseline and its
 * own reduced rate. An unverified Catalonia-wide rate never lowers the baseline; it is reported.
 *
 * How a place benefit enters the timeline depends on WHEN its cash exists (see `translate`):
 *   - at the purchase: it lowers the upfront cash needed (reduced transfer tax, purchase grants);
 *   - while living in the place before buying: it adds to savings, one tax year late;
 *   - after the purchase: it never shortens the wait, so it is shown and not counted.
 *
 * WHEN a benefit is screened. A benefit tied to the purchase is screened on the day the person could
 * buy, not on the plan date: the plan date plus the months of the timeline, with the buyer and the
 * children as old as they will be then. That day depends on what is counted, and what is counted
 * depends on that day, so each timeline is recomputed until the two agree (`settle`). When they do
 * not agree within `maxSettleRounds` rounds, nothing is counted for that timeline. A benefit tied to
 * living in the place is screened on the plan date, the assumed day of the move.
 *
 * A stated age is a whole number of years on the plan date and the birthday is unknown, so after m
 * months a person is `age + floor(m / 12)` or one year more. A condition that holds for one and fails
 * for the other is unverified, never assumed. When the person carries dates of birth (`person.born`),
 * every age is derived from them on the day it is needed and there is nothing to leave open. Tax
 * bases, family status and the rules are assumed unchanged.
 *
 * The three timelines (baseline, with habits, with place benefits) each settle on their own purchase
 * day, so a faster timeline can keep a rate that a slower one loses with age.
 *
 * Two rules keep the three consistent with each other:
 *   - Saving more never gives a later day. The cash of a slower timeline is there on that timeline's
 *     day, so a faster one that settles later (or not at all) is held at the slower one's day:
 *     with habits is never later than the baseline, with place benefits never later than with habits.
 *   - A timeline without a finite number of months has no purchase day. Its benefits are then listed
 *     as screened on the plan date, and say so; none is described against a day that does not exist.
 *
 * LANGUAGE. Every sentence of the result comes from `plan.messages.ts` and is written in the
 * language passed as `locale` (English by default). The language changes sentences only: every
 * amount, month, date, status, id and the order of the plans are the same in the three languages.
 */
type Eligibility = z.infer<typeof eligibility>;
type Household = NonNullable<Person['household']>;
type Timeline = NonNullable<PlacePlan['baseline']>;
export type Assumptions = z.infer<typeof planAssumptions>;
/** When the money of a benefit exists relative to the purchase. */
type Timing = 'at_purchase' | 'while_living_there' | 'after_purchase' | 'not_applicable';
type TransferTaxEffect = Extract<NonNullable<Policy['effect']>, { kind: 'transfer_tax_rate' }>;
/** The general transfer tax as the policy data states it: one rate, or a tariff by value. */
type StandardTax = Pick<TransferTaxEffect, 'standardRate' | 'standardTariff'>;
/** The transfer tax a reduced rate is compared with, for one person and price. */
type TaxReference = {
  /** The general tax on this price. Null when the price is unknown. */
  standardCents: number | null;
  /** What the person pays anywhere in Catalonia: the general tax or a verified lower rate. */
  baselineCents: number | null;
  standardLabel: string;
  baselineLabel: string;
};
type Translated = Pick<PlaceBenefit, 'kind' | 'amountCents'> & {
  timing: Timing;
  maxYears: number | null;
  /** What the measure is worth, in plain language. */
  what: string;
};
/** A screened policy next to the same policy screened on the plan date. */
type Screened = {
  result: Eligibility;
  /** The screening on the plan date; the same object when the event is the plan date. */
  today: Eligibility;
  /** True when the event is the purchase, so the screening moves with the purchase day. */
  atPurchase: boolean;
};
/** The day a timeline is screened on. */
type When = { months: number; date: string; ages: string };

/** A tax deduction is received with the return filed the year after the qualifying event. */
const taxReturnDelayMonths = 12;
/** Rounds of screening on the estimated purchase day before a timeline is declared unsettled. */
const maxSettleRounds = 8;
/** Intents screened for a purchase plan. Renovation measures depend on works this plan does not model. */
const screenedIntents = new Set<Policy['intent']>(['buy', 'move', 'rent']);

type PlanMessage = keyof (typeof planMessages)['en'];

/**
 * The words of one language: its sentences and how it writes an amount, a share and a date.
 *
 * English writes whole euros without decimals and any other amount with both (`€26,989`,
 * `€397.70`), and keeps ISO dates. Catalan and Spanish use the formats of `packages/i18n`.
 */
function wordsFor(locale: Locale) {
  const write = wording(locale);
  const t = translator(planMessages, locale) as (key: PlanMessage, values?: MessageValues) => string;
  return {
    locale,
    t,
    euros: (amountCents: number) => {
      const cents = Math.round(amountCents);
      const digits = cents % 100 === 0 ? 0 : 2;
      const english = `€${(cents / 100).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
      return write.euros(cents, english);
    },
    percent: write.percent,
    date: write.date,
    number: write.number,
    list: write.list,
  };
}
type Words = ReturnType<typeof wordsFor>;

/** What a plan cannot tell, in `locale`. */
export function planLimitationsIn(locale: Locale = defaultLocale): string[] {
  const { t } = wordsFor(locale);
  return [
    t('limitation1'),
    t('limitation2'),
    t('limitation3'),
    t('limitation4', { maxMonths: maxPlanningMonths }),
    t('limitation5'),
  ];
}

export const planLimitations = planLimitationsIn(defaultLocale);

/** A share of an amount in cents, rounded to the nearest cent. */
function share(rate: number, amountCents: number): number {
  return Math.round(rate * amountCents);
}

/**
 * The general transfer tax on a price. With a tariff, each bracket's rate applies to the part of the
 * price inside the bracket and every product is rounded once; without one, the single rate applies.
 * The price stands for the property's total value.
 */
function standardTaxCents(standard: StandardTax, priceCents: number): number {
  const tariff = standard.standardTariff;
  if (!tariff) return share(standard.standardRate, priceCents);
  return tariff.reduce((total, bracket, index) => {
    const from = bracket.fromEur * 100;
    const to = index + 1 < tariff.length ? tariff[index + 1].fromEur * 100 : Number.POSITIVE_INFINITY;
    return total + share(bracket.rate, Math.max(0, Math.min(priceCents, to) - from));
  }, 0);
}

/** The price above which the general tariff stops being a single rate; null without a tariff. */
function firstBracketEndCents(standard: StandardTax): number | null {
  const next = standard.standardTariff?.[1];
  return next ? next.fromEur * 100 : null;
}

/** The value of a rural-category table for a place; null for partially covered municipalities. */
function forCategory(
  table: { rural: number; special_attention: number; other: number },
  category: Place['rural'],
): number | null {
  // The same value everywhere does not depend on the nucleus.
  if (table.rural === table.special_attention && table.rural === table.other) return table.rural;
  if (category === 'rural') return table.rural;
  if (category === 'special_attention') return table.special_attention;
  // Which nucleus of a partially covered municipality the home is in is unknown here.
  return category === 'not_listed' ? table.other : null;
}

/** The municipality facts `evaluateIncentives` reads, taken from a `Place`. */
function asMunicipality(place: Place): Municipality {
  const unsourced = { observedAt: 'not carried by Place', sourceUrl: 'https://www.relo.cat/' };
  return {
    code: place.municipalityCode,
    name: place.name,
    comarca: place.comarca,
    recommendable: true,
    identity: unsourced,
    centre: { ...place.centre, ...unsourced, name: place.name },
    // A place built before `ruralEffectiveFrom` existed carries none: the date is then unknown (null).
    rural: { ...unsourced, category: place.rural, effectiveFrom: place.ruralEffectiveFrom ?? null },
  };
}

/** A date `months` calendar months later; a day past the end of the month becomes its last day. */
function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** The household with everyone `years` older. */
function older(facts: Household, years: number): Household {
  return {
    ...facts,
    ...(facts.age === undefined ? {} : { age: facts.age + years }),
    ...(facts.children ? { children: facts.children.map(child => ({ ...child, age: child.age + years })) } : {}),
  };
}

const maxAge = 125;

/**
 * The household as the screening reads it on `date`, with every age derived from a date of birth
 * where the person has one (`person.born`). A stated age is kept only without a date of birth. A list
 * of children in which one child has neither a date, a year nor an age is left unknown: an unknown
 * child is never dropped, because an empty list means "no children".
 */
function householdOn(person: Person, date: string): Household | undefined {
  const { born } = person;
  if (!born) return person.household;
  const household: Household = { ...person.household };
  if (born.self !== undefined) household.age = Math.min(maxAge, Math.max(0, ageOn(born.self, date)));
  if (born.children) {
    const children = born.children.map(({ birthDate: _, birthYear: __, age: ___, ...flags }, index) => ({
      ...flags,
      age: childAgeOn(born.children?.[index] ?? {}, date),
    }));
    if (children.every(child => child.age !== null))
      household.children = children.map(child => ({ ...child, age: Math.min(maxAge, child.age ?? 0) }));
    else delete household.children;
  }
  return Object.keys(household).length ? household : undefined;
}

/** The same person with the ages of the plan date written into `household`, so the result states them. */
export function withDerivedAges(person: Person, date: string): Person {
  if (!person.born) return person;
  const { household: _, ...rest } = person;
  const household = householdOn(person, date);
  return household ? { ...rest, household } : rest;
}

/** True when every age of the household comes from a full date of birth, so a future age is exact. */
function agesAreExact(person: Person): boolean {
  const { born, household } = person;
  if (!born) return false;
  const selfExact = born.self !== undefined || household?.age === undefined;
  const childrenExact = born.children
    ? born.children.every(child => child.birthDate !== undefined)
    : household?.children === undefined;
  return selfExact && childrenExact && (born.self !== undefined || born.children !== undefined);
}

/** "46", or "46 or 47" when the birthday decides. */
function ageRange(age: number, months: number, words: Words): string {
  const [low, high] = [age + Math.floor(months / 12), age + Math.ceil(months / 12)];
  return low === high ? `${low}` : words.t('ageRange', { low, high });
}

/**
 * The ages on the purchase day, as a sentence; empty when no age is known or the day is the plan date.
 * `exact` is the household on that day when every age comes from a date of birth.
 */
function agesOn(facts: Household | undefined, months: number, words: Words, exact?: Household): string {
  if (!facts || months === 0) return '';
  const children = (exact ?? facts).children ?? [];
  const age = (exact ?? facts).age;
  const range = (value: number) => (exact ? `${value}` : ageRange(value, months, words));
  const ages = children.map(child => range(child.age)).join(', ');
  const count = children.length;
  if (age === undefined) return count ? words.t('agesChildren', { count, ages }) : '';
  return count ? words.t('agesBoth', { age: range(age), count, ages }) : words.t('agesSelf', { age: range(age) });
}

/**
 * One screening for the two ages a person can have on a future day. The same answer for both is the
 * answer; different answers mean the birthday decides, which is unverified.
 */
function mergeAges(youngest: Eligibility, oldest: Eligibility, date: string, words: Words): Eligibility {
  const missing = [...new Set([...oldest.missingCriteria, ...youngest.missingCriteria])];
  if (youngest.eligibilityStatus === oldest.eligibilityStatus) return { ...oldest, missingCriteria: missing };
  return {
    ...oldest,
    eligibilityStatus: 'needs_verification',
    screenedAmountEur: undefined,
    unmetCriteria: [],
    missingCriteria: [
      words.t('birthdaysUnknown', { date: words.date(date) }),
      ...new Set([...oldest.unmetCriteria, ...youngest.unmetCriteria, ...missing]),
    ],
  };
}

/**
 * Price of the home: the person's budget, else floor area × published resale EUR/m².
 * A price must be greater than zero: a budget, a floor area or a published price of zero is unknown.
 */
function priceFor(person: Person, place: Place): Pick<PlacePlan, 'purchasePriceCents' | 'priceBasis'> {
  const unknown = { purchasePriceCents: null, priceBasis: 'unknown' as const };
  if (person.home.budgetCents !== null)
    return person.home.budgetCents > 0
      ? { purchasePriceCents: person.home.budgetCents, priceBasis: 'budget' }
      : unknown;
  const resale = place.indicators.resaleEurPerM2;
  if (person.home.floorAreaM2 === null || !(person.home.floorAreaM2 > 0) || !resale || !(resale.value > 0))
    return unknown;
  // EUR → cents happens once, here.
  const purchasePriceCents = Math.round(person.home.floorAreaM2 * resale.value * 100);
  if (!(purchasePriceCents > 0)) return unknown;
  return {
    purchasePriceCents,
    priceBasis: resale.geography === 'comarca' ? 'comarca_eur_per_m2' : 'municipal_eur_per_m2',
  };
}

/**
 * Monthly saving of the habits that count: planned amount × adherence (full amount when unknown).
 *
 * A habit changes what the person spends. When the monthly spending was observed in bank movements,
 * an active habit that was already running during the observed period is inside that figure. It
 * counts on top of it only when `startedOn` is after `finances.asOf`, the end of the observed
 * period. An active habit without a start date, or a bank period without an end date, is withheld:
 * shown, not counted. A proposed habit has not started, so it is never inside the observed figure.
 *
 * Only the spending figure matters: income observed in the bank next to declared spending does not
 * hide a habit. `finances.expensesBasis` says where spending came from; a person built before that
 * field existed has only `basis`, and `mixed` is then read cautiously as observed spending.
 *
 * The result states, habit by habit, what was done and why (`effects`), so no display has to derive it.
 */
function habitSavings(person: Person, includeProposed: boolean, words: Words) {
  const { t, euros, percent, date } = words;
  const { basis, asOf } = person.finances;
  const spendingObserved =
    person.finances.expensesBasis === undefined
      ? basis === 'bank_observed' || basis === 'mixed'
      : person.finances.expensesBasis === 'bank_observed';
  const effects: HabitEffect[] = person.habits.map(habit => {
    // Rounded down per habit: a partly kept habit never counts for more than it saved.
    const amount = Math.floor((habit.monthlySavingCents ?? 0) * (habit.adherence ?? 1));
    const left = (reason: HabitEffect['reason'], explanation: string): HabitEffect => ({
      habitId: habit.id,
      counted: false,
      countedMonthlyCents: 0,
      reason,
      explanation,
    });
    const taken = (reason: HabitEffect['reason'], explanation: string): HabitEffect => ({
      habitId: habit.id,
      counted: true,
      countedMonthlyCents: amount,
      reason,
      explanation:
        habit.adherence === null
          ? explanation
          : `${explanation} ${t('habitScaled', { share: percent(habit.adherence) })}`,
    });
    if (habit.status === 'paused') return left('paused', t('habitPaused'));
    if (habit.monthlySavingCents === null) return left('no_amount', t('habitNoAmount'));
    if (habit.status === 'proposed')
      return includeProposed
        ? taken('counted_as_proposed', t('habitAsProposed', { amount: euros(amount) }))
        : left('not_adopted', t('habitNotAdopted'));
    if (!spendingObserved) return taken('counted', t('habitCounted', { amount: euros(amount) }));
    if (habit.startedOn === undefined)
      return left(
        'start_unknown',
        asOf === null ? t('habitStartUnknown') : t('habitStartUnknownUpTo', { asOf: date(asOf) }),
      );
    if (asOf === null) return left('start_unknown', t('habitPeriodEndUnknown'));
    return habit.startedOn > asOf
      ? taken(
          'counted',
          t('habitCountedAfter', { amount: euros(amount), startedOn: date(habit.startedOn), asOf: date(asOf) }),
        )
      : left('inside_bank_figures', t('habitInside', { startedOn: date(habit.startedOn), asOf: date(asOf) }));
  });
  const of = (keep: (effect: HabitEffect) => boolean) => person.habits.filter((_, index) => keep(effects[index]));
  return {
    effects,
    counted: of(effect => effect.counted),
    withheld: of(effect => effect.reason === 'inside_bank_figures' || effect.reason === 'start_unknown'),
    monthlyCents: effects.reduce((total, effect) => total + effect.countedMonthlyCents, 0),
  };
}
type HabitSavings = ReturnType<typeof habitSavings>;

/** Turn a screened policy into the kind, amount and timing of a benefit for this price and place. */
function translate(
  result: Eligibility,
  place: Place,
  priceCents: number | null,
  tax: TaxReference,
  words: Words,
): Translated {
  const { t, euros, percent } = words;
  const effect = result.effect;
  const livingThere = result.intent === 'move' || result.intent === 'rent';
  const none = { amountCents: null, maxYears: null };
  if (!effect || effect.kind === 'unquantified') {
    // The reason is the policy's own text, already in the language of the screening.
    const what = effect ? t('whatUnquantified', { reason: effect.reason }) : t('whatNotModelled');
    return { ...none, kind: 'unquantified', timing: 'not_applicable', what };
  }
  switch (effect.kind) {
    case 'transfer_tax_rate': {
      const reduced = forCategory(effect.reducedRate, place.rural);
      // A rate for the whole of Catalonia is measured against the general tax; a place's rate against
      // what this person would pay anywhere, so the place is only credited with the difference.
      const everywhere = isGeneralRate(result);
      const againstCents = everywhere ? tax.standardCents : tax.baselineCents;
      const amountCents =
        reduced === null || priceCents === null || againstCents === null
          ? null
          : Math.max(0, againstCents - share(reduced, priceCents));
      const what =
        reduced === null
          ? t('whatNucleus')
          : everywhere
            ? t('whatRateAnywhere', { rate: percent(reduced), standard: tax.standardLabel })
            : t('whatRate', { rate: percent(reduced), baseline: tax.baselineLabel });
      return { kind: 'upfront_cost_reduction', amountCents, maxYears: null, timing: 'at_purchase', what };
    }
    case 'one_off_rate_of_price': {
      // The lower of a fixed ceiling and a share of the price; both are rounded to the cent once.
      const capCents = Math.round(effect.maxAmountEur * 100);
      const timing =
        result.mechanism === 'grant' && result.intent === 'buy'
          ? 'at_purchase'
          : livingThere
            ? 'while_living_there'
            : 'after_purchase';
      return {
        kind: 'one_off_cash',
        amountCents: priceCents === null ? null : Math.min(capCents, share(effect.rate, priceCents)),
        maxYears: null,
        timing,
        what: t('whatOneOffRate', { cap: euros(capCents), rate: percent(effect.rate) }),
      };
    }
    case 'one_off_eur': {
      const eur = result.screenedAmountEur ?? forCategory(effect.amount, place.rural);
      const timing =
        result.mechanism === 'grant' && result.intent === 'buy'
          ? 'at_purchase'
          : livingThere
            ? 'while_living_there'
            : 'after_purchase';
      return {
        kind: 'one_off_cash',
        amountCents: eur === null ? null : Math.round(eur * 100),
        maxYears: null,
        timing,
        what: t('whatOneOff'),
      };
    }
    case 'annual_eur': {
      const eur = forCategory(effect.amount, place.rural);
      return {
        kind: 'annual_cash',
        amountCents: eur === null ? null : Math.round(eur * 100),
        maxYears: effect.maxYears,
        timing: livingThere ? 'while_living_there' : 'after_purchase',
        what: effect.maxYears ? t('whatAnnualYears', { years: effect.maxYears }) : t('whatAnnual'),
      };
    }
    case 'annual_rate_of_cost': {
      // The base is what the household actually pays each year, which the person entity does not hold,
      // so the amount stays unknown and is never counted.
      const rate = forCategory(effect.rate, place.rural);
      // The two limits are clauses that close the first sentence, in the order the rule states them.
      const base = effect.maxBaseEur === undefined ? '' : t('limitBase', { base: euros(effect.maxBaseEur * 100) });
      const cap = effect.maxAmountEur
        ? t('limitCap', {
            individual: euros(effect.maxAmountEur.individual * 100),
            joint: euros(effect.maxAmountEur.joint * 100),
          })
        : '';
      const limits = `${base}${cap}`;
      return {
        ...none,
        kind: 'annual_cash',
        timing: livingThere ? 'while_living_there' : 'after_purchase',
        what:
          rate === null
            ? t(`whatCostShare.${effect.cost}`, { limits })
            : t(`whatCostRate.${effect.cost}`, { rate: percent(rate), limits }),
      };
    }
  }
}

const eligibilityRank = { ineligible: 0, needs_verification: 1, eligible: 2 } as const;

/**
 * Why a benefit that holds on the plan date does not hold on the purchase day, in plain language.
 * Null when the purchase day is the plan date or the screening there is no worse than today's.
 */
function lostBy({ result, today, atPurchase }: Screened, when: When, words: Words): string | null {
  const { t, date } = words;
  // Something that does not apply on the plan date either was never there to lose.
  if (!atPurchase || when.months === 0 || today.eligibilityStatus === 'ineligible') return null;
  const day = { date: date(when.date), months: when.months };
  if (result.measureStatus !== 'active' && today.measureStatus === 'active')
    return t('lostMeasureEnds', { ...day, through: date(result.effectiveThrough) });
  if (eligibilityRank[result.eligibilityStatus] >= eligibilityRank[today.eligibilityStatus]) return null;
  // Whole sentences, one after the other: what changes, the ages on that day, and the criteria.
  const sentences =
    result.eligibilityStatus === 'ineligible'
      ? [t('lostNotOnDay', day), when.ages, t('criteriaNotMetByThen', { criteria: result.unmetCriteria.join(' ') })]
      : [t('lostNotCertain', day), when.ages, t('toVerify', { criteria: result.missingCriteria.join(' ') })];
  return sentences.filter(Boolean).join(' ');
}

/** Decide whether a translated benefit is counted, and say why in plain language. */
function benefitFor(
  screened: Screened,
  translated: Translated,
  person: Person,
  place: Place,
  options: Assumptions,
  when: When,
  words: Words,
): PlaceBenefit {
  const { t, euros, date } = words;
  const { result } = screened;
  const { amountCents, timing, what } = translated;
  const unverified = result.eligibilityStatus === 'needs_verification';
  const lost = lostBy(screened, when, words);
  const notCounted = (reason: string) => t('notCounted', { reason });
  let blocker: string | null = null;
  if (result.geographicStatus === 'does_not_apply' || result.eligibilityStatus === 'ineligible') {
    blocker = lost ? notCounted(lost) : t('notCountedCriteria', { criteria: result.unmetCriteria.join(' ') });
  } else if (result.callStatus === 'closed') {
    blocker = t('callClosed');
  } else if (result.callStatus === 'upcoming') {
    blocker = t('callUpcoming');
  } else if (result.callWindow === null) {
    blocker = t('callNone');
  } else if (timing === 'at_purchase' && result.callStatus === 'open' && callStatusOn(result, when.date) !== 'open') {
    // An open call only helps a purchase that happens while it is open; a later call is not known.
    blocker = t('callClosesBefore', { date: date(when.date) });
  } else if (result.measureStatus !== 'active') {
    blocker = lost
      ? notCounted(lost)
      : screened.atPurchase
        ? t('notInForceOn', { date: date(when.date) })
        : t('notInForceOnPlanDate');
  } else if (result.geographicStatus !== 'applies') {
    blocker = t('untilVerifiedGeo', { criteria: result.missingCriteria.join(' ') });
  } else if (unverified && !options.includeUnverifiedBenefits) {
    blocker = lost ? notCounted(lost) : t('shownUntilVerified', { criteria: result.missingCriteria.join(' ') });
  } else if (amountCents === null) {
    blocker = t('amountUnknown');
  } else if (amountCents === 0) {
    blocker = t('noReduction');
  } else if (timing === 'after_purchase') {
    blocker = t('afterPurchase');
  } else if (timing === 'while_living_there' && person.currentMunicipalityCode === place.municipalityCode) {
    blocker = t('alreadyLiveHere');
  }
  const counted = blocker === null && amountCents !== null;
  const excluded = result.geographicStatus === 'does_not_apply' || result.eligibilityStatus === 'ineligible';
  const caveat = unverified ? ` ${t('countedUnverified')}` : '';
  const how =
    timing === 'at_purchase'
      ? t('countedAtPurchase', { amount: euros(amountCents ?? 0) })
      : translated.kind === 'annual_cash'
        ? t('countedAnnual', {
            amount: euros(Math.floor((amountCents ?? 0) / 12)),
            month: taxReturnDelayMonths + 1,
          })
        : t('countedOneOff', { amount: euros(amountCents ?? 0), months: taxReturnDelayMonths });
  return {
    policyId: result.id,
    title: result.title,
    kind: translated.kind,
    // An amount the person would not receive is not shown as theirs; the nominal figure stays for reference.
    amountCents: excluded ? null : amountCents,
    nominalAmountCents: amountCents,
    eligibilityStatus: result.eligibilityStatus,
    callStatus: result.callStatus,
    counted,
    scope: 'place',
    sourceUrl: result.sourceUrl,
    explanation: `${what} ${counted ? how + caveat : blocker}`.trim(),
  };
}

/** A reduced transfer-tax rate that applies in every municipality: it can set the baseline, never a place saving. */
function isGeneralRate(result: Pick<Policy, 'territory' | 'effect'>): boolean {
  return result.territory === 'catalonia' && result.effect?.kind === 'transfer_tax_rate';
}

/** True when every condition of a Catalonia-wide rate is confirmed for the day it is screened on. */
function isVerified(result: Eligibility): boolean {
  return (
    result.eligibilityStatus === 'eligible' &&
    result.measureStatus === 'active' &&
    result.geographicStatus === 'applies'
  );
}

/**
 * List a Catalonia-wide reduced rate. It is never `counted`: when it applies it is already inside the
 * baseline of every place, so it cannot be a saving of this one.
 */
function generalRateBenefit(
  screened: Screened,
  translated: Translated,
  applied: Eligibility | null,
  isLower: boolean,
  when: When,
  /** Why a rate that would be the baseline was left out; null when it was not. */
  leftOut: string | null,
  words: Words,
): PlaceBenefit {
  const { t, euros, date } = words;
  const { result } = screened;
  const { amountCents, what } = translated;
  const lost = lostBy(screened, when, words);
  let outcome: string;
  if (result === applied) {
    outcome = t('appliedBaseline', { amount: euros(amountCents ?? 0) });
  } else if (lost) {
    outcome = t('notApplied', { reason: lost });
  } else if (result.eligibilityStatus === 'ineligible') {
    outcome = t('notAppliedCriteria', { criteria: result.unmetCriteria.join(' ') });
  } else if (result.measureStatus !== 'active') {
    outcome = t('notAppliedNotInForce', { date: date(when.date) });
  } else if (result.eligibilityStatus === 'needs_verification') {
    const until = t('notAppliedUntilVerified', { criteria: result.missingCriteria.join(' ') });
    outcome = isLower ? `${until} ${t('ifYouQualify')}` : until;
  } else if (leftOut !== null) {
    outcome = t('notApplied', { reason: leftOut });
  } else if (applied !== null) {
    outcome = t('notAppliedAnother');
  } else {
    outcome = t('notAppliedNotLower');
  }
  return {
    policyId: result.id,
    title: result.title,
    kind: translated.kind,
    amountCents: result.eligibilityStatus === 'ineligible' ? null : amountCents,
    nominalAmountCents: amountCents,
    eligibilityStatus: result.eligibilityStatus,
    callStatus: result.callStatus,
    counted: false,
    scope: 'anywhere',
    sourceUrl: result.sourceUrl,
    explanation: `${what} ${outcome}`.trim(),
  };
}

type DelayedCash = { lumpCents: number; annual: { monthlyCents: number; maxYears: number | null }[] };

/**
 * Months to cover `remaining` with `monthly` savings plus cash that arrives one tax year late.
 * Every step uses `monthsToTarget`. Delayed cash only helps a timeline that is already finite and
 * longer than the delay, so it can never create a timeline out of zero or negative savings.
 */
function monthsWithDelayedCash(remaining: number, monthly: number, cash: DelayedCash): number | null {
  const plain = monthsToTarget(remaining, monthly);
  if (plain === null || plain <= taxReturnDelayMonths) return plain;
  let left = remaining - monthly * taxReturnDelayMonths - cash.lumpCents;
  let elapsed = taxReturnDelayMonths;
  let start = 0;
  const caps = [...new Set(cash.annual.flatMap(item => (item.maxYears === null ? [] : [item.maxYears * 12])))];
  for (const cap of [...caps.sort((a, b) => a - b), null]) {
    const rate = cash.annual
      .filter(item => item.maxYears === null || item.maxYears * 12 > start)
      .reduce((total, item) => total + item.monthlyCents, monthly);
    const months = monthsToTarget(left, rate);
    if (cap === null) return months === null ? plain : Math.min(plain, elapsed + months);
    if (months !== null && months <= cap - start) return Math.min(plain, elapsed + months);
    left -= rate * (cap - start);
    elapsed += cap - start;
    start = cap;
  }
  return plain;
}

function difference(longer: Timeline | null, shorter: Timeline | null): number | null {
  return longer?.months == null || shorter?.months == null ? null : longer.months - shorter.months;
}

/** One timeline computed with the purchase screened on `when`. */
type Outcome = {
  when: When;
  /** False when the purchase day and what is counted did not agree, and nothing was counted. */
  settled: boolean;
  /** True when the timeline has no purchase day although the screening on the plan date gave one. */
  noDay: boolean;
  /** True when a faster timeline settled later than a slower one and is held at the slower one's day. */
  held: boolean;
  /** The Catalonia-wide rate that is the baseline on that day; null for the general tax. */
  applied: { result: Eligibility; rate: number } | null;
  possiblyLower: { result: Eligibility; rate: number }[];
  standardCents: number | null;
  baselineCents: number | null;
  standardLabel: string;
  aboveFirstBracket: boolean;
  tax: TaxReference;
  benefits: PlaceBenefit[];
  /** Deposit, baseline transfer tax and fees, less what the place takes off when it is counted. */
  upfrontCents: number | null;
  months: number | null;
};

function planOne(
  person: Person,
  place: Place,
  policies: Policy[],
  options: Assumptions,
  asOf: string,
  standard: StandardTax | null,
  habits: HabitSavings,
  words: Words,
  /** True for the plan without a place: `place` then stands for anywhere in Catalonia. */
  noPlace = false,
): PlacePlan {
  const { t, euros, percent, date, number, locale } = words;
  const { finances, home } = person;
  const assumptions: string[] = [];
  const dataMissing: string[] = [];
  const price = priceFor(person, place);
  const priceCents = price.purchasePriceCents;

  if (price.priceBasis === 'budget') assumptions.push(t('assumeBudget', { amount: euros(priceCents ?? 0) }));
  else if (priceCents === null) {
    if (home.budgetCents !== null) dataMissing.push(t('missingBudgetPositive'));
    else if (noPlace) dataMissing.push(t('missingBudgetNoPlace'));
    else {
      if (home.floorAreaM2 === null) dataMissing.push(t('missingAreaOrBudget'));
      if (!((place.indicators.resaleEurPerM2?.value ?? 0) > 0))
        dataMissing.push(t('missingResale', { place: place.name }));
    }
  } else {
    const resale = place.indicators.resaleEurPerM2;
    const figures = {
      area: number(home.floorAreaM2 ?? 0, String(home.floorAreaM2)),
      perM2: euros((resale?.value ?? 0) * 100),
      // The observation date is the source's own text (a year, a quarter): it is not reformatted.
      observedAt: String(resale?.observedAt),
      price: euros(priceCents),
    };
    assumptions.push(
      price.priceBasis === 'comarca_eur_per_m2'
        ? t('assumePriceComarca', { ...figures, comarca: place.comarca })
        : t('assumePriceTown', { ...figures, place: place.name }),
    );
    if (price.priceBasis === 'comarca_eur_per_m2') dataMissing.push(t('missingMunicipalResale', { place: place.name }));
  }
  if (standard === null) dataMissing.push(t('missingStandardRate'));
  if (finances.currentSavingsCents === null) dataMissing.push('person.finances.currentSavingsCents');
  if (finances.monthlyIncomeCents === null) dataMissing.push('person.finances.monthlyIncomeCents');
  if (finances.monthlyExpensesCents === null) dataMissing.push('person.finances.monthlyExpensesCents');

  // ------------------------------------------------------------ screening
  const town = asMunicipality(place);
  const considered = policies.filter(policy => screenedIntents.has(policy.intent));
  const buyPolicies = considered.filter(policy => policy.intent === 'buy');
  const livingPolicies = considered.filter(policy => policy.intent !== 'buy');
  // The price cap of an aid is checked against the price of this plan, not a separately stated one.
  const priced = (household: Household | undefined): Household | undefined =>
    priceCents === null ? household : { ...household, purchasePriceEur: priceCents / 100 };
  const facts = priced(person.household);
  // With dates of birth the ages on any later day are known, and no birthday is left open.
  const exact = agesAreExact(person);
  const screenOn = (list: Policy[], eventDate: string, household: Household | undefined) =>
    evaluateIncentives(list, town, { municipalityCode: place.municipalityCode, eventDate, household }, asOf, locale);
  // A move or a rental is assumed to start on the plan date, with everyone as old as they are today.
  const living = screenOn(livingPolicies, asOf, facts);
  const buyScreenings = new Map<number, Eligibility[]>();
  /** Buy-side policies screened `months` after the plan date, for both ages a birthday allows. */
  const screenBuy = (months: number): Eligibility[] => {
    const cached = buyScreenings.get(months);
    if (cached) return cached;
    const date = addMonths(asOf, months);
    if (exact) {
      const onDay = screenOn(buyPolicies, date, priced(householdOn(person, date)));
      buyScreenings.set(months, onDay);
      return onDay;
    }
    const [low, high] = [Math.floor(months / 12), Math.ceil(months / 12)];
    const youngest = screenOn(buyPolicies, date, facts && older(facts, low));
    const oldest = low === high || !facts ? youngest : screenOn(buyPolicies, date, older(facts, high));
    const merged = youngest.map((result, index) =>
      oldest === youngest ? result : mergeAges(result, oldest[index], date, words),
    );
    buyScreenings.set(months, merged);
    return merged;
  };
  /** Every considered policy in its original order, screened for a purchase `months` from now. */
  const screenedAt = (months: number): Screened[] => {
    const [buy, today] = [screenBuy(months), screenBuy(0)];
    return considered.map(policy => {
      const buyIndex = buyPolicies.indexOf(policy);
      if (buyIndex >= 0) return { result: buy[buyIndex], today: today[buyIndex], atPurchase: true };
      const result = living[livingPolicies.indexOf(policy)];
      return { result, today: result, atPurchase: false };
    });
  };

  const monthly =
    finances.monthlyIncomeCents === null || finances.monthlyExpensesCents === null
      ? null
      : finances.monthlyIncomeCents - finances.monthlyExpensesCents;
  const availableCents =
    finances.currentSavingsCents === null
      ? null
      : Math.max(0, finances.currentSavingsCents - finances.emergencyReserveCents);
  const standardCents = standard === null || priceCents === null ? null : standardTaxCents(standard, priceCents);
  const aboveFirstBracket =
    standard !== null &&
    priceCents !== null &&
    priceCents > (firstBracketEndCents(standard) ?? Number.POSITIVE_INFINITY);
  const standardLabel =
    standard === null
      ? t('labelGeneralRate')
      : aboveFirstBracket && standardCents !== null && priceCents
        ? t('labelGeneralTariff', { amount: euros(standardCents), rate: percent(standardCents / priceCents) })
        : t('labelGeneralPercent', { rate: percent(standard.standardRate) });
  const depositCents = priceCents === null ? null : share(home.depositRate, priceCents);
  const feesCents = priceCents === null ? null : share(options.purchaseFeesRate, priceCents);

  /**
   * One timeline with the purchase screened `months` after the plan date.
   * `withPlace`: the benefits of the place lower the upfront cash and add delayed cash.
   * `cautious`: benefits are left out. `place` leaves out what the place offers and keeps the
   * baseline rate; `all` also falls back to the general transfer tax. `why` says which of the two
   * reasons applies: the purchase day did not settle, or there is no purchase day at all.
   */
  const evaluate = (
    months: number,
    monthlyCents: number | null,
    withPlace: boolean,
    cautious: 'no' | 'place' | 'all' = 'no',
    why: 'unsettled' | 'no_day' = 'unsettled',
  ): Outcome => {
    const leftOutReason = why === 'no_day' ? t('reasonNoDay', { asOf: date(asOf) }) : t('reasonUnsettled');
    const day = addMonths(asOf, months);
    const when: When = {
      months,
      date: day,
      ages: agesOn(person.household, months, words, exact ? householdOn(person, day) : undefined),
    };
    const screened = screenedAt(months);

    // The baseline transfer tax: the general tax, or the lowest Catalonia-wide rate verified for that day.
    const generalRates = screened.flatMap(({ result }) => {
      if (!isGeneralRate(result)) return [];
      const rate =
        result.effect?.kind === 'transfer_tax_rate' ? forCategory(result.effect.reducedRate, place.rural) : null;
      return rate === null ? [] : [{ result, rate }];
    });
    /** True when a flat rate gives less tax than `cents` on this price (compared by rate when the price is unknown). */
    const lowerThan = (rate: number, cents: number | null, fallbackRate: number | null) =>
      priceCents !== null && cents !== null
        ? share(rate, priceCents) < cents
        : fallbackRate !== null && rate < fallbackRate;
    const candidate =
      generalRates
        .filter(({ result }) => isVerified(result))
        .sort((a, b) => a.rate - b.rate)
        .find(({ rate }) => lowerThan(rate, standardCents, standard?.standardRate ?? null)) ?? null;
    const applied = cautious === 'all' ? null : candidate;
    const baselineCents = applied && priceCents !== null ? share(applied.rate, priceCents) : standardCents;
    const baselineRate = applied?.rate ?? standard?.standardRate ?? null;
    const possiblyLower = generalRates.filter(
      ({ result, rate }) =>
        result.eligibilityStatus === 'needs_verification' && lowerThan(rate, baselineCents, baselineRate),
    );
    const tax: TaxReference = {
      standardCents,
      baselineCents,
      standardLabel,
      baselineLabel: applied
        ? t('labelAlreadyQualify', { rate: percent(applied.rate), title: applied.result.title })
        : standardLabel,
    };

    const listed = screened.map(item => {
      const translated = translate(item.result, place, priceCents, tax, words);
      const benefit = isGeneralRate(item.result)
        ? generalRateBenefit(
            item,
            translated,
            applied?.result ?? null,
            possiblyLower.some(entry => entry.result === item.result),
            when,
            cautious === 'all' && candidate?.result === item.result ? leftOutReason : null,
            words,
          )
        : benefitFor(item, translated, person, place, options, when, words);
      return { translated, benefit };
    });
    // Reduced transfer-tax rates are alternatives, not cumulative: only the largest reduction counts.
    const taxCuts = listed
      .filter(item => item.benefit.counted && item.benefit.kind === 'upfront_cost_reduction')
      .sort((a, b) => (b.benefit.amountCents ?? 0) - (a.benefit.amountCents ?? 0));
    const leaveOut = (item: (typeof listed)[number], reason: string) => {
      item.benefit.counted = false;
      item.benefit.explanation = `${item.translated.what} ${t('notCounted', { reason })}`;
    };
    for (const item of taxCuts.slice(1)) leaveOut(item, t('reasonAnotherRate'));
    // The cautious figure differs from the plain one only when something was in fact left out.
    const leftOut =
      cautious === 'no'
        ? []
        : [
            ...listed.filter(entry => entry.benefit.counted),
            ...(cautious === 'all' && candidate
              ? listed.filter(entry => entry.benefit.policyId === candidate.result.id)
              : []),
          ];
    for (const item of leftOut.filter(entry => entry.benefit.counted)) leaveOut(item, leftOutReason);

    const outcome = {
      when,
      settled: why === 'no_day' || leftOut.length === 0,
      noDay: why === 'no_day',
      held: false,
      applied,
      possiblyLower,
      standardCents,
      baselineCents,
      standardLabel,
    };
    const shared = { ...outcome, aboveFirstBracket, tax, benefits: listed.map(item => item.benefit) };
    if (
      baselineCents === null ||
      depositCents === null ||
      feesCents === null ||
      availableCents === null ||
      monthlyCents === null
    )
      return { ...shared, upfrontCents: null, months: null };

    const upfrontCents = depositCents + baselineCents + feesCents;
    if (!withPlace)
      return { ...shared, upfrontCents, months: monthsToTarget(upfrontCents - availableCents, monthlyCents) };

    const counted = () => listed.filter(item => item.benefit.counted);
    const sumOf = (timing: Timing, kind: PlaceBenefit['kind']) =>
      counted()
        .filter(item => item.translated.timing === timing && item.benefit.kind === kind)
        .reduce((total, item) => total + (item.benefit.amountCents ?? 0), 0);
    const atPurchaseCents = sumOf('at_purchase', 'upfront_cost_reduction') + sumOf('at_purchase', 'one_off_cash');
    const placeUpfrontCents = Math.max(0, upfrontCents - atPurchaseCents);
    const remaining = placeUpfrontCents - availableCents;
    // Cash that arrives a tax year after the move cannot help a purchase that happens before it arrives.
    const withoutDelayed = monthsToTarget(remaining, monthlyCents);
    if (withoutDelayed !== null && withoutDelayed <= taxReturnDelayMonths)
      for (const item of counted().filter(entry => entry.translated.timing === 'while_living_there'))
        leaveOut(
          item,
          withoutDelayed === 0
            ? t('reasonAlreadyHaveCash')
            : t('reasonBuyBefore', { months: withoutDelayed, delay: taxReturnDelayMonths }),
        );
    const delayed: DelayedCash = {
      lumpCents: sumOf('while_living_there', 'one_off_cash'),
      annual: counted()
        .filter(item => item.translated.timing === 'while_living_there' && item.benefit.kind === 'annual_cash')
        // Rounded down: a yearly amount spread over twelve months never counts for more than it is.
        .map(item => ({
          monthlyCents: Math.floor((item.benefit.amountCents ?? 0) / 12),
          maxYears: item.translated.maxYears,
        })),
    };
    return {
      ...shared,
      upfrontCents: placeUpfrontCents,
      months: monthsWithDelayedCash(remaining, monthlyCents, delayed),
    };
  };

  /**
   * A timeline that turned out to have no purchase day on a day other than the plan date: the
   * screening on the plan date gave a number of months, and on the day that number leads to a benefit
   * no longer holds and the upfront cash is beyond the horizon. There is no later day either, because
   * the cautious upfront cash (general tax, no benefit) is the largest there is. The result is that
   * cautious figure with the benefits as screened on the plan date, each saying so.
   */
  const withoutDay = (monthlyCents: number | null, withPlace: boolean): Outcome => ({
    ...evaluate(0, monthlyCents, withPlace, 'all', 'no_day'),
    months: null,
  });
  /**
   * Find the purchase day on which the timeline and what is counted agree.
   *
   * It starts on the plan date and re-screens on the day each result gives, until that day stops
   * moving. A timeline without a finite number of months has no purchase day: it is screened on the
   * plan date (`withoutDay` when a later round found that out). If the day keeps moving after
   * `maxSettleRounds` rounds, the cautious timeline is returned: the general transfer tax and no
   * benefit, screened on its own purchase day.
   *
   * Every finite result is screened on its own day: `months === when.months`.
   */
  const settle = (monthlyCents: number | null): Outcome => {
    let outcome = evaluate(0, monthlyCents, false);
    for (let round = 0; round <= maxSettleRounds; round++) {
      if (outcome.months === null) return outcome.when.months === 0 ? outcome : withoutDay(monthlyCents, false);
      if (outcome.months === outcome.when.months) return outcome;
      if (round < maxSettleRounds) outcome = evaluate(outcome.months, monthlyCents, false);
    }
    const cautious = evaluate(0, monthlyCents, false, 'all');
    return evaluate(cautious.months ?? 0, monthlyCents, false, 'all');
  };
  /**
   * The timeline with habits. Saving more never gives a later day: on the baseline's day the cash of
   * the baseline is there, and with habits there is more. So when the search with the higher savings
   * settles later than the baseline, or not at all (an earlier day can lose a rate that only starts
   * later), the timeline is held at the baseline's day, screened as the baseline is.
   */
  const settleHabits = (monthlyCents: number | null, baseline: Outcome): Outcome => {
    const outcome = settle(monthlyCents);
    const later = baseline.months !== null && (outcome.months === null || outcome.months > baseline.months);
    if (!later) return outcome;
    const cautious = baseline.settled ? 'no' : 'all';
    return { ...evaluate(baseline.when.months, monthlyCents, false, cautious), months: baseline.months, held: true };
  };
  /**
   * The same search with the benefits of the place counted. `without` is the settled timeline with
   * the same monthly savings and no place benefit. When the day does not settle, or settles later
   * than `without` (a place never lengthens the wait), the place's benefits are left out and the
   * timeline is `without`, screened on its day.
   */
  const settleWithPlace = (monthlyCents: number | null, without: Outcome): Outcome => {
    let outcome = evaluate(0, monthlyCents, true);
    for (let round = 0; round < maxSettleRounds && outcome.months !== null; round++) {
      if (outcome.months === outcome.when.months) break;
      outcome = evaluate(outcome.months, monthlyCents, true);
    }
    const agreed = outcome.months === null || outcome.months === outcome.when.months;
    const longer = without.months !== null && (outcome.months === null || outcome.months > without.months);
    if (agreed && !longer)
      return outcome.months === null && outcome.when.months !== 0 ? withoutDay(monthlyCents, true) : outcome;
    if (without.noDay) return withoutDay(monthlyCents, true);
    const cautious = without.settled ? 'place' : 'all';
    // Without the place's benefits the upfront cash is that of `without`, and so is the day.
    return { ...evaluate(without.when.months, monthlyCents, true, cautious), months: without.months };
  };

  const withHabitsMonthly = monthly === null ? null : monthly + habits.monthlyCents;
  const baselineOutcome = settle(monthly);
  const habitsOutcome = habits.monthlyCents === 0 ? baselineOutcome : settleHabits(withHabitsMonthly, baselineOutcome);
  const placeOutcome = settleWithPlace(withHabitsMonthly, habitsOutcome);

  const { applied, possiblyLower, baselineCents, tax } = baselineOutcome;
  if (possiblyLower.length)
    dataMissing.push(
      t('missingGeneralRates', {
        ids: possiblyLower.map(({ result }) => result.id).join(', '),
        baseline: tax.baselineLabel,
        rate: percent(Math.min(...possiblyLower.map(({ rate }) => rate))),
      }),
    );
  const transferTax =
    standardCents === null || baselineCents === null
      ? null
      : {
          standardCents,
          baselineCents,
          baselinePolicyId: applied?.result.id ?? null,
          couldBeLower: possiblyLower.length > 0,
        };
  // An upfront target the person stated is shown beside the computed figure; it never replaces it.
  const statedTarget = finances.targetCashCents ?? null;
  const computedUpfront = baselineOutcome.upfrontCents;
  const upfrontTarget =
    statedTarget === null
      ? {}
      : {
          upfrontTarget: {
            statedCents: statedTarget,
            computedCents: computedUpfront,
            differenceCents: computedUpfront === null ? null : statedTarget - computedUpfront,
            usedByTimeline: 'computed' as const,
          },
        };
  if (statedTarget !== null) {
    const figures = { target: euros(statedTarget), computed: euros(computedUpfront ?? 0), place: place.name };
    const difference = computedUpfront === null ? 0 : statedTarget - computedUpfront;
    assumptions.push(
      computedUpfront === null
        ? t('targetNoComputed', figures)
        : difference > 0
          ? t('targetHigher', { ...figures, difference: euros(difference) })
          : difference < 0
            ? t('targetLower', { ...figures, difference: euros(-difference) })
            : t('targetEqual', figures),
    );
  }
  if (noPlace) assumptions.push(t('assumeNoPlace'));
  const base = { place, ...price, benefits: placeOutcome.benefits, transferTax, ...upfrontTarget };
  if (
    priceCents === null ||
    standard === null ||
    baselineCents === null ||
    depositCents === null ||
    feesCents === null ||
    availableCents === null ||
    monthly === null ||
    withHabitsMonthly === null ||
    baselineOutcome.upfrontCents === null ||
    habitsOutcome.upfrontCents === null ||
    placeOutcome.upfrontCents === null
  ) {
    return {
      ...base,
      status: 'insufficient_data',
      estimatedPurchaseDate: null,
      baseline: null,
      withHabits: null,
      withPlaceBenefits: null,
      monthsSaved: null,
      monthsSavedByHabits: null,
      monthsSavedByPlace: null,
      assumptions,
      dataMissing,
    };
  }

  const baseline: Timeline = {
    upfrontCashCents: baselineOutcome.upfrontCents,
    monthlySavingsCents: monthly,
    months: baselineOutcome.months,
  };
  const withHabits: Timeline = {
    upfrontCashCents: habitsOutcome.upfrontCents,
    monthlySavingsCents: withHabitsMonthly,
    months: habitsOutcome.months,
  };
  const withPlaceBenefits: Timeline = {
    upfrontCashCents: placeOutcome.upfrontCents,
    monthlySavingsCents: withHabitsMonthly,
    months: placeOutcome.months,
  };
  const months = withPlaceBenefits.months;

  const monthlyFigures = { amount: euros(monthly), basis: t(`basis.${finances.basis}`) };
  assumptions.push(
    t('assumeUpfront', {
      depositRate: percent(home.depositRate),
      deposit: euros(depositCents),
      baseline: tax.baselineLabel,
      tax: euros(baselineCents),
      feesRate: percent(options.purchaseFeesRate),
      fees: euros(feesCents),
      total: euros(baselineOutcome.upfrontCents),
    }),
    applied
      ? t('assumeBaselineApplied', {
          rate: percent(applied.rate),
          standard: standardLabel,
          title: applied.result.title,
        })
      : possiblyLower.length
        ? t('assumeBaselinePossiblyLower', { standard: standardLabel })
        : t('assumeBaselineStandard', { standard: standardLabel }),
    finances.emergencyReserveCents > 0
      ? t('assumeSavingsReserve', {
          available: euros(availableCents),
          reserve: euros(finances.emergencyReserveCents),
        })
      : t('assumeSavingsNoReserve', { available: euros(availableCents) }),
    finances.asOf
      ? t('assumeMonthlyAsOf', { ...monthlyFigures, asOf: date(finances.asOf) })
      : t('assumeMonthly', monthlyFigures),
  );
  if (aboveFirstBracket && standard?.standardTariff)
    assumptions.push(
      t('assumeTariff', {
        threshold: euros(firstBracketEndCents(standard) ?? 0),
        steps: standard.standardTariff
          .map(bracket => t('tariffStep', { rate: percent(bracket.rate), amount: euros(bracket.fromEur * 100) }))
          .join(', '),
        tax: euros(standardCents ?? 0),
      }),
    );
  if (habits.counted.length)
    assumptions.push(t('assumeHabitsCounted', { count: habits.counted.length, amount: euros(habits.monthlyCents) }));
  if (habits.withheld.length) {
    const withheld = { count: habits.withheld.length, titles: habits.withheld.map(habit => habit.title).join(', ') };
    assumptions.push(
      finances.asOf
        ? t('assumeHabitsWithheldUpTo', { ...withheld, asOf: date(finances.asOf) })
        : t('assumeHabitsWithheld', withheld),
    );
  }
  if (options.includeProposedHabits) assumptions.push(t('assumeProposed'));

  const purchaseDay = (outcome: Outcome) =>
    outcome.months === null
      ? t('purchaseDayNone')
      : t('purchaseDayOn', { date: date(outcome.when.date), months: outcome.months, asOf: date(asOf) });
  assumptions.push(
    noPlace
      ? t('assumeScreeningNoPlace', { baseline: purchaseDay(baselineOutcome), asOf: date(asOf) })
      : t('assumeScreening', {
          place: purchaseDay(placeOutcome),
          baseline: purchaseDay(baselineOutcome),
          asOf: date(asOf),
        }),
  );
  if (placeOutcome.applied?.result.id !== applied?.result.id)
    assumptions.push(t('assumeTaxDiffers', { baseline: tax.baselineLabel, place: placeOutcome.tax.baselineLabel }));
  if (habitsOutcome.held) assumptions.push(t('assumeHeld', { date: date(habitsOutcome.when.date) }));
  /** The names of the timelines for which `is` holds, each once, as a list. */
  const timelines = (is: (outcome: Outcome) => boolean) =>
    [
      ...new Set([
        ...(is(baselineOutcome) ? [t('timelineBaseline')] : []),
        ...(is(habitsOutcome) ? [t('timelineHabits')] : []),
        ...(is(placeOutcome) ? [t('timelinePlace')] : []),
      ]),
    ].join(', ');
  const dayless = timelines(outcome => outcome.noDay);
  if (dayless) assumptions.push(t('assumeNoDay', { timelines: dayless, asOf: date(asOf) }));
  const unsettled = timelines(outcome => !outcome.settled);
  if (unsettled) assumptions.push(t('assumeUnsettled', { timelines: unsettled }));
  const beyond = (timeline: Timeline) =>
    timeline.months === null && timeline.monthlySavingsCents > 0 && timeline.upfrontCashCents > availableCents;
  if (beyond(withPlaceBenefits) || beyond(baseline)) {
    const horizon = { months: maxPlanningMonths, years: maxPlanningMonths / 12 };
    assumptions.push(
      beyond(withPlaceBenefits)
        ? t('assumeBeyond', { ...horizon, amount: euros(withPlaceBenefits.monthlySavingsCents) })
        : t('assumeBeyondBaseline', { ...horizon, amount: euros(baseline.monthlySavingsCents) }),
    );
  }
  if (!noPlace)
    assumptions.push(
      options.includeUnverifiedBenefits ? t('assumeUnverifiedCounted') : t('assumeOnlyVerified'),
      t('assumeTiming'),
    );

  return {
    ...base,
    status:
      months === 0
        ? 'target_reached'
        : months !== null
          ? 'estimated'
          : beyond(withPlaceBenefits)
            ? 'beyond_horizon'
            : 'no_positive_savings',
    estimatedPurchaseDate: months === null ? null : placeOutcome.when.date,
    baseline,
    withHabits,
    withPlaceBenefits,
    monthsSaved: difference(baseline, withPlaceBenefits),
    monthsSavedByHabits: difference(baseline, withHabits),
    monthsSavedByPlace: difference(withHabits, withPlaceBenefits),
    assumptions,
    dataMissing,
  };
}

/**
 * Plan the same person against several places.
 *
 * `asOf` is the plan date (`assumptions.asOf` overrides it). Plans come back sorted by the shortest
 * finite timeline with place benefits; places without a finite timeline keep their input order last.
 * The general transfer tax (rate and, when stated, tariff by value) is read from the policies whose
 * effect is `transfer_tax_rate`; when the policies do not state it, no rate is invented and every plan
 * is `insufficient_data`.
 */
export function planForPlaces(
  person: PersonInput,
  places: Place[],
  policies: Policy[],
  assumptions: z.input<typeof planAssumptions> | undefined,
  asOf: string,
  locale: Locale = defaultLocale,
): PlanResult {
  const options = planAssumptions.parse(assumptions ?? {});
  const date = options.asOf ?? asOf;
  // Ages are derived from dates of birth on the plan date, and the result states them.
  const who = withDerivedAges(inlinePerson(person), date);
  if (!places.length) return planWithoutPlace(who, policies, options, date, locale);
  const { plans: unsorted, habits } = planPlaces(who, places, policies, options, date, locale);
  // What is known, what disagrees and what is still worth asking, for the places compared.
  const facts = factsOf(who, places, policies, options, date, unsorted, locale);
  const order = (plan: PlacePlan) => plan.withPlaceBenefits?.months ?? Number.POSITIVE_INFINITY;
  const plans = unsorted
    .map(plan => (facts.reliedOn ? { ...plan, assumptions: [...plan.assumptions, facts.reliedOn] } : plan))
    .map((plan, index) => ({ plan, index }))
    .sort((a, b) => {
      const [left, right] = [order(a.plan), order(b.plan)];
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map(({ plan }) => plan);
  return planResult.parse({
    person: who,
    asOf: date,
    nextQuestions: facts.nextQuestions,
    knownFacts: facts.knownFacts,
    conflicts: facts.conflicts,
    habits: habits.effects,
    plans,
    limitations: planLimitationsIn(locale),
  });
}

/** The code of the stand-in for "anywhere in Catalonia"; no municipality has it and no result carries it. */
const anywhereCode = '000000';

/**
 * The plan when no place is chosen: valid, with no place plans. It says what the person would need
 * anywhere in Catalonia (`withoutPlace`: priced from a budget only, no benefit of a place), which
 * questions about the person are worth asking (what a timeline needs first, then the facts that
 * decide a Catalonia-wide rate, then the assumed defaults) and that a place is still to be chosen
 * (`placeQuestion`). The arithmetic is `planOne` on a stand-in that is in no rural category and
 * publishes no price, so nothing here is a second rule.
 */
function planWithoutPlace(
  who: Person,
  policies: Policy[],
  options: Assumptions,
  date: string,
  locale: Locale,
): PlanResult {
  const words = wordsFor(locale);
  const { t } = words;
  const name = t('anywhereName');
  const anywhere: Place = {
    municipalityCode: anywhereCode,
    name,
    comarca: name,
    rural: 'not_listed',
    centre: { latitude: 0, longitude: 0 },
    indicators: {
      population: null,
      densityPerKm2: null,
      foreignPopulationPercent: null,
      resaleEurPerM2: null,
      rentEurPerMonth: null,
    },
    services: [],
    dataMissing: [],
  };
  const { plans, habits } = planPlaces(who, [anywhere], policies, options, date, locale, true);
  const facts = factsOf(who, [anywhere], policies, options, date, plans, locale);
  const {
    place: _place,
    withPlaceBenefits: _withPlace,
    monthsSaved: _saved,
    monthsSavedByPlace: _byPlace,
    estimatedPurchaseDate: _day,
    ...rest
  } = plans[0];
  const withoutPlace: AnywherePlan = {
    ...rest,
    // Only what applies wherever the person buys; a place's own measures are screened once one is chosen.
    benefits: rest.benefits.filter(benefit => benefit.scope === 'anywhere'),
    assumptions: facts.reliedOn ? [...rest.assumptions, facts.reliedOn] : rest.assumptions,
  };
  return planResult.parse({
    person: who,
    asOf: date,
    // The stand-in is not a municipality: an effect names Catalonia and carries no code.
    nextQuestions: facts.nextQuestions.map(question => ({
      ...question,
      effect: { ...question.effect, municipalityCode: null },
    })),
    knownFacts: facts.knownFacts,
    conflicts: facts.conflicts,
    habits: habits.effects,
    plans: [],
    withoutPlace,
    placeQuestion: {
      inputPath: 'location.selectedMunicipalityCode',
      label: t('placeLabel'),
      question: t('placeQuestion'),
      why: t('placeWhy'),
      suggestTool: 'recommend_towns',
    },
    limitations: planLimitationsIn(locale),
  });
}

/**
 * The plans of one person for several places, in the order of `places`, without the questions.
 * `person` is already parsed and carries the ages of the plan date. `missingFacts` calls this to try
 * an answer; everything else goes through `planForPlaces`.
 */
export function planPlaces(
  who: Person,
  places: Place[],
  policies: Policy[],
  options: Assumptions,
  date: string,
  locale: Locale = defaultLocale,
  noPlace = false,
): { plans: PlacePlan[]; habits: HabitSavings } {
  const words = wordsFor(locale);
  const taxEffects = policies.flatMap(policy => (policy.effect?.kind === 'transfer_tax_rate' ? [policy.effect] : []));
  // The tariff by value, when a policy states it, is more complete than the single rate.
  const taxEffect = taxEffects.find(effect => effect.standardTariff) ?? taxEffects[0];
  const standard: StandardTax | null = taxEffect
    ? { standardRate: taxEffect.standardRate, standardTariff: taxEffect.standardTariff }
    : null;
  // What the habits add is the same for every place: it depends on the person only.
  const habits = habitSavings(who, options.includeProposedHabits, words);
  return {
    plans: places.map(place => planOne(who, place, policies, options, date, standard, habits, words, noPlace)),
    habits,
  };
}
