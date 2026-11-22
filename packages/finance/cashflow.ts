import { z } from 'zod';

import { safeId } from '../contracts/ids.ts';
import { monthsToTarget } from './savings.ts';
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Use a real calendar date in YYYY-MM-DD format');
export const transactionSchema = z
  .object({
    id: safeId,
    accountId: safeId,
    date: dateSchema,
    description: z.string().trim().min(1).max(200),
    amountCents: z
      .number()
      .int()
      .safe()
      .min(-100_000_000_000)
      .max(100_000_000_000)
      .refine(value => value !== 0, 'Amount must be nonzero'),
    currency: z.literal('EUR'),
    category: z.enum([
      'income',
      'housing',
      'food',
      'transport',
      'utilities',
      'subscriptions',
      'healthcare',
      'education',
      'debt',
      'other',
      'internal_transfer',
    ]),
    status: z.enum(['booked', 'pending']).default('booked'),
    /** True for fabricated records, false for real bank data. Required: a missing flag is never read as real. */
    synthetic: z.boolean(),
  })
  .strict()
  .superRefine((transaction, context) => {
    if (transaction.category === 'income' && transaction.amountCents < 0)
      context.addIssue({ code: 'custom', path: ['amountCents'], message: 'Income must be positive' });
    if (!['income', 'other', 'internal_transfer'].includes(transaction.category) && transaction.amountCents > 0)
      context.addIssue({
        code: 'custom',
        path: ['amountCents'],
        message: 'Expense categories must be negative; use other for refunds',
      });
  });
export type Transaction = z.infer<typeof transactionSchema>;

const balance = z.number().int().min(-100_000_000_000).max(100_000_000_000);
/** A bank account of the ledger: an opening balance on a day, and movements from that day on. */
export const accountSchema = z
  .object({
    id: safeId,
    name: z.string().trim().min(1).max(100),
    currency: z.literal('EUR'),
    openingBalanceCents: balance,
    openingDate: dateSchema,
    /** True for fabricated accounts, false for accounts of a real bank. */
    synthetic: z.boolean(),
  })
  .strict();
export type Account = z.infer<typeof accountSchema>;
/** Most accounts kept per user. */
export const maxAccounts = 20;
/**
 * Most movements kept per user. It stops a runaway feed from growing the database without end
 * (Banc Demo at its default pace takes about three weeks to produce that for one customer).
 */
export const defaultMaxTransactions = 100_000;

