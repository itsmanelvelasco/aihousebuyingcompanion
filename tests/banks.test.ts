import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBankStore } from '../apps/profile-api/bank.ts';
import { createProfileApi } from '../apps/profile-api/server.ts';
import type { ProviderTransaction } from '../packages/banks/provider.ts';
import {
  decimalToCents,
  defineBankProvider,
  hmacSha256Matches,
  safeCategory,
  stableId,
} from '../packages/banks/provider.ts';
import synthetic from '../packages/banks/providers/synthetic.ts';
import { createBankRegistry, loadBankRegistry } from '../packages/banks/registry.ts';
import type { BankEvent } from '../packages/banks/sync.ts';
import { createBankSync } from '../packages/banks/sync.ts';
import { createVault, developmentVault, parseDataKey, VaultError } from '../packages/banks/vault.ts';
import { safeId } from '../packages/contracts/ids.ts';
import { getConnection } from '../packages/db/bank-sync.ts';
import type { Database } from '../packages/db/database.ts';
import { open } from '../packages/db/database.ts';
import { createStore } from '../packages/profiles/store.ts';
import { consentBank, testVault } from './support/banks.ts';

const webhookSecret = 'fake-webhook-secret';
const fakeEnv = { BANK_FAKE_BANK_API_KEY: 'fake-api-key', BANK_FAKE_BANK_WEBHOOK_SECRET: webhookSecret };

/** A fictional bank whose movements the test controls. It records how the engine called it. */
function fakeBank() {
  const state = { feed: [] as ProviderTransaction[], sinceSeen: [] as (string | null)[], keysSeen: [] as string[] };
  const provider = defineBankProvider({
    id: 'fake-bank',
    displayName: 'Fake Bank',
    synthetic: true,
    env: [
      { name: 'BANK_FAKE_BANK_API_KEY', description: 'Fictional API key.' },
      { name: 'BANK_FAKE_BANK_WEBHOOK_SECRET', description: 'Fictional signing secret.' },
    ],
    async listAccounts() {
      return [
        {
          id: stableId('fake-bank', 'ACC/1'),
          name: 'Fake current account',
          currency: 'EUR' as const,
          openingBalanceCents: 100000,
          openingDate: '2026-11-01',
        },
      ];
    },
    async fetchTransactions(_connection, { since, env }) {
      state.sinceSeen.push(since);
      state.keysSeen.push(env.BANK_FAKE_BANK_API_KEY);
      return { transactions: state.feed, nextCursor: `cursor-${state.feed.length}` };
    },
    verifyWebhook({ headers, rawBody }, { env }) {
      const signature = headers['x-fake-signature'];
      return (
        typeof signature === 'string' && hmacSha256Matches(env.BANK_FAKE_BANK_WEBHOOK_SECRET, rawBody, signature, 'hex')
      );
    },
    parseWebhook(rawBody) {
      const body = JSON.parse(rawBody) as { link?: unknown };
      return typeof body.link === 'string' ? { connectionRef: body.link, hint: 'movement' } : null;
    },
  });
  return { provider, state };
}

const accountId = stableId('fake-bank', 'ACC/1');
const movement = (externalId: string, amountCents: number, status: 'booked' | 'pending' = 'booked') => ({
  id: stableId('fake-bank', externalId),
  accountId,
  date: '2026-11-10',
  description: `Fake movement ${externalId}`,
  amountCents,
  category: safeCategory('food', amountCents),
  status,
});

async function fixture() {
  const db = open(':memory:');
  const document = { schemaVersion: 1 as const, synthetic: true as const };
  for (const id of ['alice', 'bob']) {
    await createStore(db).create(id, {
      details: { ...document, id },
      preferences: document,
      'bank-account': {
        ...document,
        snapshotDate: '2026-11-21',
        balanceCents: 500000,
        monthlyIncomeCents: 240000,
        monthlyExpensesCents: 170000,
        debtPaymentsCents: 10000,
      },
    });
  }
  return db;
}

