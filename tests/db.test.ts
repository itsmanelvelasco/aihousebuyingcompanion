import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { getView, openDemo, persistDemoRuns, updateDemo } from '../apps/board/demo.ts';
import { createHabitStore } from '../apps/habits-agent/store.ts';
import { createBankStore } from '../apps/profile-api/bank.ts';
import { createInputStore } from '../apps/profile-api/inputs.ts';
import type { ProviderTransaction } from '../packages/banks/provider.ts';
import { defineBankProvider } from '../packages/banks/provider.ts';
import { createBankRegistry } from '../packages/banks/registry.ts';
import { createBankSync } from '../packages/banks/sync.ts';
import { countSeenWebhooks, enqueueWebhook, pendingWebhooks, seenRetention } from '../packages/db/bank-sync.ts';
import { countBoardRuns } from '../packages/db/board.ts';
import type { Database } from '../packages/db/database.ts';
import { appliedMigrations, integrityCheck, open, readMeta, SchemaTooNewError } from '../packages/db/database.ts';
import { appendRevision, eventRetention, insertTransaction } from '../packages/db/ledger.ts';
import { importLegacyJson, legacyImportMarker } from '../packages/db/legacy.ts';
import { migrations } from '../packages/db/schema.ts';
import { createStore, seedRuntime } from '../packages/profiles/store.ts';

const document = { schemaVersion: 1 as const, synthetic: true as const };
const account = {
  id: 'current',
  name: 'Current account',
  currency: 'EUR',
  openingBalanceCents: 100000,
  openingDate: '2026-01-01',
  synthetic: true,
};
const movement = (id: string, amountCents = -1000, extra: Record<string, unknown> = {}) => ({
  id,
  accountId: 'current',
  date: '2026-06-15',
  description: `Movement ${id}`,
  amountCents,
  currency: 'EUR',
  category: 'other',
  status: 'booked',
  synthetic: true,
  ...extra,
});
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `tx-${from + index}`);

