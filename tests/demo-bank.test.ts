import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectDemoBank } from '../apps/demo-bank/connect.ts';
import type { DemoBankOptions } from '../apps/demo-bank/server.ts';
import { createDemoBank } from '../apps/demo-bank/server.ts';
import { createProfileApiHandler } from '../apps/profile-api/server.ts';
import demoBankProvider from '../packages/banks/providers/demo-bank.ts';
import { createBankRegistry } from '../packages/banks/registry.ts';
import { demoBankConfig } from '../packages/config/env.ts';
import { countSeenWebhooks, listConnections, pendingWebhooks } from '../packages/db/bank-sync.ts';
import type { Database } from '../packages/db/database.ts';
import { open } from '../packages/db/database.ts';
import { createStore } from '../packages/profiles/store.ts';
import type { Browser } from './support/app.ts';
import { startApp } from './support/app.ts';

/**
 * Banc Demo and ReloCat's profile API in one process, on ephemeral loopback ports, talking real
 * HTTP to each other. Nothing sleeps: the wall clock is a variable both services read, the bank's
 * simulation and deliveries are stepped by hand, and ReloCat's sync engine has no timer.
 */

const apiKey = 'demo-bank-test-key';
const adminKey = 'demo-bank-admin-key';
const token = 'relocat-test-token';
const startedAt = Date.parse('2026-11-22T10:00:00.000Z');
const retryBaseMs = 1000;
const fallbackPollMs = 60_000;

type Json = Record<string, any>;

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
const stop = (server: Server) =>
  new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** One JSON request with a bearer key. */
async function call(url: string, key: string | null, method = 'GET', body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, data: (await response.json()) as Json };
}

/**
 * Start both services. `gate` lets a test take either one down: `refuse` drops the connection (the
 * process is not there), `error` answers 503 (it is there but failing).
 */
async function world(options: { webhook?: boolean; bank?: Partial<DemoBankOptions>; db?: Database } = {}) {
  const time = { now: startedAt };
  const clock = () => new Date(time.now);
  const gate = { bank: 'up' as 'up' | 'refuse' | 'error', relocat: 'up' as 'up' | 'refuse' | 'error' };
  const db = options.db ?? open(':memory:');
  if (!options.db) {
    const document = { schemaVersion: 1 as const, synthetic: true as const };
    await createStore(db).create('alice', {
      details: { ...document, id: 'alice' },
      preferences: document,
      'bank-account': { ...document, snapshotDate: '2026-11-21' },
    });
  }

  const bank = createDemoBank({
    apiKey,
    adminKey,
    seed: 'test-seed',
    startDate: '2026-09-01',
    clock,
    delivery: { baseMs: retryBaseMs, maxAttempts: 4, timeoutMs: 2000 },
    ...options.bank,
  });
  await bank.ready;
  const gated = (which: 'bank' | 'relocat', handle: (request: any, response: any) => unknown) =>
    createServer((request, response) => {
      if (gate[which] === 'refuse') return void request.socket.destroy();
      if (gate[which] === 'error') return void response.writeHead(503).end('{"error":"down"}');
      void handle(request, response);
    });
  const bankServer = gated('bank', bank.handle);
  const bankUrl = await listen(bankServer);

  // ReloCat's port must exist before the webhook is registered, and the secret the bank returns
  // must exist before ReloCat's provider is configured: listen first, build the API second.
  let relocat: ReturnType<typeof createProfileApiHandler> | undefined;
  const apiServer = gated('relocat', (request, response) => relocat!.handle(request, response));
  const apiUrl = await listen(apiServer);
  const webhookUrl = `${apiUrl}/webhooks/bank/demo-bank`;
  let secret = 'no-webhook-registered';
  if (options.webhook !== false) {
    const subscribed = await call(`${bankUrl}/webhooks`, apiKey, 'POST', { url: webhookUrl });
    assert.equal(subscribed.status, 201);
    assert.equal(subscribed.data.synthetic, true);
    secret = subscribed.data.signing_secret;
  }
  const startRelocat = () =>
    createProfileApiHandler(db, token, {
      bankRegistry: createBankRegistry([demoBankProvider], {
        BANK_DEMO_BANK_BASE_URL: bankUrl,
        BANK_DEMO_BANK_API_KEY: apiKey,
        BANK_DEMO_BANK_WEBHOOK_SECRET: secret,
      }),
      clock,
      bankSync: { housekeepingMs: null, retryBaseMs, fallbackPollMs },
    });
  relocat = startRelocat();

  const ledgerUrl = `${apiUrl}/users/alice/bank`;
  return {
    time,
    gate,
    db,
    bank,
    bankUrl,
    apiUrl,
    webhookUrl,
    secret,
    sync: () => relocat!.bankSync,
    /** Stop ReloCat's API (keeping its database) and start a new instance on the same port and database. */
    async restartRelocat() {
      await relocat!.close();
      relocat = startRelocat();
    },
    /** Link alice to the bank customer; with `pull`, also import the history. */
    async connect(pull = true) {
      const created = await call(`${ledgerUrl}/connections`, token, 'POST', {
        providerId: 'demo-bank',
        ref: 'cust-001',
      });
      assert.equal(created.status, 201);
      if (pull) {
        const first = await call(`${ledgerUrl}/sync`, token, 'POST', {});
        assert.equal(first.data.results[0].status, 'synced');
      }
      return created.data.id as string;
    },
    /** Let the bank deliver what is due, then wait for the syncs those webhooks started. */
    async settle() {
      await bank.flushDeliveries();
      await relocat!.bankSync.idle();
    },
    async ledger() {
      const listed = await call(`${ledgerUrl}/transactions?limit=500`, token);
      assert.equal(listed.status, 200);
      assert.ok(listed.data.total <= 500, 'the test ledger fits one page');
      return listed.data.transactions as Json[];
    },
    async connection() {
      return (await call(`${ledgerUrl}/connections`, token)).data.connections[0] as Json;
    },
    /** Fire one movement at the bank through its admin API. */
    async fire(body: Json) {
      const fired = await call(`${bankUrl}/simulate/transaction`, adminKey, 'POST', {
        customer_id: 'cust-001',
        ...body,
      });
      assert.equal(fired.status, 201, JSON.stringify(fired.data));
      return fired.data.transactions as Json[];
    },
    /** Every transaction the bank holds for the customer, read page by page. */
    async bankTransactions(limit = 200) {
      const all: Json[] = [];
      let cursor = '';
      for (;;) {
        const page = await call(
          `${bankUrl}/customers/cust-001/transactions?limit=${limit}${cursor && `&cursor=${cursor}`}`,
          apiKey,
        );
        assert.equal(page.status, 200);
        all.push(...page.data.transactions);
        cursor = page.data.next_cursor;
        if (!page.data.has_more) return all;
      }
    },
    /** Call ReloCat's webhook route the way the bank does, with full control over what is signed. */
    async webhook(rawBody: string, overrides: { timestamp?: string; signature?: string } = {}) {
      const timestamp = overrides.timestamp ?? String(time.now);
      const signature =
        overrides.signature ?? createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Demo-Bank-Timestamp': timestamp,
          'X-Demo-Bank-Signature': signature,
        },
        body: rawBody,
      });
      await response.body?.cancel();
      return response.status;
    },
    async close(keepDatabase = false) {
      await relocat!.close();
      await bank.close();
      await stop(apiServer);
      await stop(bankServer);
      if (!keepDatabase) db.close();
    },
  };
}

