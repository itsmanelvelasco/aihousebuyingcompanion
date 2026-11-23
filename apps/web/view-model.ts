import type {
  FactConflict,
  Habit,
  HabitEffect,
  Person,
  Place,
  PlaceBenefit,
  PlacePlan,
  PlanResult,
} from '../../packages/contracts/planner.ts';
import { defaultLocale, isLocale, type Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import {
  formatCount,
  formatDecimal,
  formatDuration,
  formatDurationShort,
  formatEuros,
  formatMonthsSaved,
} from './format.ts';
import { detailsMessages } from './messages/details.messages.ts';
import { personMessages } from './messages/person.messages.ts';
import { placesMessages } from './messages/places.messages.ts';

/**
 * View models for the workspace: what each panel says, derived from a `PlanResult`.
 * Nothing here calculates money or timelines; it only reads what the planner returned.
 * Every function that returns text takes the language last and defaults to English.
 */
type PlacesKey = keyof typeof placesMessages.en;
type PersonKey = keyof typeof personMessages.en;
type DetailsKey = keyof typeof detailsMessages.en;

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

const stepLabels: Record<TimelineKey, PlacesKey> = {
  baseline: 'stepBaseline',
  withHabits: 'stepHabits',
  withPlaceBenefits: 'stepPlace',
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

export function timelineSteps(plan: PlacePlan, scaleMonths: number, locale: Locale = defaultLocale): TimelineStep[] {
  const t = translator(placesMessages, locale);
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
      label: t(stepLabels[key]),
      state,
      months,
      text: state === 'not_estimated' ? t('notEstimated') : formatDuration(months, locale),
      shortText: state === 'not_estimated' ? t('notEstimated') : formatDurationShort(months, locale),
      // A finite bar is never drawn shorter than 2% so one month still shows; no bar otherwise.
      barPercent:
        state === 'finite' && months !== null && scaleMonths > 0
          ? Math.max(2, Math.min(100, Math.round((months / scaleMonths) * 1000) / 10))
          : null,
      upfrontCashCents: timeline?.upfrontCashCents ?? null,
      monthlySavingsCents: timeline?.monthlySavingsCents ?? null,
      savedMonths,
      savedText: key === 'baseline' || savedMonths === null ? null : formatMonthsSaved(savedMonths, locale),
    };
  });
}

const statusText: Record<PlacePlan['status'], PlacesKey> = {
  estimated: 'statusEstimated',
  target_reached: 'statusReached',
  no_positive_savings: 'statusNoSavings',
  insufficient_data: 'statusInsufficient',
  beyond_horizon: 'statusBeyond',
};

