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

/** The value of a rural-category table for a place; null for partially covered municipalities. */
function forCategory(
  table: { rural: number; special_attention: number; other: number },
  category: Place['rural'],
): number | null {
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
function translate(result: Eligibility, place: Place, priceCents: number | null): Translated {
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
      const amountCents =
        reduced === null || priceCents === null
          ? null
          : Math.max(0, share(effect.standardRate, priceCents) - share(reduced, priceCents));
      const what =
        reduced === null
          ? 'A reduced transfer-tax rate may apply, depending on the nucleus where the home is.'
          : `Transfer tax at ${percent(reduced)} instead of the standard ${percent(effect.standardRate)}.`;
      return { kind: 'upfront_cost_reduction', amountCents, maxYears: null, timing: 'at_purchase', what };
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
      // The base is what the household actually pays each year, which the person entity does not hold.
      const rate = forCategory(effect.rate, place.rural);
      const cost = { purchase_payments: 'home-purchase payments', rent: 'rent paid', renovation: 'renovation costs' };
      return {
        ...none,
        kind: 'annual_cash',
        timing: livingThere ? 'while_living_there' : 'after_purchase',
        what: `${rate === null ? 'A yearly share' : `${percent(rate)} a year`} of ${cost[effect.cost]}, on at most ${euros(effect.maxBaseEur * 100)} a year. The amount depends on what you actually pay, which this plan does not know.`,
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
    sourceUrl: result.sourceUrl,
    explanation: `${what} ${counted ? how + caveat : blocker}`.trim(),
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
  standardRate: number | null,
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
  if (standardRate === null) dataMissing.push('standard transfer-tax rate (no policy in the snapshot states it)');
  if (finances.currentSavingsCents === null) dataMissing.push('person.finances.currentSavingsCents');
  if (finances.monthlyIncomeCents === null) dataMissing.push('person.finances.monthlyIncomeCents');
  if (finances.monthlyExpensesCents === null) dataMissing.push('person.finances.monthlyExpensesCents');

  // Screened as if the purchase happened under the rules in force on the plan date.
  const benefits = evaluateIncentives(
    policies.filter(policy => screenedIntents.has(policy.intent)),
    asMunicipality(place),
    { municipalityCode: place.municipalityCode, eventDate: asOf, household: person.household },
    asOf,
  ).map(result => ({
    translated: translate(result, place, priceCents),
    result,
  }));
  const listed = benefits.map(({ result, translated }) => ({
    translated,
    benefit: benefitFor(result, translated, person, place, options),
  }));
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
  if (priceCents === null || standardRate === null || finances.currentSavingsCents === null || monthly === null) {
    return {
      ...base,
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
  const taxCents = share(standardRate, priceCents);
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
    `Upfront cash = ${percent(home.depositRate)} deposit (${euros(depositCents)}) + ${percent(standardRate)} standard transfer tax (${euros(taxCents)}) + ${percent(options.purchaseFeesRate)} notary, registry and similar fees (${euros(feesCents)}) = ${euros(upfrontCents)}. The rest of the price is assumed to be financed; no lender has assessed it.`,
    finances.emergencyReserveCents > 0
      ? `Available savings are ${euros(availableCents)}: current savings less the ${euros(finances.emergencyReserveCents)} emergency reserve.`
      : `Available savings are ${euros(availableCents)}. No emergency reserve was declared, so none is set aside.`,
    `Monthly savings are income less expenses (${euros(monthly)}), from ${finances.basis.replace('_', '-')} figures${finances.asOf ? ` as of ${finances.asOf}` : ''}.`,
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
 * The standard transfer-tax rate is read from the policy whose effect is `transfer_tax_rate`; when
 * the policies do not state it, no rate is invented and every plan is `insufficient_data`.
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
  const taxEffect = policies.map(policy => policy.effect).find(effect => effect?.kind === 'transfer_tax_rate');
  const standardRate = taxEffect?.kind === 'transfer_tax_rate' ? taxEffect.standardRate : null;
  const order = (plan: PlacePlan) => plan.withPlaceBenefits?.months ?? Number.POSITIVE_INFINITY;
  const plans = places
    .map(place => planOne(who, place, policies, options, date, standardRate))
    .map((plan, index) => ({ plan, index }))
    .sort((a, b) => {
      const [left, right] = [order(a.plan), order(b.plan)];
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map(({ plan }) => plan);
  return planResult.parse({ person: who, asOf: date, plans, limitations: planLimitations });
}