const ledgerId = (bankTransactionId: string) => `demo-bank-${bankTransactionId}`;

test('the bank simulates a believable, deterministic month and serves it with cursor pagination', async () => {
  const w = await world({ webhook: false });
  try {
    const health = await call(`${w.bankUrl}/health`, null);
    assert.equal(health.headers.get('x-demo-bank'), 'fictional');
    assert.equal((await call(`${w.bankUrl}/customers`, null)).status, 401);
    assert.equal((await call(`${w.bankUrl}/customers`, 'wrong-key')).status, 401);
    assert.equal((await call(`${w.bankUrl}/simulate/status`, apiKey)).status, 401, 'simulation needs the admin key');
    assert.equal((await call(`${w.bankUrl}/customers/cust-999/accounts`, apiKey)).status, 404);

    const accounts = await call(`${w.bankUrl}/customers/cust-001/accounts`, apiKey);
    assert.equal(accounts.headers.get('x-demo-bank'), 'fictional');
    assert.deepEqual(
      accounts.data.accounts.map((account: Json) => [account.id, account.type, account.currency, account.synthetic]),
      [
        ['acc-001-main', 'current', 'EUR', true],
        ['acc-001-savings', 'savings', 'EUR', true],
      ],
    );
    assert.match(accounts.data.accounts[0].balance, /^-?\d+\.\d{2}$/, 'amounts are decimal strings');

    // The history from the start date to the wall clock exists before anything is stepped.
    const all = await w.bankTransactions();
    assert.ok(all.every(transaction => transaction.synthetic === true && transaction.currency === 'EUR'));
    const october = all.filter(transaction => transaction.created_at.startsWith('2026-10'));
    const count = (category: string, state = 'completed') =>
      october.filter(transaction => transaction.merchant_category === category && transaction.state === state).length;
    assert.equal(count('salary'), 1, 'one salary a month');
    assert.equal(count('rent'), 1, 'one rent a month');
    assert.equal(count('utilities'), 3);
    assert.equal(count('subscriptions'), 3);
    assert.ok(count('groceries') >= 12, 'groceries three times a week');
    assert.ok(count('transport') >= 2);
    assert.equal(count('transfer'), 2, 'an own-account transfer has a leg on each account');
    assert.ok(all.some(transaction => transaction.state === 'declined'));
    assert.ok(all.some(transaction => transaction.state === 'reverted'));
    const settled = all.find(
      transaction => transaction.type === 'card_payment' && transaction.completed_at > transaction.created_at,
    );
    assert.ok(settled, 'some card payments stay pending and complete later');
    assert.equal(Date.parse(settled.completed_at) - Date.parse(settled.created_at), 86_400_000, 'a day later');

    // Small pages walk the same list in the same order, and a single transaction can be read.
    const paged = await w.bankTransactions(7);
    assert.deepEqual(
      paged.map(transaction => transaction.id),
      all.map(transaction => transaction.id),
    );
    const one = await call(`${w.bankUrl}/customers/cust-001/transactions/${all[0].id}`, apiKey);
    assert.deepEqual(one.data, all[0]);
    const recent = await call(`${w.bankUrl}/customers/cust-001/transactions?from=2026-11-01&limit=200`, apiKey);
    assert.ok(recent.data.transactions.length > 0);
    assert.ok(recent.data.transactions.every((transaction: Json) => transaction.created_at >= '2026-11-01'));
    assert.equal((await call(`${w.bankUrl}/customers/cust-001/transactions?cursor=nonsense`, apiKey)).status, 400);
    assert.equal((await call(`${w.bankUrl}/customers/cust-001/transactions?limit=0`, apiKey)).status, 400);

    // Same seed, same clock: the same bank. Another seed: another history.
    const twin = createDemoBank({
      apiKey,
      seed: 'test-seed',
      startDate: '2026-09-01',
      clock: () => new Date(w.time.now),
    });
    const other = createDemoBank({
      apiKey,
      seed: 'other-seed',
      startDate: '2026-09-01',
      clock: () => new Date(w.time.now),
    });
    const stepped = await w.bank.step(15);
    assert.ok(stepped.length >= 15);
    assert.deepEqual(await twin.step(15), stepped);
    assert.notDeepEqual(await other.step(15), stepped);
    assert.ok(stepped[0].created_at > new Date(w.time.now).toISOString(), 'the simulated calendar runs ahead');
    await twin.close();
    await other.close();
  } finally {
    await w.close();
  }
});

test('a simulated payment reaches the ledger through the webhook, and state changes update one row', async () => {
  const w = await world();
  try {
    assert.equal((await call(`${w.apiUrl}/bank/providers`, token)).data.providers[0].status, 'configured');
    await w.connect();
    const history = await w.ledger();
    const booked = (await w.bankTransactions()).filter(transaction => transaction.state === 'completed');
    assert.ok(history.length >= booked.length && history.length > 100, 'the first pull imports the history');
    assert.ok(history.every(row => row.synthetic === true && Number.isInteger(row.amountCents)));
    const syncsAfterPull = (await w.connection()).syncCount;

    // A completed card payment: no manual sync and no polling, only the bank's webhook.
    const [payment] = await w.fire({ amount: '-23.45', description: 'Cafeteria Demo', category: 'restaurants' });
    await w.settle();
    const row = (await w.ledger()).find(item => item.id === ledgerId(payment.id));
    assert.deepEqual(row && [row.amountCents, row.category, row.status, row.description, row.accountId, row.currency], [
      -2345,
      'food',
      'booked',
      'Cafeteria Demo',
      'demo-bank-acc-001-main',
      'EUR',
    ]);
    assert.equal((await w.connection()).syncCount, syncsAfterPull + 1, 'the webhook started exactly one sync');
    assert.equal(w.sync().webhookStatus().accepted, 1);
    const delivered = await call(`${w.bankUrl}/webhooks/deliveries`, apiKey);
    assert.deepEqual(
      delivered.data.deliveries.map((item: Json) => [item.event_type, item.state, item.attempts, item.last_status]),
      [['TransactionCreated', 'delivered', 1, 202]],
    );

    // A pending payment is one ledger row; completing it changes that row instead of adding one.
    const [pending] = await w.fire({ amount: '-80.00', description: 'Botiga Demo', state: 'pending' });
    await w.settle();
    const before = await w.ledger();
    assert.equal(before.find(item => item.id === ledgerId(pending.id))?.status, 'pending');
    const completed = await call(`${w.bankUrl}/simulate/transactions/${pending.id}/state`, adminKey, 'POST', {
      state: 'completed',
    });
    assert.equal(completed.data.state, 'completed');
    await w.settle();
    const after = await w.ledger();
    assert.equal(after.length, before.length, 'still one row');
    assert.equal(after.find(item => item.id === ledgerId(pending.id))?.status, 'booked');
    assert.equal(
      (await call(`${w.bankUrl}/simulate/transactions/${pending.id}/state`, adminKey, 'POST', { state: 'reverted' }))
        .status,
      409,
      'a completed transaction cannot change again',
    );

    // A declined payment never enters the ledger; a pending one that is reverted leaves it.
    const [declined] = await w.fire({ amount: '-500.00', description: 'Targeta denegada', state: 'declined' });
    const [doomed] = await w.fire({ amount: '-12.00', description: 'Reserva Demo', state: 'pending' });
    await w.settle();
    let ids = (await w.ledger()).map(item => item.id);
    assert.ok(!ids.includes(ledgerId(declined.id)));
    assert.ok(ids.includes(ledgerId(doomed.id)));
    await call(`${w.bankUrl}/simulate/transactions/${doomed.id}/state`, adminKey, 'POST', { state: 'reverted' });
    await w.settle();
    ids = (await w.ledger()).map(item => item.id);
    assert.ok(!ids.includes(ledgerId(doomed.id)), 'a reverted payment is removed');
    assert.equal(ids.length, after.length);

    // Stepping the scripted simulation flows through the same path.
    const stepped = await w.bank.step(40);
    await w.settle();
    ids = (await w.ledger()).map(item => item.id);
    for (const transaction of stepped.filter(item => item.customer_id === 'cust-001')) {
      const expected = transaction.state === 'pending' || transaction.state === 'completed';
      assert.equal(ids.includes(ledgerId(transaction.id)), expected, `${transaction.id} ${transaction.state}`);
    }
    const failed = (await call(`${w.bankUrl}/webhooks/deliveries?limit=500`, apiKey)).data.deliveries.filter(
      (item: Json) => item.state !== 'delivered',
    );
    assert.deepEqual(failed, []);
    assert.equal(w.sync().webhookStatus().pending, 0, 'every queued notification was processed');
  } finally {
    await w.close();
  }
});