export const periodSchema = z
  .object({ from: dateSchema, to: dateSchema })
  .strict()
  .superRefine(({ from, to }, context) => {
    if (from > to) context.addIssue({ code: 'custom', path: ['to'], message: 'End date must not precede start date' });
    const end = new Date(`${to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    if (!from.endsWith('-01') || end.getUTCDate() !== 1)
      context.addIssue({ code: 'custom', message: 'Analysis requires complete calendar months' });
    const count = monthIndex(to) - monthIndex(from) + 1;
    if (count > 24) context.addIssue({ code: 'custom', message: 'Maximum analysis range is 24 months' });
  });
function monthIndex(date: string) {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}
function sum(values: number[]) {
  const total = values.reduce((accumulator, value) => accumulator + value, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError('Monetary total exceeds safe integer range');
  return total;
}

/** A result is synthetic only when every record it could draw on is; one real record makes it real. */
export function allSynthetic(records: readonly { synthetic: boolean }[]) {
  return records.every(record => record.synthetic);
}

/** Months before the period in which an earlier occurrence still makes an expense recurring. */
export const recurringLookbackMonths = 12;

function monthName(index: number) {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** First day of the window in which recurring expenses are looked for: the lookback before `from`. */
export function recurringSince(from: string) {
  return `${monthName(Math.max(0, monthIndex(from) - recurringLookbackMonths))}-01`;
}

/**
 * What a period analysis is computed from. The database produces it with two grouped queries
 * (`cashflowCells` and `expenseGroups` in `packages/db/ledger.ts`); `aggregateTransactions` produces
 * the same thing from movements in memory. Either way the analysis never needs the rows themselves.
 */
export type CashflowAggregates = {
  /** Movements dated inside the period, counted and summed per month, category and status. */
  cells: {
    month: string;
    category: string;
    status: string;
    count: number;
    incomeCents: number;
    expenseCents: number;
  }[];
  /**
   * Booked expenses, transfers between own accounts left out, dated from `recurringSince(from)` to
   * the end of the period, grouped by account, category and exact description, in the order each
   * group first appeared.
   */
  expenseGroups: {
    accountId: string;
    category: string;
    description: string;
    occurrenceCount: number;
    totalCents: number;
    months: string[];
  }[];
};

/** The aggregates of `from`–`to`, computed in memory from movements in the order they were imported. */
export function aggregateTransactions(transactions: Transaction[], from: string, to: string): CashflowAggregates {
  const cells = new Map<string, CashflowAggregates['cells'][number]>();
  const groups = new Map<string, CashflowAggregates['expenseGroups'][number]>();
  const since = recurringSince(from);
  for (const transaction of transactions) {
    const { date, category, status, amountCents } = transaction;
    if (date > to) continue;
    const month = date.slice(0, 7);
    if (date >= from) {
      const key = `${month}|${category}|${status}`;
      const cell = cells.get(key) ?? { month, category, status, count: 0, incomeCents: 0, expenseCents: 0 };
      cell.count++;
      if (amountCents > 0) cell.incomeCents = sum([cell.incomeCents, amountCents]);
      else cell.expenseCents = sum([cell.expenseCents, -amountCents]);
      cells.set(key, cell);
    }
    if (date >= since && status === 'booked' && category !== 'internal_transfer' && amountCents < 0) {
      const key = JSON.stringify([transaction.accountId, category, transaction.description]);
      const group = groups.get(key) ?? {
        accountId: transaction.accountId,
        category,
        description: transaction.description,
        occurrenceCount: 0,
        totalCents: 0,
        months: [],
      };
      group.occurrenceCount++;
      group.totalCents = sum([group.totalCents, -amountCents]);
      if (!group.months.includes(month)) group.months.push(month);
      groups.set(key, group);
    }
  }
  return { cells: [...cells.values()], expenseGroups: [...groups.values()] };
}

/**
 * Cash flow of complete calendar months, from aggregates. `synthetic` is stated by the caller: true
 * only when every movement the result could draw on is fabricated.
 */
export function summarizeCashflow(aggregates: CashflowAggregates, from: string, to: string, synthetic: boolean) {
  periodSchema.parse({ from, to });
  const inPeriod = aggregates.cells.filter(cell => cell.month >= from.slice(0, 7) && cell.month <= to.slice(0, 7));
  const selected = inPeriod.filter(cell => cell.status === 'booked' && cell.category !== 'internal_transfer');
  const incomeCents = sum(selected.map(cell => cell.incomeCents));
  const expenseCents = sum(selected.map(cell => cell.expenseCents));
  const netCashflowCents = sum([incomeCents, -expenseCents]);
  const months = monthIndex(to) - monthIndex(from) + 1;
  const spendingByCategory: Record<string, number> = {};
  for (const cell of selected) {
    if (cell.expenseCents > 0)
      spendingByCategory[cell.category] = sum([spendingByCategory[cell.category] ?? 0, cell.expenseCents]);
  }
  const monthlyTotals = Array.from({ length: months }, (_, offset) => {
    const month = monthName(monthIndex(from) + offset);
    const movements = selected.filter(cell => cell.month === month);
    const income = sum(movements.map(cell => cell.incomeCents));
    const expenses = sum(movements.map(cell => cell.expenseCents));
    const transactionCount = sum(movements.map(cell => cell.count));
    return {
      month,
      incomeCents: income,
      expenseCents: expenses,
      netCashflowCents: sum([income, -expenses]),
      transactionCount,
      dataStatus: transactionCount ? 'observed' : 'unknown',
    };
  });
  // The same payee written with different capitals or spacing is one recurring expense.
  const merged = new Map<string, CashflowAggregates['expenseGroups'][number]>();
  for (const group of aggregates.expenseGroups) {
    const key = JSON.stringify([
      group.accountId,
      group.category,
      group.description.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim(),
    ]);
    const known = merged.get(key);
    if (!known) merged.set(key, { ...group, months: [...group.months] });
    else {
      known.occurrenceCount += group.occurrenceCount;
      known.totalCents = sum([known.totalCents, group.totalCents]);
      known.months = [...new Set([...known.months, ...group.months])];
    }
  }
  const recurringExpenses = [...merged.values()]
    .filter(group => group.months.length >= 2)
    .map(group => ({
      description: group.description,
      accountId: group.accountId,
      category: group.category,
      observedMonths: [...group.months].sort(),
      occurrenceCount: group.occurrenceCount,
      averagePaymentCents: Math.round(group.totalCents / group.occurrenceCount),
      status: 'candidate_needs_confirmation' as const,
    }));
  const transactionCount = sum(selected.map(cell => cell.count));
  const dataStatus =
    transactionCount === 0
      ? 'unknown'
      : monthlyTotals.some(month => month.transactionCount === 0)
        ? 'partial'
        : 'observed';
  return {
    synthetic,
    currency: 'EUR' as const,
    from,
    to,
    monthCount: months,
    dataStatus,
    transactionCount,
    incomeCents,
    expenseCents,
    netCashflowCents,
    spendingByCategory,
    monthlyTotals,
    recurringExpenses,
    averageMonthlySavingsCents: dataStatus === 'observed' ? Math.floor(netCashflowCents / months) : null,
    excludedPendingCount: sum(inPeriod.filter(cell => cell.status === 'pending').map(cell => cell.count)),
    excludedInternalTransferCount: sum(
      inPeriod
        .filter(cell => cell.status === 'booked' && cell.category === 'internal_transfer')
        .map(cell => cell.count),
    ),
    assumptions: [
      'Amounts are integer EUR cents; expense totals are positive and net cash flow is income minus expenses.',
      'Only booked external movements are counted; transfers between owned accounts are excluded.',
      'Each requested calendar month must contain external booked movements for a savings estimate; completeness of imported transactions is not guaranteed.',
      'Savings capacity is a historical arithmetic average, not a promise of sustainable future savings.',
      `Recurring expenses are candidates based on matching account, category and normalized description in at least two distinct months of the period and the ${recurringLookbackMonths} months before it.`,
    ],
  };
}

/** Cash flow of complete calendar months, from movements held in memory. */
export function analyzeTransactions(transactions: Transaction[], from: string, to: string) {
  periodSchema.parse({ from, to });
  return summarizeCashflow(aggregateTransactions(transactions, from, to), from, to, allSynthetic(transactions));
}

const money = z.number().int().safe().nonnegative().max(100_000_000_000);
export const scenarioSchema = z
  .object({
    targetCashCents: money,
    currentSavingsCents: money,
    extraMonthlySavingsCents: money.default(0),
    emergencyReserveCents: money.default(0),
  })
  .strict();
export function simulateSavings(
  summary: ReturnType<typeof analyzeTransactions>,
  input: z.infer<typeof scenarioSchema>,
) {
  const values = scenarioSchema.parse(input);
  const availableSavingsCents = Math.max(0, values.currentSavingsCents - values.emergencyReserveCents);
  const shortfallCents = Math.max(0, values.targetCashCents - availableSavingsCents);
  const baseline = summary.averageMonthlySavingsCents;
  const scenario = baseline === null ? null : sum([baseline, values.extraMonthlySavingsCents]);
  const months = (monthly: number | null) => monthsToTarget(shortfallCents, monthly);
  const suggestions: { code: string; message: string }[] = [];
  if (baseline === null)
    suggestions.push({
      code: 'complete_transaction_history',
      message: 'Import and confirm complete calendar-month movements before estimating a savings timeline.',
    });
  else if (baseline <= 0)
    suggestions.push({
      code: 'review_cashflow_gap',
      message:
        'Observed spending meets or exceeds income. Review recurring commitments and missing movements before setting a new savings commitment.',
    });
  if ((summary.spendingByCategory.subscriptions ?? 0) > 0)
    suggestions.push({
      code: 'review_subscriptions',
      message:
        'Review subscription expenses and confirm which, if any, you want to reduce. No cancellation is assumed.',
    });
  return {
    synthetic: summary.synthetic,
    currency: 'EUR' as const,
    ...values,
    availableSavingsCents,
    shortfallCents,
    baselineMonthlySavingsCents: baseline,
    scenarioMonthlySavingsCents: scenario,
    baselineMonthsToTarget: months(baseline),
    scenarioMonthsToTarget: months(scenario),
    status:
      shortfallCents === 0
        ? 'target_reached'
        : baseline === null
          ? 'insufficient_data'
          : scenario !== null && scenario > 0
            ? 'estimated'
            : 'no_positive_savings',
    suggestions,
    assumptions: [
      ...summary.assumptions,
      'The emergency reserve is excluded from available purchase savings.',
      'The target is explicitly supplied, including any deposit, taxes and fees the user chooses; no lending or tax formula is inferred.',
      'The scenario assumes the requested extra monthly savings are achievable and repeats the historical average without interest, inflation or income changes.',
      'Zero or negative savings produce no finite timeline unless the target is already reached. Months are rounded up.',
      'This calculation does not assess creditworthiness, eligibility, investment suitability or mortgage approval.',
    ],
  };
}
