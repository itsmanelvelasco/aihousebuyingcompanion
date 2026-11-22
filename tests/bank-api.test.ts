import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBankStore, manualAccountId } from '../apps/profile-api/bank.ts';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { createStatementImports, maxStatementRows, readStatement } from '../apps/profile-api/statements.ts';
import { createAccounts } from '../packages/auth/accounts.ts';
import { defineBankProvider } from '../packages/banks/provider.ts';
import { createBankRegistry } from '../packages/banks/registry.ts';
import type { BankEvent } from '../packages/banks/sync.ts';
import { createBankSync } from '../packages/banks/sync.ts';
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

// ------------------------------------------------------------ statements a person imports

const header = 'date,description,amount';
const september = [
  '2026-09-01,Salary September,2100.00',
  '2026-09-03,Rent,-800.00',
  '2026-09-05,Cafe Central,-2.40',
  '2026-09-05,Cafe Central,-2.40',
  '2026-09-10,Internal transfer to savings,-300.00',
  '2026-09-20,Refund Amazon,19.99',
  '2026-09-21,Free sample,0.00',
  '2026-09-30,Mercadona,-64.20',
];
const october = ['2026-10-01,Salary October,2100.00', '2026-10-03,Rent,-800.00', '2026-10-31,Netflix,-12.99'];
const statementA = [header, ...september, ...october].join('\n');

/** A person who signed up (real, not fictional), the ledger store and the statement store with a clock. */
async function importer() {
  const db = open(':memory:');
  const account = await createAccounts(db).signUp({
    email: 'ada@example.com',
    password: 'correct horse battery',
    address: 'a',
  });
  const clock = { now: Date.parse('2026-11-22T10:00:00Z') };
  const bank = createBankStore(db);
  const statements = createStatementImports(db, bank, () => new Date(clock.now));
  const events: BankEvent[] = [];
  bank.onEvent(event => events.push(event));
  return { db, userId: account.userId, clock, bank, statements, events };
}

