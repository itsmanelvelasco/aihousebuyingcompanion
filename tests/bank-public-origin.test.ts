import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createDemoBank } from '../apps/demo-bank/server.ts';
import type { BankStream, EventSourceLike } from '../apps/web/hooks.ts';
import { followBankStream } from '../apps/web/hooks.ts';
import demoBankProvider from '../packages/banks/providers/demo-bank.ts';
import { createBankRegistry } from '../packages/banks/registry.ts';
import { demoBankEnabled, demoBankMountPath } from '../packages/config/env.ts';
import { productionSite, startApp, startProductionApp } from './support/app.ts';

/**
 * The live fictional bank on the one public origin. ReloCat runs in its deployed shape (production,
 * `PUBLIC_ORIGIN`, every request through a reverse proxy) with Banc Demo's consent page mounted on
 * that same origin under `/banc-demo`. A person only ever opens addresses of the public origin; the
 * bank's keyed API and its webhooks stay on loopback ports, server to server.
 */

const apiKey = 'public-origin-bank-key';
const adminKey = 'public-origin-admin-key';
const signingSecret = 'public-origin-signing-secret';
const admin = 'admin-test-token';

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

async function call(url: string, key: string | null, method = 'GET', body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: (await response.json()) as Json };
}

type Delivery = { headers: Record<string, string>; body: string; status: number };

async function world(options: { returnOrigins?: string[] } = {}) {
  const bank = createDemoBank({
    apiKey,
    adminKey,
    seed: 'public-origin-seed',
    startDate: '2026-10-01',
    signingSecret,
    returnOrigins: options.returnOrigins ?? [productionSite],
  });
  await bank.ready;
  const bankServer = createServer((request, response) => void bank.handle(request, response));
  const bankUrl = await listen(bankServer);
  const server = await startProductionApp({
    demoBank: { path: demoBankMountPath, handle: bank.handleCustomer },
    profileApi: {
      bankRegistry: createBankRegistry([demoBankProvider], {
        BANK_DEMO_BANK_BASE_URL: bankUrl,
        BANK_DEMO_BANK_API_KEY: apiKey,
        BANK_DEMO_BANK_WEBHOOK_SECRET: signingSecret,
        BANK_DEMO_BANK_PUBLIC_PATH: demoBankMountPath,
      }),
      bankSync: { housekeepingMs: null },
      heartbeatMs: 50,
    },
  });
  const webhookUrl = `${server.direct}/api/webhooks/bank/demo-bank`;
  // Between the bank and ReloCat, on loopback: records each webhook exactly as the bank sent it.
  const deliveries: Delivery[] = [];
  const recorder = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers))
      if (name.startsWith('x-demo-bank') || name === 'content-type') headers[name] = String(value);
    const forwarded = await fetch(webhookUrl, { method: 'POST', headers, body });
    deliveries.push({ headers, body, status: forwarded.status });
    response.writeHead(forwarded.status, { 'Content-Type': 'application/json' }).end(await forwarded.text());
  });
  const recorderUrl = await listen(recorder);
  assert.equal((await call(`${bankUrl}/webhooks`, apiKey, 'POST', { url: `${recorderUrl}/hook` })).status, 201);
  const api = (path: string) => call(`${server.direct}/api${path}`, admin);
  return {
    bank,
    bankUrl,
    server,
    webhookUrl,
    deliveries,
    idOf: (email: string) =>
      server.db.get<{ user_id: string }>('SELECT user_id FROM accounts WHERE email = ?', email)!.user_id,
    movements: async (userId: string) =>
      (await api(`/users/${userId}/bank/transactions?limit=500`)).data as { total: number; transactions: Json[] },
    events: async (userId: string, after: number) =>
      (await api(`/users/${userId}/bank/events?after=${after}&limit=100`)).data as {
        events: { sequence: number; type: string; transactionCount: number }[];
        latestRevision: number;
      },
    summary: async (userId: string, from: string, to: string) =>
      (await api(`/users/${userId}/bank/summary?from=${from}&to=${to}`)).data,
    fire: (description: string, customer = 'cust-002') =>
      call(`${bankUrl}/simulate/transaction`, adminKey, 'POST', {
        customer_id: customer,
        amount: '-23.45',
        description,
        category: 'groceries',
      }),
    async settle() {
      await bank.flushDeliveries();
      await server.app.profiles.bankSync.idle();
    },
    async close() {
      await server.close();
      await bank.close();
      await stop(recorder);
      await stop(bankServer);
    },
  };
}

