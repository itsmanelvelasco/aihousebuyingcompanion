import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBankStore } from '../apps/profile-api/bank.ts';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { open } from '../packages/db/database.ts';
import { createStore } from '../packages/profiles/store.ts';

test('bank API persists movements, validates atomic imports and calculates isolated household plans', async () => {
  const db = open(':memory:');
  const profiles = createStore(db);
  const document = { schemaVersion: 1 as const, synthetic: true as const };
  for (const id of ['alice', 'bob']) {
    await profiles.create(id, {
      details: { ...document, id },
      preferences: document,
      'bank-account': {
        ...document,
        snapshotDate: '2026-11-21',
        balanceCents: 100000,
        monthlyIncomeCents: 200000,
        monthlyExpensesCents: 150000,
        debtPaymentsCents: 10000,
      },
    });
  }
  const server = createProfileApi(db, 'bank-test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/users`;
  async function request(path: string, method = 'GET', body?: unknown, authorized = true) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { Authorization: 'Bearer bank-test-token' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  const account = {
    id: 'current',
    name: 'Fictional current',
    currency: 'EUR',
    openingBalanceCents: 5000,
    openingDate: '2026-10-01',
    synthetic: true,
  };
  const movement = (id: string, amountCents: number, category = 'other') => ({
    id,
    accountId: 'current',
    date: '2026-10-10',
    description: `Fictional ${id}`,
    amountCents,
    currency: 'EUR',
    category,
    status: 'booked',
    synthetic: true,
  });
  const salary = movement('salary', 100000, 'income');
  const rent = movement('rent', -40000, 'housing');
  const period = '?from=2026-10-01&to=2026-10-31';
  try {
    for (const [path, method, body] of [
      ['/alice/bank/accounts', 'GET', undefined],
      ['/alice/bank/accounts', 'POST', account],
      [`/alice/bank/summary${period}`, 'GET', undefined],
      [`/alice/bank/simulate${period}`, 'POST', {}],
    ] as const)
      assert.equal((await request(path, method, body, false)).status, 401);

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
    assert.deepEqual((await request('/alice/bank/transactions', 'POST', { transactions: [salary, rent] })).data, {
      inserted: 0,
      duplicates: 2,
    });
    assert.equal(
      (
        await request('/alice/bank/transactions', 'POST', {
          transactions: [movement('should-not-save', -500), { ...salary, amountCents: 100001 }],
        })
      ).status,
      409,
    );
    assert.equal(
      (await request('/alice/bank/transactions')).data.total,
      2,
      'a conflicting batch must leave no partial rows',
    );
    assert.equal(
      (
        await request('/alice/bank/transactions', 'POST', {
          transactions: [{ ...salary, id: 'unknown', accountId: 'missing' }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request('/alice/bank/transactions', 'POST', {
          transactions: [{ ...salary, id: 'bad-date', date: '2026-02-30' }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request('/alice/bank/transactions', 'POST', {
          transactions: [{ ...salary, id: 'too-early', date: '2026-09-30' }],
        })
      ).status,
      400,
    );
    assert.equal((await request('/alice/bank/transactions')).data.total, 2);

    const concurrent = await Promise.all([
      request('/alice/bank/transactions', 'POST', { transactions: [movement('tx-a', -1000, 'food')] }),
      request('/alice/bank/transactions', 'POST', { transactions: [movement('tx-b', -2000, 'transport')] }),
    ]);
    assert.ok(concurrent.every(result => result.status === 200 && result.data.inserted === 1));
    assert.equal((await request('/alice/bank/transactions')).data.total, 4, 'serialized imports preserve both writes');
    assert.equal((await request('/alice/bank/transactions/tx-a', 'PUT', movement('tx-a', -3000, 'food'))).status, 200);
    assert.equal((await request('/alice/bank/transactions/tx-b', 'DELETE')).status, 200);
    assert.equal((await request('/alice/bank/transactions/tx-b', 'DELETE')).status, 404);
    assert.equal(
      (await request('/alice/bank/transactions?limit=1&offset=1&accountId=current')).data.transactions.length,
      1,
    );
    assert.equal((await request('/alice/bank/transactions?accountId=missing')).status, 404);
    assert.equal((await request('/alice/bank/transactions?from=2026-11-01&to=2026-10-01')).status, 400);
    assert.equal(
      (await request('/alice/bank/accounts/current', 'PUT', { ...account, openingDate: '2026-10-11' })).status,
      400,
    );

    const summary = await request(`/alice/bank/summary${period}`);
    assert.equal(summary.status, 200);
    assert.equal(summary.data.incomeCents, 100000);
    assert.equal(summary.data.expenseCents, 43000);
    assert.equal(summary.data.netCashflowCents, 57000);
    assert.equal(summary.data.averageMonthlySavingsCents, 57000);
    assert.equal((await request('/alice/bank/accounts?asOf=2026-10-31')).data.accounts[0].balanceCents, 62000);
    assert.equal((await request('/alice/bank/summary?from=2026-10-02&to=2026-10-31')).status, 400);
    const simulation = await request(`/alice/bank/simulate${period}`, 'POST', {
      targetCashCents: 300000,
      currentSavingsCents: 50000,
      extraMonthlySavingsCents: 10000,
    });
    assert.equal(simulation.status, 200);
    assert.equal(simulation.data.baselineMonthsToTarget, 5);
    assert.equal(simulation.data.scenarioMonthsToTarget, 4);

    assert.equal((await request('/bob/bank/transactions')).data.total, 0);
    assert.equal((await request('/bob/bank/accounts')).data.accounts.length, 0);
    assert.equal(
      (await request(`/bob/bank/simulate${period}`, 'POST', { targetCashCents: 300000, currentSavingsCents: 50000 }))
        .data.status,
      'insufficient_data',
    );
    assert.equal((await request('/missing/bank/accounts')).status, 404);
    const persisted = await createBankStore(db).read('alice');
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
    assert.equal(
      (await request('/alice/bank/transactions')).data.total,
      3,
      'seeding another user must not touch existing movements',
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    db.close();
  }
});

test('bank aggregates say all synthetic only when every record is, and never for a real person without records', async () => {
  const db = open(':memory:');
  const profiles = createStore(db);
  const fictional = { schemaVersion: 1 as const, synthetic: true };
  const real = { schemaVersion: 1 as const, synthetic: false };
  await profiles.create('user-001', {
    details: { ...fictional, id: 'user-001' },
    preferences: fictional,
    'bank-account': fictional,
  });
  await profiles.create('p-real', { details: { ...real, id: 'p-real' }, preferences: real, 'bank-account': real });
  const bank = createBankStore(db);
  const period = { from: '2026-10-01', to: '2026-10-31' };
  const account = (id: string, synthetic: boolean) => ({
    id,
    name: synthetic ? 'Banc Demo current' : 'Current account',
    currency: 'EUR',
    openingBalanceCents: 0,
    openingDate: '2026-10-01',
    synthetic,
  });
  const movement = (id: string, accountId: string, synthetic: boolean) => ({
    id,
    accountId,
    date: '2026-10-10',
    description: `Movement ${id}`,
    amountCents: -1000,
    currency: 'EUR',
    category: 'other',
    status: 'booked',
    synthetic,
  });
  const flags = async (id: string) => [
    (await bank.head(id)).synthetic,
    (await bank.summary(id, period)).synthetic,
    (await bank.events(id, 0, 10)).synthetic,
    (await bank.balances(id, '2026-10-31')).synthetic,
    (await bank.transactions(id, {}, { limit: 10, offset: 0 })).synthetic,
  ];
  try {
    // No bank records at all: a fixture persona is fictional, a real person is not called synthetic.
    assert.deepEqual(await flags('user-001'), [true, true, true, true, true]);
    assert.deepEqual(await flags('p-real'), [false, false, false, false, false]);

    // The real person connects the fictional demo bank: the movements are synthetic and say so.
    await bank.createAccount('p-real', account('demo', true));
    await bank.importTransactions('p-real', { transactions: [movement('d-1', 'demo', true)] });
    assert.deepEqual(await flags('p-real'), [true, true, true, true, true]);
    const summary = await bank.summary('p-real', period);
    assert.deepEqual([summary.synthetic, summary.transactionCount, summary.expenseCents], [true, 1, 1000]);
    // ...while the person stays real: the two flags are separate facts.
    assert.equal(profiles.isSynthetic('p-real'), false);
    assert.equal((await bank.events('p-real', 0, 10)).events.at(-1)?.synthetic, true);

    // One real movement, even outside the period asked for, and nothing is "all synthetic" any more.
    await bank.createAccount('p-real', account('own', false));
    assert.deepEqual(await flags('p-real'), [false, true, false, false, false]);
    await bank.importTransactions('p-real', {
      transactions: [{ ...movement('r-1', 'own', false), date: '2026-11-02' }],
    });
    assert.deepEqual(await flags('p-real'), [false, false, false, false, false]);
    assert.equal((await bank.summary('p-real', period)).transactionCount, 1);
    // Each record still carries its own flag.
    const page = await bank.transactions('p-real', {}, { limit: 10, offset: 0 });
    assert.deepEqual(
      page.transactions.map(tx => [tx.id, tx.synthetic]),
      [
        ['d-1', true],
        ['r-1', false],
      ],
    );
  } finally {
    db.close();
  }
});
