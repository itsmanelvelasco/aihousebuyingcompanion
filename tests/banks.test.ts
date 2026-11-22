import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { safeId } from '../packages/contracts/ids.ts';
import { getConnection } from '../packages/db/bank-sync.ts';
import type { Database } from '../packages/db/database.ts';
import { open } from '../packages/db/database.ts';
import { createStore } from '../packages/profiles/store.ts';

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
