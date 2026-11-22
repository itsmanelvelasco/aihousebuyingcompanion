import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { getView, openDemo, persistDemoRuns, updateDemo } from '../apps/board/demo.ts';
import { createHabitStore } from '../apps/habits-agent/store.ts';
import { createBankStore } from '../apps/profile-api/bank.ts';
import { createInputStore } from '../apps/profile-api/inputs.ts';
import { createProfileApi } from '../apps/profile-api/server.ts';
import type { ProviderTransaction } from '../packages/banks/provider.ts';
import { defineBankProvider } from '../packages/banks/provider.ts';
import { createBankRegistry } from '../packages/banks/registry.ts';
import { createBankSync } from '../packages/banks/sync.ts';
import { countSeenWebhooks, enqueueWebhook, pendingWebhooks, seenRetention } from '../packages/db/bank-sync.ts';
import { countBoardRuns } from '../packages/db/board.ts';
import type { Database } from '../packages/db/database.ts';
import {
  appliedMigrations,
  DatabaseBusyError,
  integrityCheck,
  open,
  readMeta,
  SchemaTooNewError,
} from '../packages/db/database.ts';
import { eventRetention, insertTransaction } from '../packages/db/ledger.ts';
import { importedLegacyFiles, importLegacyFiles, importLegacyJson, legacyImportMarker } from '../packages/db/legacy.ts';
import { migrations } from '../packages/db/schema.ts';
import { analyzeTransactions } from '../packages/finance/cashflow.ts';
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
    // A lock is waited for only briefly while serving: the wait stops the event loop.
    assert.equal(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout, 250);
    const patient = open(join(directory, 'relocat.db'), { busyTimeoutMs: 1200 });
    assert.equal(patient.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout, 1200);
    patient.close();
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
    assert.equal((await first.summary('alice', { from: '2026-05-01', to: '2026-05-31' })).transactionCount, 0);
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