test('transfers between own accounts are imported on both accounts and excluded from savings', async () => {
  const w = await world();
  try {
    await w.connect();
    const period = 'from=2026-10-01&to=2026-10-31';
    const summary = (await call(`${w.apiUrl}/users/alice/bank/summary?${period}`, token)).data;
    const october = (await w.bankTransactions()).filter(
      transaction => (transaction.completed_at ?? '').startsWith('2026-10') && transaction.state === 'completed',
    );
    const cents = (transaction: Json) => Math.round(Number(transaction.amount) * 100);
    const external = october.filter(transaction => !transaction.counterparty.own_account);
    const transfers = october.filter(transaction => transaction.counterparty.own_account);
    assert.equal(transfers.length, 2);
    assert.equal(cents(transfers[0]) + cents(transfers[1]), 0, 'the two legs cancel out');
    assert.equal(summary.excludedInternalTransferCount, 2);
    assert.equal(summary.synthetic, true);
    assert.equal(
      summary.incomeCents,
      cents(external.find(transaction => transaction.merchant_category === 'salary')!),
      'the money arriving in the savings account is not income',
    );
    assert.equal(
      summary.netCashflowCents,
      external.reduce((total, transaction) => total + cents(transaction), 0),
    );
    assert.equal(summary.spendingByCategory.internal_transfer, undefined);

    // A transfer fired on demand arrives by webhook as two internal-transfer rows and changes no total.
    const before = (await call(`${w.apiUrl}/users/alice/bank/accounts?asOf=2026-11-30`, token)).data.accounts;
    const legs = await w.fire({
      amount: '-150.00',
      description: 'Traspas de prova',
      to_account_id: 'acc-001-savings',
    });
    assert.equal(legs.length, 2);
    await w.settle();
    const rows = (await w.ledger()).filter(row => legs.some(leg => ledgerId(leg.id) === row.id));
    assert.deepEqual(rows.map(row => [row.category, row.amountCents, row.accountId]).sort(), [
      ['internal_transfer', -15000, 'demo-bank-acc-001-main'],
      ['internal_transfer', 15000, 'demo-bank-acc-001-savings'],
    ]);
    const after = (await call(`${w.apiUrl}/users/alice/bank/accounts?asOf=2026-11-30`, token)).data.accounts;
    const balance = (accounts: Json[], id: string) => accounts.find(account => account.id === id)!.balanceCents;
    assert.equal(balance(after, 'demo-bank-acc-001-main'), balance(before, 'demo-bank-acc-001-main') - 15000);
    assert.equal(balance(after, 'demo-bank-acc-001-savings'), balance(before, 'demo-bank-acc-001-savings') + 15000);
    assert.equal(
      (await call(`${w.apiUrl}/users/alice/bank/summary?${period}`, token)).data.netCashflowCents,
      summary.netCashflowCents,
    );
  } finally {
    await w.close();
  }
});

test('tampered signatures and stale timestamps are rejected, and a duplicate delivery is ignored', async () => {
  const w = await world();
  try {
    await w.connect();
    const event = (id: string) =>
      JSON.stringify({ id, type: 'TransactionCreated', synthetic: true, data: { customer_id: 'cust-001' } });
    const accepted = () => w.sync().webhookStatus();

    assert.equal(await w.webhook(event('evt-forged'), { signature: 'ab'.repeat(32) }), 401, 'a wrong signature');
    const signedForAnotherBody = createHmac('sha256', w.secret)
      .update(`${w.time.now}.${event('evt-a')}`)
      .digest('hex');
    assert.equal(await w.webhook(event('evt-b'), { signature: signedForAnotherBody }), 401, 'a changed body');
    const stale = String(w.time.now - 6 * 60_000);
    assert.equal(await w.webhook(event('evt-old'), { timestamp: stale }), 401, 'a replayed old call');
    assert.equal(await w.webhook(event('evt-future'), { timestamp: String(w.time.now + 6 * 60_000) }), 401);
    // An old signature cannot be given a fresh timestamp: the timestamp is part of what is signed.
    const oldSignature = createHmac('sha256', w.secret)
      .update(`${stale}.${event('evt-old')}`)
      .digest('hex');
    assert.equal(await w.webhook(event('evt-old'), { signature: oldSignature }), 401);
    assert.equal(await w.webhook(event('evt-x'), { timestamp: 'yesterday' }), 401);
    assert.deepEqual(accepted(), { accepted: 0, duplicates: 0, pending: 0 }, 'nothing rejected was queued');

    // A real movement, delivered once by the bank and then delivered again by hand.
    const [payment] = await w.fire({ amount: '-9.99', description: 'Quiosc Demo' });
    await w.settle();
    const ledger = await w.ledger();
    const connection = await w.connection();
    assert.ok(ledger.some(row => row.id === ledgerId(payment.id)));
    assert.equal(accepted().accepted, 1);
    const sent = (await call(`${w.bankUrl}/webhooks/deliveries`, apiKey)).data.deliveries[0];
    assert.equal(await w.webhook(event(sent.event_id)), 202, 'a duplicate is acknowledged');
    assert.equal(await w.webhook(event(sent.event_id)), 202);
    await w.sync().idle();
    assert.deepEqual(accepted(), { accepted: 1, duplicates: 2, pending: 0 });
    assert.equal((await w.connection()).syncCount, connection.syncCount, 'a duplicate starts no sync');
    assert.deepEqual(await w.ledger(), ledger, 'and nothing is counted twice');

    // A notification about a customer nobody linked is acknowledged without revealing anything.
    const unknown = JSON.stringify({
      id: 'evt-unknown',
      type: 'TransactionCreated',
      data: { customer_id: 'cust-004' },
    });
    assert.equal(await w.webhook(unknown), 202);
    assert.equal(accepted().accepted, 1);
  } finally {
    await w.close();
  }
});