/** A temporary directory that is removed when the test ends, whatever happens. */
async function scratch(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, remove: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/** A user with one account, ready for movements. */
async function withLedger(db: Database, userId = 'alice') {
  await createStore(db).create(userId, {
    details: { ...document, id: userId },
    preferences: document,
    'bank-account': document,
  });
  const bank = createBankStore(db);
  await bank.createAccount(userId, account);
  return bank;
}

test('migrations apply once, in order, and opening again changes nothing', async () => {
  const { directory, remove } = await scratch('relocat-db-migrate-');
  const file = join(directory, 'nested', 'relocat.db');
  const first = { version: 1, name: 'first', sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT) STRICT;' };
  const second = { version: 2, name: 'second', sql: 'ALTER TABLE notes ADD COLUMN author TEXT;' };
  try {
    let db = open(file, { migrations: [first] });
    assert.equal(db.schemaVersion, 1);
    const appliedAt = appliedMigrations(db)[0].appliedAt;
    db.run('INSERT INTO notes (body) VALUES (?)', 'kept');
    db.close();

    // A statement that is not repeatable proves the first migration is not run again.
    db = open(file, { migrations: [second, first] });
    assert.equal(db.schemaVersion, 2);
    assert.deepEqual(
      appliedMigrations(db).map(row => [row.version, row.name]),
      [
        [1, 'first'],
        [2, 'second'],
      ],
    );
    assert.equal(appliedMigrations(db)[0].appliedAt, appliedAt);
    assert.deepEqual(db.all('SELECT body, author FROM notes'), [{ body: 'kept', author: null }]);
    db.close();

    db = open(file, { migrations: [first, second] });
    assert.equal(db.schemaVersion, 2);
    assert.equal(appliedMigrations(db).length, 2);
    db.close();

    // A migration that fails half-way leaves the schema and its version as they were.
    const broken = { version: 3, name: 'broken', sql: 'CREATE TABLE extra (id INTEGER); SELECT * FROM missing_table;' };
    assert.throws(() => open(file, { migrations: [first, second, broken] }), /missing_table/);
    db = open(file, { migrations: [first, second] });
    assert.equal(db.schemaVersion, 2);
    assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name = 'extra'"), undefined);
    db.close();

    assert.throws(() => open(':memory:', { migrations: [second] }), /without gaps/);
  } finally {
    await remove();
  }
});

test('the application schema opens in memory and on disk with the expected settings', async () => {
  const { directory, remove } = await scratch('relocat-db-open-');
  try {
    const memory = open(':memory:');
    assert.equal(memory.schemaVersion, migrations.length);
    memory.close();
    memory.close();

    const db = open(join(directory, 'relocat.db'));
    assert.equal(db.schemaVersion, migrations.at(-1)?.version);
    assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
    assert.equal(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
    assert.equal(db.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous, 1);
    assert.equal(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout, 5000);
    assert.equal(integrityCheck(db), 'ok');
    // Foreign keys are enforced: a movement cannot exist without its account.
    assert.throws(() => insertTransaction(db, 'nobody', movement('orphan')), /FOREIGN KEY/);
    assert.throws(() => db.transaction(() => Promise.resolve()), /synchronous/);
    db.close();
  } finally {
    await remove();
  }
});

test('a database written by newer code is refused and left untouched', async () => {
  const { directory, remove } = await scratch('relocat-db-newer-');
  const file = join(directory, 'relocat.db');
  try {
    const future = { version: migrations.length + 1, name: 'from the future', sql: 'CREATE TABLE later (id INTEGER);' };
    open(file, { migrations: [...migrations, future] }).close();
    const before = await readFile(file);
    assert.throws(() => open(file), SchemaTooNewError);
    assert.throws(() => open(file), /newer|knows only/);
    assert.deepEqual(await readFile(file), before);
    // Read-only access, as the backup command uses it, still works and reports the stored version.
    const readOnly = open(file, { readOnly: true });
    assert.equal(readOnly.schemaVersion, migrations.length + 1);
    assert.throws(() => readOnly.run('CREATE TABLE nope (id INTEGER)'), /readonly/);
    readOnly.close();
  } finally {
    await remove();
  }
});

test('a failed import leaves no partial ledger change', async () => {
  const db = open(':memory:');
  try {
    const bank = await withLedger(db);
    await bank.importTransactions('alice', { transactions: [movement('tx-1')] });
    const before = await bank.read('alice');
    const failing = [
      // Unknown account after valid rows, an ID conflict, and a date before the account opened.
      [movement('tx-2'), movement('tx-3'), movement('tx-4', -500, { accountId: 'missing' })],
      [movement('tx-5'), movement('tx-1', -999)],
      [movement('tx-6'), movement('tx-7', -500, { date: '2025-12-31' })],
    ];
    for (const transactions of failing) {
      await assert.rejects(bank.importTransactions('alice', { transactions }));
      await assert.rejects(
        bank.upsertTransactions('alice', { transactions: transactions.slice(0, 1).concat(failing[0][2]) }),
      );
    }
    assert.deepEqual(await bank.read('alice'), before);
    assert.equal(before.revision, 2);
    assert.deepEqual(
      before.events.map(event => [event.sequence, event.transactionCount]),
      [
        [1, 0],
        [2, 1],
      ],
    );
  } finally {
    db.close();
  }
});

test('concurrent imports of overlapping movements create no duplicates and keep revisions consistent', async () => {
  const { directory, remove } = await scratch('relocat-db-concurrent-');
  const file = join(directory, 'relocat.db');
  // Two handles on one file stand for two server instances sharing the database.
  const one = open(file);
  const two = open(file);
  try {
    const first = await withLedger(one);
    const second = createBankStore(two);
    const batch = (from: number, to: number) => ({ transactions: range(from, to).map(id => movement(id)) });
    const seen: number[] = [];
    first.onEvent(change => seen.push(change.event.sequence));
    second.onEvent(change => seen.push(change.event.sequence));
    const results = await Promise.all([
      first.importTransactions('alice', batch(0, 300)),
      second.importTransactions('alice', batch(200, 500)),
      first.upsertTransactions('alice', batch(400, 700)),
      second.importTransactions('alice', batch(0, 300)),
    ]);
    const inserted = results.reduce((total, outcome) => total + outcome.result.inserted, 0);
    assert.equal(inserted, 700);
    const ledger = await second.read('alice');
    assert.equal(ledger.transactions.length, 700);
    assert.equal(new Set(ledger.transactions.map(tx => tx.id)).size, 700);
    // One revision for the account and one per batch that changed something; the repeat changed nothing.
    assert.equal(ledger.revision, 4);
    assert.deepEqual(
      ledger.events.map(event => event.sequence),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      ledger.events.map(event => event.transactionCount),
      [0, 300, 500, 700],
    );
    assert.deepEqual(
      seen.sort((a, b) => a - b),
      [2, 3, 4],
    );
    assert.equal(results[3].ledger.revision, 4);
    assert.deepEqual(results[3].result, { inserted: 0, duplicates: 300 });

    // Reads select instead of loading everything.
    const page = await first.transactions('alice', { from: '2026-06-01' }, { limit: 5, offset: 698 });
    assert.equal(page.total, 700);
    assert.equal(page.transactions.length, 2);
    assert.equal((await first.history('alice', '2026-06-14')).transactions.length, 0);
    assert.equal((await first.balances('alice', '2026-06-15')).accounts[0].balanceCents, 100000 - 700 * 1000);
  } finally {
    one.close();
    two.close();
    await remove();
  }
});

test('two processes importing overlapping movements into one file agree on the result', async () => {
  const { directory, remove } = await scratch('relocat-db-processes-');
  const file = join(directory, 'relocat.db');
  const url = (path: string) => pathToFileURL(join(import.meta.dirname, '..', path)).href;
  // Each worker is a separate Node process with its own connection, as two server instances would be.
  const worker = `
    import { open } from ${JSON.stringify(url('packages/db/database.ts'))};
    import { createBankStore } from ${JSON.stringify(url('apps/profile-api/bank.ts'))};
    const [file, from, to] = process.argv.slice(-3);
    const db = open(file);
    const bank = createBankStore(db);
    let changed = 0;
    for (let start = Number(from); start < Number(to); start += 50) {
      const transactions = Array.from({ length: 50 }, (_, index) => ({
        id: 'tx-' + (start + index), accountId: 'current', date: '2026-06-15', description: 'Shared movement',
        amountCents: -1000, currency: 'EUR', category: 'other', status: 'booked', synthetic: true,
      }));
      const outcome = await bank.importTransactions('alice', { transactions });
      if (outcome.result.inserted) changed++;
      await new Promise(resolve => setImmediate(resolve));
    }
    db.close();
    console.log(JSON.stringify({ changed }));
  `;
  const run = (from: number, to: number) =>
    new Promise<{ changed: number }>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ['--input-type=module', '-e', worker, '--', file, String(from), String(to)],
        (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout))),
      );
      child.stdin?.end();
    });
  try {
    const db = open(file);
    const bank = await withLedger(db);
    const outcomes = await Promise.all([run(0, 600), run(300, 900), run(0, 900)]);
    const ledger = await bank.read('alice');
    assert.equal(ledger.transactions.length, 900);
    assert.equal(new Set(ledger.transactions.map(tx => tx.id)).size, 900);
    // Every batch that inserted something is exactly one revision, whichever process wrote it.
    const changed = outcomes.reduce((total, outcome) => total + outcome.changed, 0);
    assert.equal(ledger.revision, 1 + changed);
    assert.deepEqual(
      ledger.events.map(event => event.sequence),
      Array.from({ length: ledger.revision }, (_, index) => index + 1),
    );
    assert.equal(ledger.events.at(-1)?.transactionCount, 900);
    assert.ok(
      ledger.events.every(
        (event, index, all) => index === 0 || event.transactionCount > all[index - 1].transactionCount,
      ),
    );
    db.close();
  } finally {
    await remove();
  }
});