test('a process killed in the middle of a large import leaves the previous ledger', async () => {
  const { directory, remove } = await scratch('relocat-db-crash-');
  const file = join(directory, 'relocat.db');
  const url = (path: string) => pathToFileURL(join(import.meta.dirname, '..', path)).href;
  // A separate Node process that imports movements in one transaction and never gets to commit:
  // it reports once tens of thousands of rows are written (enough for SQLite to have spilled
  // uncommitted pages into the write-ahead log) and keeps inserting until it is killed.
  const importer = `
    import { writeSync } from 'node:fs';
    import { open } from ${JSON.stringify(url('packages/db/database.ts'))};
    import { appendRevision, insertTransaction } from ${JSON.stringify(url('packages/db/ledger.ts'))};
    const db = open(process.argv.at(-1));
    db.transaction(() => {
      for (let index = 0; index < 5_000_000; index++) {
        insertTransaction(db, 'alice', {
          id: 'big-' + index, accountId: 'current', date: '2026-06-15', description: 'Imported movement ' + index,
          amountCents: -1000, currency: 'EUR', category: 'other', status: 'booked', synthetic: true,
        });
        if (index === 30_000) {
          appendRevision(db, 'alice', new Date().toISOString());
          writeSync(1, 'midway\\n');
        }
      }
    });
    writeSync(1, 'committed\\n');
  `;
  try {
    let db = open(file);
    let bank = await withLedger(db);
    await bank.importTransactions('alice', { transactions: [movement('tx-1'), movement('tx-2')] });
    const before = await bank.read('alice');
    db.close();

    const child = spawn(process.execPath, ['--input-type=module', '-e', importer, '--', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stderr.on('data', chunk => (errors += chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('midway')) resolve();
      });
      child.once('exit', () => reject(new Error(`The importer ended before it was killed: ${errors || output}`)));
    });
    // No warning and no clean-up: the process is gone in the middle of its transaction.
    assert.equal(child.kill('SIGKILL'), true);
    const end = await exited;
    assert.notEqual(end.code, 0, 'the importer did not end normally');
    assert.doesNotMatch(output, /committed/);

    // The parent opens the file the dead process left, write-ahead log and all.
    db = open(file);
    bank = createBankStore(db);
    assert.equal(integrityCheck(db), 'ok');
    assert.deepEqual(await bank.read('alice'), before, 'nothing of the interrupted import is visible');
    assert.equal(
      db.get<{ total: number }>("SELECT COUNT(*) AS total FROM bank_transactions WHERE id LIKE 'big-%'")?.total,
      0,
    );
    // The ledger still works after the interrupted change: the next import is the next revision.
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

// ------------------------------------------------- reads, locks and query plans

/** Start a process that takes the write lock of `file`, says so, and commits after `holdMs`. */
function holdWriteLock(file: string, holdMs: number) {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const connection = new DatabaseSync(process.argv.at(-1));
    connection.exec('BEGIN IMMEDIATE');
    connection.exec("UPDATE users SET created_at = created_at");
    process.stdout.write('locked');
    setTimeout(() => { connection.exec('COMMIT'); connection.close(); }, ${holdMs});
  `;
  const child = spawn(process.execPath, ['-e', script, '--', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  const locked = new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', code => reject(new Error(`The lock holder ended early with status ${code}`)));
  });
  const released = new Promise<void>(resolve => child.once('exit', () => resolve()));
  return { locked, released };
}

test('reads never wait for a writer of another process, and a busy write is a clean retryable 503', async () => {
  const { directory, remove } = await scratch('relocat-db-busy-');
  const file = join(directory, 'relocat.db');
  const db = open(file);
  const server = createProfileApi(db, 'test-token');
  try {
    const bank = await withLedger(db);
    await bank.importTransactions('alice', { transactions: [movement('tx-1'), movement('tx-2')] });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/users/alice`;
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    const holdMs = 4000;
    const lock = holdWriteLock(file, holdMs);
    await lock.locked;
    const started = performance.now();
    const elapsed = () => performance.now() - started;

    // Every read path answers from its snapshot while the other process holds the write lock.
    assert.equal((await bank.head('alice')).revision, 2);
    assert.equal((await bank.read('alice')).transactions.length, 2);
    assert.equal((await bank.summary('alice', { from: '2026-06-01', to: '2026-06-30' })).transactionCount, 2);
    assert.equal((await bank.balances('alice', '2026-06-30')).accounts[0].balanceCents, 98000);
    assert.equal((await bank.transactions('alice', {}, { limit: 10, offset: 0 })).total, 2);
    assert.equal((await bank.events('alice', 0, 10)).events.length, 2);
    assert.equal((await createInputStore(db).read('alice')).inputs.length, 0);
    assert.equal((await createHabitStore(db).read('alice')).goals.length, 0);
    for (const path of ['/bank/summary?from=2026-06-01&to=2026-06-30', '/bank/accounts', '/context', '/inputs'])
      assert.equal((await fetch(`${base}${path}`, { headers })).status, 200, path);
    const readsTook = elapsed();
    assert.ok(readsTook < holdMs / 2, `reads took ${Math.round(readsTook)} ms while a write was held for ${holdMs}`);

    // A write cannot proceed. It gives up after the short busy timeout instead of freezing the server.
    const writeStarted = performance.now();
    await assert.rejects(bank.importTransactions('alice', { transactions: [movement('tx-3')] }), DatabaseBusyError);
    const response = await fetch(`${base}/bank/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ transactions: [movement('tx-3')] }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), { error: 'Storage is busy; try again shortly', retryable: true });
    const writesTook = performance.now() - writeStarted;
    assert.ok(writesTook < 1500, `two refused writes took ${Math.round(writesTook)} ms`);
    assert.ok(elapsed() < holdMs, 'all of it happened while the lock was still held');

    // Nothing was written, and the same request succeeds once the other process has committed.
    await lock.released;
    assert.equal((await bank.head('alice')).revision, 2);
    const retried = await fetch(`${base}/bank/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ transactions: [movement('tx-3')] }),
    });
    assert.deepEqual([retried.status, await retried.json()], [200, { inserted: 1, duplicates: 0 }]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    await remove();
  }
});

