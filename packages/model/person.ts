import { z } from 'zod';
import { stateSchema } from '../contracts/habits.ts';
import { childInput } from '../contracts/inputs.ts';
import { household as householdFacts } from '../contracts/places.ts';
import type { FactAnswer, Habit, Person, PersonInput } from '../contracts/planner.ts';
import { person, personInput } from '../contracts/planner.ts';
import { questions } from './questions.ts';

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

type FieldProvenance = { confirmed: boolean; observedAt: string; source?: string };
type FieldConflict = { field: string; candidates: (FieldProvenance & { value?: unknown })[] };
/** The `resolved` part of `GET /users/:id/context` (`resolveInputs`); only the fields read here matter. */
export type PersonContext = {
  resolved: {
    data: Record<string, Record<string, unknown> | undefined>;
    provenance?: Record<string, FieldProvenance[] | undefined>;
    /** Fields whose latest answers disagree; such a field resolves to null and is reported, never picked. */
    conflicts?: FieldConflict[];
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
    // The children are read by `childrenFrom`: they can carry dates of birth, which the screening does not hold.
    if (value === null || value === undefined || field === 'purchasePriceEur' || field === 'children') continue;
    if (!provenance[`eligibility.${field}`]?.some(item => item.confirmed)) continue;
    const schema = (householdFacts.shape as Record<string, z.ZodType | undefined>)[field];
    const parsed = schema?.safeParse(value);
    if (parsed?.success) known[field] = parsed.data;
  }
  return Object.keys(known).length ? householdFacts.parse(known) : undefined;
}

type Born = NonNullable<Person['born']>;
type BornChild = NonNullable<Born['children']>[number];

/**
 * The children of a confirmed `eligibility.children` input. A schooling flag that is `null` (the
 * person does not know) is left off, so the screening keeps the measure unverified. A list where
 * every child has a plain age goes to the screening as it is; a list with a date or a year of birth
 * is kept as stated, and the planner derives each age on the date of the plan.
 */
function childrenFrom(
  value: unknown,
  confirmed: boolean,
): { born?: BornChild[]; ages?: NonNullable<Person['household']>['children'] } {
  const parsed = confirmed ? z.array(childInput).max(30).safeParse(value) : undefined;
  if (!parsed?.success) return {};
  const children = parsed.data.map(({ inDesignatedSchool, meetsItpSchooling, ...when }) => ({
    ...when,
    ...(typeof inDesignatedSchool === 'boolean' ? { inDesignatedSchool } : {}),
    ...(typeof meetsItpSchooling === 'boolean' ? { meetsItpSchooling } : {}),
  }));
  if (children.every(child => child.age !== undefined))
    return { ages: children.map(({ birthDate: _, birthYear: __, ...child }) => ({ ...child, age: child.age ?? 0 })) };
  return { born: children };
}

const answerSources = new Set(['profile', 'interview', 'manual', 'bank', 'listing']);

/**
 * Where each answer of the question set came from, by question id. A field in conflict is reported
 * with its candidates; a field stated as `null` is "I don't know"; a household fact nobody confirmed
 * is `unconfirmed`, because the screening does not read it. A question that was never answered has
 * no entry.
 */