test('with the receiver down the bank retries with backoff, and dead letters are caught up by pull', async () => {
  const w = await world();
  try {
    await w.connect();
    const deliveries = async () => (await call(`${w.bankUrl}/webhooks/deliveries`, apiKey)).data.deliveries as Json[];

    // ReloCat is not there at all: the connection is refused.
    w.gate.relocat = 'refuse';
    const [payment] = await w.fire({ amount: '-31.00', description: 'Ferreteria Demo' });
    await w.bank.flushDeliveries();
    let [delivery] = await deliveries();
    assert.deepEqual([delivery.state, delivery.attempts, delivery.last_error], ['pending', 1, 'connection failed']);
    assert.equal(Date.parse(delivery.next_attempt_at), w.time.now + retryBaseMs);
    await w.bank.flushDeliveries();
    assert.equal((await deliveries())[0].attempts, 1, 'no retry before it is due');

    // The simulation is not held back by the failing receiver.
    assert.ok((await w.bank.step(3)).length >= 3);

    // It is back but failing: a non-2xx answer is retried too, with a doubled delay.
    w.gate.relocat = 'error';
    w.time.now += retryBaseMs;
    await w.bank.flushDeliveries();
    delivery = (await deliveries()).find(item => item.id === delivery.id)!;
    assert.deepEqual([delivery.state, delivery.attempts, delivery.last_status], ['pending', 2, 503]);
    assert.equal(Date.parse(delivery.next_attempt_at), w.time.now + 2 * retryBaseMs);

    // Healthy again: the next attempt lands and the movement appears.
    w.gate.relocat = 'up';
    assert.ok(!(await w.ledger()).some(row => row.id === ledgerId(payment.id)));
    w.time.now += 2 * retryBaseMs;
    await w.settle();
    delivery = (await deliveries()).find(item => item.id === delivery.id)!;
    assert.deepEqual([delivery.state, delivery.attempts, delivery.last_status], ['delivered', 3, 202]);
    assert.ok(
      (await w.ledger()).some(row => row.id === ledgerId(payment.id)),
      'it arrived after the retries',
    );
    assert.deepEqual(
      (await deliveries()).filter(item => item.state !== 'delivered'),
      [],
      'the events of the stepped movements were retried as well',
    );

    // Down for longer than the bank is willing to retry: the delivery is dead-lettered...
    w.gate.relocat = 'refuse';
    const [lost] = await w.fire({ amount: '-7.50', description: 'Forn Demo' });
    for (let attempt = 0; attempt < 4; attempt++) {
      await w.bank.flushDeliveries();
      w.time.now += 2 ** attempt * retryBaseMs;
    }
    const dead = (await call(`${w.bankUrl}/webhooks/deliveries?state=dead`, apiKey)).data.deliveries;
    assert.deepEqual(
      dead.map((item: Json) => [item.attempts, item.next_attempt_at]),
      [[4, null]],
    );
    w.time.now += 60 * 60_000;
    await w.bank.flushDeliveries();
    assert.equal((await deliveries()).find(item => item.id === dead[0].id)!.attempts, 4, 'a dead letter stays dead');

    // ...and ReloCat still catches up, because a silent connection is pulled as a fallback.
    w.gate.relocat = 'up';
    assert.ok(!(await w.ledger()).some(row => row.id === ledgerId(lost.id)));
    await w.sync().runDue();
    assert.ok(
      (await w.ledger()).some(row => row.id === ledgerId(lost.id)),
      'the fallback pull found it',
    );
  } finally {
    await w.close();
  }
});

test('pull-only converges, and a failing bank is retried with backoff and shown on the connection', async () => {
  const w = await world({ webhook: false });
  try {
    await w.connect(false);
    const expected = async () =>
      (await w.bankTransactions())
        .filter(transaction => transaction.state === 'pending' || transaction.state === 'completed')
        .map(transaction => ledgerId(transaction.id))
        .sort();
    const imported = async () => (await w.ledger()).map(row => row.id).sort();

    // The bank is failing when the first pull is due: the failure is recorded, not thrown around.
    w.gate.bank = 'error';
    w.time.now += fallbackPollMs;
    await w.sync().runDue();
    let connection = await w.connection();
    assert.deepEqual(
      [connection.consecutiveFailures, connection.lastError, connection.lastSyncAt],
      [1, 'Banc Demo answered with status 503', null],
    );
    assert.equal(connection.lastAttemptAt, new Date(w.time.now).toISOString());
    assert.equal(Date.parse(connection.nextRetryAt), w.time.now + retryBaseMs);
    await w.sync().runDue();
    assert.equal((await w.connection()).consecutiveFailures, 1, 'no retry before the backoff has passed');

    // The bank process is gone altogether: the second failure doubles the delay.
    w.gate.bank = 'refuse';
    w.time.now += retryBaseMs;
    await w.sync().runDue();
    connection = await w.connection();
    assert.deepEqual([connection.consecutiveFailures, connection.lastError], [2, 'Banc Demo could not be reached']);
    assert.equal(Date.parse(connection.nextRetryAt), w.time.now + 2 * retryBaseMs);
    const manual = await call(`${w.apiUrl}/users/alice/bank/sync`, token, 'POST', {});
    assert.deepEqual(
      [manual.status, manual.data.results[0].status, manual.data.results[0].error],
      [200, 'failed', 'Banc Demo could not be reached'],
      'a manual sync reports the failure instead of failing the request',
    );

    // The bank returns: the scheduled retry succeeds and the connection is healthy again.
    w.gate.bank = 'up';
    w.time.now += 4 * retryBaseMs;
    await w.sync().runDue();
    connection = await w.connection();
    assert.deepEqual([connection.consecutiveFailures, connection.lastError, connection.nextRetryAt], [0, null, null]);
    assert.equal(connection.lastSyncAt, new Date(w.time.now).toISOString());
    assert.deepEqual(await imported(), await expected(), 'the whole history was pulled');

    // No webhook exists, so new movements only arrive by the fallback pull, and only the changes.
    const stepped = await w.bank.step(60);
    const [pending] = await w.fire({ amount: '-19.90', description: 'Llibreria Demo', state: 'pending' });
    await w.sync().runDue();
    assert.notDeepEqual(await imported(), await expected(), 'nothing is pulled before the fallback interval');
    w.time.now += fallbackPollMs;
    await w.sync().runDue();
    assert.deepEqual(await imported(), await expected());
    await call(`${w.bankUrl}/simulate/transactions/${pending.id}/state`, adminKey, 'POST', { state: 'completed' });
    const again = (await call(`${w.apiUrl}/users/alice/bank/sync`, token, 'POST', {})).data.results[0];
    assert.deepEqual(
      [again.inserted, again.updated, again.duplicates, again.removed],
      [0, 1, 0, 0],
      'the cursor returns only what changed since the last pull',
    );
    assert.ok(stepped.length >= 60);
    const idle = (await call(`${w.apiUrl}/users/alice/bank/sync`, token, 'POST', {})).data.results[0];
    assert.deepEqual([idle.inserted, idle.updated, idle.duplicates], [0, 0, 0]);
  } finally {
    await w.close();
  }
});

