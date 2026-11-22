import { z } from 'zod';
import { stateSchema } from '../contracts/habits.ts';
import { household as householdFacts } from '../contracts/places.ts';
import type { Habit, Person } from '../contracts/planner.ts';
import { person } from '../contracts/planner.ts';

/**
 * The person entity: one household with its finances, home needs and habits.
 *
 * `buildPerson` is pure. It assembles a `Person` from three independent pieces of evidence and
 * never turns a missing fact into a number: unknown stays `null`.
 */

/** The part of a bank cash-flow summary (`analyzeTransactions`) that describes a typical month. */
export const bankSummaryInput = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  monthCount: z.number().int().min(1).max(24),
  dataStatus: z.enum(['unknown', 'partial', 'observed']),
  incomeCents: z.number().int().safe().nonnegative(),
  expenseCents: z.number().int().safe().nonnegative(),
  /**
   * True when every movement behind the totals is fabricated, false when real bank data is included.
   * Absent in summaries produced before the flag was carried; the person then states it as unknown.
   */
  synthetic: z.boolean().optional(),
});
export type BankSummaryInput = z.infer<typeof bankSummaryInput>;
export type HabitState = z.input<typeof stateSchema>;

type FieldProvenance = { confirmed: boolean; observedAt: string };
/** The `resolved` part of `GET /users/:id/context` (`resolveInputs`); only the fields read here matter. */
export type PersonContext = {
  resolved: {
    data: Record<string, Record<string, unknown> | undefined>;
    provenance?: Record<string, FieldProvenance[] | undefined>;
  };
};

export type BuildPersonInput = {
  userId: string;
  /**
   * Whether the person's records are fictional. Required: a missing flag is never defaulted, because
   * real data must not be labelled synthetic nor the reverse.
   */
  synthetic: boolean;
  context: PersonContext;
  bankSummary?: BankSummaryInput;
  habitState?: HabitState;
  /** The context stores the current municipality as a name; the caller resolves it to a code. */
  currentMunicipalityCode?: string | null;
  displayName?: string;
};

/** A non-negative whole number of cents, or null for anything else (missing, conflicting, malformed). */
function centsOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Share of recorded check-ins that were completed; null when the habit has no check-ins. */
function adherence(goalId: string, checkins: HabitState['checkins']): number | null {
  const own = checkins.filter(checkin => checkin.goalId === goalId);
  return own.length ? own.filter(checkin => checkin.completed).length / own.length : null;
}

/**
 * The household facts used to screen incentives, from the `eligibility` group of the resolved inputs.
 * A fact is taken only when a confirmed input states it; an unconfirmed, conflicting (null) or
 * malformed value is left out, so the screening keeps it at needs_verification. Nothing is inferred:
 * the household size or the number of dependants never becomes a child's age or a family status.
 * The purchase price is not read here; the planner screens with the price of the plan.
 */
function householdFrom(
  facts: Record<string, unknown> | undefined,
  provenance: Record<string, FieldProvenance[] | undefined>,
): Person['household'] {
  const known: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(facts ?? {})) {
    if (value === null || value === undefined || field === 'purchasePriceEur') continue;
    if (!provenance[`eligibility.${field}`]?.some(item => item.confirmed)) continue;
    const schema = (householdFacts.shape as Record<string, z.ZodType | undefined>)[field];
    const parsed = schema?.safeParse(value);
    if (parsed?.success) known[field] = parsed.data;
  }
  return Object.keys(known).length ? householdFacts.parse(known) : undefined;
}

/**
 * Stored goals are habits the person adopted: `active` or `paused`, never merely `proposed`.
 * The start day travels with the habit; a goal stored before the day was recorded has none.
 */
export function habitsFromState(state: HabitState | undefined): Habit[] {
  if (!state) return [];
  const { goals, checkins } = stateSchema.parse(state);
  return goals.map(goal => ({
    ...(goal.startedOn === null ? {} : { startedOn: goal.startedOn }),
    id: goal.id,
    title: goal.title,
    category: goal.category,
    monthlySavingCents: goal.plannedMonthlySavingCents,
    status: goal.active ? ('active' as const) : ('paused' as const),
    adherence: adherence(goal.id, checkins),
  }));
}