function answersFrom(context: PersonContext['resolved']): Record<string, FactAnswer> {
  const { data, provenance = {}, conflicts = [] } = context;
  const answers: Record<string, FactAnswer> = {};
  for (const question of questions) {
    const [group, field] = question.path.split('.');
    const items = provenance[question.path] ?? [];
    if (!items.length) continue;
    const latest = items.reduce((a, b) => (a.observedAt >= b.observedAt ? a : b));
    const confirmed = items.some(item => item.confirmed);
    const stamp = {
      ...(latest.source && answerSources.has(latest.source) ? { source: latest.source as FactAnswer['source'] } : {}),
      observedAt: latest.observedAt,
      confirmed,
    };
    const conflict = conflicts.find(item => item.field === question.path);
    const value = data[group]?.[field];
    if (conflict) {
      answers[question.id] = {
        ...stamp,
        status: 'conflict',
        candidates: conflict.candidates.slice(0, 10).map(candidate => ({
          value: candidate.value ?? null,
          source: candidate.source ?? 'unknown',
          observedAt: candidate.observedAt,
          confirmed: candidate.confirmed,
        })),
      };
      continue;
    }
    if (value === null || value === undefined) {
      answers[question.id] = { ...stamp, status: 'said_unknown' };
      continue;
    }
    if (question.kind.type === 'per_child') {
      // The flags live on each child: the question is answered once a child carries its flag.
      const flag = question.kind.flag;
      const flags = Array.isArray(value) ? value.map(child => (child as Record<string, unknown> | null)?.[flag]) : [];
      if (!flags.some(item => item !== undefined)) continue;
      answers[question.id] = {
        ...stamp,
        status: !confirmed ? 'unconfirmed' : flags.some(item => item === null) ? 'said_unknown' : 'known',
      };
      continue;
    }
    // The plan's own figures are used even when unconfirmed (see `buildPerson`); a household fact is not.
    answers[question.id] = {
      ...stamp,
      status: confirmed || question.group === 'plan' ? 'known' : 'unconfirmed',
    };
  }
  // An age stored instead of a date of birth answers the same question, and its date says how old it is.
  const age = provenance['eligibility.age'] ?? [];
  if (!answers.birthDate && age.length && typeof data.eligibility?.age === 'number') {
    const latest = age.reduce((a, b) => (a.observedAt >= b.observedAt ? a : b));
    const confirmed = age.some(item => item.confirmed);
    answers.birthDate = {
      ...(latest.source && answerSources.has(latest.source) ? { source: latest.source as FactAnswer['source'] } : {}),
      observedAt: latest.observedAt,
      confirmed,
      status: confirmed ? 'known' : 'unconfirmed',
    };
  }
  return answers;
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
 * `householdFrom`). A confirmed date of birth goes to `born.self` and replaces a stored age: the
 * planner derives the age on the date of each plan, so it cannot go stale. Children stated with a
 * date or a year of birth go to `born.children` the same way. `answers` says where each answer came
 * from and which were "I don't know" or in conflict. `synthetic` is whatever the caller states; it
 * has no default.
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
  const isConfirmed = (path: string) => provenance[path]?.some(item => item.confirmed) ?? false;
  const children = childrenFrom(data.eligibility?.children, isConfirmed('eligibility.children'));
  const birthDate = isConfirmed('eligibility.birthDate') ? z.iso.date().safeParse(data.eligibility?.birthDate) : null;
  const screened = householdFrom(data.eligibility, provenance);
  // A date of birth is the better source of an age; a stored age stays only without one.
  const { age: storedAge, ...otherFacts } = screened ?? {};
  const facts = {
    ...otherFacts,
    ...(storedAge !== undefined && !birthDate?.success ? { age: storedAge } : {}),
    ...(children.ages ? { children: children.ages } : {}),
  };
  const born = {
    ...(birthDate?.success ? { self: birthDate.data } : {}),
    ...(children.born ? { children: children.born } : {}),
  };
  const answers = answersFrom(input.context.resolved);
  const depositRate = data.housing?.depositRate;
  return person.parse({
    id: input.userId,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    synthetic: input.synthetic,
    ...(Object.keys(facts).length ? { household: facts } : {}),
    ...(Object.keys(born).length ? { born } : {}),
    ...(Object.keys(answers).length ? { answers } : {}),
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
      // An explicit upfront target is kept as stated; the plan shows it beside its own figure.
      ...(centsOrNull(finance.targetCashCents) === null
        ? {}
        : { targetCashCents: centsOrNull(finance.targetCashCents) }),
    },
    home: {
      floorAreaM2: positiveOrNull(data.housing?.homeSizeM2),
      // A budget of zero is not a price: it is left unknown.
      budgetCents: centsOrNull(data.housing?.budgetCents) || null,
      // The share of the price paid upfront, when the person stated one; the contract defaults to 20%.
      ...(typeof depositRate === 'number' && depositRate >= 0 && depositRate <= 1 ? { depositRate } : {}),
    },
    habits: habitsFromState(input.habitState),
  });
}

/**
 * A person sent inline with a request, completed: whatever was left out is unknown or empty (see
 * `personInput`). Monthly figures that arrive without a `basis` were said in the conversation, so
 * they are `declared`; with no monthly figure the basis is `unknown`.
 */
export function inlinePerson(input: PersonInput = {}): Person {
  const parsed = personInput.parse(input);
  const { monthlyIncomeCents, monthlyExpensesCents } = parsed.finances;
  const stated = monthlyIncomeCents !== null || monthlyExpensesCents !== null;
  return person.parse({
    ...parsed,
    finances: { ...parsed.finances, basis: parsed.finances.basis ?? (stated ? 'declared' : 'unknown') },
  });
}
