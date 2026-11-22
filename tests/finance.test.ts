import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Transaction } from '../packages/finance/cashflow.ts';
import {
  analyzeTransactions,
  scenarioSchema,
  simulateSavings,
  transactionSchema,
} from '../packages/finance/cashflow.ts';

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
