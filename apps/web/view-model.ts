import type { Habit, Person, Place, PlaceBenefit, PlacePlan, PlanResult } from '../../packages/contracts/planner.ts';
import {
  formatCount,
  formatDecimal,
  formatDuration,
  formatDurationShort,
  formatEuros,
  formatMonthsSaved,
} from './format.ts';

/**
 * View models for the workspace: what each panel says, derived from a `PlanResult`.
 * Nothing here calculates money or timelines; it only reads what the planner returned.
 */

// ---------------------------------------------------------------- timelines

export type TimelineKey = 'baseline' | 'withHabits' | 'withPlaceBenefits';
/**
 * - `finite`: a number of months to show as a bar.
 * - `reached`: zero months; the cash is already there.
 * - `none`: the planner ran and found no finite timeline (savings zero, negative or unknown).
 * - `not_estimated`: the planner returned no timeline for this step.
 */
export type TimelineState = 'finite' | 'reached' | 'none' | 'not_estimated';

export type TimelineStep = {
  key: TimelineKey;
  label: string;
  state: TimelineState;
  months: number | null;
  /** Long text, e.g. `4 years 2 months`, `No finite timeline`, `Not estimated`. */
  text: string;
  shortText: string;
  /** Bar length as a percentage of the longest finite timeline on screen. Null when there is no bar. */
  barPercent: number | null;
  upfrontCashCents: number | null;
  monthlySavingsCents: number | null;
  /** Change against the previous step, in months. Null for the baseline or when not comparable. */
  savedMonths: number | null;
  savedText: string | null;
};

const stepLabels: Record<TimelineKey, string> = {
  baseline: 'Baseline',
  withHabits: 'With habits',
  withPlaceBenefits: 'With this place',
};

/** The longest finite timeline across every place, so bars are comparable between places. */
export function longestTimeline(plans: PlacePlan[]) {
  const months = plans.flatMap(plan =>
    [plan.baseline, plan.withHabits, plan.withPlaceBenefits].flatMap(step =>
      step && step.months !== null ? [step.months] : [],
    ),
  );
  return months.length ? Math.max(...months) : 0;
}

export function timelineSteps(plan: PlacePlan, scaleMonths: number): TimelineStep[] {
  const saved: Record<TimelineKey, number | null> = {
    baseline: null,
    withHabits: plan.monthsSavedByHabits,
    withPlaceBenefits: plan.monthsSavedByPlace,
  };
  return (['baseline', 'withHabits', 'withPlaceBenefits'] as const).map(key => {
    const timeline = plan[key];
    const months = timeline?.months ?? null;
    const state: TimelineState = !timeline
      ? 'not_estimated'
      : months === null
        ? 'none'
        : months === 0
          ? 'reached'
          : 'finite';
    const savedMonths = key === 'baseline' ? null : saved[key];
    return {
      key,
      label: stepLabels[key],
      state,
      months,
      text: state === 'not_estimated' ? 'Not estimated' : formatDuration(months),
      shortText: state === 'not_estimated' ? 'Not estimated' : formatDurationShort(months),
      // A finite bar is never drawn shorter than 2% so one month still shows; no bar otherwise.
      barPercent:
        state === 'finite' && months !== null && scaleMonths > 0
          ? Math.max(2, Math.min(100, Math.round((months / scaleMonths) * 1000) / 10))
          : null,
      upfrontCashCents: timeline?.upfrontCashCents ?? null,
      monthlySavingsCents: timeline?.monthlySavingsCents ?? null,
      savedMonths,
      savedText: key === 'baseline' || savedMonths === null ? null : formatMonthsSaved(savedMonths),
    };
  });
}

const statusText: Record<PlacePlan['status'], string> = {
  estimated: 'Estimated',
  target_reached: 'Upfront cash already covered',
  no_positive_savings: 'No finite timeline: nothing is being saved each month',
  insufficient_data: 'Not enough data to estimate',
  beyond_horizon: 'No timeline: at this rate the upfront cash is more than 50 years away',
};

