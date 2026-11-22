import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Transaction } from '../packages/finance/cashflow.ts';
import {
  analyzeTransactions,
  scenarioSchema,
  simulateSavings,
  transactionSchema,
} from '../packages/finance/cashflow.ts';
import { compareSavings, parseTransactions, summarizeCsv, summarizeTransactions } from '../packages/finance/csv.ts';
import { maxPlanningMonths, monthsToTarget } from '../packages/finance/savings.ts';
import { generateFirstScenario } from '../packages/finance/scenario.ts';

function movement(overrides: Partial<Transaction> = {}): Transaction {
  return transactionSchema.parse({
    id: 'tx-1',
    accountId: 'current',
    date: '2026-10-01',
    description: 'Salary',
    amountCents: 100000,
    currency: 'EUR',
    category: 'income',
    synthetic: true,
    ...overrides,
  });
}
const period = ['2026-10-01', '2026-10-31'] as const;
test('cash flow excludes own transfers and pending movements and counts debt once', () => {
  const summary = analyzeTransactions(
    [
      movement(),
      movement({ id: 'rent', amountCents: -50000, category: 'housing' }),
      movement({ id: 'debt', amountCents: -10000, category: 'debt' }),
      movement({ id: 'own-out', amountCents: -40000, category: 'internal_transfer' }),
      movement({ id: 'own-in', amountCents: 40000, category: 'internal_transfer' }),
      movement({ id: 'pending', amountCents: -20000, category: 'food', status: 'pending' }),
    ],
    ...period,
  );
  assert.equal(summary.incomeCents, 100000);
  assert.equal(summary.expenseCents, 60000);
  assert.equal(summary.netCashflowCents, 40000);
  assert.equal(summary.spendingByCategory.debt, 10000);
  assert.equal(summary.averageMonthlySavingsCents, 40000);
  assert.equal(summary.excludedInternalTransferCount, 2);
  assert.equal(summary.excludedPendingCount, 1);
});
test('recurring candidates require distinct months and ignore future or pending history', () => {
  const monthly = (date: string, id: string, description = 'Video Plan') =>
    movement({ id, date, description, category: 'subscriptions', amountCents: -1000 });
  const history = [
    monthly('2026-09-01', 'a'),
    monthly('2026-09-15', 'b'),
    monthly('2026-10-01', 'c', ' video   plan '),
    monthly('2026-11-01', 'd', 'Future only'),
  ];
  const summary = analyzeTransactions(history, ...period);
  assert.equal(summary.recurringExpenses.length, 1);
  assert.deepEqual(summary.recurringExpenses[0].observedMonths, ['2026-09', '2026-10']);
  assert.equal(summary.recurringExpenses[0].status, 'candidate_needs_confirmation');
  assert.equal(analyzeTransactions(history, '2026-09-01', '2026-09-30').recurringExpenses.length, 0);
});
test('no data or empty months are unknown for projections, while balanced observed flow is zero', () => {
  const empty = analyzeTransactions([], ...period);
  assert.equal(empty.averageMonthlySavingsCents, null);
  assert.equal(
    simulateSavings(
      empty,
      scenarioSchema.parse({ targetCashCents: 100, currentSavingsCents: 0, extraMonthlySavingsCents: 50 }),
    ).scenarioMonthsToTarget,
    null,
  );
  const partial = analyzeTransactions([movement()], '2026-09-01', '2026-10-31');
  assert.equal(partial.dataStatus, 'partial');
  assert.equal(partial.averageMonthlySavingsCents, null);
  const balanced = analyzeTransactions(
    [movement(), movement({ id: 'expense', amountCents: -100000, category: 'other' })],
    ...period,
  );
  assert.equal(balanced.averageMonthlySavingsCents, 0);
  const negative = analyzeTransactions([movement({ amountCents: -1000, category: 'food' })], ...period);
  assert.equal(
    simulateSavings(negative, scenarioSchema.parse({ targetCashCents: 10000, currentSavingsCents: 0 }))
      .baselineMonthsToTarget,
    null,
  );
});
test('scenario respects reserves, extra savings and already reached targets', () => {
  const summary = analyzeTransactions([movement()], ...period);
  const result = simulateSavings(
    summary,
    scenarioSchema.parse({
      targetCashCents: 600000,
      currentSavingsCents: 200000,
      emergencyReserveCents: 100000,
      extraMonthlySavingsCents: 100000,
    }),
  );
  assert.equal(result.availableSavingsCents, 100000);
  assert.equal(result.baselineMonthsToTarget, 5);
  assert.equal(result.scenarioMonthsToTarget, 3);
  assert.equal(
    simulateSavings(
      analyzeTransactions([], ...period),
      scenarioSchema.parse({ targetCashCents: 10, currentSavingsCents: 10 }),
    ).baselineMonthsToTarget,
    0,
  );
});
test('schemas reject invalid dates, unsafe amounts and incompatible signs', () => {
  assert.throws(() => movement({ date: '2026-02-30' }));
  assert.throws(() => movement({ amountCents: 1.5 }));
  assert.throws(() => movement({ amountCents: 0 }));
  assert.throws(() => movement({ amountCents: -1 }));
  assert.throws(() => movement({ amountCents: 1, category: 'food' }));
  assert.throws(() => movement({ id: '../escape' }));
  assert.throws(() => analyzeTransactions([], '2026-10-02', '2026-10-31'));
  assert.throws(() => analyzeTransactions([], '2026-10-01', '2026-10-30'));
  assert.throws(() => analyzeTransactions([], '2026-11-01', '2026-10-31'));
  assert.throws(() => analyzeTransactions([], '2024-01-01', '2026-01-31'));
});

