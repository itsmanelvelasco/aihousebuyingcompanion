import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { createStore } from '../apps/profile-api/store.ts';
import { createBankStore } from '../apps/profile-api/bank.ts';

test('bank API persists movements, validates atomic imports and calculates isolated household plans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relocat-bank-api-'));
  const profiles = createStore(root);
  const document = { schemaVersion: 1 as const, synthetic: true as const };
  for (const id of ['alice', 'bob']) {
    await profiles.create(id, {
      details: { ...document, id }, preferences: document,
      'bank-account': { ...document, snapshotDate: '2026-11-21', balanceCents: 100000, monthlyIncomeCents: 200000, monthlyExpensesCents: 150000, debtPaymentsCents: 10000 }
    });
  }
  const server = createProfileApi(root, 'bank-test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/users`;
  async function request(path: string, method = 'GET', body?: unknown, authorized = true) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer bank-test-token' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, data: await response.json() };
  }
  const account = { id: 'current', name: 'Fictional current', currency: 'EUR', openingBalanceCents: 5000, openingDate: '2026-10-01', synthetic: true };
  const movement = (id: string, amountCents: number, category = 'other') => ({ id, accountId: 'current', date: '2026-10-10', description: `Fictional ${id}`, amountCents, currency: 'EUR', category, status: 'booked', synthetic: true });
  const salary = movement('salary', 100000, 'income');
  const rent = movement('rent', -40000, 'housing');
  const period = '?from=2026-10-01&to=2026-10-31';
  try {
    for (const [path, method, body] of [
      ['/alice/bank/accounts', 'GET', undefined],
      ['/alice/bank/accounts', 'POST', account],
      [`/alice/bank/summary${period}`, 'GET', undefined],
      [`/alice/bank/simulate${period}`, 'POST', {}]
    ] as const) assert.equal((await request(path, method, body, false)).status, 401);

    assert.equal((await request('/alice/bank/accounts', 'POST', account)).status, 201);
    assert.equal((await request('/alice/bank/accounts', 'POST', account)).status, 409);
    const updatedAccount = { ...account, name: 'Renamed fictional account' };
    assert.equal((await request('/alice/bank/accounts/current', 'PUT', updatedAccount)).status, 200);
    assert.equal((await request('/alice/bank/accounts/current', 'PUT', { ...account, id: 'wrong' })).status, 400);
    const initialAccounts = await request('/alice/bank/accounts?asOf=2026-10-01');
    assert.equal(initialAccounts.data.accounts[0].name, updatedAccount.name);
    assert.equal(initialAccounts.data.accounts[0].balanceCents, 5000);
    assert.equal((await request('/alice/bank/accounts?asOf=2026-09-30')).data.accounts[0].balanceCents, null);

    const imported = await request('/alice/bank/transactions', 'POST', { transactions: [salary, rent] });
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.data, { inserted: 2, duplicates: 0 });
    assert.deepEqual((await request('/alice/bank/transactions', 'POST', { transactions: [salary, rent] })).data, { inserted: 0, duplicates: 2 });
    assert.equal((await request('/alice/bank/transactions', 'POST', { transactions: [movement('should-not-save', -500), { ...salary, amountCents: 100001 }] })).status, 409);
    assert.equal((await request('/alice/bank/transactions')).data.total, 2, 'a conflicting batch must leave no partial rows');
    assert.equal((await request('/alice/bank/transactions', 'POST', { transactions: [{ ...salary, id: 'unknown', accountId: 'missing' }] })).status, 400);
    assert.equal((await request('/alice/bank/transactions', 'POST', { transactions: [{ ...salary, id: 'bad-date', date: '2026-02-30' }] })).status, 400);
    assert.equal((await request('/alice/bank/transactions', 'POST', { transactions: [{ ...salary, id: 'too-early', date: '2026-09-30' }] })).status, 400);
    assert.equal((await request('/alice/bank/transactions')).data.total, 2);

    const concurrent = await Promise.all([
      request('/alice/bank/transactions', 'POST', { transactions: [movement('tx-a', -1000, 'food')] }),
      request('/alice/bank/transactions', 'POST', { transactions: [movement('tx-b', -2000, 'transport')] })
    ]);
    assert.ok(concurrent.every(result => result.status === 200 && result.data.inserted === 1));
    assert.equal((await request('/alice/bank/transactions')).data.total, 4, 'serialized imports preserve both writes');
    assert.equal((await request('/alice/bank/transactions/tx-a', 'PUT', movement('tx-a', -3000, 'food'))).status, 200);
    assert.equal((await request('/alice/bank/transactions/tx-b', 'DELETE')).status, 200);
    assert.equal((await request('/alice/bank/transactions/tx-b', 'DELETE')).status, 404);
    assert.equal((await request('/alice/bank/transactions?limit=1&offset=1&accountId=current')).data.transactions.length, 1);
    assert.equal((await request('/alice/bank/transactions?accountId=missing')).status, 404);
    assert.equal((await request('/alice/bank/transactions?from=2026-11-01&to=2026-10-01')).status, 400);
    assert.equal((await request('/alice/bank/accounts/current', 'PUT', { ...account, openingDate: '2026-10-11' })).status, 400);

    const summary = await request(`/alice/bank/summary${period}`);
    assert.equal(summary.status, 200);
    assert.equal(summary.data.incomeCents, 100000);
    assert.equal(summary.data.expenseCents, 43000);
    assert.equal(summary.data.netCashflowCents, 57000);
    assert.equal(summary.data.averageMonthlySavingsCents, 57000);
    assert.equal((await request('/alice/bank/accounts?asOf=2026-10-31')).data.accounts[0].balanceCents, 62000);
    assert.equal((await request('/alice/bank/summary?from=2026-10-02&to=2026-10-31')).status, 400);
    const simulation = await request(`/alice/bank/simulate${period}`, 'POST', { targetCashCents: 300000, currentSavingsCents: 50000, extraMonthlySavingsCents: 10000 });
    assert.equal(simulation.status, 200);
    assert.equal(simulation.data.baselineMonthsToTarget, 5);
    assert.equal(simulation.data.scenarioMonthsToTarget, 4);

    assert.equal((await request('/bob/bank/transactions')).data.total, 0);
    assert.equal((await request('/bob/bank/accounts')).data.accounts.length, 0);
    assert.equal((await request(`/bob/bank/simulate${period}`, 'POST', { targetCashCents: 300000, currentSavingsCents: 50000 })).data.status, 'insufficient_data');
    assert.equal((await request('/missing/bank/accounts')).status, 404);
    const persisted = await createBankStore(root).read('alice');
    assert.equal(persisted.transactions.length, 3);
    assert.equal(persisted.transactions.find(tx => tx.id === 'tx-a')?.amountCents, -3000);
    assert.equal(persisted.accounts[0].name, updatedAccount.name);

    assert.equal((await request('/alice/bank/demo', 'POST', {})).status, 409);
    const seeded = await request('/bob/bank/demo', 'POST', {});
    assert.equal(seeded.status, 201);
    assert.equal(seeded.data.from, '2026-08-01');
    assert.equal(seeded.data.to, '2026-10-31');
    assert.equal((await request('/bob/bank/demo', 'POST', {})).status, 409);
    const seededSummary = await request('/bob/bank/summary?from=2026-08-01&to=2026-10-31');
    assert.equal(seededSummary.data.incomeCents, 600000);
    assert.equal(seededSummary.data.expenseCents, 480000);
    assert.equal(seededSummary.data.netCashflowCents, 120000);
    assert.equal(seededSummary.data.averageMonthlySavingsCents, 40000);
    assert.equal(seededSummary.data.monthlyTotals.length, 3);
    assert.ok(seededSummary.data.recurringExpenses.length >= 2);
    assert.equal((await request('/bob/bank/accounts?asOf=2026-10-31')).data.accounts[0].balanceCents, 100000);
    assert.equal((await request('/alice/bank/transactions')).data.total, 3, 'seeding another user must not touch existing movements');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
