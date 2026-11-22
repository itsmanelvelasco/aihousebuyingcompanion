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
    synthetic: z.literal(true),
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

export function analyzeTransactions(transactions: Transaction[], from: string, to: string) {
  periodSchema.parse({ from, to });
  const history = transactions.filter(t => t.date <= to && t.status === 'booked' && t.category !== 'internal_transfer');
  const selected = history.filter(t => t.date >= from);
  const incomeCents = sum(selected.filter(t => t.amountCents > 0).map(t => t.amountCents));
  const expenseCents = sum(selected.filter(t => t.amountCents < 0).map(t => -t.amountCents));
  const netCashflowCents = sum([incomeCents, -expenseCents]);
  const months = monthIndex(to) - monthIndex(from) + 1;
  const spendingByCategory: Record<string, number> = {};
  for (const transaction of selected.filter(t => t.amountCents < 0)) {
    spendingByCategory[transaction.category] = sum([
      spendingByCategory[transaction.category] ?? 0,
      -transaction.amountCents,
    ]);
  }
  const monthlyTotals = Array.from({ length: months }, (_, offset) => {
    const index = monthIndex(from) + offset;
    const month = `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
    const movements = selected.filter(t => t.date.startsWith(month));
    const income = sum(movements.filter(t => t.amountCents > 0).map(t => t.amountCents));
    const expenses = sum(movements.filter(t => t.amountCents < 0).map(t => -t.amountCents));
    return {
      month,
      incomeCents: income,
      expenseCents: expenses,
      netCashflowCents: sum([income, -expenses]),
      transactionCount: movements.length,
      dataStatus: movements.length ? 'observed' : 'unknown',
    };
  });
  const groups = new Map<string, Transaction[]>();
  for (const transaction of history.filter(t => t.amountCents < 0)) {
    const key = JSON.stringify([
      transaction.accountId,
      transaction.category,
      transaction.description.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim(),
    ]);
    groups.set(key, [...(groups.get(key) ?? []), transaction]);
  }
  const recurringExpenses = [...groups.values()]
    .filter(group => new Set(group.map(t => t.date.slice(0, 7))).size >= 2)
    .map(group => ({
      description: group[0].description,
      accountId: group[0].accountId,
      category: group[0].category,
      observedMonths: [...new Set(group.map(t => t.date.slice(0, 7)))].sort(),
      occurrenceCount: group.length,
      averagePaymentCents: Math.round(sum(group.map(t => -t.amountCents)) / group.length),
      status: 'candidate_needs_confirmation' as const,
    }));
  const dataStatus =
    selected.length === 0
      ? 'unknown'
      : monthlyTotals.some(month => month.transactionCount === 0)
        ? 'partial'
        : 'observed';
  return {
    synthetic: true as const,
    currency: 'EUR' as const,
    from,
    to,
    monthCount: months,
    dataStatus,
    transactionCount: selected.length,
    incomeCents,
    expenseCents,
    netCashflowCents,
    spendingByCategory,
    monthlyTotals,
    recurringExpenses,
    averageMonthlySavingsCents: dataStatus === 'observed' ? Math.floor(netCashflowCents / months) : null,
    excludedPendingCount: transactions.filter(t => t.date >= from && t.date <= to && t.status === 'pending').length,
    excludedInternalTransferCount: transactions.filter(
      t => t.date >= from && t.date <= to && t.status === 'booked' && t.category === 'internal_transfer',
    ).length,
    assumptions: [
      'Amounts are integer EUR cents; expense totals are positive and net cash flow is income minus expenses.',
      'Only booked external movements are counted; transfers between owned accounts are excluded.',
      'Each requested calendar month must contain external booked movements for a savings estimate; completeness of imported transactions is not guaranteed.',
      'Savings capacity is a historical arithmetic average, not a promise of sustainable future savings.',
      'Recurring expenses are candidates based on matching account, category and normalized description in at least two distinct historical months.',
    ],
  };
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
    synthetic: true as const,
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
