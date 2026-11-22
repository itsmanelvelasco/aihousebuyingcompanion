import type { z } from 'zod';
import type { eligibility, Municipality, Policy } from '../contracts/places.ts';
import type { Person, Place, PlaceBenefit, PlacePlan, PlanResult } from '../contracts/planner.ts';
import { person as personSchema, planAssumptions, planResult } from '../contracts/planner.ts';
import { monthsToTarget } from '../finance/savings.ts';
import { evaluateIncentives } from '../places/eligibility.ts';

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
 */
type Eligibility = z.infer<typeof eligibility>;
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

/** A tax deduction is received with the return filed the year after the qualifying event. */
const taxReturnDelayMonths = 12;
/** Intents screened for a purchase plan. Renovation measures depend on works this plan does not model. */
const screenedIntents = new Set<Policy['intent']>(['buy', 'move', 'rent']);

export const planLimitations = [
  'This is an arithmetic estimate from the figures supplied. It is not a mortgage offer, a credit assessment or a promise that a lender will approve a loan.',
  'No aid, grant or tax benefit is guaranteed. Benefits are screened against the rules in the dated policy snapshot and must be confirmed with the Catalan Tax Agency or the housing agency before relying on them.',
  'Prices are published municipal or comarca averages per square metre, not actual listings. The timeline assumes constant income, expenses and prices, with no interest or inflation.',
  'Months are rounded up. Zero, negative or unknown monthly savings give no timeline rather than a misleading number.',
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

/**
 * The municipality facts `evaluateIncentives` reads, taken from a `Place`.
 * `effectiveFrom` is not part of a place; the eligibility rules already return
 * needs_verification for any date before the rural classification took effect.
 */
function asMunicipality(place: Place): Municipality {
  const unsourced = { observedAt: 'not carried by Place', sourceUrl: 'https://www.relo.cat/' };
  return {
    code: place.municipalityCode,
    name: place.name,
    comarca: place.comarca,
    recommendable: true,
    identity: unsourced,
    centre: { ...place.centre, ...unsourced, name: place.name },
    rural: { ...unsourced, category: place.rural, effectiveFrom: null },
  };
}

/** Price of the home: the person's budget, else floor area × published resale EUR/m². */
function priceFor(person: Person, place: Place): Pick<PlacePlan, 'purchasePriceCents' | 'priceBasis'> {
  if (person.home.budgetCents !== null) return { purchasePriceCents: person.home.budgetCents, priceBasis: 'budget' };
  const resale = place.indicators.resaleEurPerM2;
  if (person.home.floorAreaM2 === null || !resale) return { purchasePriceCents: null, priceBasis: 'unknown' };
  return {
    // EUR → cents happens once, here.
    purchasePriceCents: Math.round(person.home.floorAreaM2 * resale.value * 100),
    priceBasis: resale.geography === 'comarca' ? 'comarca_eur_per_m2' : 'municipal_eur_per_m2',
  };
}

/** Monthly saving of the habits that count: planned amount × adherence (full amount when unknown). */
function habitSavings(person: Person, includeProposed: boolean) {
  const counted = person.habits.filter(
    habit =>
      (habit.status === 'active' || (includeProposed && habit.status === 'proposed')) &&
      habit.monthlySavingCents !== null,
  );
  // Rounded down per habit: a partly kept habit never counts for more than it saved.
  const monthlyCents = counted.reduce(
    (total, habit) => total + Math.floor((habit.monthlySavingCents ?? 0) * (habit.adherence ?? 1)),
    0,
  );
  return { counted, monthlyCents };
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

/** Decide whether a translated benefit is counted, and say why in plain language. */
function benefitFor(
  result: Eligibility,
  translated: Translated,
  person: Person,
  place: Place,
  options: Assumptions,
): PlaceBenefit {
  const { amountCents, timing, what } = translated;
  const unverified = result.eligibilityStatus === 'needs_verification';
  let blocker: string | null = null;
  if (result.geographicStatus === 'does_not_apply' || result.eligibilityStatus === 'ineligible') {
    blocker = `Not counted, criteria not met: ${result.unmetCriteria.join(' ')}`;
  } else if (result.callStatus === 'closed') {
    blocker = 'Not counted: the application call is closed.';
  } else if (result.callStatus === 'upcoming') {
    blocker = 'Not counted: the application call has not opened yet.';
  } else if (result.callWindow === null) {
    blocker = 'Not counted: no application call could be verified, so this aid cannot be claimed yet.';
  } else if (result.measureStatus !== 'active') {
    blocker = 'Not counted: the measure is not confirmed to be in force on the plan date.';
  } else if (result.geographicStatus !== 'applies') {
    blocker = `Not counted until verified: ${result.missingCriteria.join(' ')}`;
  } else if (unverified && !options.includeUnverifiedBenefits) {
    blocker = `Shown but not counted until verified: ${result.missingCriteria.join(' ')}`;
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

/** True when every condition of a Catalonia-wide rate is confirmed for the plan date. */
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
  result: Eligibility,
  translated: Translated,
  appliedId: Policy['id'] | null,
  isLower: boolean,
): PlaceBenefit {
  const { amountCents, what } = translated;
  let outcome: string;
  if (result.id === appliedId) {
    outcome = `Applied to your baseline: it lowers the upfront cash by ${euros(amountCents ?? 0)} wherever you buy in Catalonia, so it is not counted as a saving of this place.`;
  } else if (result.eligibilityStatus === 'ineligible') {
    outcome = `Not applied, criteria not met: ${result.unmetCriteria.join(' ')}`;
  } else if (result.measureStatus !== 'active') {
    outcome = 'Not applied: the measure is not confirmed to be in force on the plan date.';
  } else if (result.eligibilityStatus === 'needs_verification') {
    outcome = `Not applied to your baseline until verified: ${result.missingCriteria.join(' ')}${isLower ? ' If you qualify, you pay less transfer tax everywhere, and the transfer-tax saving of this place is smaller than shown.' : ''}`;
  } else if (appliedId !== null) {
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
    if (home.floorAreaM2 === null) dataMissing.push('person.home.floorAreaM2 or person.home.budgetCents');
    if (!place.indicators.resaleEurPerM2) dataMissing.push(`resale price per m² for ${place.name}`);
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

  // Screened as if the purchase happened under the rules in force on the plan date.
  const results = evaluateIncentives(
    policies.filter(policy => screenedIntents.has(policy.intent)),
    asMunicipality(place),
    { municipalityCode: place.municipalityCode, eventDate: asOf, household: person.household },
    asOf,
  );

  // The baseline transfer tax: the general tax, or the lowest Catalonia-wide rate verified for this person.
  const standardCents = standard === null || priceCents === null ? null : standardTaxCents(standard, priceCents);
  const generalRates = results.filter(isGeneralRate).flatMap(result => {
    const rate =
      result.effect?.kind === 'transfer_tax_rate' ? forCategory(result.effect.reducedRate, place.rural) : null;
    return rate === null ? [] : [{ result, rate }];
  });
  /** True when a flat rate gives less tax than `cents` on this price (compared by rate when the price is unknown). */
  const lowerThan = (rate: number, cents: number | null, fallbackRate: number | null) =>
    priceCents !== null && cents !== null
      ? share(rate, priceCents) < cents
      : fallbackRate !== null && rate < fallbackRate;
  const applied =
    generalRates
      .filter(({ result }) => isVerified(result))
      .sort((a, b) => a.rate - b.rate)
      .find(({ rate }) => lowerThan(rate, standardCents, standard?.standardRate ?? null)) ?? null;
  const baselineCents = applied && priceCents !== null ? share(applied.rate, priceCents) : standardCents;
  const baselineRate = applied?.rate ?? standard?.standardRate ?? null;
  const possiblyLower = generalRates.filter(
    ({ result, rate }) =>
      result.eligibilityStatus === 'needs_verification' && lowerThan(rate, baselineCents, baselineRate),
  );
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
  const tax: TaxReference = {
    standardCents,
    baselineCents,
    standardLabel,
    baselineLabel: applied
      ? `the ${percent(applied.rate)} you already qualify for anywhere in Catalonia (${applied.result.title})`
      : standardLabel,
  };
  if (possiblyLower.length)
    dataMissing.push(
      `household facts for the reduced transfer-tax rates that apply anywhere in Catalonia (${possiblyLower.map(({ result }) => result.id).join(', ')}): the baseline uses ${tax.baselineLabel} and could be as low as ${percent(Math.min(...possiblyLower.map(({ rate }) => rate)))}, which would shorten the baseline and shrink the transfer-tax saving of this place`,
    );

  const listed = results.map(result => {
    const translated = translate(result, place, priceCents, tax);
    const benefit = isGeneralRate(result)
      ? generalRateBenefit(
          result,
          translated,
          applied?.result.id ?? null,
          possiblyLower.some(item => item.result.id === result.id),
        )
      : benefitFor(result, translated, person, place, options);
    return { translated, benefit };
  });
  // Reduced transfer-tax rates are alternatives, not cumulative: only the largest reduction counts.
  const taxCuts = listed
    .filter(item => item.benefit.counted && item.benefit.kind === 'upfront_cost_reduction')
    .sort((a, b) => (b.benefit.amountCents ?? 0) - (a.benefit.amountCents ?? 0));
  for (const { benefit, translated } of taxCuts.slice(1)) {
    benefit.counted = false;
    benefit.explanation = `${translated.what} Not counted: another reduced transfer-tax rate is already counted, and reduced rates do not add up.`;
  }
  const counted = listed.filter(item => item.benefit.counted);
  const base = {
    place,
    ...price,
    benefits: listed.map(item => item.benefit),
  };

  const monthly =
    finances.monthlyIncomeCents === null || finances.monthlyExpensesCents === null
      ? null
      : finances.monthlyIncomeCents - finances.monthlyExpensesCents;
  const transferTax =
    standardCents === null || baselineCents === null
      ? null
      : {
          standardCents,
          baselineCents,
          baselinePolicyId: applied?.result.id ?? null,
          couldBeLower: possiblyLower.length > 0,
        };
  if (
    priceCents === null ||
    standard === null ||
    baselineCents === null ||
    finances.currentSavingsCents === null ||
    monthly === null
  ) {
    return {
      ...base,
      transferTax,
      status: 'insufficient_data',
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

  const depositCents = share(home.depositRate, priceCents);
  const taxCents = baselineCents;
  const feesCents = share(options.purchaseFeesRate, priceCents);
  const upfrontCents = depositCents + taxCents + feesCents;
  const availableCents = Math.max(0, finances.currentSavingsCents - finances.emergencyReserveCents);
  const habits = habitSavings(person, options.includeProposedHabits);
  const withHabitsMonthly = monthly + habits.monthlyCents;

  const sumOf = (timing: Timing, kind: PlaceBenefit['kind']) =>
    counted
      .filter(item => item.translated.timing === timing && item.benefit.kind === kind)
      .reduce((total, item) => total + (item.benefit.amountCents ?? 0), 0);
  const atPurchaseCents = sumOf('at_purchase', 'upfront_cost_reduction') + sumOf('at_purchase', 'one_off_cash');
  const placeUpfrontCents = Math.max(0, upfrontCents - atPurchaseCents);
  const delayed: DelayedCash = {
    lumpCents: sumOf('while_living_there', 'one_off_cash'),
    annual: counted
      .filter(item => item.translated.timing === 'while_living_there' && item.benefit.kind === 'annual_cash')
      // Rounded down: a yearly amount spread over twelve months never counts for more than it is.
      .map(item => ({
        monthlyCents: Math.floor((item.benefit.amountCents ?? 0) / 12),
        maxYears: item.translated.maxYears,
      })),
  };

  const baseline: Timeline = {
    upfrontCashCents: upfrontCents,
    monthlySavingsCents: monthly,
    months: monthsToTarget(upfrontCents - availableCents, monthly),
  };
  const withHabits: Timeline = {
    upfrontCashCents: upfrontCents,
    monthlySavingsCents: withHabitsMonthly,
    months: monthsToTarget(upfrontCents - availableCents, withHabitsMonthly),
  };
  const withPlaceBenefits: Timeline = {
    upfrontCashCents: placeUpfrontCents,
    monthlySavingsCents: withHabitsMonthly,
    months: monthsWithDelayedCash(placeUpfrontCents - availableCents, withHabitsMonthly, delayed),
  };

  assumptions.push(
    `Upfront cash = ${percent(home.depositRate)} deposit (${euros(depositCents)}) + transfer tax at ${tax.baselineLabel} (${euros(taxCents)}) + ${percent(options.purchaseFeesRate)} notary, registry and similar fees (${euros(feesCents)}) = ${euros(upfrontCents)}. The rest of the price is assumed to be financed; no lender has assessed it.`,
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
  if (options.includeProposedHabits) assumptions.push('Habits that are only proposed are counted as if adopted.');
  assumptions.push(
    `Benefits are screened against the rules in force on ${asOf}, as if the purchase took place under them; the rules on the actual purchase date may differ.`,
    options.includeUnverifiedBenefits
      ? 'Benefits whose eligibility is not yet verified are counted at your request; treat the shorter timeline as provisional.'
      : 'Only benefits with every eligibility condition confirmed are counted; the others are listed, not counted.',
    'A benefit tied to the purchase lowers the upfront cash. A benefit tied to living or renting in the place counts only on the assumption that you move there on the plan date and buy later, and arrives one tax year late. A benefit received after the purchase is never counted.',
  );

  const months = withPlaceBenefits.months;
  return {
    ...base,
    transferTax,
    status: months === 0 ? 'target_reached' : months === null ? 'no_positive_savings' : 'estimated',
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