const priceBasisText: Record<PlacePlan['priceBasis'], string> = {
  budget: 'your stated budget',
  municipal_eur_per_m2: 'the municipal average price per m²',
  comarca_eur_per_m2: 'the comarca average price per m² (no municipal figure)',
  unknown: 'an unknown basis',
};

export type PlanHeadline = {
  /** The answer for this place in one line. */
  headline: string;
  tone: 'ok' | 'reached' | 'none' | 'unknown';
  statusText: string;
  priceText: string;
  savedByHabitsText: string;
  savedByPlaceText: string;
  savedTotalText: string;
};

export function planHeadline(plan: PlacePlan): PlanHeadline {
  const final = plan.withPlaceBenefits;
  const tone: PlanHeadline['tone'] =
    plan.status === 'insufficient_data' || !final
      ? 'unknown'
      : plan.status === 'target_reached' || final.months === 0
        ? 'reached'
        : final.months === null
          ? 'none'
          : 'ok';
  const headline =
    tone === 'unknown'
      ? 'Not enough data to estimate'
      : tone === 'reached'
        ? 'Upfront cash already covered'
        : tone === 'none'
          ? 'No finite timeline'
          : `Ready in ${formatDuration(final?.months)}`;
  return {
    headline,
    tone,
    statusText: statusText[plan.status],
    priceText:
      plan.purchasePriceCents === null
        ? 'Purchase price unknown'
        : `${formatEuros(plan.purchasePriceCents)} home, priced from ${priceBasisText[plan.priceBasis]}`,
    savedByHabitsText: formatMonthsSaved(plan.monthsSavedByHabits),
    savedByPlaceText: formatMonthsSaved(plan.monthsSavedByPlace),
    savedTotalText: formatMonthsSaved(plan.monthsSaved),
  };
}

// ----------------------------------------------------------------- benefits

/**
 * How a benefit must look.
 * - `counted`: eligible and counted in the plan — the only tone drawn as confirmed.
 * - `counted_unverified`: counted because unverified benefits were switched on; still flagged.
 * - `unverified`: shown, not counted, eligibility needs verification.
 * - `ineligible`: not counted, screened out on the supplied facts.
 * - `not_counted`: eligible but left out (closed call, no amount, or not quantifiable).
 */
export type BenefitTone = 'counted' | 'counted_unverified' | 'unverified' | 'ineligible' | 'not_counted';

export type BenefitView = {
  tone: BenefitTone;
  counted: boolean;
  /** True only when eligibility is settled as eligible. Unverified never reads as confirmed. */
  confirmed: boolean;
  countedLabel: string;
  eligibilityLabel: string;
  callLabel: string;
  kindLabel: string;
  amountLabel: string;
};

const eligibilityLabels: Record<PlaceBenefit['eligibilityStatus'], string> = {
  eligible: 'Eligible on supplied facts',
  ineligible: 'Ineligible on supplied facts',
  needs_verification: 'Eligibility needs verification',
};
const callLabels: Record<PlaceBenefit['callStatus'], string> = {
  open: 'Call open',
  closed: 'Call closed',
  upcoming: 'Call upcoming',
  unknown: 'Call status unknown',
};
const kindLabels: Record<PlaceBenefit['kind'], string> = {
  upfront_cost_reduction: 'Lowers the upfront cost',
  one_off_cash: 'One-off payment',
  annual_cash: 'Yearly payment',
  unquantified: 'No amount can be put on it',
};

export function benefitView(benefit: PlaceBenefit): BenefitView {
  const unverified = benefit.eligibilityStatus === 'needs_verification';
  const tone: BenefitTone = benefit.counted
    ? unverified
      ? 'counted_unverified'
      : 'counted'
    : unverified
      ? 'unverified'
      : benefit.eligibilityStatus === 'ineligible'
        ? 'ineligible'
        : 'not_counted';
  const amount =
    benefit.amountCents === null
      ? 'Amount not computed'
      : `${formatEuros(benefit.amountCents)}${benefit.kind === 'annual_cash' ? ' per year' : ''}`;
  return {
    tone,
    counted: benefit.counted,
    confirmed: benefit.eligibilityStatus === 'eligible',
    countedLabel:
      tone === 'counted' ? 'Counted in plan' : tone === 'counted_unverified' ? 'Counted, unverified' : 'Not counted',
    eligibilityLabel: eligibilityLabels[benefit.eligibilityStatus],
    callLabel: callLabels[benefit.callStatus],
    kindLabel: kindLabels[benefit.kind],
    amountLabel: amount,
  };
}