test('a webhook accepted while the bank cannot be pulled survives a restart of ReloCat', async () => {
  const w = await world();
  try {
    await w.connect();
    w.gate.bank = 'error';
    const [payment] = await w.bank.simulate({ customer_id: 'cust-001', amount: '-64.20', description: 'Taller Demo' });
    await w.settle();
    assert.equal(w.bank.listDeliveries()[0].state, 'delivered', 'the bank was answered with a 202');
    assert.equal(w.sync().webhookStatus().pending, 1, 'acknowledged, queued, not yet imported');
    assert.equal((await w.connection()).consecutiveFailures, 1);
    assert.deepEqual(
      pendingWebhooks(w.db).map(item => [item.providerId, item.ref]),
      [['demo-bank', 'cust-001']],
    );
    assert.equal(countSeenWebhooks(w.db), 1);

    // ReloCat stops before it could import the movement, and the bank recovers meanwhile.
    await w.restartRelocat();
    w.gate.bank = 'up';
    await w.sync().ready;
    assert.equal(w.sync().webhookStatus().pending, 1, 'the queue was read back from disk');
    assert.ok(!(await w.ledger()).some(row => row.id === ledgerId(payment.id)));
    w.time.now += retryBaseMs;
    await w.sync().runDue();
    assert.ok(
      (await w.ledger()).some(row => row.id === ledgerId(payment.id)),
      'imported after the restart',
    );
    assert.equal(w.sync().webhookStatus().pending, 0);
    assert.equal((await w.connection()).consecutiveFailures, 0);

    // The event ID is remembered across the restart too.
    const delivery = (await call(`${w.bankUrl}/webhooks/deliveries`, apiKey)).data.deliveries[0];
    const replay = JSON.stringify({
      id: delivery.event_id,
      type: 'TransactionCreated',
      data: { customer_id: 'cust-001' },
    });
    assert.equal(await w.webhook(replay), 202);
    assert.equal(w.sync().webhookStatus().duplicates, 1);
  } finally {
    await w.close();
  }
});

test('the bank keeps its history, webhooks and cursors across a restart when it has a snapshot file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relocat-demo-bank-snapshot-'));
  const snapshotFile = join(directory, 'demo-bank.json');
  const first = await world({ bank: { snapshotFile } });
  let second: Awaited<ReturnType<typeof world>> | undefined;
  try {
    await first.connect();
    const [payment] = await first.fire({ amount: '-11.00', description: 'Papereria Demo' });
    await first.settle();
    const cursorBefore = listConnections(first.db, 'alice')[0].cursor;
    const known = (await first.bankTransactions()).map(transaction => transaction.id);
    await first.close(true);
    assert.equal(JSON.parse(await readFile(snapshotFile, 'utf8')).synthetic, true);

    // A new bank process with the same snapshot: same transactions, same webhook, cursor still valid.
    second = await world({ bank: { snapshotFile }, db: first.db, webhook: false });
    assert.deepEqual(
      (await second.bankTransactions()).map(transaction => transaction.id),
      known,
    );
    assert.ok(known.includes(payment.id));
    assert.equal((await call(`${second.bankUrl}/webhooks`, apiKey)).data.webhooks.length, 1);
    const page = await call(`${second.bankUrl}/customers/cust-001/transactions?cursor=${cursorBefore}`, apiKey);
    assert.deepEqual([page.status, page.data.transactions.length], [200, 0]);
    await assert.rejects(
      createDemoBank({ apiKey, seed: 'another-seed', startDate: '2026-09-01', snapshotFile }).ready,
      /another seed/,
    );
    await second.close(true);

    // A bank that lost its state refuses the old cursor; ReloCat starts over and nothing is duplicated.
    second = await world({ db: first.db, webhook: false });
    const expired = await call(`${second.bankUrl}/customers/cust-001/transactions?cursor=${cursorBefore}`, apiKey);
    assert.equal(expired.status, 410);
    const rows = (await second.ledger()).length;
    const resync = (await call(`${second.apiUrl}/users/alice/bank/sync`, token, 'POST', {})).data.results[0];
    assert.equal(resync.status, 'synced');
    assert.equal(resync.inserted, 0, 'the deterministic history has the same IDs');
    assert.equal((await second.ledger()).length, rows);
  } finally {
    await second?.close();
    first.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the connect helper wires both services idempotently over HTTP', async () => {
  const w = await world({ webhook: false, bank: { signingSecret: 'shared-demo-secret' } });
  try {
    const options = { bankUrl: w.bankUrl, bankApiKey: apiKey, relocatApiUrl: w.apiUrl, relocatToken: token };
    const first = await connectDemoBank({ ...options, userId: 'alice', expectedSecret: 'shared-demo-secret' });
    assert.deepEqual(
      [first.webhook.created, first.connection.created, first.sync?.status, first.warnings],
      [true, true, 'synced', []],
    );
    assert.equal(first.webhookUrl, w.webhookUrl);
    const second = await connectDemoBank({ ...options, userId: 'alice' });
    assert.deepEqual([second.webhook.created, second.connection.created], [false, false]);
    assert.equal(second.connection.id, first.connection.id);
    assert.equal((await call(`${w.bankUrl}/webhooks`, apiKey)).data.webhooks.length, 1);
    assert.ok((await w.ledger()).length > 100);
    await assert.rejects(
      connectDemoBank({ ...options, bankApiKey: 'wrong', userId: 'alice' }),
      /Banc Demo answered 401/,
    );

    // Webhook management: only loopback receivers by default, and a deleted webhook gets no events.
    const remote = await call(`${w.bankUrl}/webhooks`, apiKey, 'POST', { url: 'https://example.com/hook' });
    assert.equal(remote.status, 400);
    assert.equal((await call(`${w.bankUrl}/webhooks/${first.webhook.id}`, apiKey, 'DELETE')).status, 200);
    assert.equal((await call(`${w.bankUrl}/webhooks/${first.webhook.id}`, apiKey, 'DELETE')).status, 404);
    await w.fire({ amount: '-1.00', description: 'Sense webhook' });
    assert.deepEqual((await call(`${w.bankUrl}/webhooks/deliveries`, apiKey)).data.deliveries, []);
  } finally {
    await w.close();
  }
});

const toCents = (amount: string) => Math.round(Number(amount) * 100);