test('a statement is summarised first and written only by confirming that summary; repeats and overlaps write each movement once', async () => {
  const { db, userId, bank, statements, events } = await importer();
  try {
    const preview = await statements.preview(userId, statementA);
    assert.deepEqual(
      {
        rows: preview.rowCount,
        new: preview.newRows,
        known: preview.alreadyInLedger,
        zero: preview.skippedZeroAmountRows,
        from: preview.coveredFrom,
        to: preview.coveredTo,
        basis: preview.averageBasis,
        monthly: preview.monthlyFigures,
        again: preview.alreadyImported,
        synthetic: preview.synthetic,
        account: preview.accountId,
      },
      {
        rows: 10,
        new: 10,
        known: 0,
        zero: 1,
        from: '2026-09-01',
        to: '2026-10-31',
        basis: 'complete_months',
        monthly: true,
        again: false,
        synthetic: false,
        account: 'manual-import',
      },
    );
    // Rows as they would be stored, per category; the totals leave the transfer between own accounts out.
    assert.deepEqual(preview.byCategory, {
      income: { count: 2, cents: 420000 },
      housing: { count: 2, cents: -160000 },
      food: { count: 3, cents: -6900 },
      internal_transfer: { count: 1, cents: -30000 },
      other: { count: 1, cents: 1999 },
      subscriptions: { count: 1, cents: -1299 },
    });
    assert.deepEqual(preview.periodTotals, { inflowCents: 421999, outflowCents: 168199, netCents: 253800 });
    assert.match(preview.previewHash, /^[0-9a-f]{40}$/);
    // Nothing was written: no account, no movement, no revision, no event. Only the upload waits.
    assert.deepEqual(
      [(await bank.head(userId)).revision, (await bank.read(userId)).transactions.length, events.length],
      [0, 0, 0],
    );
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bank_import_previews')?.n, 1);

    // A hash that is not this person's live preview confirms nothing.
    for (const wrong of ['', 'not-a-hash', 'f'.repeat(40), preview.previewHash.toUpperCase(), undefined])
      await assert.rejects(statements.confirm(userId, wrong), { status: 409 });
    assert.equal((await bank.read(userId)).transactions.length, 0);

    const written = await statements.confirm(userId, preview.previewHash);
    assert.deepEqual(
      [written.inserted, written.duplicates, written.alreadyImported, written.synthetic, written.revision],
      [10, 0, false, false, 1],
    );
    const ledger = await bank.read(userId);
    assert.deepEqual(ledger.accounts, [
      {
        id: manualAccountId,
        name: 'Statements you imported',
        currency: 'EUR',
        openingBalanceCents: 0,
        openingDate: '2026-09-01',
        synthetic: false,
      },
    ]);
    assert(
      ledger.transactions.every(
        row => row.synthetic === false && row.accountId === manualAccountId && row.status === 'booked',
      ),
    );
    // Two identical rows of the statement are two movements; one revision and one event for the whole import.
    assert.equal(ledger.transactions.filter(row => row.description === 'cafe central').length, 2);
    assert.equal(new Set(ledger.transactions.map(row => row.id)).size, 10);
    assert.deepEqual([ledger.revision, ledger.synthetic, events.length], [1, false, 1]);
    const summary = await bank.summary(userId, { from: '2026-09-01', to: '2026-10-31' });
    assert.deepEqual(
      [summary.synthetic, summary.incomeCents, summary.expenseCents, summary.excludedInternalTransferCount],
      [false, 421999, 168199, 1],
    );
    // The confirmation used the upload up.
    await assert.rejects(statements.confirm(userId, preview.previewHash), { status: 409 });
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bank_import_previews')?.n, 0);

    // The same statement again: the preview says so, and confirming it changes nothing at all.
    const again = await statements.preview(userId, statementA);
    assert.deepEqual(
      [again.previewHash, again.newRows, again.alreadyInLedger, again.alreadyImported],
      [preview.previewHash, 0, 10, true],
    );
    const repeated = await statements.confirm(userId, again.previewHash);
    assert.deepEqual([repeated.inserted, repeated.alreadyImported, repeated.revision], [0, true, 1]);
    assert.equal(events.length, 1);
    // The same rows in another order, with other line endings and a BOM, are the same statement.
    const shuffled = `\uFEFF${[header, ...october, ...september].join('\r\n')}\r\n`;
    assert.equal(readStatement(shuffled).batch.importId, written.importId);
    assert.deepEqual(
      (({ newRows, alreadyImported }) => [newRows, alreadyImported])(await statements.preview(userId, shuffled)),
      [0, true],
    );

    // An overlapping statement (October again, plus August and November) adds only what is new,
    // and moves the account's opening date back so the earlier movements fit.
    const statementB = [header, '2026-08-28,Mercadona,-31.10', ...october, '2026-11-02,Salary November,2100.00'].join(
      '\n',
    );
    const overlap = await statements.preview(userId, statementB);
    assert.deepEqual(
      [overlap.rowCount, overlap.newRows, overlap.alreadyInLedger, overlap.alreadyImported],
      [5, 2, 3, false],
    );
    const merged = await statements.confirm(userId, overlap.previewHash);
    assert.deepEqual([merged.inserted, merged.duplicates], [2, 3]);
    assert.equal((await bank.read(userId)).accounts[0].openingDate, '2026-08-28');
    assert.equal((await bank.read(userId)).transactions.length, 12);
    assert.deepEqual(
      (await statements.list(userId)).map(item => [item.rowCount, item.coveredFrom, item.coveredTo]).sort(),
      [
        [10, '2026-09-01', '2026-10-31'],
        [5, '2026-08-28', '2026-11-02'],
      ].sort(),
    );

    // Deleting a statement removes the movements only it brought: October stays while B still states it.
    const [idA, idB] = [written.importId, merged.importId];
    assert.deepEqual(await statements.remove(userId, idA), { deleted: idA, removedMovements: 7 });
    assert.deepEqual((await bank.read(userId)).transactions.map(row => row.date).sort(), [
      '2026-08-28',
      '2026-10-01',
      '2026-10-03',
      '2026-10-31',
      '2026-11-02',
    ]);
    await assert.rejects(statements.remove(userId, idA), { status: 404 });
    assert.deepEqual(await statements.remove(userId, idB), { deleted: idB, removedMovements: 5 });
    assert.equal((await bank.read(userId)).transactions.length, 0);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bank_import_rows')?.n, 0);
  } finally {
    db.close();
  }
});