export function benefitSummary(benefits: PlaceBenefit[]) {
  const counted = benefits.filter(benefit => benefit.counted).length;
  if (!benefits.length) return 'No benefits listed for this place';
  return `${counted} of ${benefits.length} ${benefits.length === 1 ? 'benefit' : 'benefits'} counted`;
}

// ---------------------------------------------------------------- indicators

type IndicatorKey = keyof Place['indicators'];
export type IndicatorView = {
  key: IndicatorKey;
  label: string;
  /** Formatted value, or `Unknown` when the place has no figure. */
  value: string;
  known: boolean;
  unit: string | null;
  geography: 'municipality' | 'comarca' | null;
  observedAt: string | null;
  sourceUrl: string | null;
};

const indicatorLabels: Record<IndicatorKey, string> = {
  population: 'Population',
  densityPerKm2: 'Density',
  foreignPopulationPercent: 'Foreign residents',
  resaleEurPerM2: 'Resale price',
  rentEurPerMonth: 'Average rent',
};
const indicatorFormat: Record<IndicatorKey, (value: number) => string> = {
  population: value => formatCount(value),
  densityPerKm2: value => `${formatDecimal(value)} per km²`,
  foreignPopulationPercent: value => `${formatDecimal(value)}%`,
  resaleEurPerM2: value => `${formatEuros(Math.round(value * 100))} per m²`,
  rentEurPerMonth: value => `${formatEuros(Math.round(value * 100))} per month`,
};

export function indicatorViews(place: Place): IndicatorView[] {
  return (Object.keys(indicatorLabels) as IndicatorKey[]).map(key => {
    const indicator = place.indicators[key];
    return {
      key,
      label: indicatorLabels[key],
      value: indicator ? indicatorFormat[key](indicator.value) : 'Unknown',
      known: indicator !== null,
      unit: indicator?.unit ?? null,
      geography: indicator?.geography ?? null,
      observedAt: indicator?.observedAt ?? null,
      sourceUrl: indicator?.sourceUrl ?? null,
    };
  });
}

const serviceLabels: Record<Place['services'][number]['kind'], string> = {
  primary_care: 'Primary care centres',
  hospital: 'Hospitals',
  pharmacy: 'Pharmacies',
  school: 'Schools',
  library: 'Libraries',
  rail_station: 'Rail stations',
  retail: 'Shops',
  sports: 'Sports facilities',
  social_services: 'Social services',
};
export const serviceLabel = (kind: Place['services'][number]['kind']) => serviceLabels[kind];

const ruralLabels: Record<Place['rural'], string | null> = {
  rural: 'Rural municipality',
  special_attention: 'Rural, special attention',
  partial: 'Partly rural',
  not_listed: null,
};
export const ruralLabel = (category: Place['rural']) => ruralLabels[category];

// ------------------------------------------------------------------- person

const basisLabels: Record<Person['finances']['basis'], string> = {
  declared: 'Declared in the interview',
  bank_observed: 'Observed in bank movements',
  mixed: 'Part declared, part observed in bank movements',
  unknown: 'Origin of the figures unknown',
};
export const basisLabel = (basis: Person['finances']['basis']) => basisLabels[basis];

const habitStatusLabels: Record<Habit['status'], string> = {
  active: 'Active',
  proposed: 'Proposed',
  paused: 'Paused',
};
export const habitStatusLabel = (status: Habit['status']) => habitStatusLabels[status];

/** Habit id → switched on or off in this what-if. Habits without an entry keep their stored status. */
export type HabitOverrides = Record<string, boolean>;