test('the timeline rule rounds up, gives nothing for no savings and stops at the planning horizon', () => {
  assert.equal(maxPlanningMonths, 600);
  assert.equal(monthsToTarget(0, 0), 0);
  assert.equal(monthsToTarget(-5, null), 0);
  assert.equal(monthsToTarget(1001, 500), 3);
  for (const monthly of [0, -1, null, Number.NaN]) assert.equal(monthsToTarget(1000, monthly), null);
  // 600 months is still a timeline; 601 is not, and one cent a month never yields millions of months.
  assert.equal(monthsToTarget(600_000, 1000), 600);
  assert.equal(monthsToTarget(600_001, 1000), null);
  assert.equal(monthsToTarget(2_200_000, 1), null);
  assert.equal(monthsToTarget(1, Number.MIN_VALUE), null);
  assert.deepEqual(compareSavings({ target: 22_000, saved: 0, monthly: 0.01, habit: 100 }), {
    remaining: 22_000,
    baselineMonths: null,
    withHabitMonths: 220,
  });
});

const csv = (...rows: string[]) => ['date,description,amount', ...rows].join('\n');

test('a CSV is averaged over its complete months only, and the partial ones are named', () => {
  // October in full, then one coffee on 1 November: November is not a month of data.
  const summary = summarizeCsv(csv('2026-10-01,Salary,2000', '2026-10-15,Rent,-800', '2026-11-01,Coffee,-3'));
  assert.deepEqual(
    [summary.observedMonths, summary.completeMonths, summary.partialMonths, summary.averageBasis],
    [['2026-10', '2026-11'], ['2026-10'], ['2026-11'], 'complete_months'],
  );
  assert.deepEqual([summary.coveredFrom, summary.coveredTo], ['2026-10-01', '2026-11-01']);
  assert.equal(summary.estimatedMonthlySalary, 2000);
  assert.equal(summary.salaryMonths, 1);
  assert.equal(summary.monthlyInflows, 2000);
  assert.equal(summary.monthlyCostOfLiving, 800);
  assert.equal(summary.monthlyNetCashFlow, 1200);
  assert.deepEqual(summary.monthlyExpenses, { Rent: 800 }, 'the November coffee is in no average');
  assert.equal(summary.transactionCount, 3, 'every row is still counted as read');
  assert.match(summary.averagingNote, /averages of 1 complete month\(s\): 2026-10\. Left out as partial: 2026-11/);

  // A month is complete only when the rows reach both its first and its last day.
  const edges = summarizeCsv(
    csv('2026-08-02,Salary,1000', '2026-09-01,Salary,3000', '2026-09-20,Rent,-900', '2026-10-30,Salary,5000'),
  );
  assert.deepEqual([edges.completeMonths, edges.partialMonths], [['2026-09'], ['2026-08', '2026-10']]);
  assert.equal(edges.estimatedMonthlySalary, 3000);
  assert.equal(edges.monthlyCostOfLiving, 900);
  // A covered month without a single row is a month with no movements: it counts in the divisor.
  const quiet = summarizeCsv(csv('2026-08-01,Salary,3000', '2026-10-31,Rent,-900'));
  assert.deepEqual(quiet.completeMonths, ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual([quiet.estimatedMonthlySalary, quiet.salaryMonths, quiet.monthlyCostOfLiving], [1000, 1, 300]);
  // February of a leap year ends on the 29th.
  assert.deepEqual(summarizeCsv(csv('2028-02-01,Salary,1', '2028-02-28,Rent,-1')).completeMonths, []);
  assert.deepEqual(summarizeCsv(csv('2028-02-01,Salary,1', '2028-02-29,Rent,-1')).completeMonths, ['2028-02']);
  // An own-account transfer is excluded whichever month it falls in.
  const transfers = summarizeCsv(
    csv('2026-10-01,Salary,2000', '2026-10-31,Internal transfer,-500', '2026-11-02,Internal transfer,500'),
  );
  assert.deepEqual([transfers.excludedTransfers, transfers.monthlyCostOfLiving], [2, 0]);
});

test('a CSV with only partial months says so instead of presenting a monthly average', () => {
  // A salary on 28 October and a coffee on 1 November: five days, no complete month.
  const summary = summarizeCsv(csv('2026-10-28,Salary,2000', '2026-11-01,Coffee,-3'));
  assert.deepEqual(
    [summary.completeMonths, summary.partialMonths, summary.averageBasis],
    [[], ['2026-10', '2026-11'], 'partial_months_only'],
  );
  assert.match(summary.averagingNote, /covers no complete calendar month \(2026-10, 2026-11 are partial\)/);
  assert.match(summary.averagingNote, /5 day\(s\) spread over 1 month\(s\): a rough indication, not a monthly average/);
  // The totals of the days covered, never divided by the two calendar months the rows touch.
  assert.deepEqual(
    [summary.estimatedMonthlySalary, summary.monthlyCostOfLiving, summary.monthlyNetCashFlow, summary.salaryMonths],
    [2000, 3, 1997, 1],
  );
  // Thirty-seven days across two calendar months are about 1.2 months (365.25 / 12 days each), not two.
  const span = summarizeCsv(csv('2026-10-15,Salary,2000', '2026-11-20,Rent,-900'));
  assert.equal(span.averageBasis, 'partial_months_only');
  assert.deepEqual([span.estimatedMonthlySalary, span.monthlyCostOfLiving], [1645.27, 740.37]);
  assert.match(span.averagingNote, /37 day\(s\) spread over 1.22 month\(s\)/);
  // A single row is one day, counted as one month at least: never a salary multiplied by thirty.
  const single = summarizeCsv(csv('2026-10-28,Salary,2000'));
  assert.deepEqual([single.estimatedMonthlySalary, single.averageBasis], [2000, 'partial_months_only']);
  // The summary can be built from parsed rows, which carry their date.
  const rows = parseTransactions(csv('2026-10-28,Salary,2000'));
  assert.deepEqual(rows, [{ date: '2026-10-28', month: '2026-10', label: 'salary', cents: 200_000 }]);
  assert.deepEqual(summarizeTransactions(rows), single);
});

test('the demo statement is averaged over August and September; the cut-off October is left out', async () => {
  const scenario = await generateFirstScenario({
    target: 20_000,
    saved: 5000,
    monthly: 500,
    currency: 'EUR',
    useDemoBank: true,
  });
  assert.equal(scenario.baselineMonths, 30);
  assert.deepEqual(
    scenario.suggestions.map(suggestion => suggestion.category),
    ['other', 'subscriptions', 'food', 'transport'],
  );
});