/** Reads a Server-Sent Events response into `{ id, event, data }` records as they arrive. */
function readEvents(response: Response) {
  const received: { id?: string; event?: string; data?: string }[] = [];
  const waiters: (() => void)[] = [];
  const reader = response.body!.getReader();
  const done = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const record: Record<string, string> = {};
          for (const line of buffer.slice(0, end).split('\n')) {
            const colon = line.indexOf(': ');
            if (colon > 0) record[line.slice(0, colon)] = line.slice(colon + 2);
          }
          buffer = buffer.slice(end + 2);
          if (record.event) received.push(record);
          for (const wake of waiters.splice(0)) wake();
        }
      }
    } catch {
      // The test closed the stream.
    }
    for (const wake of waiters.splice(0)) wake();
  })();
  return {
    received,
    done,
    /** Close the stream from this side. */
    stop: () => reader.cancel().catch(() => {}),
    /** Resolves with the first record that matches, now or later. */
    async next(match: (record: { id?: string; event?: string; data?: string }) => boolean) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = received.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('The event stream did not deliver the event in time');
        await Promise.race([
          new Promise<void>(resolve => waiters.push(resolve)),
          new Promise<void>(resolve => setTimeout(resolve, 100)),
        ]);
      }
    },
  };
}

const sign = (timestamp: string, body: string, secret = signingSecret) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