test('a read transaction sees one snapshot and refuses to write', async () => {
  const { directory, remove } = await scratch('relocat-db-read-');
  const file = join(directory, 'relocat.db');
  const reader = open(file);
  const writer = open(file);
  try {
    const bank = await withLedger(writer);
    const counts = reader.read(() => {
      const first = reader.get<{ total: number }>('SELECT COUNT(*) AS total FROM bank_transactions')?.total;
      // Another connection commits in the middle of the read.
      writer.transaction(() => insertTransaction(writer, 'alice', movement('tx-1')));
      return [first, reader.get<{ total: number }>('SELECT COUNT(*) AS total FROM bank_transactions')?.total];
    });
    assert.deepEqual(counts, [0, 0], 'both queries of one read see the same state');
    assert.equal((await bank.read('alice')).transactions.length, 1);
    assert.throws(() => reader.read(() => insertTransaction(reader, 'alice', movement('tx-2'))), /readonly|read-only/);
    // The refusal ends with the read: the same handle writes again, alone or inside a write transaction.
    reader.transaction(() => reader.read(() => insertTransaction(reader, 'alice', movement('tx-2'))));
    assert.equal(reader.get<{ total: number }>('SELECT COUNT(*) AS total FROM bank_transactions')?.total, 2);
    assert.throws(() => reader.read(() => Promise.resolve()), /synchronous/);
  } finally {
    reader.close();
    writer.close();
    await remove();
  }
});

test('summaries, balances and pages read a date range from an index and never scan the ledger', async () => {
  const db = open(':memory:');
  try {
    const bank = await withLedger(db);
    for (let start = 0; start < 1500; start += 500)
      await bank.importTransactions('alice', {
        transactions: Array.from({ length: 500 }, (_, index) =>
          movement(`m-${start + index}`, -100 - index, {
            date: `2026-${String(1 + ((start + index) % 9)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}`,
            description: `Shop ${index % 7}`,
            category: index % 5 ? 'food' : 'subscriptions',
          }),
        ),
      });
    db.run('ANALYZE');
    // Every statement the read paths run is captured and explained with its own parameters.
    const statements: { sql: string; parameters: unknown[] }[] = [];
    const observed: Database = {
      ...db,
      get: (sql, ...parameters) => {
        statements.push({ sql, parameters });
        return db.get(sql, ...parameters);
      },
      all: (sql, ...parameters) => {
        statements.push({ sql, parameters });
        return db.all(sql, ...parameters);
      },
    };
    const reads = createBankStore(observed);
    const plansOf = async (run: () => Promise<unknown>) => {
      statements.length = 0;
      await run();
      return statements
        .filter(({ sql }) => /FROM bank_transactions/.test(sql))
        .map(({ sql, parameters }) =>
          db
            .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(parameters as never[]))
            .map(row => row.detail)
            .join(' | '),
        );
    };
    const range = /USING (COVERING )?INDEX bank_transactions_by_date \(user_id=\? AND date>\? AND date<\?\)/;

    const summary = await plansOf(() => reads.summary('alice', { from: '2026-03-01', to: '2026-05-31' }));
    // Two grouped queries over the period (and the lookback), plus the whole-ledger provenance check.
    assert.equal(summary.filter(plan => range.test(plan)).length, 2, summary.join('\n'));
    const balances = await plansOf(() => reads.balances('alice', '2026-06-30'));
    assert.ok(
      balances.some(plan => /USING COVERING INDEX bank_transactions_by_account/.test(plan)),
      balances.join('\n'),
    );
    const page = await plansOf(() =>
      reads.transactions('alice', { from: '2026-03-01', to: '2026-05-31' }, { limit: 50, offset: 100 }),
    );
    assert.equal(page.filter(plan => range.test(plan)).length, 2, page.join('\n'));
    assert.ok(!page.some(plan => /TEMP B-TREE FOR ORDER BY/.test(plan)), 'the page comes out of the index in order');
    for (const plan of [...summary, ...balances, ...page])
      assert.doesNotMatch(plan, /SCAN bank_transactions(?! USING)/, `no full scan of the ledger: ${plan}`);
  } finally {
    db.close();
  }
});