/**
 * Assemble a `Person`.
 *
 * Precedence for monthly income and monthly expenses, decided per figure:
 *   1. a declaration the person confirmed;
 *   2. otherwise the bank average, but only when every requested month was observed;
 *   3. otherwise an unconfirmed declaration (for example the saved profile snapshot);
 *   4. otherwise unknown (`null`).
 * A bank summary is evidence: it replaces a guess, never a confirmed statement. `basis` reports
 * which rule supplied the two figures: `declared`, `bank_observed`, `mixed` or `unknown`;
 * `incomeBasis` and `expensesBasis` say it for each figure, and `bankSynthetic` says whether the
 * movements behind a bank-observed figure are fabricated (a real person can use a fictional bank).
 *
 * Debt is counted once. Declared expenses are `monthlyExpensesCents + debtPaymentsCents` (the
 * interview already folds debt into spending and sends debt as zero). Bank expenses already contain
 * the debt movements, so declared debt is not added to them.
 *
 * Household facts for incentive screening come only from confirmed `eligibility` inputs (see
 * `householdFrom`). `synthetic` is whatever the caller states; it has no default.
 *
 * Savings and the emergency reserve are always declared: a bank balance is never assumed to be
 * money available for the purchase. An undeclared reserve is 0, which the plan states out loud.
 */
export function buildPerson(input: BuildPersonInput): Person {
  const { data, provenance = {} } = input.context.resolved;
  const finance = data.finance ?? {};
  const confirmed = (field: string) => provenance[`finance.${field}`]?.some(item => item.confirmed) ?? false;

  const bank = input.bankSummary ? bankSummaryInput.parse(input.bankSummary) : undefined;
  const observed = bank?.dataStatus === 'observed' ? bank : undefined;
  const declaredIncome = centsOrNull(finance.monthlyIncomeCents);
  const declaredSpending = centsOrNull(finance.monthlyExpensesCents);
  const declaredExpenses =
    declaredSpending === null ? null : declaredSpending + (centsOrNull(finance.debtPaymentsCents) ?? 0);
  // Monthly averages are rounded to the nearest cent.
  const bankIncome = observed ? Math.round(observed.incomeCents / observed.monthCount) : null;
  const bankExpenses = observed ? Math.round(observed.expenseCents / observed.monthCount) : null;

  const choose = (declared: number | null, isConfirmed: boolean, fromBank: number | null) => {
    if (declared !== null && isConfirmed) return { value: declared, basis: 'declared' as const };
    if (fromBank !== null) return { value: fromBank, basis: 'bank_observed' as const };
    if (declared !== null) return { value: declared, basis: 'declared' as const };
    return { value: null, basis: 'unknown' as const };
  };
  const income = choose(declaredIncome, confirmed('monthlyIncomeCents'), bankIncome);
  const expenses = choose(declaredExpenses, confirmed('monthlyExpensesCents'), bankExpenses);
  const known = [income.basis, expenses.basis].filter(basis => basis !== 'unknown');
  const basis = !known.length ? 'unknown' : known.every(item => item === known[0]) ? known[0] : 'mixed';

  const usesBank = known.includes('bank_observed');
  const declaredDates = Object.entries(provenance)
    .filter(([field]) => field.startsWith('finance.'))
    .flatMap(([, items]) => (items ?? []).map(item => item.observedAt.slice(0, 10)))
    .filter(date => z.iso.date().safeParse(date).success)
    .sort();
  const asOf = usesBank && observed ? observed.to : (declaredDates.at(-1) ?? null);

  const size = data.household?.size;
  const facts = householdFrom(data.eligibility, provenance);
  return person.parse({
    id: input.userId,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    synthetic: input.synthetic,
    ...(facts ? { household: facts } : {}),
    householdSize: typeof size === 'number' && Number.isInteger(size) && size >= 1 ? size : null,
    currentMunicipalityCode: input.currentMunicipalityCode ?? null,
    finances: {
      monthlyIncomeCents: income.value,
      monthlyExpensesCents: expenses.value,
      currentSavingsCents: centsOrNull(finance.currentSavingsCents),
      emergencyReserveCents: centsOrNull(finance.emergencyReserveCents) ?? 0,
      basis,
      asOf,
      incomeBasis: income.basis,
      expensesBasis: expenses.basis,
      bankSynthetic: usesBank ? (observed?.synthetic ?? null) : null,
    },
    home: {
      floorAreaM2: positiveOrNull(data.housing?.homeSizeM2),
      // A budget of zero is not a price: it is left unknown.
      budgetCents: centsOrNull(data.housing?.budgetCents) || null,
    },
    habits: habitsFromState(input.habitState),
  });
}
