import type { z } from 'zod';
import type { eligibility, Municipality, Policy } from '../contracts/places.ts';
import type { Person, Place, PlaceBenefit, PlacePlan, PlanResult } from '../contracts/planner.ts';
import { person as personSchema, planAssumptions, planResult } from '../contracts/planner.ts';
import { maxPlanningMonths, monthsToTarget } from '../finance/savings.ts';
import { callStatusOn, evaluateIncentives } from '../places/eligibility.ts';

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
 * An age is a whole number of years on the plan date and the birthday is unknown, so after m months
 * a person is `age + floor(m / 12)` or one year more. A condition that holds for one and fails for the
 * other is unverified, never assumed. Tax bases, family status and the rules are assumed unchanged.
 *
 * The three timelines (baseline, with habits, with place benefits) each settle on their own purchase
 * day, so a faster timeline can keep a rate that a slower one loses with age.
 */
type Eligibility = z.infer<typeof eligibility>;
type Household = NonNullable<Person['household']>;
type Timeline = NonNullable<PlacePlan['baseline']>;
type Assumptions = z.infer<typeof planAssumptions>;
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
const unsettledReason =
  'whether it applies depends on the day you could buy, and that day depends on whether it is counted. The two did not settle, so the plan takes the cautious figure and leaves it out.';

export const planLimitations = [
  'This is an arithmetic estimate from the figures supplied. It is not a mortgage offer, a credit assessment or a promise that a lender will approve a loan.',
  'No aid, grant or tax benefit is guaranteed. Benefits are screened against the rules in the dated policy snapshot and must be confirmed with the Catalan Tax Agency or the housing agency before relying on them.',
  'Prices are published municipal or comarca averages per square metre, not actual listings. The timeline assumes constant income, expenses and prices, with no interest or inflation.',
  `Months are rounded up. Zero, negative or unknown monthly savings give no timeline rather than a misleading number, and neither does a target more than ${maxPlanningMonths} months away.`,
  'Benefits tied to the purchase are screened on the estimated purchase day, with ages advanced to it. Tax bases, family status and the rules themselves are assumed to stay as they are on the plan date; the rules on the actual purchase day may differ.',
];