test('the summary the database computes is the one the movements give, for any period', async () => {
  const db = open(':memory:');
  try {
    const bank = await withLedger(db);
    await bank.updateAccount('alice', 'current', { ...account, openingDate: '2024-01-01' });
    await bank.createAccount('alice', { ...account, id: 'savings', name: 'Savings', openingDate: '2024-01-01' });
    // A deterministic mix: two accounts, pending rows, own transfers, refunds, payees written in
    // different capitals and spacing, over thirty months.
    let state = 7;
    const next = (limit: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      // The high bits: the low ones of this generator repeat too soon.
      return Math.floor(state / 65_536) % limit;
    };
    const payees = ['Gym', 'gym ', 'GYM', 'Corner  Shop', 'corner shop', 'Rail pass', 'Insurance', 'One-off'];
    const categories = ['housing', 'food', 'transport', 'subscriptions', 'utilities', 'other'];
    const rows = Array.from({ length: 900 }, (_, index) => {
      const month = next(30);
      const date = `${2024 + Math.floor(month / 12)}-${String(1 + (month % 12)).padStart(2, '0')}-${String(1 + next(28)).padStart(2, '0')}`;
      const kind = next(12);
      const expense = { description: payees[next(payees.length)], category: categories[next(categories.length)] };
      return movement(`g-${index}`, kind === 0 ? 150_000 + next(50_000) : -(100 + next(40_000)), {
        date,
        accountId: next(4) ? 'current' : 'savings',
        status: next(15) ? 'booked' : 'pending',
        ...(kind === 0
          ? { category: 'income', description: 'Salary' }
          : kind === 1
            ? { category: 'internal_transfer', description: 'Own transfer' }
            : kind === 2
              ? { category: 'other', description: 'Refund', amountCents: 500 + next(2_000) }
              : expense),
      });
    });
    for (let start = 0; start < rows.length; start += 300)
      await bank.importTransactions('alice', { transactions: rows.slice(start, start + 300) });
    const { transactions } = await bank.read('alice');
    assert.equal(transactions.length, 900);
    for (const [from, to] of [
      ['2024-01-01', '2024-03-31'],
      ['2025-02-01', '2025-02-28'],
      ['2024-07-01', '2026-06-30'],
      ['2026-04-01', '2026-06-30'],
      ['2027-01-01', '2027-01-31'],
    ]) {
      const { ledgerUpdatedAt, ...computed } = await bank.summary('alice', { from, to });
      assert.deepEqual(computed, analyzeTransactions(transactions, from, to), `${from} to ${to}`);
      assert.match(ledgerUpdatedAt ?? '', /^\d{4}-/);
    }
    // The comparison is not vacuous: recurring payees were merged across spellings and both paths agree on them.
    const year = await bank.summary('alice', { from: '2025-01-01', to: '2025-12-31' });
    assert.ok(year.recurringExpenses.length > 5, `recurring ${year.recurringExpenses.length}`);
    assert.ok(year.excludedPendingCount > 0 && year.excludedInternalTransferCount > 0);
    assert.ok(year.transactionCount > 100, `counted ${year.transactionCount}`);
    assert.ok(
      year.recurringExpenses.some(expense => /^gym$/i.test(expense.description) && expense.occurrenceCount > 3),
    );
  } finally {
    db.close();
  }
});