test('a process that dies in the middle of an import leaves the previous ledger', async () => {
  const { directory, remove } = await scratch('relocat-db-crash-');
  const file = join(directory, 'relocat.db');
  try {
    let db = open(file);
    let bank = await withLedger(db);
    await bank.importTransactions('alice', { transactions: [movement('tx-1'), movement('tx-2')] });
    const before = await bank.read('alice');
    // The same steps an import takes, interrupted before the commit.
    assert.throws(
      () =>
        db.transaction(() => {
          for (const id of range(10, 60)) insertTransaction(db, 'alice', movement(id));
          appendRevision(db, 'alice', new Date().toISOString());
          throw new Error('killed');
        }),
      /killed/,
    );
    assert.deepEqual(await bank.read('alice'), before);
    db.close();

    db = open(file);
    bank = createBankStore(db);
    assert.deepEqual(await bank.read('alice'), before);
    // The ledger still works after the interrupted change.
    const next = await bank.importTransactions('alice', { transactions: [movement('tx-3')] });
    assert.equal(next.ledger.revision, before.revision + 1);
    db.close();
  } finally {
    await remove();
  }
});

/** Write the files the JSON-file version of ReloCat left behind. */
async function writeLegacyLayout(root: string) {
  const profileDir = join(root, 'runtime-users');
  const habitsDir = join(root, 'runtime-habits');
  const files: Record<string, unknown> = {};
  const user = (id: string) => {
    files[join(profileDir, id, 'details.json')] = { ...document, id, name: `Household ${id}` };
    files[join(profileDir, id, 'preferences.json')] = { ...document, schoolStages: ['ESO'], edited: true };
    files[join(profileDir, id, 'bank-account.json')] = { ...document, balanceCents: 123456 };
  };
  user('user-001');
  user('user-002');
  user('user-003');
  files[join(profileDir, 'user-001', 'app-inputs.json')] = {
    schemaVersion: 1,
    synthetic: true,
    inputs: ['second', 'first'].map((id, index) => ({
      id,
      source: 'interview',
      observedAt: `2026-11-2${index}T10:00:00Z`,
      confirmed: index === 0,
      synthetic: true,
      data: { housing: { budgetCents: 13000000 + index, homeSizeM2: 85.5 } },
    })),
  };
  const transactions = [
    movement('tx-b', -2500, { date: '2026-06-20' }),
    movement('tx-a', 300000, { category: 'income', date: '2026-06-02', synthetic: false }),
    movement('tx-c', -900, { status: 'pending' }),
  ];
  const events = [3, 4, 5].map(sequence => ({
    sequence,
    occurredAt: `2026-11-21T12:00:0${sequence}.000Z`,
    type: 'bank.updated',
    accountCount: 1,
    transactionCount: sequence - 2,
    synthetic: false,
  }));
  files[join(profileDir, 'user-001', 'bank-ledger.json')] = {
    schemaVersion: 1,
    synthetic: false,
    updatedAt: '2026-11-21T12:00:05.000Z',
    accounts: [account],
    transactions,
    revision: 5,
    events,
  };
  // A ledger whose movement points at no account is skipped as a whole, never half-imported.
  files[join(profileDir, 'user-002', 'bank-ledger.json')] = {
    schemaVersion: 1,
    synthetic: true,
    updatedAt: '2026-11-21T12:00:00.000Z',
    accounts: [],
    transactions: [movement('orphan')],
    revision: 1,
    events: [],
  };
  files[join(profileDir, 'user-001', 'bank-connections.json')] = {
    schemaVersion: 1,
    connections: [
      {
        id: 'legacy-bank-1',
        providerId: 'legacy-bank',
        ref: 'customer/001',
        createdAt: '2026-11-20T09:00:00.000Z',
        cursor: 'cursor-41',
        pollIntervalMs: null,
        lastSyncAt: '2026-11-21T12:00:00.000Z',
        lastError: null,
      },
    ],
  };
  files[join(profileDir, 'bank-webhook-queue.json')] = {
    schemaVersion: 1,
    lastSeq: 9,
    pending: [{ seq: 7, providerId: 'legacy-bank', ref: 'customer/001', receivedAt: '2026-11-21T12:30:00.000Z' }],
    seen: ['legacy-bank:evt-1', 'legacy-bank:evt:2'],
  };
  files[join(habitsDir, 'users', 'user-001.json')] = {
    schemaVersion: 1,
    synthetic: true,
    userId: 'user-001',
    goals: [
      {
        id: 'weekly-review',
        title: 'Weekly review',
        action: 'Review the plan',
        category: 'other',
        targetDaysPerWeek: 1,
        plannedMonthlySavingCents: 4000,
        active: true,
      },
    ],
    checkins: [
      { id: 'check-1', date: '2026-11-20', completed: true, note: 'Done', goalId: 'weekly-review' },
      { id: 'check-2', date: '2026-11-21', completed: false, goalId: 'weekly-review' },
    ],
  };
  files[join(habitsDir, 'openai-usage.json')] = { date: '2026-11-21', attempts: 3 };
  const written = new Map<string, string>();
  for (const [path, value] of Object.entries(files)) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    written.set(path, text);
  }
  await writeFile(join(profileDir, 'user-003', 'app-inputs.json'), '{ not json');
  return { profileDir, habitsDir, written, transactions, events };
}