/** Wait until a condition holds, for work the server does in the background. */
async function eventually(condition: () => boolean | Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test('registry discovers provider files, skips templates and reports missing variables as unconfigured', async () => {
  const shipped = await loadBankRegistry({ env: {} });
  assert.deepEqual(shipped.loadErrors, []);
  assert.equal(shipped.get('synthetic')?.status, 'configured');
  assert.equal(shipped.get('demo-bank')?.status, 'unconfigured', 'the demo bank needs its three variables');
  assert.deepEqual(shipped.get('demo-bank')?.missingEnv, [
    'BANK_DEMO_BANK_BASE_URL',
    'BANK_DEMO_BANK_API_KEY',
    'BANK_DEMO_BANK_WEBHOOK_SECRET',
  ]);
  assert.equal(shipped.get('my-bank'), undefined, 'files starting with _ are templates, not providers');
  assert.ok(shipped.list().every(provider => provider.id !== 'my-bank'));

  const directory = await mkdtemp(join(tmpdir(), 'relocat-providers-'));
  const source = (id: string, variable: string) =>
    `export default { id: '${id}', displayName: 'Bank ${id}', synthetic: true,
      env: [{ name: '${variable}', description: 'Fictional key.' }],
      async listAccounts() { return []; }, async fetchTransactions() { return { transactions: [] }; } };\n`;
  try {
    await writeFile(join(directory, 'needy.ts'), source('needy', 'BANK_NEEDY_KEY'));
    await writeFile(join(directory, '_draft.ts'), source('draft', 'BANK_DRAFT_KEY'));
    await writeFile(join(directory, 'broken.ts'), 'export default 42;\n');
    await writeFile(join(directory, 'misnamed.ts'), source('misnamed', 'SOME_OTHER_KEY'));
    await writeFile(join(directory, 'notes.md'), 'not a provider\n');

    const missing = await loadBankRegistry({ directory, env: {} });
    assert.deepEqual(
      missing.list().map(provider => [provider.id, provider.status]),
      [['needy', 'unconfigured']],
    );
    assert.deepEqual(missing.get('needy')?.missingEnv, ['BANK_NEEDY_KEY']);
    assert.deepEqual(missing.loadErrors.map(error => error.file).sort(), ['broken.ts', 'misnamed.ts']);

    const configured = await loadBankRegistry({ directory, env: { BANK_NEEDY_KEY: 'value-that-must-not-be-listed' } });
    const listed = configured.list()[0];
    assert.equal(listed.status, 'configured');
    assert.deepEqual(listed.env, [
      { name: 'BANK_NEEDY_KEY', description: 'Fictional key.', required: true, set: true },
    ]);
    assert.ok(!JSON.stringify(configured.list()).includes('value-that-must-not-be-listed'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider helpers give stable IDs, exact cents and sign-safe categories', () => {
  assert.equal(stableId('fake-bank', 'abc123'), 'fake-bank-abc123');
  const hashed = stableId('fake-bank', 'TX_9/001 with spaces');
  assert.equal(hashed, stableId('fake-bank', 'TX_9/001 with spaces'));
  assert.ok(safeId.safeParse(hashed).success);
  assert.notEqual(hashed, stableId('fake-bank', 'TX_9/002 with spaces'));
  assert.equal(decimalToCents('-12.3'), -1230);
  assert.equal(decimalToCents('1050.07'), 105007);
  assert.equal(decimalToCents('0.29'), 29);
  assert.throws(() => decimalToCents('1.005'));
  assert.throws(() => decimalToCents('1e3'));
  assert.equal(safeCategory('food', 500), 'other');
  assert.equal(safeCategory('income', -500), 'other');
  assert.equal(safeCategory('housing', -500), 'housing');
  assert.throws(() =>
    defineBankProvider({ ...synthetic, id: 'other-bank', env: [{ name: 'OTHER_KEY', description: 'Wrong prefix.' }] }),
  );
  assert.throws(() => defineBankProvider({ ...synthetic, id: 'half-hook', verifyWebhook: () => true }));
});

test('a provider syncs end to end: connect, import, idempotent re-sync, updates and events', async () => {
  const db = await fixture();
  const { provider, state } = fakeBank();
  const bank = createBankStore(db);
  const registry = createBankRegistry([provider], fakeEnv);
  const sync = createBankSync({ ledger: bank, registry, db, clock: () => new Date('2026-11-21T12:00:00Z') });
  const events: BankEvent[] = [];
  const unsubscribe = sync.onEvent(event => events.push(event));
  try {
    const connection = await sync.connect('alice', {
      providerId: 'fake-bank',
      ref: 'link-alice',
      pollIntervalMs: null,
    });
    assert.equal(connection.providerId, 'fake-bank');
    assert.equal(connection.polling, false);
    assert.ok(!('ref' in connection), 'the bank-side reference is not echoed');
    await assert.rejects(sync.connect('bob', { providerId: 'fake-bank', ref: 'link-alice' }), { status: 409 });
    await assert.rejects(sync.connect('alice', { providerId: 'unknown-bank', ref: 'x' }), { status: 404 });
    await assert.rejects(sync.connect('missing', { providerId: 'fake-bank', ref: 'y' }), { status: 404 });

    state.feed = [movement('TX/1', -2500), movement('TX/2', -900, 'pending')];
    const first = (await sync.sync('alice')).results[0];
    assert.equal(first.status, 'synced');
    assert.deepEqual(
      first.status === 'synced' && [first.accountsCreated, first.inserted, first.updated, first.duplicates],
      [1, 2, 0, 0],
    );
    assert.deepEqual(state.sinceSeen, [null]);
    assert.deepEqual(state.keysSeen, ['fake-api-key']);
    const ledger = await bank.read('alice');
    assert.equal(ledger.transactions.length, 2);
    assert.ok(ledger.transactions.every(tx => tx.synthetic === true && tx.currency === 'EUR'));
    assert.deepEqual(
      events.map(event => [event.userId, event.event.sequence]),
      [
        ['alice', 1],
        ['alice', 2],
      ],
      'one event for the new account and one for the imported movements',
    );

    const repeated = (await sync.sync('alice', connection.id)).results[0];
    assert.deepEqual(
      repeated.status === 'synced' && [repeated.accountsCreated, repeated.inserted, repeated.duplicates],
      [0, 0, 2],
    );
    assert.equal((await bank.read('alice')).revision, ledger.revision, 'an identical sync writes no revision');
    assert.equal(events.length, 2);
    assert.equal(state.sinceSeen[1], '2026-11-14', 'later syncs overlap the previous one by a week');

    state.feed = [movement('TX/1', -2500), movement('TX/2', -900, 'booked'), movement('TX/3', -100)];
    const changed = (await sync.sync('alice')).results[0];
    assert.deepEqual(changed.status === 'synced' && [changed.inserted, changed.updated, changed.duplicates], [1, 1, 1]);
    assert.equal(events.length, 3);
    assert.equal(events[2].event.transactionCount, 3);

    assert.equal(getConnection(db, 'alice', connection.id)?.cursor, 'cursor-3');
    assert.equal((await sync.listConnections('alice'))[0].lastSyncAt, '2026-11-21T12:00:00.000Z');

    state.feed = [{ ...movement('TX/4', -100), accountId: 'not-an-account' }];
    const failed = (await sync.sync('alice')).results[0];
    assert.equal(failed.status, 'failed');
    assert.equal((await bank.read('alice')).transactions.length, 3, 'a rejected batch leaves the ledger untouched');
    assert.ok((await sync.listConnections('alice'))[0].lastError);

    assert.deepEqual(await sync.listConnections('bob'), []);
    assert.deepEqual(await sync.disconnect('alice', connection.id), { deleted: connection.id });
    await assert.rejects(sync.disconnect('alice', connection.id), { status: 404 });
    assert.equal((await bank.read('alice')).transactions.length, 3, 'disconnecting keeps imported movements');
  } finally {
    unsubscribe();
    await sync.close();
    db.close();
  }
});

test('connections without webhooks are polled, and persisted links survive a restart', async () => {
  const db = await fixture();
  const { provider, state } = fakeBank();
  const polled = defineBankProvider({
    ...provider,
    id: 'polled-bank',
    env: [],
    verifyWebhook: undefined,
    parseWebhook: undefined,
  });
  const bank = createBankStore(db);
  const registry = createBankRegistry([polled], {});
  let sync = createBankSync({ ledger: bank, registry, db });
  try {
    state.feed = [{ ...movement('TX/1', -2500), id: 'polled-tx-1' }];
    const connection = await sync.connect('alice', {
      providerId: 'polled-bank',
      ref: 'link-poll',
      pollIntervalMs: 1000,
    });
    assert.equal(connection.polling, true);
    await eventually(async () => (await bank.read('alice')).transactions.length === 1, 'polling never imported');
    await sync.close();

    sync = createBankSync({ ledger: bank, registry, db });
    const restored = await sync.listConnections('alice');
    assert.equal(restored.length, 1);
    assert.equal(restored[0].pollIntervalMs, 1000);
    assert.equal(restored[0].polling, false, 'synthetic providers never resume polling on their own');
    await assert.rejects(sync.connect('bob', { providerId: 'polled-bank', ref: 'link-poll' }), { status: 409 });
  } finally {
    await sync.close();
    db.close();
  }
});

test('HTTP routes list providers, manage connections, verify webhooks and stream ledger events', async () => {
  const db = await fixture();
  const { provider, state } = fakeBank();
  const token = 'banks-test-token';
  const needy = defineBankProvider({
    ...provider,
    id: 'needy-bank',
    env: [{ name: 'BANK_NEEDY_BANK_KEY', description: 'Never set in this test.' }],
  });
  const server = createProfileApi(db, token, {
    bankRegistry: createBankRegistry([provider, synthetic, needy], fakeEnv),
    heartbeatMs: 40,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const authorization = { Authorization: `Bearer ${token}` };
  async function request(path: string, method = 'GET', body?: unknown, authorized = true) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(authorized ? authorization : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  /** Call the webhook route the way a bank would: no bearer token, a signature over the raw body. */
  async function webhook(providerId: string, rawBody: string, signature?: string) {
    const response = await fetch(`${base}/webhooks/bank/${providerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Fake-Signature': signature } : {}) },
      body: rawBody,
    });
    return response.status;
  }
  const sign = (rawBody: string) => createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const stream = new AbortController();
  try {
    assert.equal((await request('/bank/providers', 'GET', undefined, false)).status, 401);
    assert.equal((await request('/users/alice/bank/connections', 'GET', undefined, false)).status, 401);
    assert.equal((await request('/users/alice/bank/sync', 'POST', {}, false)).status, 401);
    assert.equal((await request('/users/alice/bank/events/stream', 'GET', undefined, false)).status, 401);

    const providers = await request('/bank/providers');
    assert.equal(providers.status, 200);
    assert.deepEqual(
      providers.data.providers.map((item: any) => [item.id, item.status, item.webhooks]),
      [
        ['fake-bank', 'configured', true],
        ['synthetic', 'configured', false],
        ['needy-bank', 'unconfigured', true],
      ],
    );
    assert.ok(!JSON.stringify(providers.data).includes(webhookSecret), 'the listing never contains values');

    assert.equal(
      (await request('/users/alice/bank/connections', 'POST', { providerId: 'needy-bank', ref: 'n' })).status,
      409,
    );
    assert.equal((await request('/users/alice/bank/connections', 'POST', { providerId: 'fake-bank' })).status, 400);
    const created = await request('/users/alice/bank/connections', 'POST', {
      providerId: 'fake-bank',
      ref: 'link-alice',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.pollIntervalMs, null, 'a provider with webhooks is not polled by default');
    assert.equal((await request('/users/alice/bank/connections')).data.connections.length, 1);
    assert.deepEqual((await request('/users/alice/bank/sync', 'POST', {})).data.results[0].accountsCreated, 1);
    assert.equal((await request('/users/bob/bank/sync', 'POST', {})).data.results.length, 0);
    assert.equal((await request('/users/alice/bank/sync', 'POST', { connectionId: 'missing' })).status, 404);

    // Server-Sent Events: replay from the cursor, then live pushes and heartbeats.
    const response = await fetch(`${base}/users/alice/bank/events/stream?after=0`, {
      headers: authorization,
      signal: stream.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const reader = response.body!.getReader();
    let received = '';
    async function readUntil(pattern: RegExp) {
      const deadline = Date.now() + 5000;
      while (!pattern.test(received)) {
        assert.ok(Date.now() < deadline, `stream never matched ${pattern}; got ${received}`);
        const { value, done } = await reader.read();
        assert.ok(!done, 'stream ended early');
        received += Buffer.from(value).toString('utf8');
      }
    }
    await readUntil(/event: ready\ndata: \{"latestRevision":1,"requiresRefresh":false,"synthetic":true\}\n\n/);
    await readUntil(/id: 1\nevent: bank\.updated\ndata: \{"sequence":1,/);
    await readUntil(/: heartbeat\n\n/);

    // Webhooks: only a valid signature triggers a sync, and the sync reads the bank, not the body.
    const notification = JSON.stringify({ link: 'link-alice', amountCents: 99999999 });
    assert.equal(await webhook('synthetic', notification, sign(notification)), 404, 'no webhook support');
    assert.equal(await webhook('unknown-bank', notification, sign(notification)), 404);
    assert.equal(await webhook('needy-bank', notification, sign(notification)), 503);
    assert.equal(await webhook('fake-bank', notification), 401);
    assert.equal(await webhook('fake-bank', notification, sign(`${notification} `)), 401);
    assert.equal(await webhook('fake-bank', 'x'.repeat(70_000), sign('x')), 413);
    assert.equal((await request('/webhooks/bank/fake-bank')).status, 405);
    assert.equal((await bank(db).read('alice')).transactions.length, 0, 'rejected webhooks import nothing');

    state.feed = [movement('TX/1', -2500)];
    assert.equal(await webhook('fake-bank', notification, sign(notification)), 202);
    await readUntil(/id: 2\nevent: bank\.updated\ndata: (\{[^\n]*"sequence":2[^\n]*\})\n\n/);
    const pushed = JSON.parse(/id: 2\nevent: bank\.updated\ndata: (\{[^\n]*\})\n\n/.exec(received)![1]);
    const polled = await request('/users/alice/bank/events?after=1&limit=1');
    assert.deepEqual(pushed, polled.data.events[0], 'stream items have the shape of /events items');
    const ledger = await bank(db).read('alice');
    assert.deepEqual(
      ledger.transactions.map(tx => tx.amountCents),
      [-2500],
    );
    const unknown = JSON.stringify({ link: 'nobody' });
    assert.equal(await webhook('fake-bank', unknown, sign(unknown)), 202, 'unknown references are not revealed');

    // A manual import through the existing route reaches the stream too.
    const manual = { ...movement('manual', -700), id: 'manual-1', currency: 'EUR', synthetic: true };
    assert.equal((await request('/users/alice/bank/transactions', 'POST', { transactions: [manual] })).status, 200);
    await readUntil(/id: 3\nevent: bank\.updated\n/);
    assert.doesNotMatch(received, /Fake movement/, 'events carry counts, not descriptions');

    // The original runtime route now drives the synthetic provider through a connection.
    const tick = await request('/users/bob/bank/runtime/tick', 'POST', {});
    assert.equal(tick.status, 200);
    assert.equal(tick.data.inserted, 1);
    assert.equal(tick.data.tickCount, 1);
    const bobConnections = (await request('/users/bob/bank/connections')).data.connections;
    assert.deepEqual(
      bobConnections.map((item: any) => [item.id, item.providerId, item.polling]),
      [['synthetic-feed', 'synthetic', false]],
    );
    assert.equal((await request('/users/bob/bank/runtime')).data.enabled, false);

    assert.equal((await request(`/users/alice/bank/connections/${created.data.id}`, 'DELETE')).status, 200);
    assert.equal((await request(`/users/alice/bank/connections/${created.data.id}`, 'DELETE')).status, 404);
    assert.equal((await request('/users/missing/bank/connections')).status, 404);
  } finally {
    // Closing the server must end the open event stream instead of waiting for it.
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    stream.abort();
    db.close();
  }
});

test('a non-synthetic provider stores real records, and any real record makes results non-synthetic', async () => {
  const db = await fixture();
  const { provider, state } = fakeBank();
  // Still a test double: `synthetic: false` only declares how its records must be labelled.
  const realAccount = stableId('real-bank', 'acc-1');
  const real = defineBankProvider({
    ...provider,
    id: 'real-bank',
    env: [],
    synthetic: false,
    async listAccounts() {
      return [
        {
          id: realAccount,
          name: 'Current account',
          currency: 'EUR' as const,
          openingBalanceCents: 100000,
          openingDate: '2026-08-01',
        },
      ];
    },
  });
  const token = 'banks-real-token';
  const server = createProfileApi(db, token, { bankRegistry: createBankRegistry([real, synthetic], {}) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/users`;
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  const period = '?from=2026-08-01&to=2026-10-31';
  const link = (ref: string) => ({ providerId: 'real-bank', ref, pollIntervalMs: null });
  try {
    // Nothing imported yet: an empty ledger has no real record.
    assert.equal((await request(`/alice/bank/summary${period}`)).data.synthetic, true);

    state.feed = ['2026-08', '2026-09', '2026-10'].map(month => ({
      ...movement(`salary-${month}`, 200000),
      id: `real-salary-${month}`,
      accountId: realAccount,
      date: `${month}-02`,
      category: 'income' as const,
    }));
    assert.equal((await request('/alice/bank/connections', 'POST', link('link-real-alice'))).status, 201);
    const synced = await request('/alice/bank/sync', 'POST', {});
    assert.equal(synced.data.results[0].status, 'synced');
    assert.equal(synced.data.results[0].inserted, 3);

    const stored = await bank(db).read('alice');
    assert.equal(stored.synthetic, false);
    assert.ok(stored.accounts.every(account => account.synthetic === false));
    assert.ok(stored.transactions.every(tx => tx.synthetic === false));
    const summary = await request(`/alice/bank/summary${period}`);
    assert.equal(summary.data.synthetic, false);
    assert.equal(summary.data.incomeCents, 600000);
    const simulation = await request(`/alice/bank/simulate${period}`, 'POST', {
      targetCashCents: 1000000,
      currentSavingsCents: 0,
    });
    assert.equal(simulation.data.synthetic, false);
    assert.equal((await request('/alice/bank/accounts')).data.synthetic, false);
    assert.equal((await request('/alice/bank/transactions')).data.synthetic, false);
    const events = (await request('/alice/bank/events')).data;
    assert.equal(events.synthetic, false);
    assert.ok(events.events.every((event: any) => event.synthetic === false));

    // Bob starts with the synthetic demo ledger, then links the real provider: mixed means not synthetic.
    assert.equal((await request('/bob/bank/runtime/tick', 'POST', {})).status, 200);
    assert.equal((await request(`/bob/bank/summary${period}`)).data.synthetic, true);
    assert.equal((await request('/bob/bank/events')).data.synthetic, true);
    state.feed = [{ ...state.feed[0], id: 'real-bob-salary' }];
    assert.equal((await request('/bob/bank/connections', 'POST', link('link-real-bob'))).status, 201);
    assert.equal((await request('/bob/bank/sync', 'POST', { connectionId: 'missing' })).status, 404);
    const mixed = await request('/bob/bank/sync', 'POST', {});
    assert.ok(mixed.data.results.every((result: any) => result.status === 'synced'));
    const bob = await bank(db).read('bob');
    assert.ok(bob.transactions.some(tx => tx.synthetic) && bob.transactions.some(tx => !tx.synthetic));
    assert.equal(bob.synthetic, false);
    assert.equal((await request(`/bob/bank/summary${period}`)).data.synthetic, false);
    const bobEvents = (await request('/bob/bank/events')).data;
    assert.equal(bobEvents.synthetic, false);
    assert.equal(bobEvents.events[0].synthetic, true, 'earlier revisions keep the label they had');
    assert.equal(bobEvents.events.at(-1).synthetic, false);

    // A record without the flag is rejected rather than assumed real or synthetic.
    const unlabelled = { ...movement('unlabelled', -500), id: 'unlabelled', accountId: realAccount, currency: 'EUR' };
    assert.equal((await request('/alice/bank/transactions', 'POST', { transactions: [unlabelled] })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    db.close();
  }
});

/** A second store instance, to assert what was actually persisted. */
function bank(db: Database) {
  return createBankStore(db);
}

test('a full ledger rejects the batch once, says so on the connection and is not retried', async () => {
  const db = await fixture();
  const { provider, state } = fakeBank();
  const ledger = createBankStore(db, { maxTransactions: 3 });
  const registry = createBankRegistry([provider], fakeEnv);
  let now = Date.parse('2026-11-21T12:00:00Z');
  const sync = createBankSync({
    ledger,
    registry,
    db,
    clock: () => new Date(now),
    housekeepingMs: null,
    retryBaseMs: 1000,
    fallbackPollMs: 60_000,
  });
  const fetches = () => state.sinceSeen.length;
  try {
    const connection = await sync.connect('alice', { providerId: 'fake-bank', ref: 'link-alice' });
    state.feed = [movement('TX/1', -100), movement('TX/2', -200), movement('TX/3', -300)];
    assert.equal((await sync.sync('alice')).results[0].status, 'synced');

    // The bank now has more than the ledger may hold: the batch is refused whole.
    state.feed = [...state.feed, movement('TX/4', -400), movement('TX/5', -500)];
    const failed = (await sync.sync('alice')).results[0];
    assert.equal(failed.status, 'failed');
    assert.match(String('error' in failed && failed.error), /Movement limit reached.*3 movements/);
    let view = await sync.connection('alice', connection.id);
    assert.match(view?.lastError ?? '', /Delete older movements, then sync again/);
    assert.equal(view?.consecutiveFailures, 1);
    assert.equal(view?.nextRetryAt, null, 'no retry is scheduled');
    assert.equal((await ledger.read('alice')).transactions.length, 3, 'nothing of the refused batch was stored');

    // Neither time passing nor more webhooks make the engine ask the bank again.
    const before = fetches();
    for (let round = 0; round < 5; round++) {
      now += 120_000;
      await sync.acceptWebhook('fake-bank', { connectionRef: 'link-alice', eventId: `evt-${round}` });
      await sync.runDue();
      await sync.idle();
    }
    assert.equal(fetches(), before);
    assert.equal((await sync.connection('alice', connection.id))?.consecutiveFailures, 1);
    assert.equal(sync.webhookStatus().pending, 1, 'the notification waits; it is not lost');

    // Once there is room, a sync asked for by a caller succeeds and the connection is healthy again.
    await ledger.deleteTransaction('alice', stableId('fake-bank', 'TX/1'));
    await ledger.deleteTransaction('alice', stableId('fake-bank', 'TX/2'));
    state.feed = state.feed.slice(2);
    assert.equal((await sync.sync('alice')).results[0].status, 'synced');
    view = await sync.connection('alice', connection.id);
    assert.equal(view?.lastError, null);
    assert.equal(view?.consecutiveFailures, 0);
    assert.equal(sync.webhookStatus().pending, 0);
    state.feed = [movement('TX/3', -301)];
    await sync.acceptWebhook('fake-bank', { connectionRef: 'link-alice', eventId: 'evt-after' });
    await sync.idle();
    assert.equal(fetches(), before + 2, 'webhooks drive syncs again');
  } finally {
    await sync.close();
    db.close();
  }
});

// --------------------------------------------------------------- consent and sealing

/** An engine over a fresh database with the consent bank, a vault and a clock the test moves. */
async function consentFixture(options: { file?: string; webhooks?: boolean } = {}) {
  const db = options.file ? open(options.file) : await fixture();
  if (options.file) {
    const document = { schemaVersion: 1 as const, synthetic: true as const };
    for (const id of ['alice', 'bob'])
      if (!db.get('SELECT 1 FROM users WHERE id = ?', id))
        await createStore(db).create(id, {
          details: { ...document, id },
          preferences: document,
          'bank-account': document,
        });
  }
  const bank = consentBank({ webhooks: options.webhooks });
  const clock = { now: Date.parse('2026-11-22T10:00:00Z') };
  const vault = testVault();
  const ledger = createBankStore(db);
  const engine = (overrides: Partial<Parameters<typeof createBankSync>[0]> = {}) =>
    createBankSync({
      ledger,
      registry: bank.registry([synthetic]),
      db,
      vault,
      clock: () => new Date(clock.now),
      housekeepingMs: null,
      ...overrides,
    });
  const returnUrl = 'http://127.0.0.1:8787/bank/consent/callback';
  return { db, bank, clock, vault, ledger, engine, returnUrl };
}

test('the vault seals for one row, fails closed on any mismatch, and reads the key in three spellings', () => {
  const key = randomBytes(32);
  const vault = createVault(key);
  const sealed = vault.seal('CREDENTIAL-1', 'row-a');
  assert.match(sealed, /^v1\.[\w-]{16}\.[\w-]+\.[\w-]{22}$/);
  assert(!sealed.includes('CREDENTIAL'));
  assert.notEqual(vault.seal('CREDENTIAL-1', 'row-a'), sealed, 'a fresh nonce every time');
  assert.equal(vault.open(sealed, 'row-a'), 'CREDENTIAL-1');
  // Another row, another key, a changed byte, another format: nothing comes back.
  assert.throws(() => vault.open(sealed, 'row-b'), VaultError);
  assert.throws(() => createVault(randomBytes(32)).open(sealed, 'row-a'), VaultError);
  const parts = sealed.split('.');
  parts[2] = `${parts[2].startsWith('A') ? 'B' : 'A'}${parts[2].slice(1)}`;
  assert.throws(() => vault.open(parts.join('.'), 'row-a'), VaultError);
  assert.throws(() => vault.open('v2.a.b.c', 'row-a'), VaultError);
  assert.throws(() => vault.open('plain text', 'row-a'), VaultError);
  // The fingerprint is stable, keyed and not the value.
  assert.equal(vault.fingerprint('cust-001'), vault.fingerprint('cust-001'));
  assert.match(vault.fingerprint('cust-001'), /^sealed:[0-9a-f]{64}$/);
  assert.notEqual(vault.fingerprint('cust-001'), createVault(randomBytes(32)).fingerprint('cust-001'));

  for (const spelling of [key.toString('hex'), key.toString('base64'), key.toString('base64url')])
    assert.deepEqual(parseDataKey(spelling), key, spelling);
  assert.equal(parseDataKey(undefined), undefined);
  assert.equal(parseDataKey('  '), undefined);
  for (const bad of ['short', 'x'.repeat(64), key.toString('hex').slice(2)])
    assert.throws(() => parseDataKey(bad), VaultError);
  assert.throws(() => createVault(randomBytes(16)), VaultError);
});

test('without DATA_ENCRYPTION_KEY a development key is created once, kept in the database and announced once', () => {
  const db = open(':memory:');
  const notices: string[] = [];
  const first = developmentVault(db, message => notices.push(message));
  const second = developmentVault(db, message => notices.push(message));
  assert.equal(first.development, true);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /DATA_ENCRYPTION_KEY is not set/);
  assert.match(notices[0], /development key/);
  assert.equal(second.open(first.seal('x', 'row'), 'row'), 'x', 'the same key is read back');
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_meta WHERE key LIKE 'data-encryption%'")?.n, 1);
  db.close();
});

test('a consent connects a bank for the person who started it, once, in the session that started it', async () => {
  const { db, bank, clock, engine, returnUrl } = await consentFixture();
  const sync = engine();
  try {
    assert.deepEqual(await sync.banks(), [
      { id: 'consent-bank', displayName: 'Consent Bank', synthetic: false, connect: 'consent_at_bank', webhooks: true },
      { id: 'synthetic', displayName: 'Synthetic demo feed', synthetic: true, connect: 'direct', webhooks: false },
    ]);
    const begin = () => sync.beginConsent('alice', 'consent-bank', { sessionKey: 'session-alice', returnUrl });
    const started = await begin();
    assert.equal(new URL(started.redirectUrl).origin, 'https://bank.example');
    assert.equal(bank.state.begun[0].returnUrl, returnUrl);
    const state = bank.lastState();
    assert.match(state, /^[\w-]{43}$/);
    // Only a hash of the state is stored, with the person and a hash of the session.
    const stored = db.all<Record<string, string>>('SELECT * FROM bank_consents');
    assert.equal(stored.length, 1);
    assert(!JSON.stringify(stored).includes(state) && !JSON.stringify(stored).includes('session-alice'));
    assert.deepEqual(
      (await sync.pendingConsents('alice')).map(item => item.providerId),
      ['consent-bank'],
    );
    assert.deepEqual(await sync.pendingConsents('bob'), []);

    // Another person presents the callback: refused, and the state is spent.
    await assert.rejects(
      sync.completeConsent({ state, code: 'code-ada' }, { userId: 'bob', sessionKey: 'session-bob' }),
      { status: 403 },
    );
    await assert.rejects(
      sync.completeConsent({ state, code: 'code-ada' }, { userId: 'alice', sessionKey: 'session-alice' }),
      { status: 400 },
    );
    assert.equal(bank.state.completed, 0, 'the bank was never asked');

    // The same person in another browser session: refused too.
    await begin();
    await assert.rejects(
      sync.completeConsent(
        { state: bank.lastState(), code: 'code-ada' },
        { userId: 'alice', sessionKey: 'other-session' },
      ),
      { status: 403 },
    );

    // Too late: refused.
    await begin();
    const late = bank.lastState();
    clock.now += 10 * 60_000 + 1;
    await assert.rejects(
      sync.completeConsent({ state: late, code: 'code-ada' }, { userId: 'alice', sessionKey: 'session-alice' }),
      { status: 400 },
    );
    assert.equal(sync.housekeeping(), 0, 'presenting it removed it');

    // An unknown or missing state, or one made up: refused.
    for (const forged of ['', 'x'.repeat(43), 'y'.repeat(300)])
      await assert.rejects(
        sync.completeConsent({ state: forged, code: 'code-ada' }, { userId: 'alice', sessionKey: 'session-alice' }),
        { status: 400 },
      );

    // Denied at the bank: nothing is connected and the bank is not asked for a link.
    await begin();
    const denied = await sync.completeConsent(
      { state: bank.lastState(), error: 'access_denied' },
      { userId: 'alice', sessionKey: 'session-alice' },
    );
    assert.equal(denied.status, 'denied');
    assert.equal(bank.state.completed, 0);
    assert.deepEqual(await sync.listConnections('alice'), []);

    // A code the bank refuses: nothing is connected.
    await begin();
    await assert.rejects(
      sync.completeConsent(
        { state: bank.lastState(), code: 'made-up' },
        { userId: 'alice', sessionKey: 'session-alice' },
      ),
      { status: 502, message: 'Consent Bank refused the code' },
    );
    assert.deepEqual(await sync.listConnections('alice'), []);

    // The real thing.
    await begin();
    const good = bank.lastState();
    const outcome = await sync.completeConsent(
      { state: good, code: 'code-ada' },
      { userId: 'alice', sessionKey: 'session-alice' },
    );
    assert.equal(outcome.status, 'connected');
    assert(outcome.status === 'connected');
    assert.deepEqual(
      [outcome.connection.consent, outcome.connection.consentExpiresAt, outcome.connection.synthetic],
      ['granted', null, false],
    );
    assert(outcome.connection.lastSyncAt, 'a first pull ran');
    assert.deepEqual(
      bank.state.refsSeen,
      ['CREDENTIAL-ada-7f3c9b1e'],
      'the provider got the credential back, decrypted',
    );
    assert.equal((await createBankStore(db).read('alice')).transactions.length, 1);
    // Replay of a state that connected a bank: refused.
    await assert.rejects(
      sync.completeConsent({ state: good, code: 'code-ada' }, { userId: 'alice', sessionKey: 'session-alice' }),
      { status: 400 },
    );
    assert.deepEqual(await sync.pendingConsents('alice'), []);

    // At most five consents wait per person; a sixth pushes the oldest out.
    for (let n = 0; n < 7; n++) await begin();
    assert.equal((await sync.pendingConsents('alice')).length, 5);
    clock.now += 11 * 60_000;
    assert.equal(sync.housekeeping(), 5);
  } finally {
    await sync.close();
    db.close();
  }
});

test('the credential is sealed at rest: not in the file, one bank login per person, gone on disconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relocat-vault-'));
  const file = join(directory, 'relocat.db');
  const { db, bank, vault, engine, returnUrl } = await consentFixture({ file });
  const sync = engine();
  const consent = async (userId: string, code: string) => {
    await sync.beginConsent(userId, 'consent-bank', { sessionKey: `session-${userId}`, returnUrl });
    return sync.completeConsent({ state: bank.lastState(), code }, { userId, sessionKey: `session-${userId}` });
  };
  const credential = 'CREDENTIAL-ada-7f3c9b1e';
  /** Everything SQLite keeps for this database, as bytes. */
  const onDisk = async () =>
    Buffer.concat(
      await Promise.all(['', '-wal'].map(suffix => readFile(`${file}${suffix}`).catch(() => Buffer.alloc(0)))),
    );
  try {
    assert.equal((await consent('alice', 'code-ada')).status, 'connected');
    const row = db.get<{ id: string; ref: string }>("SELECT id, ref FROM bank_connections WHERE user_id = 'alice'")!;
    assert.equal(row.ref, vault.fingerprint(credential));
    const cipher = db.get<{ cipher: string }>("SELECT cipher FROM bank_credentials WHERE user_id = 'alice'")!.cipher;
    assert.match(cipher, /^v1\./);
    assert(!(await onDisk()).includes(Buffer.from(credential)), 'the credential is nowhere in the file in clear');
    assert(!(await onDisk()).includes(Buffer.from(bank.state.begun[0].state)), 'neither is the consent state');

    // One bank login belongs to one person: Bob approving with Ada's login is refused, as is an
    // operator linking the same reference in clear.
    await assert.rejects(consent('bob', 'code-ada'), { status: 409 });
    await assert.rejects(sync.connect('bob', { providerId: 'consent-bank', ref: credential }), { status: 409 });
    assert.deepEqual(await sync.listConnections('bob'), []);
    // And the other way round: a reference an operator linked cannot be taken over by a consent.
    await sync.connect('bob', { providerId: 'consent-bank', ref: 'CREDENTIAL-bob-52aa0d4c', pollIntervalMs: null });
    await assert.rejects(consent('alice', 'code-bob'), { status: 409 });

    // The bank's webhook names the credential; the engine finds the sealed connection without storing it.
    const fetched = bank.state.fetches;
    assert.deepEqual(await sync.acceptWebhook('consent-bank', { connectionRef: credential }), {
      known: true,
      duplicate: false,
    });
    await sync.idle();
    assert.equal(bank.state.fetches, fetched + 1);
    assert.deepEqual(await sync.acceptWebhook('consent-bank', { connectionRef: 'CREDENTIAL-nobody' }), {
      known: false,
      duplicate: false,
    });
    assert(!(await onDisk()).includes(Buffer.from(credential)), 'the queue did not store it either');

    // Ada consents again with the same login: the same connection, a fresh credential.
    const renewed = await consent('alice', 'code-ada');
    assert.equal(renewed.status, 'renewed');
    assert.equal((await sync.listConnections('alice')).length, 1);
    assert.notEqual(
      db.get<{ cipher: string }>("SELECT cipher FROM bank_credentials WHERE user_id = 'alice'")!.cipher,
      cipher,
    );

    // Disconnecting deletes the credential; the bank login is free for somebody else.
    await sync.disconnect('alice', row.id);
    assert.equal(db.get("SELECT 1 FROM bank_credentials WHERE user_id = 'alice'"), undefined);
    assert.deepEqual(await sync.acceptWebhook('consent-bank', { connectionRef: credential }), {
      known: false,
      duplicate: false,
    });
    await sync.disconnect('bob', (await sync.listConnections('bob'))[0].id);
    assert.equal((await consent('bob', 'code-ada')).status, 'connected');

    // Deleting a person takes credentials and consents in progress with the connections.
    await sync.beginConsent('bob', 'consent-bank', { sessionKey: 'session-bob', returnUrl });
    assert.equal(await sync.forgetUser('bob'), 1);
    for (const table of ['bank_connections', 'bank_credentials', 'bank_consents'])
      assert.equal(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n, 0, table);
  } finally {
    await sync.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a wrong key, a missing key or a moved ciphertext fails closed, and an expired consent waits for a new one', async () => {
  const { db, bank, clock, engine, returnUrl } = await consentFixture({ webhooks: false });
  const first = engine();
  const who = { userId: 'alice', sessionKey: 'session-alice' };
  const consent = async (sync: ReturnType<typeof engine>) => {
    await sync.beginConsent('alice', 'consent-bank', { sessionKey: who.sessionKey, returnUrl });
    return sync.completeConsent({ state: bank.lastState(), code: 'code-ada' }, who);
  };
  bank.state.expiresAt = '2027-02-20T10:00:00+00:00';
  const connected = await consent(first);
  assert(connected.status === 'connected');
  assert.equal(connected.connection.consentExpiresAt, '2027-02-20T10:00:00.000Z');
  const { id } = connected.connection;
  await first.beginConsent('bob', 'consent-bank', { sessionKey: 'session-bob', returnUrl });
  await first.completeConsent(
    { state: bank.lastState(), code: 'code-bob' },
    { userId: 'bob', sessionKey: 'session-bob' },
  );
  await first.close();
  const seen = bank.state.refsSeen.length;
  const failure = async (sync: ReturnType<typeof engine>) => {
    const result = (await sync.sync('alice')).results[0];
    assert.equal(result.status, 'failed');
    assert.equal(bank.state.refsSeen.length, seen, 'the provider was not called');
    await sync.close();
    return result.status === 'failed' ? result.error : '';
  };

  // Another key: the credential does not open, nothing reaches the bank, and the person is told what to do.
  assert.match(await failure(engine({ vault: testVault() })), /cannot be read with the current data encryption key/);
  // No key at all.
  assert.match(await failure(engine({ vault: undefined })), /no data encryption key/);
  // A ciphertext copied from another person's row does not open either: it is bound to its own row.
  const cipherOf = (userId: string) =>
    db.get<{ cipher: string }>('SELECT cipher FROM bank_credentials WHERE user_id = ?', userId)!.cipher;
  const [own, foreign] = [cipherOf('alice'), cipherOf('bob')];
  db.run("UPDATE bank_credentials SET cipher = ? WHERE user_id = 'alice'", foreign);
  assert.match(await failure(engine()), /cannot be read/);
  db.run("UPDATE bank_credentials SET cipher = ? WHERE user_id = 'alice'", own);

  // With the right key it works again.
  const sync = engine();
  try {
    assert.equal((await sync.sync('alice')).results[0].status, 'synced');
    // The consent runs out: syncing stops by itself and says why; no retry is scheduled.
    clock.now = Date.parse('2027-02-20T10:00:01Z');
    const fetches = bank.state.fetches;
    const expired = (await sync.sync('alice')).results[0];
    assert.deepEqual(
      [expired.status, expired.status === 'failed' && expired.error],
      ['failed', 'The consent at the bank has expired. Connect this bank again to renew it.'],
    );
    const stale = (await sync.listConnections('alice'))[0];
    assert.deepEqual(
      [stale.consent, stale.nextRetryAt, stale.lastError],
      ['expired', null, expired.status === 'failed' && expired.error],
    );
    await sync.runDue();
    assert.equal(bank.state.fetches, fetches, 'nothing is fetched on an expired consent');
    // Consenting again renews the same connection and syncing resumes at once.
    bank.state.expiresAt = '2027-05-21T10:00:00Z';
    const renewed = await consent(sync);
    assert(renewed.status === 'renewed');
    assert.deepEqual(
      [renewed.connection.id, renewed.connection.consent, renewed.connection.lastError],
      [id, 'granted', null],
    );
    assert.equal(bank.state.fetches, fetches + 1);
    // A bank that hands back a consent already over is not connected.
    bank.state.expiresAt = '2020-01-01T00:00:00Z';
    await sync.beginConsent('alice', 'consent-bank', { sessionKey: who.sessionKey, returnUrl });
    await assert.rejects(sync.completeConsent({ state: bank.lastState(), code: 'code-ada' }, who), { status: 502 });
  } finally {
    await sync.close();
    db.close();
  }
});

test('a person connects only what needs no bank themselves, and never chooses the reference', async () => {
  const { db, bank, engine, returnUrl } = await consentFixture();
  const { provider: operatorOnly } = fakeBank();
  const sync = engine({ registry: createBankRegistry([bank.provider, synthetic, operatorOnly], fakeEnv) });
  try {
    // A real bank without a consent flow is the operator's to link; it is not even offered.
    assert(!(await sync.banks()).some(item => item.id === 'fake-bank' && item.synthetic === false));
    const real = defineBankProvider({ ...operatorOnly, id: 'real-bank', synthetic: false, env: [] });
    const strict = engine({ registry: createBankRegistry([real, bank.provider], {}) });
    assert.deepEqual(
      (await strict.banks()).map(item => item.id),
      ['consent-bank'],
    );
    await assert.rejects(strict.connectSelf('alice', 'real-bank'), { status: 403 });
    await assert.rejects(strict.connectSelf('alice', 'consent-bank'), { status: 409 });
    await assert.rejects(strict.beginConsent('alice', 'real-bank', { sessionKey: 's', returnUrl }), { status: 409 });
    await strict.close();

    const direct = await sync.connectSelf('alice', 'synthetic');
    assert.deepEqual([direct.providerId, direct.consent, direct.synthetic], ['synthetic', 'not_required', true]);
    assert.equal(
      db.get<{ ref: string }>("SELECT ref FROM bank_connections WHERE user_id = 'alice'")?.ref,
      'self-alice',
    );
    await assert.rejects(sync.connectSelf('alice', 'synthetic'), { status: 409 }, 'once per person');
    await assert.rejects(sync.connectSelf('alice', 'unknown-bank'), { status: 404 });
    // Without a vault nobody can start a consent, and nothing is stored for the attempt.
    const keyless = engine({ vault: undefined });
    await assert.rejects(keyless.beginConsent('bob', 'consent-bank', { sessionKey: 's', returnUrl }), { status: 503 });
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bank_consents')?.n, 0);
    await keyless.close();
    // The bound of ten connections holds for consents too.
    for (let n = 0; n < 10; n++)
      await sync.connect('bob', { providerId: 'fake-bank', ref: `link-${n}`, pollIntervalMs: null });
    await assert.rejects(sync.beginConsent('bob', 'consent-bank', { sessionKey: 's', returnUrl }), { status: 400 });
  } finally {
    await sync.close();
    db.close();
  }
});