test('migration 3 corrects the records of account-owned people and keeps every stored row readable', async () => {
  const { directory, remove } = await scratch('relocat-db-truth-');
  const file = join(directory, 'relocat.db');
  const sectionsOf = (db: Database, userId: string) =>
    db
      .all<{ section: string; synthetic: number; document: string }>(
        'SELECT section, synthetic, document FROM profile_sections WHERE user_id = ? ORDER BY section',
        userId,
      )
      .map(row => [row.section, row.synthetic, JSON.parse(row.document).synthetic]);
  const person = (db: Database, userId: string) => {
    db.run('INSERT INTO users (id, created_at) VALUES (?, ?)', userId, '2026-11-01T00:00:00.000Z');
    for (const section of ['details', 'preferences', 'bank-account'])
      db.run(
        'INSERT INTO profile_sections (user_id, section, synthetic, document, updated_at) VALUES (?, ?, 1, ?, ?)',
        userId,
        section,
        JSON.stringify({ ...document, ...(section === 'details' ? { id: userId, name: 'Kept' } : {}) }),
        '2026-11-01T00:00:00.000Z',
      );
  };
  const own = (db: Database, userId: string) =>
    db.run(
      'INSERT INTO accounts (id, email, password_hash, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
      `acct-${userId}`,
      `${userId}@example.org`,
      'hash',
      userId,
      '2026-11-01T00:00:00.000Z',
    );
  try {
    // The database as version 2 left it: every record labelled synthetic, whoever it belonged to.
    let db = open(file, { migrations: migrations.slice(0, 2) });
    for (const userId of ['p-real', 'user-001']) {
      person(db, userId);
      for (const [id, source] of [
        ['stated', 'manual'],
        ['from-bank', 'bank'],
      ])
        db.run(
          'INSERT INTO input_records (user_id, id, source, observed_at, confirmed, synthetic, data) VALUES (?, ?, ?, ?, 1, 1, ?)',
          userId,
          id,
          source,
          '2026-11-02T00:00:00Z',
          JSON.stringify({ household: { size: 2 } }),
        );
      db.run(
        "INSERT INTO habit_goals (user_id, id, title, action, category, target_days_per_week, planned_monthly_saving_cents, active) VALUES (?, 'cook', 'Cook', 'Cook at home', 'food', 3, 5000, 1)",
        userId,
      );
    }
    own(db, 'p-real');
    db.close();

    db = open(file, { migrations: migrations.slice(0, 3) });
    assert.equal(db.schemaVersion, 3);
    // The person who belongs to an account is real, in the column and in the document; the fixture is untouched.
    assert.deepEqual(sectionsOf(db, 'p-real'), [
      ['bank-account', 0, false],
      ['details', 0, false],
      ['preferences', 0, false],
    ]);
    assert.deepEqual(sectionsOf(db, 'user-001'), [
      ['bank-account', 1, true],
      ['details', 1, true],
      ['preferences', 1, true],
    ]);
    const profiles = createStore(db);
    assert.deepEqual(await profiles.read('p-real', 'details'), {
      schemaVersion: 1,
      synthetic: false,
      id: 'p-real',
      name: 'Kept',
    });
    assert.deepEqual([profiles.isSynthetic('p-real'), profiles.isSynthetic('user-001')], [false, true]);
    // What the person stated is real; a record from a bank keeps its flag, because the bank can be fictional.
    const inputs = createInputStore(db);
    const real = await inputs.read('p-real');
    assert.deepEqual(
      [real.synthetic, ...real.inputs.map(input => [input.id, input.synthetic])],
      [false, ['stated', false], ['from-bank', true]],
    );
    const persona = await inputs.read('user-001');
    assert.deepEqual([persona.synthetic, ...persona.inputs.map(input => input.synthetic)], [true, true, true]);
    // A goal stored before start days were recorded has none, and still reads.
    const habits = createHabitStore(db);
    const state = await habits.read('p-real');
    assert.deepEqual([state.synthetic, state.goals[0].id, state.goals[0].startedOn], [false, 'cook', null]);
    assert.equal((await habits.read('user-001')).synthetic, true);

    // The rule holds for accounts created later, whatever flag their documents were written with.
    person(db, 'p-new');
    assert.equal(profiles.isSynthetic('p-new'), true);
    own(db, 'p-new');
    assert.deepEqual(sectionsOf(db, 'p-new'), [
      ['bank-account', 0, false],
      ['details', 0, false],
      ['preferences', 0, false],
    ]);
    assert.equal(integrityCheck(db), 'ok');
    db.close();
  } finally {
    await remove();
  }
});