test('first start on the old JSON layout imports everything once and leaves the files alone', async () => {
  const { directory, remove } = await scratch('relocat-db-legacy-');
  const file = join(directory, 'data', 'relocat.db');
  try {
    const legacy = await writeLegacyLayout(directory);
    const sources = { profileDir: legacy.profileDir, habitsDir: legacy.habitsDir };
    let db = open(file);
    const outcome = await importLegacyJson(db, sources);
    assert.equal(outcome.status, 'imported');
    assert.ok(outcome.status === 'imported');
    assert.deepEqual(outcome.counts, {
      users: 3,
      profile_sections: 9,
      input_records: 2,
      bank_accounts: 1,
      bank_transactions: 3,
      bank_events: 3,
      bank_ledgers: 1,
      bank_connections: 1,
      bank_webhook_queue: 1,
      bank_webhook_seen: 2,
      habit_goals: 1,
      habit_checkins: 2,
      ai_usage: 1,
    });
    assert.deepEqual(
      outcome.skipped.map(item => item.path.slice(legacy.profileDir.length + 1).replaceAll('\\', '/')).sort(),
      ['user-002/bank-ledger.json', 'user-003/app-inputs.json'],
    );
    db.close();

    // Everything is found through the ordinary stores after a restart.
    db = open(file);
    const profiles = createStore(db);
    assert.deepEqual(await profiles.list(), ['user-001', 'user-002', 'user-003']);
    assert.deepEqual(await profiles.read('user-002', 'details'), {
      ...document,
      id: 'user-002',
      name: 'Household user-002',
    });
    assert.equal((await profiles.read('user-001', 'preferences')).edited, true);
    assert.equal((await profiles.read('user-001', 'bank-account')).balanceCents, 123456);

    const inputs = await createInputStore(db).read('user-001');
    assert.deepEqual(
      inputs.inputs.map(input => [
        input.id,
        input.confirmed,
        input.data.housing?.budgetCents,
        input.data.housing?.homeSizeM2,
      ]),
      [
        ['second', true, 13000000, 85.5],
        ['first', false, 13000001, 85.5],
      ],
    );

    const bank = createBankStore(db);
    const ledger = await bank.read('user-001');
    assert.equal(ledger.revision, 5);
    assert.equal(ledger.updatedAt, '2026-11-21T12:00:05.000Z');
    assert.equal(ledger.synthetic, false, 'one real movement makes the ledger real');
    assert.deepEqual(ledger.accounts, [account]);
    assert.deepEqual(
      ledger.transactions,
      legacy.transactions,
      'records, their order and their synthetic flags survive',
    );
    assert.deepEqual(ledger.events, legacy.events);
    assert.equal((await bank.read('user-002')).transactions.length, 0);
    // The imported ledger carries on: the same movement is a duplicate, a new one is revision 6.
    assert.deepEqual((await bank.importTransactions('user-001', { transactions: [legacy.transactions[0]] })).result, {
      inserted: 0,
      duplicates: 1,
    });
    assert.equal((await bank.importTransactions('user-001', { transactions: [movement('tx-d')] })).ledger.revision, 6);

    const sync = createBankSync({ ledger: bank, registry: createBankRegistry([], {}), db, housekeepingMs: null });
    const [connection] = await sync.listConnections('user-001');
    assert.deepEqual(
      [
        connection.id,
        connection.providerId,
        connection.lastSyncAt,
        connection.lastAttemptAt,
        connection.consecutiveFailures,
      ],
      ['legacy-bank-1', 'legacy-bank', '2026-11-21T12:00:00.000Z', null, 0],
    );
    assert.equal(sync.webhookStatus().pending, 1);
    await sync.close();
    assert.deepEqual(pendingWebhooks(db), [
      { seq: 7, providerId: 'legacy-bank', ref: 'customer/001', receivedAt: '2026-11-21T12:30:00.000Z' },
    ]);
    // Notification IDs already seen stay seen, and new notifications continue after the old counter.
    const notification = { providerId: 'legacy-bank', ref: 'customer/001', receivedAt: '2026-11-22T08:00:00.000Z' };
    assert.equal(enqueueWebhook(db, { ...notification, eventId: 'evt:2' }), false);
    assert.equal(enqueueWebhook(db, { ...notification, eventId: 'evt-3' }), true);
    assert.deepEqual(
      pendingWebhooks(db).map(item => item.seq),
      [10],
    );

    const habits = createHabitStore(db);
    const state = await habits.read('user-001');
    assert.equal(state.goals[0].plannedMonthlySavingCents, 4000);
    assert.deepEqual(state.checkins, [
      { id: 'check-1', date: '2026-11-20', completed: true, note: 'Done', goalId: 'weekly-review' },
      { id: 'check-2', date: '2026-11-21', completed: false, goalId: 'weekly-review' },
    ]);
    assert.equal((await habits.reserveCall(4, '2026-11-21')).attempts, 4);
    await assert.rejects(habits.reserveCall(4, '2026-11-21'), /limit/);

    // The marker makes the import a one-off, and the JSON files are exactly as they were.
    assert.equal(JSON.parse(readMeta(db, legacyImportMarker) ?? '{}').counts.bank_transactions, 3);
    assert.deepEqual(await importLegacyJson(db, sources), { status: 'already_imported' });
    for (const [path, text] of legacy.written) assert.equal(await readFile(path, 'utf8'), text, path);

    // Fixture seeding afterwards adds missing users only; imported edits win.
    const fixtures = join(directory, 'fixtures');
    for (const id of ['user-001', 'user-009'])
      for (const [section, value] of Object.entries({
        details: { ...document, id },
        preferences: { ...document, fromFixture: true },
        'bank-account': document,
      })) {
        await mkdir(join(fixtures, id), { recursive: true });
        await writeFile(join(fixtures, id, `${section}.json`), JSON.stringify(value));
      }
    assert.deepEqual((await seedRuntime(fixtures, db)).seeded, ['user-009']);
    assert.equal((await profiles.read('user-001', 'preferences')).fromFixture, undefined);
    assert.equal((await profiles.read('user-009', 'preferences')).fromFixture, true);
    db.close();

    // A database that already has users is never imported into, and an absent layout is a no-op.
    const seeded = open(':memory:');
    await seedRuntime(fixtures, seeded);
    assert.deepEqual(await importLegacyJson(seeded, sources), { status: 'database_not_empty' });
    seeded.close();
    const fresh = open(':memory:');
    const nowhere = { profileDir: join(directory, 'absent'), habitsDir: join(directory, 'absent-too') };
    assert.deepEqual(await importLegacyJson(fresh, nowhere), { status: 'nothing_to_import' });
    assert.equal(readMeta(fresh, legacyImportMarker), undefined);
    fresh.close();
  } finally {
    await remove();
  }
});