test('the live fictional bank on the public origin: consent on one origin, a signed webhook, one ledger row, one event, the stream and the summary', async t => {
  const w = await world();
  t.after(() => w.close());
  const { server } = w;
  const ada = server.browser();
  await ada.signUp('ada@example.com');
  const adaId = w.idOf('ada@example.com');

  // Connect on the account page: the bank's page is on the public origin, under /banc-demo.
  const csrf = await ada.csrf('/account');
  const leave = await ada.request('/account/bank/connect', { form: { csrf, provider: 'demo-bank' } });
  assert.equal(leave.status, 200);
  const leaveHtml = await leave.text();
  assert.match(leaveHtml, /fictional bank/);
  const link = /href="(https:\/\/[^"]+\/consent\/consent-[0-9a-f]{32})"/.exec(leaveHtml);
  assert(link, 'the page links to the bank');
  const consentUrl = new URL(link[1]);
  assert.equal(consentUrl.origin, productionSite, 'the person is not sent to a loopback port');
  assert.match(consentUrl.pathname, /^\/banc-demo\/consent\/consent-[0-9a-f]{32}$/);
  assert(!leaveHtml.includes(w.bankUrl), 'the bank’s own port is never shown to the person');

  // The consent page, served by ReloCat's origin: fictional, labelled, no script, and its form stays in the mount.
  const page = await ada.request(consentUrl.pathname);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-demo-bank'), 'fictional');
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'.*form-action 'self'/);
  assert.match(html, /Fictional bank/);
  assert.match(html, /has no logins, its customers are invented/);
  assert.match(html, new RegExp(`action="${consentUrl.pathname}"`));
  assert.match(html, new RegExp(`href="${consentUrl.pathname}\\?lang=ca"`));
  assert.match(html, /relocat\.test/, 'it names the application that asks, by its public host');
  assert.doesNotMatch(html, /<script/i);
  assert.match(await (await ada.request(`${consentUrl.pathname}?lang=es`)).text(), /Banco ficticio/);

  // The mount serves the customer's page and nothing that takes a key.
  for (const path of ['/customers', '/webhooks', '/simulate/status', '/consents']) {
    const keyed = await fetch(`${server.origin}${demoBankMountPath}${path}`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(keyed.status, 404, `${path} is not mounted`);
  }
  const created = await fetch(`${server.origin}${demoBankMountPath}/consents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uri: `${productionSite}/bank/consent/callback`, state: 's'.repeat(43) }),
  });
  assert.equal(created.status, 404, 'a consent request cannot be created through the public origin');
  assert.equal((await fetch(`${server.origin}${demoBankMountPath}/health`)).status, 200);

  // Approve: the bank sends the browser back to the public origin's callback with the state and a code.
  const approved = await ada.request(consentUrl.pathname, { form: { decision: 'approve', customer_id: 'cust-002' } });
  assert.equal(approved.status, 303);
  const back = new URL(approved.headers.get('location') ?? 'http://missing');
  assert.equal(back.origin, productionSite);
  assert.equal(back.pathname, '/bank/consent/callback');
  assert.match(back.search, /^\?state=[\w-]{43}&code=code-[0-9a-f]{48}$/);
  assert.equal((await ada.request(consentUrl.pathname)).status, 404, 'the request cannot be decided twice');

  const done = await ada.request(back.pathname + back.search);
  assert.deepEqual([done.status, done.headers.get('location')], [302, '/account?done=bank-connected#bank']);
  assert.equal((await ada.request(back.pathname + back.search)).status, 400, 'the state works once');
  // Another signed-in person gets nothing from Ada's callback address.
  const eve = server.browser();
  await eve.signUp('eve@example.com');
  assert.equal((await eve.request(back.pathname + back.search)).status, 400);
  assert.equal((await w.movements(w.idOf('eve@example.com'))).total, 0);
  await w.settle();
  const before = await w.movements(adaId);
  assert(before.total > 20, `history pulled: ${before.total}`);
  const head = (await w.events(adaId, 0)).latestRevision;
  assert(head > 0);

  // The page's own event stream names no user id: the session cookie says whose it is.
  const anonymous = await fetch(`${server.origin}/api/me/bank/events/stream`);
  assert.equal(anonymous.status, 401);
  await anonymous.body?.cancel();
  const stream = await ada.request(`/api/me/bank/events/stream?after=${head}`);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/);
  const live = readEvents(stream);
  t.after(() => live.stop());
  const ready = JSON.parse((await live.next(record => record.event === 'ready')).data ?? '{}');
  assert.deepEqual(ready, { latestRevision: head, requiresRefresh: false, synthetic: true });

  // A movement at the bank.
  const fired = await w.fire('Forn Exemple public origin');
  assert.equal(fired.status, 201);
  await w.settle();

  // 1. The signed webhook reached /api/webhooks/bank/demo-bank and was accepted.
  assert.equal(w.deliveries.length, 1);
  const delivery = w.deliveries[0];
  assert.equal(delivery.status, 202);
  assert.equal(
    delivery.headers['x-demo-bank-signature'],
    sign(delivery.headers['x-demo-bank-timestamp'], delivery.body),
    'signed with the shared secret over timestamp and body',
  );
  // 2. The ledger gained exactly one movement.
  const after = await w.movements(adaId);
  assert.equal(after.total, before.total + 1);
  const row = after.transactions.find(item => item.description === 'Forn Exemple public origin');
  assert(row && row.amountCents === -2345);
  // 3. A `bank.updated` event with a new sequence is readable by cursor.
  const log = await w.events(adaId, head);
  assert.equal(log.events.length, 1);
  assert.deepEqual(
    [log.events[0].type, log.events[0].sequence, log.events[0].transactionCount],
    ['bank.updated', head + 1, after.total],
  );
  // 4. The stream delivered it, with the sequence as its event ID.
  const pushed = await live.next(record => record.event === 'bank.updated');
  assert.equal(pushed.id, String(head + 1));
  assert.equal(JSON.parse(pushed.data ?? '{}').sequence, head + 1);
  // 5. The person's cash-flow summary of that month changed by the movement.
  const month = String(row.date).slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const summary = await w.summary(adaId, `${month}-01`, lastDay);
  assert.equal(summary.synthetic, true);

  // A redelivery of the same webhook is acknowledged and changes nothing.
  const again = await fetch(w.webhookUrl, { method: 'POST', headers: delivery.headers, body: delivery.body });
  assert.equal(again.status, 202);
  await w.settle();
  assert.equal((await w.movements(adaId)).total, before.total + 1, 'still exactly one new movement');
  assert.equal((await w.events(adaId, 0)).latestRevision, head + 1, 'and no new event');

  // A second movement moves the summary by exactly its amount.
  await w.fire('Forn Exemple second');
  await w.settle();
  const second = (await w.movements(adaId)).transactions.find(item => item.description === 'Forn Exemple second');
  assert(second);
  if (String(second.date).slice(0, 7) === month) {
    const moved = await w.summary(adaId, `${month}-01`, lastDay);
    assert.equal(moved.expenseCents, summary.expenseCents + 2345, 'the summary counts the new movement');
    assert.equal(moved.transactionCount, summary.transactionCount + 1);
  }
  await live.next(record => record.id === String(head + 2));

  // A reconnecting EventSource repeats its address and adds Last-Event-ID: nothing is replayed.
  const resumed = await ada.request(`/api/me/bank/events/stream?after=${head}`, {
    headers: { 'Last-Event-ID': String(head + 2) },
  });
  const tail = readEvents(resumed);
  await tail.next(record => record.event === 'ready');
  await w.fire('Forn Exemple third');
  await w.settle();
  await tail.next(record => record.id === String(head + 3));
  assert.deepEqual(
    tail.received.filter(record => record.event === 'bank.updated').map(record => record.id),
    [String(head + 3)],
  );
  await tail.stop();

  // A webhook with a bad signature, a stale timestamp or another secret changes nothing.
  const settled = { total: (await w.movements(adaId)).total, revision: (await w.events(adaId, 0)).latestRevision };
  const body = JSON.stringify({
    id: 'evt-forged-0001',
    type: 'transaction.created',
    data: { customer_id: 'cust-002' },
  });
  const now = String(Date.now());
  const stale = String(Date.now() - 6 * 60_000);
  const attempts: [string, Record<string, string>, string][] = [
    [
      'tampered signature',
      { 'x-demo-bank-timestamp': now, 'x-demo-bank-signature': sign(now, body).replace(/.$/, 'x') },
      body,
    ],
    [
      'signed with another secret',
      { 'x-demo-bank-timestamp': now, 'x-demo-bank-signature': sign(now, body, 'other') },
      body,
    ],
    ['stale timestamp', { 'x-demo-bank-timestamp': stale, 'x-demo-bank-signature': sign(stale, body) }, body],
    ['old signature on a new timestamp', { ...delivery.headers, 'x-demo-bank-timestamp': now }, delivery.body],
    ['body changed after signing', delivery.headers, delivery.body.replace('cust-002', 'cust-003')],
    ['no signature', {}, body],
  ];
  for (const [name, headers, sent] of attempts) {
    const refused = await fetch(w.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: sent,
    });
    assert.equal(refused.status, 401, name);
    // The same call through the public origin is refused just the same.
    const outside = await fetch(`${server.origin}/api/webhooks/bank/demo-bank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: sent,
    });
    assert.equal(outside.status, 401, `${name}, from outside`);
  }
  await w.settle();
  assert.deepEqual(
    { total: (await w.movements(adaId)).total, revision: (await w.events(adaId, 0)).latestRevision },
    settled,
  );

  // Signing out ends the stream.
  await ada.request('/logout', { form: { csrf: await ada.csrf('/account') } });
  await live.done;
});