// ------------------------------------------------------- legacy files, again

test('a legacy file that was skipped is reported, and imported once after it is repaired', async () => {
  const { directory, remove } = await scratch('relocat-db-legacy-repair-');
  const profileDir = join(directory, 'runtime-users');
  const habitsDir = join(directory, 'runtime-habits');
  const sources = { profileDir, habitsDir };
  const write = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const ledgerFile = (id: string) => join(profileDir, id, 'bank-ledger.json');
  const ledger = (transactions: unknown[], extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    synthetic: true,
    updatedAt: '2026-11-21T12:00:00.000Z',
    accounts: [account],
    transactions,
    revision: 2,
    events: [],
    ...extra,
  });
  const reasons = (skipped: { file: string; reason: string }[]) =>
    Object.fromEntries(skipped.map(item => [item.file, item.reason]));
  const db = open(join(directory, 'relocat.db'));
  try {
    for (const id of ['user-001', 'user-002', 'user-003', 'user-004', 'user-005'])
      for (const [section, value] of Object.entries({
        details: { ...document, id },
        preferences: document,
        'bank-account': document,
      }))
        await write(join(profileDir, id, `${section}.json`), value);
    // user-001: a ledger cut off in the middle of a write.
    await write(ledgerFile('user-001'), JSON.stringify(ledger([movement('tx-a')])).slice(0, 180));
    // user-002: more input records than a user may hold.
    await write(join(profileDir, 'user-002', 'app-inputs.json'), {
      schemaVersion: 1,
      synthetic: true,
      inputs: Array.from({ length: 600 }, (_, index) => ({
        id: `in-${index}`,
        source: 'manual',
        observedAt: '2026-11-20T10:00:00Z',
        confirmed: false,
        synthetic: true,
        data: { household: { size: 2 } },
      })),
    });
    // user-003: more movements than a ledger may hold.
    const one = JSON.stringify(movement('tx-0'));
    const many = Array.from({ length: 100_050 }, (_, index) => one.replace('"tx-0"', `"tx-${index}"`)).join(',');
    await write(
      ledgerFile('user-003'),
      JSON.stringify(ledger([])).replace('"transactions":[]', `"transactions":[${many}]`),
    );
    // user-004: a revision counter no later write could increment.
    await write(ledgerFile('user-004'), ledger([movement('tx-a')], { revision: 9e15 }));
    // user-005: a movement dated before its account opened, which the running store refuses.
    await write(ledgerFile('user-005'), ledger([movement('tx-a', -1000, { date: '2025-12-31' })]));
    await write(join(habitsDir, 'openai-usage.json'), { date: 'yesterday', attempts: 3 });

    const first = await importLegacyJson(db, sources);
    assert.ok(first.status === 'imported');
    // The profiles went in; each broken file is named with the reason it was left out.
    assert.deepEqual([first.counts.users, first.counts.input_records, first.counts.bank_transactions], [5, 0, 0]);
    const why = reasons(first.skipped);
    assert.deepEqual(Object.keys(why).sort(), [
      'habits/openai-usage.json',
      'profiles/user-001/bank-ledger.json',
      'profiles/user-002/app-inputs.json',
      'profiles/user-003/bank-ledger.json',
      'profiles/user-004/bank-ledger.json',
      'profiles/user-005/bank-ledger.json',
    ]);
    assert.match(why['profiles/user-001/bank-ledger.json'], /not valid JSON \(the file may be truncated\)/);
    assert.match(why['profiles/user-002/app-inputs.json'], /at inputs: .*500/);
    assert.match(why['profiles/user-003/bank-ledger.json'], /at transactions: .*100000/);
    assert.match(why['profiles/user-004/bank-ledger.json'], /at revision/);
    assert.match(why['profiles/user-005/bank-ledger.json'], /movement tx-a precedes the opening date of its account/);
    assert.match(why['habits/openai-usage.json'], /at date/);
    assert.equal(
      first.skipped.find(item => item.file.endsWith('user-001/bank-ledger.json'))?.path,
      ledgerFile('user-001'),
    );
    const marker = JSON.parse(readMeta(db, legacyImportMarker) ?? '{}');
    assert.equal(marker.skipped, 6);
    assert.equal(marker.skippedFiles.length, 6);

    // Nothing the stores cannot read got in: every user reads, and a skipped ledger is an ordinary empty one.
    const inputs = createInputStore(db);
    const bank = createBankStore(db);
    assert.equal((await inputs.read('user-002')).inputs.length, 0);
    assert.equal((await bank.read('user-003')).transactions.length, 0);
    await bank.createAccount('user-004', account);
    assert.equal(
      (await bank.importTransactions('user-004', { transactions: [movement('tx-run')] })).ledger.revision,
      2,
    );

    // The automatic import never runs again, so a repaired file needs the explicit command.
    await write(ledgerFile('user-001'), ledger([movement('tx-a'), movement('tx-b')]));
    // user-004 has moved on at run time; its repaired file overlaps what is there now.
    await write(
      ledgerFile('user-004'),
      ledger([movement('tx-run', -777), movement('tx-old')], { revision: 40, updatedAt: '2026-01-01T00:00:00.000Z' }),
    );
    assert.deepEqual(await importLegacyJson(db, sources), { status: 'already_imported' });
    assert.equal((await bank.read('user-001')).transactions.length, 0);

    const repaired = await importLegacyFiles(db, sources);
    assert.ok(repaired.status === 'imported');
    assert.deepEqual(repaired.imported.sort(), [
      'profiles/user-001/bank-ledger.json',
      'profiles/user-004/bank-ledger.json',
    ]);
    assert.deepEqual(
      [
        repaired.counts.users,
        repaired.counts.bank_accounts,
        repaired.counts.bank_transactions,
        repaired.counts.bank_ledgers,
      ],
      [0, 1, 3, 1],
    );
    assert.equal(repaired.alreadyImported.length, 5, 'the five profiles were not read again');
    assert.equal(repaired.skipped.length, 4, 'the files that are still broken are still reported');
    // An untouched ledger comes back as the file had it.
    const restored = await bank.read('user-001');
    assert.deepEqual([restored.revision, restored.transactions.map(tx => tx.id)], [2, ['tx-a', 'tx-b']]);
    // A ledger that moved on keeps what it has: the stored movement wins, the missing one is added as one new revision.
    const merged = await bank.read('user-004');
    assert.deepEqual(
      merged.transactions.map(tx => [tx.id, tx.amountCents]),
      [
        ['tx-run', -1000],
        ['tx-old', -1000],
      ],
    );
    assert.deepEqual([merged.revision, merged.events.at(-1)?.transactionCount], [3, 2]);
    assert.notEqual(merged.updatedAt, '2026-01-01T00:00:00.000Z');

    // Running it again imports nothing and changes nothing.
    const snapshot = [await bank.read('user-001'), await bank.read('user-004')];
    const again = await importLegacyFiles(db, sources);
    assert.ok(again.status === 'imported');
    assert.deepEqual([again.imported, Object.values(again.counts).some(count => count > 0)], [[], false]);
    assert.equal(again.alreadyImported.length, 7);
    assert.deepEqual([await bank.read('user-001'), await bank.read('user-004')], snapshot);
    assert.equal(importedLegacyFiles(db).length, 7);
    assert.equal(JSON.parse(readMeta(db, legacyImportMarker) ?? '{}').counts.bank_transactions, 3);
    db.close();

    // The same through the command an operator runs: it reports what is still broken and exits with 2.
    await write(join(profileDir, 'user-002', 'app-inputs.json'), {
      schemaVersion: 1,
      synthetic: true,
      inputs: [
        {
          id: 'kept',
          source: 'manual',
          observedAt: '2026-11-20T10:00:00Z',
          confirmed: true,
          synthetic: true,
          data: { household: { size: 2 } },
        },
      ],
    });
    const command = await new Promise<{ code: number | null; output: string }>(resolve =>
      execFile(
        process.execPath,
        [join(import.meta.dirname, '..', 'scripts', 'import-legacy.ts'), profileDir, habitsDir],
        { env: { ...process.env, DATABASE_FILE: join(directory, 'relocat.db') } },
        (error, stdout, stderr) =>
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}` }),
      ),
    );
    assert.equal(command.code, 2, command.output);
    assert.match(command.output, /Imported 1 file\(s\).*1 input_records/);
    assert.match(command.output, /imported: profiles\/user-002\/app-inputs\.json/);
    assert.match(command.output, /not imported: .*user-003.*bank-ledger\.json \(.*100000/);
    assert.match(command.output, /8 legacy file\(s\) are recorded as imported in total/);
    const reopened = open(join(directory, 'relocat.db'));
    assert.equal((await createInputStore(reopened).read('user-002')).inputs[0].id, 'kept');
    reopened.close();
  } finally {
    if (db) db.close();
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

test('the backup command leaves one verified file, cleans up after a failure and never overwrites', async () => {
  const { readdir } = await import('node:fs/promises');
  const { directory, remove } = await scratch('relocat-db-backup-command-');
  try {
    const source = join(directory, 'live', 'relocat.db');
    const db = open(source);
    const bank = await withLedger(db);
    await bank.importTransactions('alice', { transactions: range(0, 20).map(id => movement(id)) });
    const backups = join(directory, 'backups');
    /** `npm run db:backup -- <file>` as the image runs it, against the given database. */
    const backup = (target: string, databaseFile = source) =>
      new Promise<{ code: number; output: string }>(resolve => {
        execFile(
          process.execPath,
          ['scripts/backup-db.ts', target],
          { env: { ...process.env, DATABASE_FILE: databaseFile } },
          (error, stdout, stderr) =>
            resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: stdout + stderr }),
        );
      });

    // While the server has the database open: one file, no write-ahead log or partial file beside it.
    const first = join(backups, 'first.db');
    const done = await backup(first);
    assert.equal(done.code, 0, done.output);
    assert.match(done.output, /Backed up .* \(schema version \d+, 1 users\)/);
    assert.deepEqual(await readdir(backups), ['first.db']);
    const copy = open(first, { readOnly: true });
    assert.equal(integrityCheck(copy), 'ok');
    assert.equal((await createBankStore(copy).read('alice')).transactions.length, 20);
    copy.close();
    await rm(`${first}-wal`, { force: true });
    await rm(`${first}-shm`, { force: true });

    // An existing backup is never overwritten.
    const again = await backup(first);
    assert.equal(again.code, 1);
    assert.match(again.output, /already exists/);

    // A backup that fails (the source is not a database) exits 1 and leaves nothing behind...
    const broken = join(directory, 'broken.db');
    await writeFile(broken, 'this is not a database, but it is long enough to look like a file with pages '.repeat(50));
    const second = join(backups, 'second.db');
    const failed = await backup(second, broken);
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, /Backup failed/);
    assert.deepEqual(await readdir(backups), ['first.db']);
    // ...so the same name works on the next run, also when a killed run left its partial file there.
    await writeFile(`${second}.partial`, 'half a backup');
    await writeFile(`${second}.partial-wal`, 'stale');
    const retried = await backup(second);
    assert.equal(retried.code, 0, retried.output);
    assert.deepEqual((await readdir(backups)).sort(), ['first.db', 'second.db']);
    db.close();
  } finally {
    await remove();
  }
});