/** A bank with webhooks whose availability and movements the test controls. */
function controlledBank() {
  const state = { up: true, feed: [] as ProviderTransaction[] };
  const provider = defineBankProvider({
    id: 'test-bank',
    displayName: 'Test Bank',
    synthetic: true,
    env: [],
    async listAccounts() {
      return [{ ...account, currency: 'EUR' as const }];
    },
    async fetchTransactions() {
      if (!state.up) throw new Error('bank is down');
      return { transactions: state.feed, nextCursor: `cursor-${state.feed.length}` };
    },
    verifyWebhook: () => true,
    parseWebhook: () => null,
  });
  return { state, registry: createBankRegistry([provider], {}) };
}

test('connections, the webhook queue and board runs survive a restart', async () => {
  const { directory, remove } = await scratch('relocat-db-restart-');
  const file = join(directory, 'relocat.db');
  const { state, registry } = controlledBank();
  let time = new Date('2026-11-21T12:00:00Z').getTime();
  const clock = () => new Date(time);
  const engine = (db: Database, bank: ReturnType<typeof createBankStore>) =>
    createBankSync({ ledger: bank, registry, db, clock, housekeepingMs: null, retryBaseMs: 1000 });
  try {
    let db = open(file);
    let bank = await withLedger(db);
    let sync = engine(db, bank);
    const connection = await sync.connect('alice', { providerId: 'test-bank', ref: 'customer-1' });
    state.feed = [{ ...movement('tx-1'), category: 'other', status: 'booked' }];
    assert.equal((await sync.sync('alice')).results[0].status, 'synced');

    // A notification arrives while the bank cannot be pulled: accepted, queued, not imported.
    state.up = false;
    state.feed = [...state.feed, { ...movement('tx-2'), category: 'other', status: 'booked' }];
    assert.deepEqual(await sync.acceptWebhook('test-bank', { connectionRef: 'customer-1', eventId: 'evt-1' }), {
      known: true,
      duplicate: false,
    });
    await sync.idle();
    assert.equal(sync.webhookStatus().pending, 1);

    // The board: a shared run with progress and a separate rehearsal.
    persistDemoRuns(db, clock);
    const shared = openDemo({});
    updateDemo({ runId: shared.runId, action: 'answer_batch', answers: { household: 3 } });
    updateDemo({ runId: shared.runId, action: 'switch_persona', persona: 'progress' });
    const rehearsal = openDemo({ newRun: true, persona: 'payoff' });
    assert.equal(countBoardRuns(db), 2);
    await sync.close();
    db.close();

    // --- restart ---
    db = open(file);
    bank = createBankStore(db);
    sync = engine(db, bank);
    const [restored] = await sync.listConnections('alice');
    assert.equal(restored.id, connection.id);
    assert.equal(restored.consecutiveFailures, 1);
    assert.equal(restored.lastSyncAt, '2026-11-21T12:00:00.000Z');
    assert.ok(restored.lastError);
    await assert.rejects(sync.connect('alice', { providerId: 'test-bank', ref: 'customer-1' }), { status: 409 });
    assert.equal(sync.webhookStatus().pending, 1, 'the queued notification is still waiting');
    assert.deepEqual(await sync.acceptWebhook('test-bank', { connectionRef: 'customer-1', eventId: 'evt-1' }), {
      known: true,
      duplicate: true,
    });
    assert.equal((await bank.read('alice')).transactions.length, 1);
    // The bank is back: the retry scheduled at start imports the movement and empties the queue.
    state.up = true;
    time += 5000;
    await sync.runDue();
    assert.equal(sync.webhookStatus().pending, 0);
    assert.deepEqual(
      (await bank.read('alice')).transactions.map(tx => tx.id),
      ['tx-1', 'tx-2'],
    );
    assert.equal((await sync.listConnections('alice'))[0].consecutiveFailures, 0);
    await sync.close();

    persistDemoRuns(db, clock);
    const reopened = openDemo({});
    assert.equal(reopened.runId, shared.runId, 'the shared board is the same run');
    assert.equal(reopened.sharedBoard, true);
    assert.equal(reopened.persona, 'progress');
    assert.equal(reopened.revision, 2);
    assert.equal(reopened.pairCode, shared.pairCode);
    assert.equal(openDemo({ pairCode: rehearsal.pairCode }).runId, rehearsal.runId);
    assert.equal(openDemo({ runId: shared.runId, persona: 'onboarding' }).persona, 'onboarding');
    const answers = getView(shared.runId);
    assert.ok('answers' in answers && answers.answers.household === 3);

    // Rehearsals expire; the shared board does not, so the table cannot grow forever.
    time += 31 * 24 * 60 * 60 * 1000;
    assert.throws(() => getView(rehearsal.runId), /expired/);
    assert.throws(() => openDemo({ pairCode: rehearsal.pairCode }), /expired/);
    assert.equal(openDemo({}).runId, shared.runId);
    openDemo({ newRun: true });
    assert.equal(countBoardRuns(db), 2, 'opening a run removes the expired ones');
    db.close();
  } finally {
    persistDemoRuns(null);
    await remove();
  }
});