/** The price sentence for each basis: `{price} home, priced from …`. */
const priceBasisText: Record<PlacePlan['priceBasis'], PlacesKey> = {
  budget: 'priceBudget',
  municipal_eur_per_m2: 'priceMunicipal',
  comarca_eur_per_m2: 'priceComarca',
  unknown: 'priceUnknownBasis',
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

export function planHeadline(plan: PlacePlan, locale: Locale = defaultLocale): PlanHeadline {
  const t = translator(placesMessages, locale);
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
      ? t('statusInsufficient')
      : tone === 'reached'
        ? t('statusReached')
        : tone === 'none'
          ? formatDuration(null, locale)
          : t('headlineReady', { duration: formatDuration(final?.months, locale) });
  return {
    headline,
    tone,
    statusText: t(statusText[plan.status]),
    priceText:
      plan.purchasePriceCents === null
        ? t('priceUnknown')
        : t(priceBasisText[plan.priceBasis], { price: formatEuros(plan.purchasePriceCents, locale) }),
    savedByHabitsText: formatMonthsSaved(plan.monthsSavedByHabits, locale),
    savedByPlaceText: formatMonthsSaved(plan.monthsSavedByPlace, locale),
    savedTotalText: formatMonthsSaved(plan.monthsSaved, locale),
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

const eligibilityLabels: Record<PlaceBenefit['eligibilityStatus'], PlacesKey> = {
  eligible: 'eligible',
  ineligible: 'ineligible',
  needs_verification: 'needsVerification',
};
const callLabels: Record<PlaceBenefit['callStatus'], PlacesKey> = {
  open: 'callOpen',
  closed: 'callClosed',
  upcoming: 'callUpcoming',
  unknown: 'callUnknown',
};
const kindLabels: Record<PlaceBenefit['kind'], PlacesKey> = {
  upfront_cost_reduction: 'kindUpfront',
  one_off_cash: 'kindOneOff',
  annual_cash: 'kindAnnual',
  unquantified: 'kindUnquantified',
};

export function benefitView(benefit: PlaceBenefit, locale?: Locale): BenefitView;
/** As an array callback (`benefits.map(benefitView)`): the index it is handed is not a language. */
export function benefitView(benefit: PlaceBenefit, index: number): BenefitView;
export function benefitView(benefit: PlaceBenefit, language: Locale | number = defaultLocale): BenefitView {
  const locale = isLocale(language) ? language : defaultLocale;
  const t = translator(placesMessages, locale);
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
  const yearly = benefit.kind === 'annual_cash';
  const nominal = benefit.nominalAmountCents ?? null;
  // The amount follows what the planner did: nothing of the person's own next to "ineligible", and an
  // unverified amount is conditional. The nominal figure is shown only as what the measure is worth.
  const amount =
    tone === 'ineligible'
      ? nominal === null || nominal === 0
        ? t('notEligibleNoAmount')
        : t(yearly ? 'notEligibleWorthPerYear' : 'notEligibleWorth', { amount: formatEuros(nominal, locale) })
      : benefit.amountCents === null
        ? t('amountNotComputed')
        : t(
            tone === 'unverified'
              ? yearly
                ? 'amountPerYearIfConfirmed'
                : 'amountIfConfirmed'
              : yearly
                ? 'amountPerYear'
                : 'amount',
            { amount: formatEuros(benefit.amountCents, locale) },
          );
  return {
    tone,
    counted: benefit.counted,
    confirmed: benefit.eligibilityStatus === 'eligible',
    countedLabel: t(
      tone === 'counted' ? 'countedInPlan' : tone === 'counted_unverified' ? 'countedUnverified' : 'notCounted',
    ),
    eligibilityLabel: t(eligibilityLabels[benefit.eligibilityStatus]),
    callLabel: t(callLabels[benefit.callStatus]),
    kindLabel: t(kindLabels[benefit.kind]),
    amountLabel: amount,
  };
}

export function benefitSummary(benefits: PlaceBenefit[], locale: Locale = defaultLocale) {
  const t = translator(placesMessages, locale);
  const counted = benefits.filter(benefit => benefit.counted).length;
  if (!benefits.length) return t('benefitsNone');
  return t('benefitsCounted', { counted, total: benefits.length });
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

const indicatorLabels: Record<IndicatorKey, PlacesKey> = {
  population: 'population',
  densityPerKm2: 'density',
  foreignPopulationPercent: 'foreignResidents',
  resaleEurPerM2: 'resalePrice',
  rentEurPerMonth: 'averageRent',
};
/** The figure of an indicator and, when it has a unit, the message that sets the unit around it. */
const indicatorFormat: Record<IndicatorKey, { value: (value: number, locale: Locale) => string; unit?: PlacesKey }> = {
  population: { value: formatCount },
  densityPerKm2: { value: formatDecimal, unit: 'perKm2' },
  foreignPopulationPercent: { value: formatDecimal, unit: 'percent' },
  resaleEurPerM2: { value: (value, locale) => formatEuros(Math.round(value * 100), locale), unit: 'perM2' },
  rentEurPerMonth: { value: (value, locale) => formatEuros(Math.round(value * 100), locale), unit: 'perMonth' },
};

export function indicatorViews(place: Place, locale: Locale = defaultLocale): IndicatorView[] {
  const t = translator(placesMessages, locale);
  const figure = (key: IndicatorKey, value: number) => {
    const { value: number, unit } = indicatorFormat[key];
    return unit ? t(unit, { value: number(value, locale) }) : number(value, locale);
  };
  return (Object.keys(indicatorLabels) as IndicatorKey[]).map(key => {
    const indicator = place.indicators[key];
    return {
      key,
      label: t(indicatorLabels[key]),
      value: indicator ? figure(key, indicator.value) : formatCount(null, locale),
      known: indicator !== null,
      unit: indicator?.unit ?? null,
      geography: indicator?.geography ?? null,
      observedAt: indicator?.observedAt ?? null,
      sourceUrl: indicator?.sourceUrl ?? null,
    };
  });
}

const serviceLabels: Record<Place['services'][number]['kind'], PlacesKey> = {
  primary_care: 'primaryCare',
  hospital: 'hospital',
  pharmacy: 'pharmacy',
  school: 'school',
  library: 'library',
  rail_station: 'railStation',
  retail: 'retail',
  sports: 'sports',
  social_services: 'socialServices',
};
export const serviceLabel = (kind: Place['services'][number]['kind'], locale: Locale = defaultLocale) =>
  translator(placesMessages, locale)(serviceLabels[kind]);

const ruralLabels: Record<Place['rural'], PlacesKey | null> = {
  rural: 'rural',
  special_attention: 'ruralSpecial',
  partial: 'ruralPartial',
  not_listed: null,
};
export const ruralLabel = (category: Place['rural'], locale: Locale = defaultLocale) => {
  const key = ruralLabels[category];
  return key ? translator(placesMessages, locale)(key) : null;
};

// ------------------------------------------------------------------- person

const basisLabels: Record<Person['finances']['basis'], PersonKey> = {
  declared: 'basisDeclared',
  bank_observed: 'basisBank',
  mixed: 'basisMixed',
  unknown: 'basisUnknown',
};
export const basisLabel = (basis: Person['finances']['basis'], locale: Locale = defaultLocale) =>
  translator(personMessages, locale)(basisLabels[basis]);

const habitStatusLabels: Record<Habit['status'], PersonKey> = {
  active: 'habitActive',
  proposed: 'habitProposed',
  paused: 'habitPaused',
};
export const habitStatusLabel = (status: Habit['status'], locale: Locale = defaultLocale) =>
  translator(personMessages, locale)(habitStatusLabels[status]);

/** Habit id → switched on or off in this what-if. Habits without an entry keep their stored status. */
export type HabitOverrides = Record<string, boolean>;

/**
 * Whether a habit is switched on: the stored status, or the what-if switch when there is one. This
 * is what the person asked for, not what the plan did with it; `habitPlanView` says the latter.
 */
export function habitSwitchedOn(habit: Habit, includeProposed: boolean, overrides: HabitOverrides = {}) {
  const override = overrides[habit.id];
  if (override !== undefined) return override;
  return habit.status === 'active' || (habit.status === 'proposed' && includeProposed);
}

export type HabitPlanView = {
  /**
   * `counted`: the planner added it to the monthly savings. `withheld`: switched on, and the planner
   * left it out. `off`: not switched on, so there is nothing to say. `unknown`: the plan does not
   * state what it did (a result from before `habits` existed, or a plan still loading), and nothing
   * is claimed either way.
   */
  state: 'counted' | 'withheld' | 'off' | 'unknown';
  label: string | null;
  /** The planner's own sentence, shown next to a habit that was withheld. */
  explanation: string | null;
  countedMonthlyCents: number | null;
};

/**
 * What the plan did with one habit, read from the plan itself (`PlanResult.habits`). The workspace
 * never works this out from the habit's status: an active habit can be left out, for example when
 * its effect is already inside spending observed in the bank.
 */
export function habitPlanView(
  habit: Habit,
  result: Pick<PlanResult, 'habits'> | null | undefined,
  on: boolean,
  locale: Locale = defaultLocale,
): HabitPlanView {
  const t = translator(personMessages, locale);
  const effect: HabitEffect | undefined = result?.habits?.find(entry => entry.habitId === habit.id);
  if (!effect) return { state: on ? 'unknown' : 'off', label: null, explanation: null, countedMonthlyCents: null };
  if (effect.counted)
    return {
      state: 'counted',
      label: t('countedInPlan'),
      explanation: effect.explanation,
      countedMonthlyCents: effect.countedMonthlyCents,
    };
  const withheld = effect.reason === 'inside_bank_figures' || effect.reason === 'start_unknown';
  return {
    state: withheld ? 'withheld' : 'off',
    label: withheld ? t('shownNotCounted') : effect.reason === 'no_amount' && on ? t('noSavingToCount') : null,
    explanation: withheld || effect.reason === 'no_amount' ? effect.explanation : null,
    countedMonthlyCents: 0,
  };
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
    if (override !== undefined && override !== habitSwitchedOn(habit, includeProposed)) kept[habit.id] = override;
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

// ------------------------------------------------------------------ details

const sourceLabels: Record<string, DetailsKey> = {
  profile: 'sourceProfile',
  interview: 'sourceInterview',
  manual: 'sourceManual',
  bank: 'sourceBank',
  listing: 'sourceListing',
  what_if: 'sourceWhatIf',
};
/** Where an answer came from, in words. An unknown source is named as such, not guessed. */
export const factSourceLabel = (source: string, locale: Locale = defaultLocale) =>
  translator(detailsMessages, locale)(Object.hasOwn(sourceLabels, source) ? sourceLabels[source] : 'sourceNotRecorded');

/**
 * The sources a picked answer is written under to settle a conflict: every disagreeing source the
 * workspace can write (`interview`, `manual`), so no older answer keeps contradicting the pick.
 * When none of them is writable the pick is saved as typed in by the person.
 */
export function conflictSources(conflict: Pick<FactConflict, 'candidates'>): ('manual' | 'interview')[] {
  const writable = (['interview', 'manual'] as const).filter(source =>
    conflict.candidates.some(candidate => candidate.source === source),
  );
  return writable.length ? writable : ['manual'];
}

export type PlanChange = { place: string; lines: string[] };

/**
 * What an answer changed, place by place, read from the plan before it and the plan after it. Both
 * timelines are quoted as the planner gave them; nothing is added or subtracted here. A place where
 * nothing changed is left out.
 */
export function planChanges(before: PlanResult, after: PlanResult, locale: Locale = defaultLocale): PlanChange[] {
  const t = translator(detailsMessages, locale);
  // A duration inside a sentence: "4 years 2 months", "no finite timeline".
  const duration = (months: number | null) => formatDuration(months, locale).toLocaleLowerCase(locale);
  return after.plans.flatMap(plan => {
    const previous = before.plans.find(item => item.place.municipalityCode === plan.place.municipalityCode);
    if (!previous) return [];
    const lines: string[] = [];
    for (const benefit of plan.benefits) {
      const was = previous.benefits.find(item => item.policyId === benefit.policyId);
      if (!was) continue;
      if (benefit.counted && !was.counted) lines.push(t('countedNow', { title: benefit.title }));
      else if (!benefit.counted && was.counted) lines.push(t('noLongerCounted', { title: benefit.title }));
      // A status that settles is news; one that only becomes open again is already in the question list.
      else if (
        benefit.eligibilityStatus !== was.eligibilityStatus &&
        benefit.eligibilityStatus !== 'needs_verification'
      )
        lines.push(
          t(benefit.eligibilityStatus === 'eligible' ? 'confirmedForYou' : 'doesNotApply', { title: benefit.title }),
        );
    }
    const baselineRate = plan.transferTax?.baselinePolicyId ?? null;
    if (baselineRate !== (previous.transferTax?.baselinePolicyId ?? null))
      lines.push(t(baselineRate ? 'taxReduced' : 'taxGeneral'));
    const [was, now] = [previous.withPlaceBenefits, plan.withPlaceBenefits];
    if (!was && now) lines.push(t('timelineNow', { duration: duration(now.months) }));
    else if (was && !now) lines.push(t('timelineGone'));
    else if (was && now && was.months !== now.months)
      lines.push(t('waitNow', { now: duration(now.months), was: duration(was.months) }));
    else if (was && now && was.upfrontCashCents !== now.upfrontCashCents)
      lines.push(
        t('upfrontNow', {
          now: formatEuros(now.upfrontCashCents, locale),
          was: formatEuros(was.upfrontCashCents, locale),
        }),
      );
    return lines.length ? [{ place: plan.place.name, lines }] : [];
  });
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