test('the bank sends a customer back only to this machine or to the origin it is mounted on', async t => {
  const w = await world();
  t.after(() => w.close());
  const state = 's'.repeat(43);
  const create = (redirect: string) => call(`${w.bankUrl}/consents`, apiKey, 'POST', { redirect_uri: redirect, state });
  assert.equal((await create(`${productionSite}/bank/consent/callback`)).status, 201);
  assert.equal((await create('http://127.0.0.1:8787/bank/consent/callback')).status, 201);
  for (const elsewhere of [
    'https://evil.example/bank/consent/callback',
    `${productionSite.replace('https:', 'http:')}/bank/consent/callback`,
    `${productionSite}:8443/bank/consent/callback`,
    `https://sub.${new URL(productionSite).host}/bank/consent/callback`,
  ])
    assert.equal((await create(elsewhere)).status, 400, elsewhere);

  // Without the mount variable the person is sent to the bank's own address, as before.
  const unmounted = await demoBankProvider.consent.beginConsent(
    { returnUrl: `${productionSite}/bank/consent/callback`, state },
    {
      env: { BANK_DEMO_BANK_BASE_URL: w.bankUrl, BANK_DEMO_BANK_API_KEY: apiKey, BANK_DEMO_BANK_WEBHOOK_SECRET: 'x' },
      now: new Date(),
    },
  );
  assert(unmounted.redirectUrl.startsWith(`${w.bankUrl}/consent/consent-`));
  // A mount that is not one plain path segment is refused instead of becoming part of a link.
  await assert.rejects(
    demoBankProvider.consent.beginConsent(
      { returnUrl: `${productionSite}/bank/consent/callback`, state },
      {
        env: {
          BANK_DEMO_BANK_BASE_URL: w.bankUrl,
          BANK_DEMO_BANK_API_KEY: apiKey,
          BANK_DEMO_BANK_WEBHOOK_SECRET: 'x',
          BANK_DEMO_BANK_PUBLIC_PATH: '//evil.example',
        },
        now: new Date(),
      },
    ),
    /one path segment/,
  );
});