test('the bank never stops: old history leaves a rolling window, balances stay exact and old cursors get 410', async () => {
  const w = await world({ webhook: false, bank: { maxTransactions: 60 } });
  // The same bank with room for everything: the reference for what the balances must be.
  const whole = createDemoBank({
    apiKey,
    seed: 'test-seed',
    startDate: '2026-09-01',
    clock: () => new Date(startedAt),
  });
  await whole.ready;
  try {
    const status = () => w.bank.status();
    assert.equal(status().transactions, 60);
    assert.equal(status().max_transactions, 60);
    assert.ok(status().dropped_transactions > 100, 'three months of history do not fit the window');
    assert.equal(status().paused_reason, null);

    // ReloCat pulls what the window holds and remembers its cursor.
    await w.connect();
    const firstCursor = listConnections(w.db, 'alice')[0].cursor;

    // Far more movements than the window holds: every tick still produces something.
    let produced = 0;
    for (let round = 0; round < 6; round++) produced += (await w.bank.step(100)).length;
    await whole.step(600);
    assert.ok(produced >= 600);
    assert.equal(status().transactions, 60);

    // Opening balance plus the listed completed transactions is the balance, and the balance is
    // what a bank that kept everything reports.
    const accounts = (await call(`${w.bankUrl}/customers/cust-001/accounts`, apiKey)).data.accounts as Json[];
    const listed = await w.bankTransactions();
    assert.ok(listed.length > 0 && listed.length <= 60);
    const reference = createServer((request, response) => void whole.handle(request, response));
    const referenceUrl = await listen(reference);
    const expected = (await call(`${referenceUrl}/customers/cust-001/accounts`, apiKey)).data.accounts as Json[];
    await stop(reference);
    for (const account of accounts) {
      const completed = listed
        .filter(transaction => transaction.account_id === account.id && transaction.state === 'completed')
        .reduce((sum, transaction) => sum + toCents(transaction.amount), 0);
      assert.equal(toCents(account.opening_balance) + completed, toCents(account.balance), account.id);
      assert.equal(account.balance, expected.find(item => item.id === account.id)?.balance, account.id);
      assert.ok(account.opened_on > '2026-09-01', 'the opening date moved with the window');
      assert.ok(
        listed.every(item => item.account_id !== account.id || item.created_at.slice(0, 10) >= account.opened_on),
      );
    }

    // The cursor from before points at history that is gone: 410, and ReloCat starts again by itself.
    const expired = await call(`${w.bankUrl}/customers/cust-001/transactions?cursor=${firstCursor}`, apiKey);
    assert.equal(expired.status, 410);
    const resync = (await call(`${w.apiUrl}/users/alice/bank/sync`, token, 'POST', {})).data.results[0];
    assert.equal(resync.status, 'synced');
    assert.ok(resync.inserted > 0);
    const fresh = listConnections(w.db, 'alice')[0].cursor;
    assert.equal((await call(`${w.bankUrl}/customers/cust-001/transactions?cursor=${fresh}`, apiKey)).status, 200);
  } finally {
    await whole.close();
    await w.close();
  }
});

test('a snapshot is accepted in a later month and keeps the seed and start date it was made with', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relocat-demo-bank-month-'));
  const snapshotFile = join(directory, 'demo-bank.json');
  try {
    // No start date configured: "three months ago" is decided on 22 November.
    const first = createDemoBank({ apiKey, seed: 'kept-seed', snapshotFile, clock: () => new Date(startedAt) });
    await first.ready;
    await first.step(3);
    const before = first.status();
    assert.equal(before.start_date, '2026-08-01');
    await first.close();

    // December: the default would now be 1 September, and no seed is given at all.
    const later = createDemoBank({ apiKey, snapshotFile, clock: () => new Date('2026-12-03T09:00:00.000Z') });
    await later.ready;
    const after = later.status();
    assert.deepEqual(
      [after.start_date, after.seed, after.transactions, after.ticks],
      [before.start_date, 'kept-seed', before.transactions, before.ticks],
    );
    assert.ok((await later.step(1)).length > 0, 'and it goes on from where it was');
    await later.close();

    // A start date that was configured and disagrees is still an error, not a silent new history.
    await assert.rejects(createDemoBank({ apiKey, startDate: '2026-10-01', snapshotFile }).ready, /start date/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a webhook that signs with an old secret gets the current one when ReloCat is connected again', async () => {
  // ReloCat verifies with `w.secret`; the bank holds a subscription made for an earlier secret.
  const w = await world({ webhook: false });
  try {
    const stale = await call(`${w.bankUrl}/webhooks`, apiKey, 'POST', { url: w.webhookUrl });
    assert.notEqual(stale.data.signing_secret, w.secret);
    await w.connect();
    await w.fire({ amount: '-3.00', description: 'Abans de la rotació' });
    await w.settle();
    const rejected = (await call(`${w.bankUrl}/webhooks/deliveries`, apiKey)).data.deliveries[0];
    assert.deepEqual([rejected.state, rejected.last_status], ['pending', 401]);

    const options = { bankUrl: w.bankUrl, bankApiKey: apiKey, relocatApiUrl: w.apiUrl, relocatToken: token };
    const fixed = await connectDemoBank({ ...options, userId: 'alice', expectedSecret: w.secret });
    assert.deepEqual([fixed.webhook.created, fixed.webhook.secretReplaced, fixed.warnings], [false, true, []]);
    assert.equal(fixed.webhook.id, stale.data.id, 'the subscription is kept, only its secret changes');
    const listed = (await call(`${w.bankUrl}/webhooks`, apiKey)).data.webhooks;
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(w.secret), 'the secret itself is never listed');

    const [payment] = await w.fire({ amount: '-4.00', description: 'Després de la rotació' });
    await w.settle();
    const delivered = (await call(`${w.bankUrl}/webhooks/deliveries?state=delivered`, apiKey)).data.deliveries;
    assert.ok(delivered.length >= 1);
    assert.ok((await w.ledger()).some(row => row.id === ledgerId(payment.id)));

    const again = await connectDemoBank({ ...options, userId: 'alice', expectedSecret: w.secret });
    assert.equal(again.webhook.secretReplaced, false, 'nothing to replace the second time');

    // The route itself: owner only, a secret of a sensible length, and an unknown webhook is a 404.
    const route = `${w.bankUrl}/webhooks/${stale.data.id}/secret`;
    assert.equal((await call(route, 'wrong-key', 'PUT', {})).status, 401);
    assert.equal((await call(route, apiKey, 'PUT', { signing_secret: 'short' })).status, 400);
    assert.equal((await call(`${w.bankUrl}/webhooks/wh-999999/secret`, apiKey, 'PUT', {})).status, 404);
    const invented = await call(route, apiKey, 'PUT', {});
    assert.match(invented.data.signing_secret, /^whsec-[0-9a-f]{48}$/);
  } finally {
    await w.close();
  }
});

test('the bank has its own tick variable and still honours the old shared one', () => {
  assert.equal(demoBankConfig({}).intervalMs, 5000);
  assert.equal(demoBankConfig({ DEMO_BANK_INTERVAL_MS: '2000' }).intervalMs, 2000);
  assert.equal(demoBankConfig({ DEMO_BANK_INTERVAL_MS: '2000', DEMO_BANK_TICK_MS: '750' }).intervalMs, 750);
});