function euros(cents: number): string {
  return `€${(cents / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
}

function percent(rate: number): string {
  return `${Math.round(rate * 10_000) / 100}%`;
}

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

/** "46", or "46 or 47" when the birthday decides. */
function ageRange(age: number, months: number): string {
  const [low, high] = [age + Math.floor(months / 12), age + Math.ceil(months / 12)];
  return low === high ? `${low}` : `${low} or ${high}`;
}

/** The ages on the purchase day, as a sentence; empty when no age is known or the day is the plan date. */
function agesOn(facts: Household | undefined, months: number): string {
  if (!facts || months === 0) return '';
  const children = facts.children ?? [];
  const parts = [
    ...(facts.age === undefined ? [] : [`you would be ${ageRange(facts.age, months)}`]),
    ...(children.length
      ? [
          `your ${children.length === 1 ? 'child' : 'children'} would be ${children.map(child => ageRange(child.age, months)).join(', ')}`,
        ]
      : []),
  ];
  return parts.length ? `By then ${parts.join(' and ')}.` : '';
}

/**
 * One screening for the two ages a person can have on a future day. The same answer for both is the
 * answer; different answers mean the birthday decides, which is unverified.
 */
function mergeAges(youngest: Eligibility, oldest: Eligibility, date: string): Eligibility {
  const missing = [...new Set([...oldest.missingCriteria, ...youngest.missingCriteria])];
  if (youngest.eligibilityStatus === oldest.eligibilityStatus) return { ...oldest, missingCriteria: missing };
  return {
    ...oldest,
    eligibilityStatus: 'needs_verification',
    screenedAmountEur: undefined,
    unmetCriteria: [],
    missingCriteria: [
      `Whether an age limit is still met on ${date} depends on birthdays this plan does not know.`,
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
 * When the monthly figures were observed in bank movements (`bank_observed` or `mixed`), an active
 * habit that was already running during the observed period is inside those figures. It counts on
 * top of them only when `startedOn` is after `finances.asOf`, the end of the observed period. An
 * active habit without a start date, or a bank basis without a period end, is `withheld`: shown, not
 * counted. A proposed habit has not started, so it is never inside the observed figures.
 */
function habitSavings(person: Person, includeProposed: boolean) {
  const { basis, asOf } = person.finances;
  const observed = basis === 'bank_observed' || basis === 'mixed';
  const quantified = person.habits.filter(habit => habit.monthlySavingCents !== null);
  const active = quantified.filter(habit => habit.status === 'active');
  const afterPeriod = (habit: Person['habits'][number]) =>
    asOf !== null && habit.startedOn !== undefined && habit.startedOn > asOf;
  const withheld = observed ? active.filter(habit => !afterPeriod(habit)) : [];
  const counted = [
    ...active.filter(habit => !withheld.includes(habit)),
    ...(includeProposed ? quantified.filter(habit => habit.status === 'proposed') : []),
  ];
  // Rounded down per habit: a partly kept habit never counts for more than it saved.
  const monthlyCents = counted.reduce(
    (total, habit) => total + Math.floor((habit.monthlySavingCents ?? 0) * (habit.adherence ?? 1)),
    0,
  );
  return { counted, withheld, monthlyCents };
}

/** Turn a screened policy into the kind, amount and timing of a benefit for this price and place. */
function translate(result: Eligibility, place: Place, priceCents: number | null, tax: TaxReference): Translated {
  const effect = result.effect;
  const livingThere = result.intent === 'move' || result.intent === 'rent';
  const none = { amountCents: null, maxYears: null };
  if (!effect || effect.kind === 'unquantified') {
    const reason = effect ? effect.reason : 'the amount is not modelled';
    return { ...none, kind: 'unquantified', timing: 'not_applicable', what: `Not quantified: ${reason}.` };
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
          ? 'A reduced transfer-tax rate may apply, depending on the nucleus where the home is.'
          : everywhere
            ? `Transfer tax at ${percent(reduced)} instead of ${tax.standardLabel}, in any municipality of Catalonia.`
            : `Transfer tax at ${percent(reduced)} instead of ${tax.baselineLabel}.`;
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
        what: `A single payment of at most the lower of ${euros(capCents)} and ${percent(effect.rate)} of the price.`,
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
        what: 'A single payment or deduction.',
      };
    }
    case 'annual_eur': {
      const eur = forCategory(effect.amount, place.rural);
      return {
        kind: 'annual_cash',
        amountCents: eur === null ? null : Math.round(eur * 100),
        maxYears: effect.maxYears,
        timing: livingThere ? 'while_living_there' : 'after_purchase',
        what: `A yearly amount${effect.maxYears ? ` for at most ${effect.maxYears} years` : ''}.`,
      };
    }
    case 'annual_rate_of_cost': {
      // The base is what the household actually pays each year, which the person entity does not hold,
      // so the amount stays unknown and is never counted.
      const rate = forCategory(effect.rate, place.rural);
      const cost = { purchase_payments: 'home-purchase payments', rent: 'rent paid', renovation: 'renovation costs' };
      const base = effect.maxBaseEur === undefined ? '' : `, on at most ${euros(effect.maxBaseEur * 100)} a year`;
      const cap = effect.maxAmountEur
        ? `, capped at ${euros(effect.maxAmountEur.individual * 100)} a year (${euros(effect.maxAmountEur.joint * 100)} on a joint return)`
        : '';
      return {
        ...none,
        kind: 'annual_cash',
        timing: livingThere ? 'while_living_there' : 'after_purchase',
        what: `${rate === null ? 'A yearly share' : `${percent(rate)} a year`} of ${cost[effect.cost]}${base}${cap}. The amount depends on what you actually pay, which this plan does not know.`,
      };
    }
  }
}

const eligibilityRank = { ineligible: 0, needs_verification: 1, eligible: 2 } as const;

/**
 * Why a benefit that holds on the plan date does not hold on the purchase day, in plain language.
 * Null when the purchase day is the plan date or the screening there is no worse than today's.
 */
function lostBy({ result, today, atPurchase }: Screened, when: When): string | null {
  // Something that does not apply on the plan date either was never there to lose.
  if (!atPurchase || when.months === 0 || today.eligibilityStatus === 'ineligible') return null;
  const day = `${when.date}, the day you could buy (${when.months} months after the plan date)`;
  if (result.measureStatus !== 'active' && today.measureStatus === 'active')
    return `the measure is in force until ${result.effectiveThrough} and is not confirmed for ${day}.`;
  if (eligibilityRank[result.eligibilityStatus] >= eligibilityRank[today.eligibilityStatus]) return null;
  const ages = when.ages ? ` ${when.ages}` : '';
  return result.eligibilityStatus === 'ineligible'
    ? `it applies if you buy on the plan date, but not on ${day}.${ages} Criteria not met by then: ${result.unmetCriteria.join(' ')}`
    : `it applies if you buy on the plan date, but it is not certain on ${day}.${ages} To verify: ${result.missingCriteria.join(' ')}`;
}

/** Decide whether a translated benefit is counted, and say why in plain language. */
function benefitFor(
  screened: Screened,
  translated: Translated,
  person: Person,
  place: Place,
  options: Assumptions,
  when: When,
): PlaceBenefit {
  const { result } = screened;
  const { amountCents, timing, what } = translated;
  const unverified = result.eligibilityStatus === 'needs_verification';
  const lost = lostBy(screened, when);
  const eventDay = screened.atPurchase ? when.date : 'the plan date';
  let blocker: string | null = null;
  if (result.geographicStatus === 'does_not_apply' || result.eligibilityStatus === 'ineligible') {
    blocker = lost ? `Not counted: ${lost}` : `Not counted, criteria not met: ${result.unmetCriteria.join(' ')}`;
  } else if (result.callStatus === 'closed') {
    blocker = 'Not counted: the application call is closed.';
  } else if (result.callStatus === 'upcoming') {
    blocker = 'Not counted: the application call has not opened yet.';
  } else if (result.callWindow === null) {
    blocker = 'Not counted: no application call could be verified, so this aid cannot be claimed yet.';
  } else if (timing === 'at_purchase' && result.callStatus === 'open' && callStatusOn(result, when.date) !== 'open') {
    // An open call only helps a purchase that happens while it is open; a later call is not known.
    blocker = `Not counted: the application call is open today but closes before ${when.date}, the day you could buy, and no later call is known.`;
  } else if (result.measureStatus !== 'active') {
    blocker = lost
      ? `Not counted: ${lost}`
      : `Not counted: the measure is not confirmed to be in force on ${eventDay}.`;
  } else if (result.geographicStatus !== 'applies') {
    blocker = `Not counted until verified: ${result.missingCriteria.join(' ')}`;
  } else if (unverified && !options.includeUnverifiedBenefits) {
    blocker = lost
      ? `Not counted: ${lost}`
      : `Shown but not counted until verified: ${result.missingCriteria.join(' ')}`;
  } else if (amountCents === null) {
    blocker = 'Not counted: the amount cannot be computed from the facts known.';
  } else if (amountCents === 0) {
    blocker = 'Not counted: it brings no reduction for this place.';
  } else if (timing === 'after_purchase') {
    blocker =
      'Not counted: it is received after the purchase (with a later tax return), so it does not shorten the time needed to gather the upfront cash. It lowers costs afterwards.';
  } else if (timing === 'while_living_there' && person.currentMunicipalityCode === place.municipalityCode) {
    blocker =
      'Not counted: you already live here, so if you receive it, it is already part of your income and savings.';
  }
  const counted = blocker === null && amountCents !== null;
  const caveat = unverified ? ' Counted at your request although eligibility is not verified.' : '';
  const how =
    timing === 'at_purchase'
      ? `Counted: lowers the upfront cash needed by ${euros(amountCents ?? 0)}.`
      : translated.kind === 'annual_cash'
        ? `Counted as ${euros(Math.floor((amountCents ?? 0) / 12))} of extra monthly savings from month ${taxReturnDelayMonths + 1}, assuming you move here on the plan date and buy later.`
        : `Counted as ${euros(amountCents ?? 0)} received after ${taxReturnDelayMonths} months, assuming you move here on the plan date and buy later.`;
  return {
    policyId: result.id,
    title: result.title,
    kind: translated.kind,
    amountCents,
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
  unsettled: boolean,
): PlaceBenefit {
  const { result } = screened;
  const { amountCents, what } = translated;
  const lost = lostBy(screened, when);
  let outcome: string;
  if (result === applied) {
    outcome = `Applied to your baseline: it lowers the upfront cash by ${euros(amountCents ?? 0)} wherever you buy in Catalonia, so it is not counted as a saving of this place.`;
  } else if (lost) {
    outcome = `Not applied: ${lost}`;
  } else if (result.eligibilityStatus === 'ineligible') {
    outcome = `Not applied, criteria not met: ${result.unmetCriteria.join(' ')}`;
  } else if (result.measureStatus !== 'active') {
    outcome = `Not applied: the measure is not confirmed to be in force on ${when.date}.`;
  } else if (result.eligibilityStatus === 'needs_verification') {
    outcome = `Not applied to your baseline until verified: ${result.missingCriteria.join(' ')}${isLower ? ' If you qualify, you pay less transfer tax everywhere, and the transfer-tax saving of this place is smaller than shown.' : ''}`;
  } else if (unsettled) {
    outcome = `Not applied: ${unsettledReason}`;
  } else if (applied !== null) {
    outcome = 'Not applied: another reduced rate is already your baseline, and reduced rates do not add up.';
  } else {
    outcome = 'Not applied: it is not lower than the general transfer tax on this price.';
  }
  return {
    policyId: result.id,
    title: result.title,
    kind: translated.kind,
    amountCents,
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
): PlacePlan {
  const { finances, home } = person;
  const assumptions: string[] = [];
  const dataMissing: string[] = [];
  const price = priceFor(person, place);
  const priceCents = price.purchasePriceCents;

  if (price.priceBasis === 'budget') assumptions.push(`The price is your stated budget of ${euros(priceCents ?? 0)}.`);
  else if (priceCents === null) {
    if (home.budgetCents !== null) dataMissing.push('person.home.budgetCents (must be greater than zero)');
    else {
      if (home.floorAreaM2 === null) dataMissing.push('person.home.floorAreaM2 or person.home.budgetCents');
      if (!((place.indicators.resaleEurPerM2?.value ?? 0) > 0))
        dataMissing.push(`resale price per m² for ${place.name}`);
    }
  } else {
    const resale = place.indicators.resaleEurPerM2;
    const scope = price.priceBasis === 'comarca_eur_per_m2' ? `the ${place.comarca} comarca average` : place.name;
    assumptions.push(
      `The price is ${home.floorAreaM2} m² × ${euros((resale?.value ?? 0) * 100)}/m² for ${scope} (${resale?.observedAt}) = ${euros(priceCents)}. It is an average of past sales, not a listing.`,
    );
    if (price.priceBasis === 'comarca_eur_per_m2')
      dataMissing.push(`municipal resale price per m² for ${place.name} (comarca average used)`);
  }
  if (standard === null) dataMissing.push('standard transfer-tax rate (no policy in the snapshot states it)');
  if (finances.currentSavingsCents === null) dataMissing.push('person.finances.currentSavingsCents');
  if (finances.monthlyIncomeCents === null) dataMissing.push('person.finances.monthlyIncomeCents');
  if (finances.monthlyExpensesCents === null) dataMissing.push('person.finances.monthlyExpensesCents');

  // ------------------------------------------------------------ screening
  const town = asMunicipality(place);
  const considered = policies.filter(policy => screenedIntents.has(policy.intent));
  const buyPolicies = considered.filter(policy => policy.intent === 'buy');
  const livingPolicies = considered.filter(policy => policy.intent !== 'buy');
  // The price cap of an aid is checked against the price of this plan, not a separately stated one.
  const facts: Household | undefined =
    priceCents === null ? person.household : { ...person.household, purchasePriceEur: priceCents / 100 };
  const screenOn = (list: Policy[], eventDate: string, household: Household | undefined) =>
    evaluateIncentives(list, town, { municipalityCode: place.municipalityCode, eventDate, household }, asOf);
  // A move or a rental is assumed to start on the plan date, with everyone as old as they are today.
  const living = screenOn(livingPolicies, asOf, facts);
  const buyScreenings = new Map<number, Eligibility[]>();
  /** Buy-side policies screened `months` after the plan date, for both ages a birthday allows. */
  const screenBuy = (months: number): Eligibility[] => {
    const cached = buyScreenings.get(months);
    if (cached) return cached;
    const date = addMonths(asOf, months);
    const [low, high] = [Math.floor(months / 12), Math.ceil(months / 12)];
    const youngest = screenOn(buyPolicies, date, facts && older(facts, low));
    const oldest = low === high || !facts ? youngest : screenOn(buyPolicies, date, older(facts, high));
    const merged = youngest.map((result, index) =>
      oldest === youngest ? result : mergeAges(result, oldest[index], date),
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
      ? 'the general rate'
      : aboveFirstBracket && standardCents !== null && priceCents
        ? `the general tariff (${euros(standardCents)}, an average of ${percent(standardCents / priceCents)} on this price)`
        : `the general ${percent(standard.standardRate)}`;
  const depositCents = priceCents === null ? null : share(home.depositRate, priceCents);
  const feesCents = priceCents === null ? null : share(options.purchaseFeesRate, priceCents);

  /**
   * One timeline with the purchase screened `months` after the plan date.
   * `withPlace`: the benefits of the place lower the upfront cash and add delayed cash.
   * `cautious`: the purchase day did not settle, so benefits are left out. `place` leaves out what the
   * place offers and keeps the baseline rate; `all` also falls back to the general transfer tax.
   */
  const evaluate = (
    months: number,
    monthlyCents: number | null,
    withPlace: boolean,
    cautious: 'no' | 'place' | 'all' = 'no',
  ): Outcome => {
    const when: When = { months, date: addMonths(asOf, months), ages: agesOn(person.household, months) };
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
        ? `the ${percent(applied.rate)} you already qualify for anywhere in Catalonia (${applied.result.title})`
        : standardLabel,
    };

    const listed = screened.map(item => {
      const translated = translate(item.result, place, priceCents, tax);
      const benefit = isGeneralRate(item.result)
        ? generalRateBenefit(
            item,
            translated,
            applied?.result ?? null,
            possiblyLower.some(entry => entry.result === item.result),
            when,
            cautious === 'all' && candidate?.result === item.result,
          )
        : benefitFor(item, translated, person, place, options, when);
      return { translated, benefit };
    });
    // Reduced transfer-tax rates are alternatives, not cumulative: only the largest reduction counts.
    const taxCuts = listed
      .filter(item => item.benefit.counted && item.benefit.kind === 'upfront_cost_reduction')
      .sort((a, b) => (b.benefit.amountCents ?? 0) - (a.benefit.amountCents ?? 0));
    const leaveOut = (item: (typeof listed)[number], reason: string) => {
      item.benefit.counted = false;
      item.benefit.explanation = `${item.translated.what} Not counted: ${reason}`;
    };
    for (const item of taxCuts.slice(1))
      leaveOut(item, 'another reduced transfer-tax rate is already counted, and reduced rates do not add up.');
    if (cautious !== 'no')
      for (const item of listed.filter(entry => entry.benefit.counted)) leaveOut(item, unsettledReason);

    const outcome = {
      when,
      settled: cautious === 'no',
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
            ? 'you already have the upfront cash, so money that arrives later does not shorten anything.'
            : `you could buy in ${withoutDelayed} month(s), before this money arrives ${taxReturnDelayMonths} months after the move.`,
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
   * Find the purchase day on which the timeline and what is counted agree.
   *
   * It starts on the plan date and re-screens on the day each result gives, until that day stops
   * moving. A timeline without a finite number of months has no purchase day and is returned as it
   * is. If the day keeps moving after `maxSettleRounds` rounds, the cautious timeline is returned:
   * the general transfer tax and no benefit, screened on its own purchase day.
   */
  const settle = (monthlyCents: number | null): Outcome => {
    let outcome = evaluate(0, monthlyCents, false);
    for (let round = 0; round < maxSettleRounds; round++) {
      if (outcome.months === null || outcome.months === outcome.when.months) return outcome;
      outcome = evaluate(outcome.months, monthlyCents, false);
    }
    if (outcome.months === null || outcome.months === outcome.when.months) return outcome;
    const cautious = evaluate(0, monthlyCents, false, 'all');
    return evaluate(cautious.months ?? 0, monthlyCents, false, 'all');
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
    if (agreed && !longer) return outcome;
    return evaluate(without.when.months, monthlyCents, true, without.settled ? 'place' : 'all');
  };

  const habits = habitSavings(person, options.includeProposedHabits);
  const withHabitsMonthly = monthly === null ? null : monthly + habits.monthlyCents;
  const baselineOutcome = settle(monthly);
  const habitsOutcome = habits.monthlyCents === 0 ? baselineOutcome : settle(withHabitsMonthly);
  const placeOutcome = settleWithPlace(withHabitsMonthly, habitsOutcome);

  const { applied, possiblyLower, baselineCents, tax } = baselineOutcome;
  if (possiblyLower.length)
    dataMissing.push(
      `household facts for the reduced transfer-tax rates that apply anywhere in Catalonia (${possiblyLower.map(({ result }) => result.id).join(', ')}): the baseline uses ${tax.baselineLabel} and could be as low as ${percent(Math.min(...possiblyLower.map(({ rate }) => rate)))}, which would shorten the baseline and shrink the transfer-tax saving of this place`,
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
  const base = { place, ...price, benefits: placeOutcome.benefits, transferTax };
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

  assumptions.push(
    `Upfront cash = ${percent(home.depositRate)} deposit (${euros(depositCents)}) + transfer tax at ${tax.baselineLabel} (${euros(baselineCents)}) + ${percent(options.purchaseFeesRate)} notary, registry and similar fees (${euros(feesCents)}) = ${euros(baselineOutcome.upfrontCents)}. The rest of the price is assumed to be financed; no lender has assessed it.`,
    applied
      ? `The baseline transfer tax is ${percent(applied.rate)}, not ${standardLabel}, because every condition of "${applied.result.title}" is confirmed and that rate applies in any municipality of Catalonia. A place is credited only with the difference between that rate and its own.`
      : possiblyLower.length
        ? `The baseline transfer tax is ${standardLabel}. A lower rate that applies anywhere in Catalonia is not assumed, because its conditions are not all confirmed; if you qualify, the baseline is shorter and the transfer-tax saving of a rural place is smaller than shown.`
        : `The baseline transfer tax is ${standardLabel}: no reduced rate that applies anywhere in Catalonia is verified for you.`,
    finances.emergencyReserveCents > 0
      ? `Available savings are ${euros(availableCents)}: current savings less the ${euros(finances.emergencyReserveCents)} emergency reserve.`
      : `Available savings are ${euros(availableCents)}. No emergency reserve was declared, so none is set aside.`,
    `Monthly savings are income less expenses (${euros(monthly)}), from ${finances.basis.replace('_', '-')} figures${finances.asOf ? ` as of ${finances.asOf}` : ''}.`,
  );
  if (aboveFirstBracket && standard?.standardTariff)
    assumptions.push(
      `The price is above ${euros(firstBracketEndCents(standard) ?? 0)}, so the general transfer tax is not a single rate. It follows the tariff by total value (${standard.standardTariff.map(bracket => `${percent(bracket.rate)} from ${euros(bracket.fromEur * 100)}`).join(', ')}): ${euros(standardCents ?? 0)} on this price. The price is taken as the property's total value, and the tax agency rounds the averaged rate, so the bill can differ by a few euros.`,
    );
  if (habits.counted.length)
    assumptions.push(
      `${habits.counted.length} habit(s) add ${euros(habits.monthlyCents)} a month: each planned saving is scaled by its check-in adherence, or counted in full when there are no check-ins yet. Habit savings are the person's own estimates.`,
    );
  if (habits.withheld.length)
    assumptions.push(
      `${habits.withheld.length} active habit(s) are shown but not counted (${habits.withheld.map(habit => habit.title).join(', ')}): your monthly savings come from bank movements${finances.asOf ? ` up to ${finances.asOf}` : ''}, which already include the effect of a habit that was running then. A habit is added on top only when it has a start date after that period.`,
    );
  if (options.includeProposedHabits) assumptions.push('Habits that are only proposed are counted as if adopted.');

  const purchaseDay = (outcome: Outcome) =>
    outcome.months === null
      ? 'no purchase day can be estimated, so it is screened on the plan date'
      : `${outcome.when.date} (${outcome.months} months after ${asOf})`;
  assumptions.push(
    `Benefits tied to the purchase are screened on the day you could buy, with ages advanced to that day, not on the plan date. With the benefits of this place: ${purchaseDay(placeOutcome)}. The baseline: ${purchaseDay(baselineOutcome)}. Tax bases, family status and the rules themselves are assumed to stay as they are on ${asOf}.`,
  );
  if (placeOutcome.applied?.result.id !== applied?.result.id)
    assumptions.push(
      `The transfer tax anywhere in Catalonia differs between the two days: ${tax.baselineLabel} for the baseline and ${placeOutcome.tax.baselineLabel} with the benefits of this place, which is the rate this place is compared with.`,
    );
  const unsettled = [
    ...(baselineOutcome.settled ? [] : ['baseline']),
    ...(habitsOutcome.settled ? [] : ['with habits']),
    ...(placeOutcome.settled ? [] : ['with the benefits of this place']),
  ];
  if (unsettled.length)
    assumptions.push(
      `For the timeline ${[...new Set(unsettled)].join(', ')}, the day you could buy did not settle: counting a benefit moved the purchase to a day on which it does not apply. The benefits that depend on that day are left out there, which is the cautious figure.`,
    );
  const beyond = (timeline: Timeline) =>
    timeline.months === null && timeline.monthlySavingsCents > 0 && timeline.upfrontCashCents > availableCents;
  if (beyond(withPlaceBenefits) || beyond(baseline))
    assumptions.push(
      `No timeline is given${beyond(withPlaceBenefits) ? '' : ' for the baseline'}: at ${euros((beyond(withPlaceBenefits) ? withPlaceBenefits : baseline).monthlySavingsCents)} a month the upfront cash is more than ${maxPlanningMonths} months (${maxPlanningMonths / 12} years) away, beyond what this plan estimates.`,
    );
  assumptions.push(
    options.includeUnverifiedBenefits
      ? 'Benefits whose eligibility is not yet verified are counted at your request; treat the shorter timeline as provisional.'
      : 'Only benefits with every eligibility condition confirmed are counted; the others are listed, not counted.',
    'A benefit tied to the purchase lowers the upfront cash. A benefit tied to living or renting in the place counts only on the assumption that you move there on the plan date and buy later, and arrives one tax year late. A benefit received after the purchase is never counted.',
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
  person: z.input<typeof personSchema>,
  places: Place[],
  policies: Policy[],
  assumptions: z.input<typeof planAssumptions> | undefined,
  asOf: string,
): PlanResult {
  const who = personSchema.parse(person);
  const options = planAssumptions.parse(assumptions ?? {});
  const date = options.asOf ?? asOf;
  const taxEffects = policies.flatMap(policy => (policy.effect?.kind === 'transfer_tax_rate' ? [policy.effect] : []));
  // The tariff by value, when a policy states it, is more complete than the single rate.
  const taxEffect = taxEffects.find(effect => effect.standardTariff) ?? taxEffects[0];
  const standard: StandardTax | null = taxEffect
    ? { standardRate: taxEffect.standardRate, standardTariff: taxEffect.standardTariff }
    : null;
  const order = (plan: PlacePlan) => plan.withPlaceBenefits?.months ?? Number.POSITIVE_INFINITY;
  const plans = places
    .map(place => planOne(who, place, policies, options, date, standard))
    .map((plan, index) => ({ plan, index }))
    .sort((a, b) => {
      const [left, right] = [order(a.plan), order(b.plan)];
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map(({ plan }) => plan);
  return planResult.parse({ person: who, asOf: date, plans, limitations: planLimitations });
}