test('a statement too short for a monthly figure says so, uploads expire, and what is not a statement is refused', async () => {
  const { db, userId, clock, bank, statements } = await importer();
  try {
    // Three days: the reader gives no monthly figure, and the preview repeats that instead of scaling.
    const short = await statements.preview(
      userId,
      [header, '2026-11-01,Salary,2100.00', '2026-11-03,Rent,-800.00'].join('\n'),
    );
    assert.deepEqual([short.averageBasis, short.monthlyFigures, short.coveredDays], ['period_too_short', false, 3]);
    assert.match(short.averagingNote, /3 day\(s\)\. That is too short for a monthly figure, so none is given/);
    assert.match(short.guidance ?? '', /Do not present any amount as monthly income, spending or an average/);
    assert.deepEqual(short.periodTotals, { inflowCents: 210000, outflowCents: 80000, netCents: 130000 });
    // The movements themselves are real and can be imported; only the monthly reading is withheld.
    assert.equal((await statements.confirm(userId, short.previewHash)).inserted, 2);

    // An upload waits fifteen minutes, then it has to be read again.
    const waiting = await statements.preview(userId, statementA);
    clock.now += 15 * 60_000 + 1;
    await assert.rejects(statements.confirm(userId, waiting.previewHash), { status: 409 });
    assert.equal(statements.housekeeping(), 1);
    assert.equal((await bank.read(userId)).transactions.length, 2);
    // At most three uploads wait per person; a fourth pushes the oldest out.
    const hashes: string[] = [];
    for (let n = 1; n <= 4; n++) {
      clock.now += 1000;
      hashes.push((await statements.preview(userId, `${header}\n2026-10-0${n},Coffee ${n},-1.00`)).previewHash);
    }
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bank_import_previews')?.n, 3);
    await assert.rejects(statements.confirm(userId, hashes[0]), { status: 409 });
    assert.deepEqual(await statements.discard(userId, hashes[1]), { discarded: true });
    assert.deepEqual(await statements.discard(userId, hashes[1]), { discarded: false });
    assert.equal((await statements.confirm(userId, hashes[3])).inserted, 1);

    // Refused: not a statement, no usable row, too many rows, too large, an unknown person.
    const refusals: [string, number, RegExp][] = [
      ['', 400, /empty/],
      ['name,value\nx,1', 400, /date, description, and amount columns/],
      [`${header}\n2026-13-45,Rent,-1.00`, 400, /Invalid transaction on data row 1/],
      [`${header}\n2026-10-01,Rent,minus ten`, 400, /Invalid transaction/],
      [`${header}\n2026-10-01,Free sample,0.00`, 400, /no row with an amount/],
      [`${header}\n${'2026-10-01,Coffee,-1.00\n'.repeat(maxStatementRows + 1)}`, 400, /more than 2000 rows/],
      [`${header}\n${`2026-10-01,${'x'.repeat(180)},-1.00\n`.repeat(1500)}`, 413, /larger than 256 KiB/],
    ];
    for (const [csv, status, message] of refusals)
      await assert.rejects(statements.preview(userId, csv), { status, message }, csv.slice(0, 40));
    await assert.rejects(statements.preview('p-000000000000000000000000000000', statementA), { status: 404 });
    await assert.rejects(statements.confirm('p-000000000000000000000000000000', hashes[2]), { status: 404 });
  } finally {
    db.close();
  }
});