test('without Banc Demo nothing answers under /banc-demo, and the own-stream alias reaches no one else', async t => {
  const server = await startApp();
  t.after(() => server.close());
  assert.equal((await fetch(`${server.origin}${demoBankMountPath}/health`)).status, 404);
  const ada = server.browser();
  await ada.signUp('ada@example.com');
  // The alias is the stream only: no other `/api/me/...` route exists, and the admin token is nobody's "me".
  assert.equal((await ada.request('/api/me/inputs')).status, 403);
  assert.equal((await ada.request('/api/me/bank/events')).status, 403);
  const asAdmin = await fetch(`${server.origin}/api/me/bank/events/stream`, {
    headers: { Authorization: 'Bearer admin-test-token' },
  });
  assert.equal(asAdmin.status, 401);
  // A page of another site cannot open it with the person's cookie.
  const cross = await ada.request('/api/me/bank/events/stream', { headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 401);
  const own = await ada.request('/api/me/bank/events/stream');
  assert.equal(own.status, 200);
  await own.body?.cancel();
});

test('DEMO_BANK: on by default outside production, off in production unless it says on', () => {
  assert.equal(demoBankEnabled({}), true);
  assert.equal(demoBankEnabled({ DEMO_BANK: 'off' }), false);
  assert.equal(demoBankEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(demoBankEnabled({ NODE_ENV: 'production', DEMO_BANK: '' }), false);
  assert.equal(demoBankEnabled({ NODE_ENV: 'production', DEMO_BANK: 'yes' }), false, 'a typo leaves it off');
  assert.equal(demoBankEnabled({ NODE_ENV: 'production', DEMO_BANK: 'on' }), true);
  assert.equal(demoBankEnabled({ NODE_ENV: 'production', DEMO_BANK: 'off' }), false);
});

// ------------------------------------------------------------------ the workspace's stream follower

/** An `EventSource` the test drives by hand. */
function fakeSource() {
  const listeners = new Map<string, ((event: { lastEventId?: string }) => void)[]>();
  const state = { readyState: 0, closed: 0, urls: [] as string[] };
  const source: EventSourceLike = {
    get readyState() {
      return state.readyState;
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close() {
      state.closed++;
      state.readyState = 2;
    },
  };
  const stream = (readyTimeoutMs = 10_000): BankStream => ({
    url: after => `/api/me/bank/events/stream?after=${after}`,
    open: url => {
      state.urls.push(url);
      return source;
    },
    readyTimeoutMs,
  });
  const emit = (type: string, lastEventId?: string) => {
    for (const listener of listeners.get(type) ?? []) listener({ lastEventId });
  };
  return { state, stream, emit };
}

test('the workspace follows the stream by cursor: each sequence is news once, replays are not, and it closes', () => {
  const fake = fakeSource();
  const seen: string[] = [];
  const following = followBankStream(fake.stream(), 7, {
    up: reconnected => seen.push(reconnected ? 'up-again' : 'up'),
    update: sequence => seen.push(`update ${sequence}`),
    down: final => seen.push(final ? 'down-final' : 'down'),
  });
  assert.deepEqual(
    fake.state.urls,
    ['/api/me/bank/events/stream?after=7'],
    'opened once, after the cursor, with no user id',
  );
  fake.emit('ready');
  fake.emit('bank.updated', '7'); // already read by the first poll
  fake.emit('bank.updated', '8');
  fake.emit('bank.updated', '8'); // the same event again
  fake.emit('bank.updated', 'not-a-number');
  fake.emit('bank.updated', '9');
  // The connection drops; the browser reconnects by itself with Last-Event-ID and the server replays nothing new.
  fake.emit('error');
  fake.emit('ready');
  fake.emit('bank.updated', '9');
  fake.emit('bank.updated', '10');
  assert.deepEqual(seen, ['up', 'update 8', 'update 9', 'down', 'up-again', 'update 10']);
  following.close();
  assert.equal(fake.state.closed, 1);
  fake.emit('bank.updated', '11');
  fake.emit('error');
  assert.equal(seen.length, 6, 'nothing is reported after it is closed');
});

test('the workspace gives the stream up when the server refuses it or it never becomes ready, and polling carries on', async () => {
  // Refused: the browser's EventSource ends in CLOSED after an error answer.
  const refused = fakeSource();
  const first: string[] = [];
  followBankStream(refused.stream(), 0, {
    up: () => first.push('up'),
    update: () => first.push('update'),
    down: final => first.push(final ? 'down-final' : 'down'),
  });
  refused.state.readyState = 2;
  refused.emit('error');
  refused.emit('error');
  assert.deepEqual(first, ['down-final']);

  // Never ready: a proxy that buffers event streams. It is closed after the wait.
  const silent = fakeSource();
  const second: string[] = [];
  followBankStream(silent.stream(20), 0, {
    up: () => second.push('up'),
    update: () => second.push('update'),
    down: final => second.push(final ? 'down-final' : 'down'),
  });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(second, ['down-final']);
  assert.equal(silent.state.closed, 1);
  silent.emit('ready');
  assert.deepEqual(second, ['down-final'], 'a late answer is ignored');
});