/** Whether the plan counts a habit's saving, given the stored status and the what-if switches. */
export function habitCounted(habit: Habit, includeProposed: boolean, overrides: HabitOverrides = {}) {
  const override = overrides[habit.id];
  if (override !== undefined) return override;
  return habit.status === 'active' || (habit.status === 'proposed' && includeProposed);
}

/**
 * The person to send to `plan_home_savings` after toggles: a habit switched on becomes `active`, a
 * habit switched off becomes `paused`. Untouched habits keep their stored status.
 *
 * A habit switched on here was not running while the person's figures were observed, so it starts
 * after them: it is given the day after `finances.asOf` as its start. The planner adds a habit on
 * top of bank-observed figures only when it started after the observed period.
 */
export function applyHabitOverrides(person: Person, overrides: HabitOverrides): Person {
  const asOf = person.finances.asOf;
  const dayAfter = asOf ? new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
  return {
    ...person,
    habits: person.habits.map(habit => {
      const override = overrides[habit.id];
      if (override === undefined) return habit;
      if (!override) return { ...habit, status: 'paused' };
      return { ...habit, status: 'active', ...(habit.status !== 'active' && dayAfter ? { startedOn: dayAfter } : {}) };
    }),
  };
}

/** Drops overrides that only restate the stored status, so an untouched what-if plans by user id. */
export function effectiveOverrides(person: Person, overrides: HabitOverrides, includeProposed: boolean) {
  const kept: HabitOverrides = {};
  for (const habit of person.habits) {
    const override = overrides[habit.id];
    if (override !== undefined && override !== habitCounted(habit, includeProposed)) kept[habit.id] = override;
  }
  return kept;
}

/**
 * Extra monthly saving the planner attributed to habits: the with-habits rate minus the baseline
 * rate of the first place that has both. Null when no place has both.
 */
export function habitMonthlyEffectCents(result: PlanResult) {
  for (const plan of result.plans) {
    if (plan.baseline && plan.withHabits)
      return plan.withHabits.monthlySavingsCents - plan.baseline.monthlySavingsCents;
  }
  return null;
}

/** The planner's baseline monthly saving, from the first place that has one. */
export function baselineMonthlySavingsCents(result: PlanResult) {
  return result.plans.find(plan => plan.baseline)?.baseline?.monthlySavingsCents ?? null;
}

// -------------------------------------------------------------------- notes

export type PlanNotes = {
  limitations: string[];
  /** Assumptions across every place, without repeats. */
  assumptions: string[];
  /** Missing data grouped by place; places with none are left out. */
  dataMissing: { place: string; items: string[] }[];
};

export function planNotes(result: PlanResult): PlanNotes {
  return {
    limitations: [...new Set(result.limitations)],
    assumptions: [...new Set(result.plans.flatMap(plan => plan.assumptions))],
    dataMissing: result.plans
      .map(plan => ({ place: plan.place.name, items: [...new Set([...plan.dataMissing, ...plan.place.dataMissing])] }))
      .filter(group => group.items.length > 0),
  };
}

// --------------------------------------------------------------------- bank

/** The last `count` complete calendar months before `today` (`YYYY-MM-DD`), as `get_bank_summary` requires. */
export function lastCompleteMonths(today: string, count: number) {
  const [year, month] = today.split('-').map(Number);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { from: iso(new Date(Date.UTC(year, month - 1 - count, 1))), to: iso(new Date(Date.UTC(year, month - 1, 0))) };
}

/**
 * Movements added by a run of bank events. Each event's `transactionCount` is the size of the
 * ledger after that change, so the number added is the last size minus the size before the run.
 * Null when the size before is unknown; never negative (a deletion is not "new transactions").
 */
export function addedTransactions(sizeBefore: number | null, events: { transactionCount: number }[]) {
  const last = events.at(-1);
  if (!last) return 0;
  return sizeBefore === null ? null : Math.max(0, last.transactionCount - sizeBefore);
}

/** Whole euros typed into a form as integer cents, or undefined for an empty or unusable value. */
export function eurosToCents(text: string) {
  const value = Number(text.trim().replace(/\s/g, '').replace(',', '.'));
  return text.trim() === '' || !Number.isFinite(value) || value < 0 ? undefined : Math.round(value * 100);
}