test('a category the person chose is kept when the bank reports the movement again, and only imported movements can be deleted', async () => {
  const { db, userId, bank, statements } = await importer();
  const feed = { amountCents: -4500, status: 'pending' as 'pending' | 'booked', category: 'food' as const };
  const provider = defineBankProvider({
    id: 'tiny-bank',
    displayName: 'Tiny Bank',
    synthetic: false,
    env: [],
    listAccounts: async () => [
      { id: 'tiny-main', name: 'Main', currency: 'EUR' as const, openingBalanceCents: 0, openingDate: '2026-01-01' },
    ],
    fetchTransactions: async () => ({
      transactions: [
        { id: 'tiny-1', accountId: 'tiny-main', date: '2026-11-10', description: 'Transfer to my savings', ...feed },
      ],
    }),
  });
  const sync = createBankSync({ ledger: bank, registry: createBankRegistry([provider], {}), db, housekeepingMs: null });
  const stored = () =>
    db.get<{ category: string; status: string; amount: number; locked: number }>(
      "SELECT category, status, amount_cents AS amount, category_locked AS locked FROM bank_transactions WHERE id = 'tiny-1'",
    )!;
  try {
    await sync.connect(userId, { providerId: 'tiny-bank', ref: 'link-1', pollIntervalMs: null });
    await sync.sync(userId);
    assert.deepEqual(stored(), { category: 'food', status: 'pending', amount: -4500, locked: 0 });

    // The bank called it food; the person knows it was a transfer between their own accounts.
    const revision = (await bank.head(userId)).revision;
    assert.deepEqual((await bank.setCategory(userId, 'tiny-1', 'internal_transfer')).result, {
      id: 'tiny-1',
      category: 'internal_transfer',
      categoryChosen: true,
    });
    assert.equal((await bank.head(userId)).revision, revision + 1);
    assert.equal(
      (await bank.setCategory(userId, 'tiny-1', 'internal_transfer')).ledger.revision,
      revision + 1,
      'saying it again changes nothing',
    );
    await assert.rejects(bank.setCategory(userId, 'tiny-1', 'income'), { status: 400, message: /cannot be income/ });
    await assert.rejects(bank.setCategory(userId, 'tiny-1', 'groceries'), { name: 'ZodError' });
    await assert.rejects(bank.setCategory(userId, 'tiny-2', 'other'), { status: 404 });

    // The same movement again: nothing to do. The bank books it: the row is updated and the choice kept.
    assert.deepEqual(
      (({ inserted, updated, duplicates }) => [inserted, updated, duplicates])(
        await sync.syncConnection(userId, (await sync.listConnections(userId))[0].id),
      ),
      [0, 0, 1],
    );
    feed.status = 'booked';
    await sync.sync(userId);
    assert.deepEqual(stored(), { category: 'internal_transfer', status: 'booked', amount: -4500, locked: 1 });
    const listed = await bank.recent(userId, {}, { limit: 10, offset: 0 });
    assert.deepEqual(
      [listed.total, listed.movements[0].categoryChosen, listed.movements[0].category],
      [1, true, 'internal_transfer'],
    );
    // A choice that no longer fits the amount (the bank now reports money in) gives way to the bank's.
    await bank.setCategory(userId, 'tiny-1', 'transport');
    feed.amountCents = 4500;
    Object.assign(feed, { category: 'other' });
    await sync.sync(userId);
    assert.deepEqual([stored().category, stored().amount], ['other', 4500]);

    // A movement that came from the bank is not deleted by the person: it would simply come back.
    await assert.rejects(bank.deleteManual(userId, 'tiny-1'), {
      status: 403,
      message: /would come back with the next sync/,
    });
    await assert.rejects(bank.deleteManual(userId, 'unknown'), { status: 404 });
    // One they imported can be; the statement then no longer brings it, and deleting the statement removes the rest.
    const preview = await statements.preview(userId, [header, ...october].join('\n'));
    const imported = await statements.confirm(userId, preview.previewHash);
    const netflix = (await bank.read(userId)).transactions.find(row => row.description === 'netflix')!;
    assert.deepEqual((await bank.deleteManual(userId, netflix.id)).result, { deleted: netflix.id });
    assert.deepEqual(await statements.remove(userId, imported.importId), {
      deleted: imported.importId,
      removedMovements: 2,
    });
    assert.deepEqual(
      (await bank.read(userId)).transactions.map(row => row.id),
      ['tiny-1'],
    );
  } finally {
    await sync.close();
    db.close();
  }
});