test('the board store stays bounded and works without a database', () => {
  const db = open(':memory:');
  try {
    persistDemoRuns(db);
    const shared = openDemo({});
    for (let index = 0; index < 2005; index++) openDemo({ newRun: true });
    assert.equal(countBoardRuns(db), 2000);
    assert.equal(openDemo({}).runId, shared.runId, 'the shared board is never the one removed');

    // Scripted mode with no database: runs live in memory, as before.
    persistDemoRuns(null);
    const scripted = openDemo({});
    assert.notEqual(scripted.runId, shared.runId);
    assert.equal(updateDemo({ runId: scripted.runId, action: 'switch_persona', persona: 'payoff' }).revision, 1);
    assert.equal(countBoardRuns(db), 2000);
  } finally {
    persistDemoRuns(null);
    db.close();
  }
});

test('only the newest events and notification IDs are kept', async () => {
  const db = open(':memory:');
  try {
    const bank = await withLedger(db);
    const revisions = eventRetention + 5;
    // The account was revision 1; every import after it is one more.
    for (let index = 2; index <= revisions; index++)
      await bank.importTransactions('alice', { transactions: [movement(`tx-${index}`)] });
    const ledger = await bank.read('alice');
    assert.equal(ledger.revision, revisions);
    assert.equal(ledger.events.length, eventRetention);
    assert.equal(ledger.events[0].sequence, 6);
    assert.equal(ledger.events.at(-1)?.sequence, revisions);
    assert.equal(ledger.transactions.length, revisions - 1, 'retention drops events, never movements');
    const behind = await bank.events('alice', 2, 50);
    assert.equal(behind.requiresRefresh, true);
    const current = await bank.events('alice', 5, 100);
    assert.deepEqual([current.requiresRefresh, current.events.length, current.hasMore], [false, 100, true]);

    const notification = { providerId: 'test-bank', ref: 'customer-1', receivedAt: '2026-11-21T12:00:00.000Z' };
    db.transaction(() => {
      for (let index = 0; index < seenRetention + 5; index++)
        assert.equal(enqueueWebhook(db, { ...notification, eventId: `evt-${index}` }), true);
    });
    assert.equal(countSeenWebhooks(db), seenRetention);
    assert.equal(pendingWebhooks(db).length, 1, 'notifications for one connection collapse into one');
    assert.equal(enqueueWebhook(db, { ...notification, eventId: `evt-${seenRetention + 4}` }), false);
    assert.equal(enqueueWebhook(db, { ...notification, eventId: 'evt-0' }), true, 'the oldest IDs were forgotten');
  } finally {
    db.close();
  }
});

test('a backup taken from a live database opens and holds the same data', async () => {
  const { directory, remove } = await scratch('relocat-db-backup-');
  try {
    const db = open(join(directory, 'relocat.db'));
    const bank = await withLedger(db);
    await bank.importTransactions('alice', { transactions: range(0, 50).map(id => movement(id)) });
    const target = join(directory, 'backup.db');
    await db.backupTo(target);
    // Writes after the backup do not reach the copy.
    await bank.importTransactions('alice', { transactions: [movement('later')] });
    const copy = open(target);
    assert.equal(integrityCheck(copy), 'ok');
    assert.equal((await createBankStore(copy).read('alice')).transactions.length, 50);
    assert.equal((await bank.read('alice')).transactions.length, 51);
    copy.close();
    db.close();
  } finally {
    await remove();
  }
});