// ------------------------------------------------------------------ consent at the bank

/**
 * The whole server (accounts, account page, `/api`, the sync engine) next to a real Banc Demo, over
 * HTTP: what a person does to connect the fictional bank themselves.
 */
async function consentWorld() {
  const signingSecret = 'consent-world-signing-secret';
  const bank = createDemoBank({ apiKey, adminKey, seed: 'consent-seed', startDate: '2026-10-01', signingSecret });
  await bank.ready;
  const bankServer = createServer((request, response) => void bank.handle(request, response));
  const bankUrl = await listen(bankServer);
  const server = await startApp({
    profileApi: {
      bankRegistry: createBankRegistry([demoBankProvider], {
        BANK_DEMO_BANK_BASE_URL: bankUrl,
        BANK_DEMO_BANK_API_KEY: apiKey,
        BANK_DEMO_BANK_WEBHOOK_SECRET: signingSecret,
      }),
      bankSync: { housekeepingMs: null },
    },
  });
  const subscribed = await call(`${bankUrl}/webhooks`, apiKey, 'POST', {
    url: `${server.origin}/api/webhooks/bank/demo-bank`,
  });
  assert.equal(subscribed.status, 201);
  const admin = 'admin-test-token';
  return {
    bank,
    bankUrl,
    server,
    /** Press Connect on the account page and return the bank's consent page address. */
    async begin(browser: Browser) {
      const csrf = await browser.csrf('/account');
      const leave = await browser.request('/account/bank/connect', { form: { csrf, provider: 'demo-bank' } });
      assert.equal(leave.status, 200);
      const html = await leave.text();
      assert.match(html, /You are leaving ReloCat/);
      assert.match(html, /fictional bank/);
      assert.doesNotMatch(html, /<script/i);
      const link = /href="(http:\/\/127\.0\.0\.1:\d+\/consent\/consent-[0-9a-f]{32})"/.exec(html);
      assert(link, 'the page links to the bank');
      assert(link[1].startsWith(bankUrl));
      return link[1];
    },
    /** Decide on the bank's page, as the customer; returns where the bank sends the browser. */
    async decide(consentUrl: string, decision: 'approve' | 'deny', customer = 'cust-002') {
      const answer = await fetch(consentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision, customer_id: customer }),
        redirect: 'manual',
      });
      return { status: answer.status, location: answer.headers.get('location') };
    },
    path: (location: string | null) => {
      const url = new URL(location ?? 'http://missing');
      assert.equal(url.origin, server.origin, 'the bank sends the person back to ReloCat');
      return url.pathname + url.search;
    },
    idOf: (email: string) =>
      server.db.get<{ user_id: string }>('SELECT user_id FROM accounts WHERE email = ?', email)!.user_id,
    async movements(userId: string) {
      const listed = await call(`${server.origin}/api/users/${userId}/bank/transactions?limit=500`, admin);
      return listed.data as { total: number; synthetic: boolean; transactions: Json[] };
    },
    async settle() {
      await bank.flushDeliveries();
      await server.app.profiles.bankSync.idle();
    },
    async close() {
      await server.close();
      await bank.close();
      await stop(bankServer);
    },
  };
}

test('a person connects Banc Demo by consenting at the bank, and its movements then arrive in their own ledger', async t => {
  const world = await consentWorld();
  t.after(() => world.close());
  const { server, bankUrl } = world;
  const ada = server.browser();
  await ada.signUp('ada@example.com');
  const adaId = world.idOf('ada@example.com');

  // The bank's own page: fictional and labelled so, no script, and it names who is asking.
  const consentUrl = await world.begin(ada);
  const page = await fetch(consentUrl);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-demo-bank'), 'fictional');
  assert.match(
    page.headers.get('content-security-policy') ?? '',
    /default-src 'none'.*form-action 'self' http:\/\/127\.0\.0\.1:\d+/,
  );
  assert.match(html, /Fictional bank/);
  assert.match(html, /Allow ReloCat to read the accounts of a customer\?/);
  assert.match(html, /has no logins, its customers are invented/);
  assert.match(html, /Client fictici 002 \(cust-002\)/);
  assert.doesNotMatch(html, /<script/i);
  const pending = (await (await ada.request(`/api/users/${adaId}/bank/consents`)).json()) as { consents: Json[] };
  assert.deepEqual(
    pending.consents.map(item => Object.keys(item).sort()),
    [['createdAt', 'expiresAt', 'providerId']],
    'a pending consent is listed without its state',
  );

  // Approve as customer 002: the bank sends the browser back with a one-time code and the state.
  const approved = await world.decide(consentUrl, 'approve');
  assert.equal(approved.status, 303);
  const callback = world.path(approved.location);
  assert.match(callback, /^\/bank\/consent\/callback\?state=[\w-]{43}&code=code-[0-9a-f]{48}$/);
  // The request cannot be decided twice, and the page is gone.
  assert.equal((await world.decide(consentUrl, 'approve')).status, 404);
  assert.equal((await fetch(consentUrl)).status, 404);

  const back = await ada.request(callback);
  assert.deepEqual([back.status, back.headers.get('location')], [302, '/account?done=bank-connected#bank']);
  const account = await (await ada.request('/account?done=bank-connected')).text();
  assert.match(account, /Your bank is connected\./);
  assert.match(account, /Banc Demo \(fictional bank\)/);
  assert.match(account, /the bank tells ReloCat when something changes/);
  assert.match(account, /consent until \d{4}-\d{2}-\d{2}/);

  // The history was pulled into Ada's ledger, labelled synthetic; nobody else got anything.
  const first = await world.movements(adaId);
  assert(first.total > 20, `history pulled: ${first.total}`);
  assert.equal(first.synthetic, true);
  assert.equal((await world.movements('user-001')).total, 0);
  // The customer reference is sealed: the connection row holds a fingerprint, and the code is spent.
  const row = server.db.get<{ ref: string }>('SELECT ref FROM bank_connections WHERE user_id = ?', adaId)!;
  assert.match(row.ref, /^sealed:[0-9a-f]{64}$/);
  assert(!JSON.stringify(server.db.all('SELECT * FROM bank_connections')).includes('cust-002'));
  const code = new URLSearchParams(callback.split('?')[1]).get('code')!;
  assert.equal((await call(`${bankUrl}/consents/token`, apiKey, 'POST', { code })).status, 400, 'a code works once');
  assert.equal((await ada.request(callback)).status, 400, 'and so does the state');

  // A new movement at the bank reaches Ada's ledger through the signed webhook.
  const fired = await call(`${bankUrl}/simulate/transaction`, adminKey, 'POST', {
    customer_id: 'cust-002',
    amount: '-23.45',
    description: 'Forn Exemple consent test',
    category: 'groceries',
  });
  assert.equal(fired.status, 201);
  await world.settle();
  const after = await world.movements(adaId);
  assert.equal(after.total, first.total + 1);
  assert(after.transactions.some(row => row.description === 'Forn Exemple consent test' && row.amountCents === -2345));
  // A movement of another customer is nobody's here.
  await call(`${bankUrl}/simulate/transaction`, adminKey, 'POST', {
    customer_id: 'cust-003',
    amount: '-1.00',
    description: 'Somebody else',
  });
  await world.settle();
  assert.equal((await world.movements(adaId)).total, first.total + 1);

  // Bob cannot attach the same bank customer: one bank login, one person.
  const bob = server.browser();
  await bob.signUp('bob@example.com');
  const bobId = world.idOf('bob@example.com');
  const taken = await bob.request(world.path((await world.decide(await world.begin(bob), 'approve')).location));
  assert.equal(taken.status, 409);
  assert.match(await taken.text(), /already connected to a ReloCat account/);
  assert.equal((await world.movements(bobId)).total, 0);

  // Denying at the bank connects nothing.
  const denied = await world.decide(await world.begin(bob), 'deny');
  assert.match(denied.location ?? '', /error=access_denied/);
  const refused = await bob.request(world.path(denied.location));
  assert.deepEqual([refused.status, refused.headers.get('location')], [302, '/account?done=bank-denied#bank']);
  assert.equal(server.db.get('SELECT 1 FROM bank_connections WHERE user_id = ?', bobId), undefined);

  // A callback that reaches somebody else's browser is refused, and is then useless to its owner too.
  const stolen = world.path((await world.decide(await world.begin(bob), 'approve', 'cust-003')).location);
  assert.equal((await ada.request(stolen)).status, 403, 'another signed-in person');
  const anonymous = await fetch(`${server.origin}${stolen}`, { redirect: 'manual' });
  assert.deepEqual([anonymous.status, anonymous.headers.get('location')], [302, '/login?next=%2Faccount']);
  assert.equal((await bob.request(stolen)).status, 400, 'the state was spent by the first presentation');
  // The same person in a new session (signed in again) cannot finish a consent the old session started.
  const fresh = world.path((await world.decide(await world.begin(bob), 'approve', 'cust-003')).location);
  const bobAgain = server.browser();
  await bobAgain.login('bob@example.com');
  assert.equal((await bobAgain.request(fresh)).status, 403);
  assert.equal(server.db.get('SELECT 1 FROM bank_connections WHERE user_id = ?', bobId), undefined);

  // Disconnecting deletes the sealed credential; movements stay, and later webhooks write nothing.
  const csrf = await ada.csrf('/account');
  const connectionId = server.db.get<{ id: string }>('SELECT id FROM bank_connections WHERE user_id = ?', adaId)!.id;
  const gone = await ada.request('/account/bank/disconnect', { form: { csrf, connection: connectionId } });
  assert.equal(gone.status, 303);
  assert.equal(server.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bank_credentials')?.n, 0);
  await call(`${bankUrl}/simulate/transaction`, adminKey, 'POST', {
    customer_id: 'cust-002',
    amount: '-2.00',
    description: 'After disconnect',
  });
  await world.settle();
  assert.equal((await world.movements(adaId)).total, first.total + 1);
});

test('the bank’s consent desk: API key, loopback return addresses, expiry and single use', async t => {
  const time = { now: startedAt };
  const bank = createDemoBank({
    apiKey,
    adminKey,
    seed: 'desk',
    startDate: '2026-11-01',
    clock: () => new Date(time.now),
  });
  await bank.ready;
  const bankServer = createServer((request, response) => void bank.handle(request, response));
  const bankUrl = await listen(bankServer);
  t.after(async () => {
    await bank.close();
    await stop(bankServer);
  });
  const request = { redirect_uri: 'http://127.0.0.1:8787/bank/consent/callback', state: 's'.repeat(43) };
  const decide = (path: string, fields: Record<string, string>) =>
    fetch(`${bankUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });

  // Only the application, with its key, creates a consent request or exchanges a code.
  assert.equal((await call(`${bankUrl}/consents`, null, 'POST', request)).status, 401);
  assert.equal((await call(`${bankUrl}/consents`, 'wrong-key', 'POST', request)).status, 401);
  assert.equal((await call(`${bankUrl}/consents/token`, null, 'POST', { code: 'c'.repeat(20) })).status, 401);
  // The customer is only ever sent back to this machine, and a short state is refused.
  for (const bad of [
    { ...request, redirect_uri: 'https://evil.example/callback' },
    { ...request, redirect_uri: 'http://user:pass@127.0.0.1/callback' },
    { ...request, redirect_uri: 'javascript:alert(1)' },
    { ...request, state: 'short' },
    { redirect_uri: request.redirect_uri },
  ])
    assert.equal((await call(`${bankUrl}/consents`, apiKey, 'POST', bad)).status, 400, JSON.stringify(bad));

  const created = await call(`${bankUrl}/consents`, apiKey, 'POST', request);
  assert.equal(created.status, 201);
  assert.match(created.data.consent_path, /^\/consent\/consent-[0-9a-f]{32}$/);
  assert.equal(created.data.synthetic, true);
  // The page needs no key, only the unguessable id; other ids are unknown.
  assert.equal((await fetch(`${bankUrl}${created.data.consent_path}`)).status, 200);
  assert.equal((await fetch(`${bankUrl}/consent/consent-${'0'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${bankUrl}/consent/not-an-id`)).status, 400);
  // A customer the bank does not have is refused, and the request stays open for a real choice.
  assert.equal((await decide(created.data.consent_path, { decision: 'approve', customer_id: 'cust-999' })).status, 400);
  assert.equal((await decide(created.data.consent_path, { decision: 'maybe' })).status, 400);
  const approved = await decide(created.data.consent_path, { decision: 'approve', customer_id: 'cust-001' });
  const location = new URL(approved.headers.get('location')!);
  assert.equal(location.searchParams.get('state'), request.state);
  const code = location.searchParams.get('code')!;
  const granted = await call(`${bankUrl}/consents/token`, apiKey, 'POST', { code });
  assert.equal(granted.status, 200);
  assert.deepEqual(
    [granted.data.customer_id, granted.data.expires_at, granted.data.synthetic],
    ['cust-001', new Date(startedAt + 90 * 86_400_000).toISOString(), true],
  );
  assert.equal((await call(`${bankUrl}/consents/token`, apiKey, 'POST', { code })).status, 400);

  // A request nobody decides lapses after ten minutes, and a code after two.
  const slow = await call(`${bankUrl}/consents`, apiKey, 'POST', request);
  const quick = await call(`${bankUrl}/consents`, apiKey, 'POST', request);
  const issued = await decide(quick.data.consent_path, { decision: 'approve', customer_id: 'cust-002' });
  time.now += 2 * 60_000 + 1;
  const stale = new URL(issued.headers.get('location')!).searchParams.get('code')!;
  assert.equal((await call(`${bankUrl}/consents/token`, apiKey, 'POST', { code: stale })).status, 400);
  time.now += 8 * 60_000;
  assert.equal((await fetch(`${bankUrl}${slow.data.consent_path}`)).status, 404);
  assert.deepEqual(bank.consents.waiting(), { requests: 0, codes: 0 });
});
