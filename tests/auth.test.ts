import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { consentPageMessages } from '../apps/demo-bank/consent.messages.ts';
import { createHabitStore } from '../apps/habits-agent/store.ts';
import { mcpEndpoint } from '../apps/mcp-server/connect-page.ts';
import { createMcpServer } from '../apps/mcp-server/tools.ts';
import { accountMessages } from '../apps/server/account.messages.ts';
import { authMessages } from '../apps/server/auth.messages.ts';
import { bankMessages } from '../apps/server/bank.messages.ts';
import { consentMessages, scopeMessage } from '../apps/server/consent.messages.ts';
import { localizeRefusal, refusalMessages } from '../apps/server/errors.messages.ts';
import { accountPage, type BankSection, consentPage, euros } from '../apps/server/pages.ts';
import { type AuthError, createAccounts } from '../packages/auth/accounts.ts';
import { allScopes, type Scope, scopes } from '../packages/auth/oauth.ts';
import { hashPassword, verifyPassword } from '../packages/auth/passwords.ts';
import { csrfToken, verifyCsrf } from '../packages/auth/secrets.ts';
import { createThrottle } from '../packages/auth/throttle.ts';
import { defineBankProvider } from '../packages/banks/provider.ts';
import synthetic from '../packages/banks/providers/synthetic.ts';
import { createBankRegistry } from '../packages/banks/registry.ts';
import { accessConfig, envText, publicOriginConfig } from '../packages/config/env.ts';
import { remainingRows } from '../packages/db/auth.ts';
import { open } from '../packages/db/database.ts';
import { loadData } from '../packages/places/data.ts';
import {
  Browser,
  bearer,
  connectClient,
  everyScope,
  mcp,
  pkce,
  postForm,
  productionSite,
  registerClient,
  shapes,
  startApp,
  startProductionApp,
  type TestApp,
} from './support/app.ts';
import { consentBank } from './support/banks.ts';

const password = 'correct horse battery';

// ------------------------------------------------------------------ passwords

test('passwords are salted scrypt hashes verified in constant time', async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  assert.notEqual(first, second, 'each hash has its own salt');
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(`${password}!`, first), false);
  for (const broken of [
    '',
    'plain',
    'scrypt$1$8$1$abc$def',
    first.replace('scrypt', 'md5'),
    `${first.slice(0, -4)}AAAA`,
  ])
    assert.equal(await verifyPassword(password, broken), false, broken);
  assert(!first.includes(password));
});

// ------------------------------------------------------------------- accounts

test('sign-up creates one empty person with an unguessable id; sign-in checks the password', async () => {
  const db = open(':memory:');
  const accounts = createAccounts(db);
  const account = await accounts.signUp({ email: ' Ada@Example.com ', password, address: 'a' });
  assert.equal(account.email, 'ada@example.com');
  assert.match(account.userId, /^p-[0-9a-f]{30}$/);
  assert.notEqual(account.userId, 'user-001');
  // The person starts from an empty template, not from a fixture.
  const sections = db.all<{ section: string; document: string }>(
    'SELECT section, document FROM profile_sections WHERE user_id = ? ORDER BY section',
    account.userId,
  );
  assert.deepEqual(
    sections.map(row => [row.section, Object.keys(JSON.parse(row.document)).sort()]),
    [
      ['bank-account', ['schemaVersion', 'synthetic']],
      ['details', ['id', 'schemaVersion', 'synthetic']],
      ['preferences', ['schemaVersion', 'synthetic']],
    ],
  );
  assert.equal(accounts.ownerOf(account.userId), account.id);
  assert.equal(accounts.ownerOf('user-001'), undefined);
  const stored = db.get<{ password_hash: string }>('SELECT password_hash FROM accounts WHERE id = ?', account.id);
  assert(stored && !stored.password_hash.includes(password));

  await assert.rejects(accounts.signUp({ email: 'ada@example.com', password, address: 'a' }), { code: 'email_taken' });
  await assert.rejects(accounts.signUp({ email: 'not-an-email', password, address: 'a' }), { code: 'invalid_email' });
  await assert.rejects(accounts.signUp({ email: 'b@example.com', password: 'short', address: 'a' }), {
    code: 'weak_password',
  });
  await assert.rejects(accounts.login({ email: 'ada@example.com', password: 'wrong password', address: 'a' }), {
    code: 'invalid_credentials',
  });
  await assert.rejects(accounts.login({ email: 'nobody@example.com', password, address: 'a' }), {
    code: 'invalid_credentials',
  });
  const { session } = await accounts.login({ email: 'ADA@example.com', password, address: 'a' });
  assert.equal(accounts.session(session.id)?.account.id, account.id);
  // Only a hash of the session id is stored.
  assert.equal(db.get('SELECT 1 FROM auth_sessions WHERE id_hash = ?', session.id), undefined);
  accounts.logout(session.id);
  assert.equal(accounts.session(session.id), null);
  db.close();
});

/** The refusal a promise ends with; a promise that succeeds fails the test. */
const refused = (attempt: Promise<unknown>) =>
  attempt.then(
    () => assert.fail('expected a refusal'),
    error => error as AuthError,
  );

test('a stranger’s wrong passwords slow the stranger down and never lock the person out', async () => {
  const db = open(':memory:');
  let now = Date.parse('2026-11-22T10:00:00Z');
  const accounts = createAccounts(db, { now: () => new Date(now) });
  await accounts.signUp({ email: 'ada@example.com', password, address: 'signup' });
  const attempt = (secret: string, address: string) =>
    accounts.login({ email: 'ada@example.com', password: secret, address });
  const refusal = (secret: string, address: string) => refused(attempt(secret, address));

  // Five wrong passwords from one address are free; from the sixth on that address waits, longer each time.
  for (let n = 0; n < 5; n++) await assert.rejects(attempt('wrong', 'attacker'), { code: 'invalid_credentials' });
  await assert.rejects(attempt('wrong', 'attacker'), { code: 'invalid_credentials' });
  const first = await refusal('wrong', 'attacker');
  assert.deepEqual([first.code, first.retryAfterSeconds], ['throttled', 30]);
  // While it waits, not even the right password is looked at from that address: it is its own budget.
  assert.equal((await refusal(password, 'attacker')).code, 'throttled');
  const waits = [];
  for (let n = 0; n < 6; n++) {
    now += (await refusal('wrong', 'attacker')).retryAfterSeconds * 1000;
    await assert.rejects(attempt('wrong', 'attacker'), { code: 'invalid_credentials' });
    waits.push((await refusal('wrong', 'attacker')).retryAfterSeconds);
  }
  assert.deepEqual(waits, [60, 120, 240, 480, 900, 900], 'the wait doubles up to 15 minutes');

  // The reviewer's scenario: all of that happened, and the person signs in from their own address at once.
  const { session } = await attempt(password, 'home');
  assert(accounts.session(session.id));
  // The person's own typo costs them nothing but one of their own five tries.
  await assert.rejects(attempt('typo', 'home'), { code: 'invalid_credentials' });
  await attempt(password, 'home');
  // And they can delete the account: the sign-in counters play no part in an authenticated action.
  const account = accounts.session(session.id)!.account;
  assert(await accounts.deleteAccount(account.id, password, { sessionId: session.id }));
  assert.equal(accounts.account(account.id), null);
  db.close();
});

test('an address that guesses across accounts waits as an address; a careful account still checks a right password', async () => {
  const db = open(':memory:');
  let now = Date.parse('2026-11-22T10:00:00Z');
  const accounts = createAccounts(db, {
    now: () => new Date(now),
    throttle: { perAddress: 4, accountCeiling: 6 },
  });
  for (const name of ['ada', 'bob']) await accounts.signUp({ email: `${name}@example.com`, password, address: name });
  const attempt = (email: string, secret: string, address: string) =>
    accounts.login({ email, password: secret, address });
  const refusal = (email: string, secret: string, address: string) => refused(attempt(email, secret, address));

  // Credential stuffing: one address, one guess per account. After four failures the address waits.
  for (let n = 0; n < 5; n++)
    await assert.rejects(attempt(`guess${n}@example.com`, 'wrong', 'stuffer'), { code: 'invalid_credentials' });
  assert.equal((await refusal('bob@example.com', password, 'stuffer')).code, 'throttled');
  await attempt('bob@example.com', password, 'elsewhere');

  // Many addresses, one account: past the ceiling the account turns careful. It is not locked:
  // a right password from an address with no failures of its own still signs in...
  for (let n = 0; n < 7; n++)
    await assert.rejects(attempt('ada@example.com', 'wrong', `bot-${n}`), { code: 'invalid_credentials' });
  await attempt('ada@example.com', password, 'home');
  // ...but every address now gets one wrong try and then the longest wait.
  await assert.rejects(attempt('ada@example.com', 'wrong', 'bot-99'), { code: 'invalid_credentials' });
  const careful = await refusal('ada@example.com', 'wrong', 'bot-99');
  assert.deepEqual([careful.code, careful.retryAfterSeconds], ['throttled', 900]);
  // An hour later the account counts from zero again.
  now += 61 * 60_000;
  await assert.rejects(attempt('ada@example.com', 'wrong', 'bot-100'), { code: 'invalid_credentials' });
  await assert.rejects(attempt('ada@example.com', 'wrong', 'bot-100'), { code: 'invalid_credentials' });
  db.close();
});

test('an address that may be everybody is never locked as one client: per-account waits and a ceiling instead', async () => {
  const db = open(':memory:');
  let now = Date.parse('2026-11-22T10:00:00Z');
  const accounts = createAccounts(db, {
    now: () => new Date(now),
    throttle: {
      attempts: 2,
      perAddress: 3,
      sharedCeiling: 12,
      signUpsPerAddress: 2,
      signUpsShared: 5,
      signUpsGlobal: 9,
    },
  });
  const proxy = { address: '172.17.0.1', shared: true };
  await accounts.signUp({ email: 'ada@example.com', password, ...proxy });
  await accounts.signUp({ email: 'bob@example.com', password, ...proxy });
  const attempt = (email: string, secret: string) => accounts.login({ email, password: secret, ...proxy });
  const refusal = (email: string, secret: string) => refused(attempt(email, secret));

  // Far more failures than the per-address limit, through the proxy: nobody else is locked out.
  for (let n = 0; n < 8; n++)
    await assert.rejects(attempt(`guess${n}@example.com`, 'wrong'), { code: 'invalid_credentials' });
  await attempt('ada@example.com', password);
  await attempt('bob@example.com', password);
  // Guessing one account through the proxy is still slowed, for that account only.
  for (let n = 0; n < 3; n++)
    await assert.rejects(attempt('bob@example.com', 'wrong'), { code: 'invalid_credentials' });
  assert.deepEqual([(await refusal('bob@example.com', password)).retryAfterSeconds], [30]);
  await attempt('ada@example.com', password);
  // The ceiling for everybody behind the proxy: twelve failures in five minutes, then a pause that ends with the window.
  await assert.rejects(attempt('guess9@example.com', 'wrong'), { code: 'invalid_credentials' });
  const ceiling = await refusal('ada@example.com', password);
  assert.equal(ceiling.code, 'throttled');
  assert(ceiling.retryAfterSeconds > 0 && ceiling.retryAfterSeconds <= 300, String(ceiling.retryAfterSeconds));
  now += 5 * 60_000;
  await attempt('ada@example.com', password);

  // Sign-ups: a shared address gets the larger budget, a single address the smaller one.
  for (let n = 0; n < 3; n++) await accounts.signUp({ email: `new${n}@example.com`, password, ...proxy });
  const full = await refused(accounts.signUp({ email: 'late@example.com', password, ...proxy }));
  assert(full.code === 'throttled' && full.retryAfterSeconds <= 900);
  for (let n = 0; n < 2; n++) await accounts.signUp({ email: `one${n}@example.com`, password, address: '8.8.8.8' });
  await assert.rejects(accounts.signUp({ email: 'one2@example.com', password, address: '8.8.8.8' }), {
    code: 'throttled',
  });
  // Everybody together meets a ceiling too, so rotating addresses does not create accounts without bound.
  await accounts.signUp({ email: 'two0@example.com', password, address: '8.8.4.4' });
  await accounts.signUp({ email: 'two1@example.com', password, address: '9.9.9.9' });
  await assert.rejects(accounts.signUp({ email: 'two2@example.com', password, address: '1.1.1.1' }), {
    code: 'throttled',
  });
  now += 61 * 60_000;
  await accounts.signUp({ email: 'two2@example.com', password, address: '1.1.1.1' });
  db.close();
});

test('deleting an account is throttled per session, not by the sign-in counters', async () => {
  const db = open(':memory:');
  const now = Date.parse('2026-11-22T10:00:00Z');
  const accounts = createAccounts(db, { now: () => new Date(now) });
  const account = await accounts.signUp({ email: 'ada@example.com', password, address: 'home' });
  const mine = accounts.startSession(account.id);
  const stolen = accounts.startSession(account.id);
  // A stranger hammers the sign-in for this email from many addresses.
  for (let n = 0; n < 8; n++)
    await accounts.login({ email: 'ada@example.com', password: 'wrong', address: `bot-${n % 2}` }).catch(() => {});
  // Somebody with a session but not the password gets five tries, then waits: for that session only.
  const refusal = (sessionId: string, secret: string) =>
    refused(accounts.deleteAccount(account.id, secret, { sessionId }));
  for (let n = 0; n < 6; n++) assert.equal((await refusal(stolen.id, 'wrong')).code, 'invalid_credentials');
  const waiting = await refusal(stolen.id, password);
  assert.deepEqual([waiting.code, waiting.retryAfterSeconds], ['throttled', 30]);
  assert(accounts.account(account.id), 'nothing was deleted');
  // The person's own session is not affected by any of it.
  const calls: string[] = [];
  const outcome = await accounts.deleteAccount(account.id, password, {
    sessionId: mine.id,
    beforeDelete: userId => void calls.push(userId),
  });
  assert(outcome && outcome.removed.accounts === 1);
  assert.deepEqual(calls, [account.userId], 'the hook ran once, after the password was confirmed');
  // A wrong password never reaches the hook.
  const other = await accounts.signUp({ email: 'bob@example.com', password, address: 'home' });
  await assert.rejects(accounts.deleteAccount(other.id, 'wrong', { beforeDelete: () => assert.fail('must not run') }), {
    code: 'invalid_credentials',
  });
  db.close();
});

test('housekeeping removes what expired without anybody signing in, and the counter table is bounded', async () => {
  const db = open(':memory:');
  let now = Date.parse('2026-11-22T10:00:00Z');
  const accounts = createAccounts(db, { now: () => new Date(now), throttle: { maxRows: 300 } });
  const account = await accounts.signUp({ email: 'ada@example.com', password, address: 'home' });
  accounts.startSession(account.id);
  const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
  // Failed sign-ins for emails that do not exist leave counters behind; nobody ever signs in to clear them.
  for (let n = 0; n < 3; n++)
    await accounts.login({ email: `nobody${n}@example.com`, password: 'wrong', address: `ip-${n}` }).catch(() => {});
  assert(count('auth_throttle') >= 9);
  assert.equal(
    db.get("SELECT 1 FROM auth_throttle WHERE key LIKE '%example.com%'"),
    undefined,
    'counter keys hold a hash of the email, never the text somebody typed',
  );
  accounts.housekeeping();
  assert(count('auth_throttle') >= 9, 'fresh counters stay');
  now += 3 * 60 * 60_000;
  accounts.housekeeping();
  assert.equal(count('auth_throttle'), 0);
  assert.equal(count('auth_sessions'), 1);
  now += 31 * 24 * 60 * 60_000;
  accounts.housekeeping();
  assert.equal(count('auth_sessions'), 0, 'a session past its end is removed by the timer, not by the next sign-in');

  // A flood of distinct keys cannot grow the table without bound: the oldest rows go first.
  const throttle = createThrottle(db, () => new Date(now), 300);
  for (let n = 0; n < 2000; n++) {
    now += 10;
    throttle.spend(`flood:${n}`, 60_000);
  }
  assert(count('auth_throttle') <= 500, String(count('auth_throttle')));
  assert(db.get("SELECT 1 FROM auth_throttle WHERE key = 'flood:1999'"), 'the newest counters are the ones kept');
  db.close();
});

test('sessions end when idle too long and at their absolute limit; CSRF tokens are bound to the session', async () => {
  const db = open(':memory:');
  let now = Date.parse('2026-11-22T10:00:00Z');
  const hour = 3_600_000;
  const accounts = createAccounts(db, {
    now: () => new Date(now),
    sessionIdleMs: 2 * hour,
    sessionAbsoluteMs: 5 * hour,
  });
  const account = await accounts.signUp({ email: 'ada@example.com', password, address: 'a' });
  const idle = accounts.startSession(account.id);
  now += hour;
  assert(accounts.session(idle.id), 'used within the idle limit');
  now += hour + 60_000;
  assert(accounts.session(idle.id), 'the use an hour ago pushed the idle clock forward');
  now += 2 * hour + 1;
  assert.equal(accounts.session(idle.id), null, 'idle for more than two hours');

  const absolute = accounts.startSession(account.id);
  for (let n = 0; n < 4; n++) {
    now += hour;
    assert(accounts.session(absolute.id), `still valid after ${n + 1} h of use`);
  }
  now += hour + 1;
  assert.equal(accounts.session(absolute.id), null, 'past the absolute limit despite constant use');

  const first = accounts.startSession(account.id);
  const second = accounts.startSession(account.id);
  const token = accounts.session(first.id)?.csrf;
  assert.equal(token, csrfToken(first.id));
  assert.equal(verifyCsrf(first.id, token), true);
  assert.equal(verifyCsrf(second.id, token), false, 'a token of another session is refused');
  assert.equal(verifyCsrf(first.id, undefined), false);
  assert.equal(verifyCsrf(undefined, token), false);
  db.close();
});

test('deleting an account removes every row stored about its person, and needs the password', async () => {
  const db = open(':memory:');
  const accounts = createAccounts(db);
  const account = await accounts.signUp({ email: 'ada@example.com', password, address: 'a' });
  const other = await accounts.signUp({ email: 'bob@example.com', password, address: 'a' });
  const habits = createHabitStore(db);
  for (const id of [account.userId, other.userId]) {
    // One row in every table that can hold something about a person.
    db.run("INSERT INTO bank_ledgers (user_id, revision, updated_at) VALUES (?, 1, '2026-11-20T00:00:00Z')", id);
    db.run(
      "INSERT INTO bank_accounts (user_id, id, name, currency, opening_balance_cents, opening_date, synthetic) VALUES (?, 'main', 'Main', 'EUR', 0, '2026-01-01', 0)",
      id,
    );
    db.run(
      "INSERT INTO bank_transactions (user_id, id, account_id, date, description, amount_cents, currency, category, status, synthetic) VALUES (?, 't1', 'main', '2026-11-01', 'Salary', 250000, 'EUR', 'income', 'booked', 0)",
      id,
    );
    db.run(
      "INSERT INTO bank_events (user_id, sequence, occurred_at, type, account_count, transaction_count, synthetic) VALUES (?, 1, '2026-11-20T00:00:00Z', 'bank.updated', 1, 1, 0)",
      id,
    );
    db.run(
      "INSERT INTO bank_connections (user_id, id, provider_id, ref, created_at) VALUES (?, 'c1', 'demo-bank', ?, '2026-11-20T00:00:00Z')",
      id,
      `ref-${id}`,
    );
    db.run(
      "INSERT INTO bank_webhook_queue (provider_id, ref, received_at) VALUES ('demo-bank', ?, '2026-11-20T00:00:00Z')",
      `ref-${id}`,
    );
    await habits.saveGoal(id, {
      id: 'coffee',
      title: 'Coffee',
      action: 'Brew',
      category: 'food',
      targetDaysPerWeek: 3,
      active: true,
    });
    await habits.checkin(id, 'coffee', { id: 'c1', date: '2026-11-20', completed: true });
    db.run(
      "INSERT INTO input_records (user_id, id, source, observed_at, confirmed, synthetic, data) VALUES (?, 'i1', 'manual', '2026-11-20T00:00:00Z', 1, 1, '{}')",
      id,
    );
  }
  accounts.startSession(account.id);
  assert(remainingRows(db, account.id, account.userId) >= 14);
  await assert.rejects(accounts.deleteAccount(account.id, 'wrong password'), { code: 'invalid_credentials' });
  assert(accounts.account(account.id), 'a wrong password deletes nothing');
  const outcome = await accounts.deleteAccount(account.id, password);
  assert(outcome && outcome.removed.bank_transactions === 1 && outcome.removed.habit_checkins === 1);
  assert.equal(remainingRows(db, account.id, account.userId), 0);
  assert.deepEqual(
    db.all<{ ref: string }>('SELECT ref FROM bank_webhook_queue').map(row => row.ref),
    [`ref-${other.userId}`],
    'a queued bank notification of the deleted person is gone too',
  );
  // The other person is untouched.
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM habit_goals WHERE user_id = ?', other.userId)?.n, 1);
  assert(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bank_transactions WHERE user_id = ?', other.userId)!.n > 0);
  assert(accounts.account(other.id));
  db.close();
});

test('configuration: empty variables count as unset, and production closes the demo and the shared board', () => {
  assert.equal(envText('HOST', '127.0.0.1', { HOST: '' }), '127.0.0.1');
  assert.equal(envText('HOST', '127.0.0.1', { HOST: '  ' }), '127.0.0.1');
  assert.equal(envText('HOST', '127.0.0.1', { HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(publicOriginConfig({ PUBLIC_ORIGIN: '' }), null);
  assert.equal(publicOriginConfig({ PUBLIC_ORIGIN: 'https://www.relo.cat/path' }), 'https://www.relo.cat');
  const dev = accessConfig({});
  assert.deepEqual([dev.publicDemo, dev.sharedBoard], [true, true]);
  assert.deepEqual(dev.demoUserIds, ['user-001', 'user-002', 'user-003', 'user-004']);
  const production = accessConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://www.relo.cat' });
  assert.deepEqual([production.publicDemo, production.sharedBoard], [false, false]);
  assert.equal(accessConfig({ NODE_ENV: 'production', PUBLIC_DEMO: 'on' }).publicDemo, true);
  assert.equal(accessConfig({ PUBLIC_DEMO: 'off' }).publicDemo, false);
  assert.equal(accessConfig({ PUBLIC_ORIGIN: 'https://demo.example' }).sharedBoard, false);
});

test('get_data_sources returns only what a person needs', async () => {
  const { snapshot, policies } = loadData();
  const server = createMcpServer({
    snapshot,
    policies,
    dataStatus: () => [
      {
        id: 'idescat',
        title: 'Idescat',
        authority: 'Generalitat',
        status: 'failing',
        fetchedAt: null,
        error: 'GET https://internal.example/api?key=SECRET failed: ECONNREFUSED',
        homepage: 'https://internal.example',
        env: [{ name: 'IDESCAT_API_KEY', set: true }],
      },
    ],
  });
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (args: object) => Promise<{ structuredContent: unknown }> }>;
    }
  )._registeredTools;
  const result = await tools.get_data_sources.handler({});
  const text = JSON.stringify(result);
  assert.deepEqual((result.structuredContent as { sources: unknown[] }).sources, [
    { id: 'idescat', title: 'Idescat', authority: 'Generalitat', status: 'failing', fetchedAt: null },
  ]);
  assert(!/SECRET|IDESCAT_API_KEY|internal\.example|ECONNREFUSED/.test(text));
});

// ---------------------------------------------------------------- HTTP: pages

for (const shape of shapes)
  test(`sign-up, sign-in and sign-out over HTTP: cookies, CSRF and security headers [${shape.name}]`, async t => {
    const server = await shape.start();
    t.after(() => server.close());
    const browser = server.browser();

    const page = await browser.request('/signup');
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.doesNotMatch(await page.text(), /<script|onclick=|onsubmit=/i);

    // A form without the CSRF token, with a token of another visitor, or from another site is refused.
    const csrf = await browser.csrf('/signup');
    const form = { email: 'ada@example.com', password };
    assert.equal((await browser.request('/signup', { form })).status, 403);
    assert.equal((await server.browser().request('/signup', { form: { ...form, csrf } })).status, 403);
    const crossSite = await browser.request('/signup', {
      form: { ...form, csrf },
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(server.db.get('SELECT 1 FROM accounts'), undefined);

    const created = await browser.request('/signup', { form: { ...form, csrf } });
    assert.equal(created.status, 303);
    assert.equal(created.headers.get('location'), '/account');
    const cookie = created.headers.getSetCookie().find(value => value.startsWith(`${server.sessionCookie}=`));
    assert(cookie && /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie) && /Path=\//.test(cookie));
    // Plain HTTP on localhost cannot carry a Secure cookie; behind HTTPS it is Secure with the __Host- prefix.
    assert.equal(/; Secure/.test(cookie), server.secure);
    const firstSession = browser.cookies.get(server.sessionCookie);

    const account = await (await browser.request('/account')).text();
    assert.match(account, /ada@example\.com/);
    assert.match(account, /What is stored about you/);

    // GET /logout only asks; the POST with the session's token signs out.
    assert.equal((await browser.request('/logout')).status, 200);
    assert.equal((await browser.request('/account')).status, 200);
    assert.equal((await browser.request('/logout', { form: { csrf: 'wrong' } })).status, 403);
    const logoutCsrf = await browser.csrf('/logout');
    assert.equal((await browser.request('/logout', { form: { csrf: logoutCsrf } })).status, 303);
    assert.equal((await browser.request('/account')).status, 303);

    // Signing in issues a new session id; the old one stays dead.
    const wrong = await browser.login('ada@example.com', 'not the password');
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /email or the password is not right/);
    assert.equal((await browser.login('ada@example.com')).status, 303);
    assert.notEqual(browser.cookies.get(server.sessionCookie), firstSession);
    const stale = server.browser();
    stale.cookies.set(server.sessionCookie, firstSession ?? '');
    assert.equal((await stale.request('/account')).status, 303);

    // An open redirect through ?next is not possible.
    for (const next of ['https://evil.example', '//evil.example', '/\\evil.example', '/api/users']) {
      // Each from another address, so these sign-ins are not one visitor's burst.
      const fresh = server.browser(`203.0.113.${20 + next.length}`);
      const token = await fresh.csrf('/login');
      const response = await fresh.request('/login', {
        form: { csrf: token, email: 'ada@example.com', password, next },
      });
      assert.equal(response.headers.get('location'), '/account', next);
    }
  });

for (const shape of shapes)
  test(`the account page escapes what it prints, lists connected clients, revokes them and deletes everything [${shape.name}]`, async t => {
    const server = await shape.start();
    t.after(() => server.close());
    const browser = server.browser();
    await browser.signUp('ada@example.com');
    const { body: client } = await registerClient(server.origin, { client_name: '<img src=x onerror=alert(1)>' });
    assert.equal(typeof client.client_id, 'string');
    const { verifier: _verifier, challenge } = pkce();
    const params = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'person:read',
    };
    const consent = await browser.request(`/oauth/authorize?${new URLSearchParams(params)}`);
    const html = await consent.text();
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /client\.example/, 'the consent page names where the person is sent back to');
    assert.match(consent.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/client\.example/);

    const connected = await connectClient(browser);
    assert.equal(connected.status, 200);
    const page = await (await browser.request('/account')).text();
    assert.match(page, /Test client/);
    const grant = /name="grant" value="([^"]+)"/.exec(page)?.[1] ?? '';
    const csrf = await browser.csrf('/account');
    // Another signed-in person cannot remove this grant.
    const stranger = server.browser();
    await stranger.signUp('eve@example.com');
    await stranger.request('/account/disconnect', { form: { csrf: await stranger.csrf('/account'), grant } });
    assert.equal((await mcp(server.origin, 'get_person', {}, bearer(connected.tokens.access_token))).status, 200);
    assert.equal((await browser.request('/account/disconnect', { form: { csrf, grant } })).status, 303);
    assert.equal((await mcp(server.origin, 'get_person', {}, bearer(connected.tokens.access_token))).status, 401);
    assert.equal(
      (
        await postForm(server.origin, '/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: connected.tokens.refresh_token,
          client_id: connected.clientId,
        })
      ).status,
      400,
    );

    // Deleting needs the password and the confirmation; afterwards nothing is left and the cookie is dead.
    const again = await connectClient(browser);
    const refused = await browser.request('/account/delete', { form: { csrf, password: 'wrong', confirm: 'yes' } });
    assert.equal(refused.status, 400);
    const account = server.db.get<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM accounts WHERE email = 'ada@example.com'",
    )!;
    const deleted = await browser.request('/account/delete', { form: { csrf, password, confirm: 'yes' } });
    assert.equal(deleted.status, 200);
    assert.equal(remainingRows(server.db, account.id, account.user_id), 0);
    assert.equal((await browser.request('/account')).status, 303);
    assert.equal((await mcp(server.origin, 'get_person', {}, bearer(again.tokens.access_token))).status, 401);
    assert.equal(server.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')?.n, 1, 'the other account remains');
  });

// ---------------------------------------------------------------- HTTP: OAuth

for (const shape of shapes)
  test(`OAuth 2.1 for MCP: discovery, registration, PKCE, tokens, refresh rotation, reuse detection and revocation [${shape.name}]`, async t => {
    const server = await shape.start();
    t.after(() => server.close());
    // `origin` is where requests go; `site` is the origin the server issues tokens and links for.
    const { origin, site } = server;

    // 1. An anonymous call to a personal tool is a 401 that tells the client where to start.
    const challenge = await mcp(origin, 'get_person');
    assert.equal(challenge.status, 401);
    const header = challenge.headers.get('www-authenticate') ?? '';
    assert.match(header, new RegExp(`^Bearer resource_metadata="${site}/\\.well-known/oauth-protected-resource"`));
    assert.match(header, /scope="person:read person:write"/);
    assert.deepEqual(challenge.result?._meta?.['mcp/www_authenticate'], [header]);
    assert.equal(challenge.result?.isError, true);

    // 2. Discovery.
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const resource = (await (await fetch(origin + path)).json()) as Record<string, unknown>;
      assert.deepEqual(resource.authorization_servers, [site]);
      assert.equal(resource.resource, `${site}/mcp`);
    }
    const metadata = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(metadata.issuer, site);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.equal(metadata.registration_endpoint, `${site}/oauth/register`);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);

    // 3. Registration validates redirect URIs.
    for (const redirect of [
      'http://evil.example/cb',
      'javascript:alert(1)',
      'https://client.example/cb#fragment',
      'not a url',
    ])
      assert.equal((await registerClient(origin, { redirect_uris: [redirect] })).status, 400, redirect);
    assert.equal((await registerClient(origin, { redirect_uris: [] })).status, 400);
    assert.equal((await registerClient(origin, { redirect_uris: ['http://127.0.0.1:7777/callback'] })).status, 201);
    const confidential = await registerClient(origin, { token_endpoint_auth_method: 'client_secret_post' });
    assert.match(confidential.body.client_secret, /^rc_cs_/);
    assert.equal(
      server.db.get('SELECT 1 FROM oauth_clients WHERE secret_hash = ?', confidential.body.client_secret),
      undefined,
    );

    // 4. Authorization: not signed in → sign-in page first, with the request kept.
    const { body: client } = await registerClient(origin);
    const { verifier, challenge: codeChallenge } = pkce();
    const base = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      state: 'xyz',
      scope: 'person:read person:write',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      resource: `${site}/mcp`,
    };
    const authorizeUrl = (params: Record<string, string>) => `/oauth/authorize?${new URLSearchParams(params)}`;
    const browser = server.browser();
    const toLogin = await browser.request(authorizeUrl(base));
    assert.equal(toLogin.status, 302);
    const loginUrl = new URL(toLogin.headers.get('location') ?? '', origin);
    assert.equal(loginUrl.pathname, '/login');
    assert(loginUrl.searchParams.get('next')?.startsWith('/oauth/authorize?'));

    await browser.signUp('ada@example.com');
    const ada = server.db.get<{ user_id: string }>(
      "SELECT user_id FROM accounts WHERE email = 'ada@example.com'",
    )!.user_id;

    // A redirect URI that is not registered exactly is never redirected to.
    for (const redirect_uri of [
      'https://client.example/callback/',
      'https://client.example/other',
      'https://evil.example/callback',
    ]) {
      const response = await browser.request(authorizeUrl({ ...base, redirect_uri }));
      assert.equal(response.status, 400, redirect_uri);
      assert.equal(response.headers.get('location'), null);
    }
    assert.equal((await browser.request(authorizeUrl({ ...base, client_id: 'client-unknown' }))).status, 400);
    // PKCE is required and only S256 is accepted; the error goes back to the registered redirect URI with state and iss.
    const { code_challenge: _c, code_challenge_method: _m, ...withoutPkce } = base;
    for (const [params, pattern] of [
      [withoutPkce, /code_challenge is missing/],
      [{ ...base, code_challenge_method: 'plain' }, /must be S256/],
      [{ ...withoutPkce, code_challenge: codeChallenge }, /must be S256/],
      [{ ...base, response_type: 'token' }, /response_type=code/],
      [{ ...base, resource: 'https://other.example/mcp' }, /resource/],
      [{ ...base, scope: 'admin' }, /scopes/],
    ] as const) {
      const response = await browser.request(authorizeUrl(params as Record<string, string>));
      assert.equal(response.status, 302);
      const back = new URL(response.headers.get('location') ?? '');
      assert.equal(back.origin + back.pathname, 'https://client.example/callback');
      assert.match(back.searchParams.get('error_description') ?? '', pattern);
      assert.equal(back.searchParams.get('state'), 'xyz');
      assert.equal(back.searchParams.get('iss'), site);
      assert.equal(back.searchParams.get('code'), null);
    }

    // Consent: the decision needs the session's CSRF token.
    const consent = await browser.request(authorizeUrl(base));
    assert.equal(consent.status, 200);
    const consentHtml = await consent.text();
    assert.match(consentHtml, /Connect Test client\?/);
    assert.match(consentHtml, /Save answers and details to your profile/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(consentHtml)?.[1] ?? '';
    assert.equal(
      (await browser.request('/oauth/authorize', { form: { ...base, decision: 'allow', csrf: 'forged' } })).status,
      403,
    );
    const denied = await browser.request('/oauth/authorize', { form: { ...base, decision: 'deny', csrf } });
    assert.equal(new URL(denied.headers.get('location') ?? '').searchParams.get('error'), 'access_denied');
    const allowed = await browser.request('/oauth/authorize', { form: { ...base, decision: 'allow', csrf } });
    assert.equal(allowed.status, 303);
    const back = new URL(allowed.headers.get('location') ?? '');
    const code = back.searchParams.get('code') ?? '';
    assert.match(code, /^rc_ac_/);
    assert.equal(back.searchParams.get('state'), 'xyz');
    assert.equal(back.searchParams.get('iss'), site);

    // 5. Token: wrong verifier, wrong redirect URI and another client are refused; the code works once.
    const exchange = {
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: base.redirect_uri,
    };
    const badVerifier = await postForm(origin, '/oauth/token', { ...exchange, code_verifier: pkce().verifier });
    assert.deepEqual([badVerifier.status, badVerifier.body.error], [400, 'invalid_grant']);
    const noVerifier = await postForm(origin, '/oauth/token', exchange);
    assert.equal(noVerifier.status, 400);
    const badRedirect = await postForm(origin, '/oauth/token', {
      ...exchange,
      code_verifier: verifier,
      redirect_uri: 'https://client.example/other',
    });
    assert.equal(badRedirect.body.error, 'invalid_grant');
    const otherClient = (await registerClient(origin)).body.client_id;
    assert.equal(
      (await postForm(origin, '/oauth/token', { ...exchange, code_verifier: verifier, client_id: otherClient })).body
        .error,
      'invalid_grant',
    );
    const issued = await postForm(origin, '/oauth/token', {
      ...exchange,
      code_verifier: verifier,
      resource: `${site}/mcp`,
    });
    assert.equal(issued.status, 200);
    const tokens = issued.body;
    assert.match(tokens.access_token, /^rc_at_/);
    assert.match(tokens.refresh_token, /^rc_rt_/);
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.scope, 'person:read person:write');
    // Only hashes are stored.
    for (const secret of [tokens.access_token, tokens.refresh_token, code])
      assert.equal(server.db.get('SELECT 1 FROM oauth_tokens WHERE token_hash = ?', secret), undefined);

    // 6. The token reads and writes the caller's own person through /mcp.
    const me = await mcp(origin, 'get_person', {}, bearer(tokens.access_token));
    assert.equal(me.status, 200);
    assert.equal(me.result?.structuredContent?.id, ada);
    assert.equal(
      me.result?.structuredContent?.synthetic,
      false,
      'a person who belongs to an account is not labelled fictional',
    );
    const saved = await mcp(
      origin,
      'save_my_inputs',
      {
        data: { finance: { monthlyIncomeCents: 310_000, currentSavingsCents: 2_000_000 }, household: { size: 2 } },
        confirmed: true,
      },
      bearer(tokens.access_token),
    );
    assert.equal(saved.result?.structuredContent?.saved, true);
    const inputs = await mcp(origin, 'get_my_inputs', {}, bearer(tokens.access_token));
    const resolved = inputs.result?.structuredContent?.resolved as {
      data: { finance: { monthlyIncomeCents: number } };
    };
    assert.equal(resolved.data.finance.monthlyIncomeCents, 310_000);
    const after = await mcp(origin, 'get_person', {}, bearer(tokens.access_token));
    assert.equal(
      (after.result?.structuredContent?.finances as { monthlyIncomeCents: number } | undefined)?.monthlyIncomeCents,
      310_000,
    );
    assert.equal(after.result?.structuredContent?.householdSize, 2);
    const plan = await mcp(
      origin,
      'plan_home_savings',
      { me: true, municipalityCodes: ['251207'] },
      bearer(tokens.access_token),
    );
    assert.equal((plan.result?.structuredContent?.person as { id: string } | undefined)?.id, ada);
    // A refresh token is not an access token, and a made-up token is refused even for a public tool.
    assert.equal((await mcp(origin, 'get_person', {}, bearer(tokens.refresh_token))).status, 401);
    const madeUp = await mcp(origin, 'list_catalonia_municipalities', {}, bearer('rc_at_made_up'));
    assert.equal(madeUp.status, 401);
    assert.match(madeUp.headers.get('www-authenticate') ?? '', /error="invalid_token"/);

    // The authorization code cannot be replayed: the replay revokes what it issued.
    const replay = await postForm(origin, '/oauth/token', { ...exchange, code_verifier: verifier });
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal((await mcp(origin, 'get_person', {}, bearer(tokens.access_token))).status, 401);

    // 7. Refresh rotation and reuse detection on a fresh grant.
    const second = await connectClient(browser);
    const refresh = (refresh_token: string) =>
      postForm(origin, '/oauth/token', { grant_type: 'refresh_token', refresh_token, client_id: second.clientId });
    const rotated = await refresh(second.tokens.refresh_token);
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.refresh_token, second.tokens.refresh_token);
    assert.notEqual(rotated.body.access_token, second.tokens.access_token);
    assert.equal((await mcp(origin, 'get_person', {}, bearer(rotated.body.access_token))).status, 200);
    const wrongClient = await postForm(origin, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: rotated.body.refresh_token,
      client_id: otherClient,
    });
    assert.equal(wrongClient.body.error, 'invalid_grant');
    // The old refresh token is presented again: the whole family is revoked.
    const reuse = await refresh(second.tokens.refresh_token);
    assert.deepEqual([reuse.status, reuse.body.error], [400, 'invalid_grant']);
    assert.equal((await refresh(rotated.body.refresh_token)).body.error, 'invalid_grant');
    assert.equal((await mcp(origin, 'get_person', {}, bearer(rotated.body.access_token))).status, 401);

    // 8. Revocation.
    const third = await connectClient(browser);
    assert.equal((await mcp(origin, 'get_person', {}, bearer(third.tokens.access_token))).status, 200);
    const foreign = await postForm(origin, '/oauth/revoke', {
      token: third.tokens.access_token,
      client_id: otherClient,
    });
    assert.equal(foreign.status, 200);
    assert.equal(
      (await mcp(origin, 'get_person', {}, bearer(third.tokens.access_token))).status,
      200,
      'another client cannot revoke it',
    );
    assert.equal(
      (await postForm(origin, '/oauth/revoke', { token: third.tokens.refresh_token, client_id: third.clientId }))
        .status,
      200,
    );
    assert.equal((await mcp(origin, 'get_person', {}, bearer(third.tokens.access_token))).status, 401);
    assert.equal(
      (
        await postForm(origin, '/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: third.tokens.refresh_token,
          client_id: third.clientId,
        })
      ).status,
      400,
    );

    // A read-only grant cannot write.
    const readOnly = await connectClient(browser, 'person:read');
    assert.equal(readOnly.tokens.scope, 'person:read');
    const refusedWrite = await mcp(
      origin,
      'save_my_inputs',
      { data: { household: { size: 5 } }, confirmed: true },
      bearer(readOnly.tokens.access_token),
    );
    assert.equal(refusedWrite.status, 403);
    assert.match(refusedWrite.headers.get('www-authenticate') ?? '', /error="insufficient_scope"/);
    assert.equal(
      (await mcp(origin, 'get_person', {}, bearer(readOnly.tokens.access_token))).result?.structuredContent
        ?.householdSize,
      2,
    );

    // No token ever appears in a redirect or a page.
    assert.doesNotMatch(back.href + consentHtml, /rc_at_|rc_rt_/);
  });

test('an access token expires, and a token issued for another resource is refused', async t => {
  let now = Date.now();
  const server = await startApp({ oauth: { now: () => new Date(now), accessTokenTtlMs: 60_000 } });
  t.after(() => server.close());
  const browser = new Browser(server.origin);
  await browser.signUp('ada@example.com');
  const { tokens } = await connectClient(browser);
  assert.equal((await mcp(server.origin, 'get_person', {}, bearer(tokens.access_token))).status, 200);
  server.db.run("UPDATE oauth_grants SET resource = 'https://other.example/mcp'");
  assert.equal((await mcp(server.origin, 'get_person', {}, bearer(tokens.access_token))).status, 401);
  server.db.run('UPDATE oauth_grants SET resource = ?', `${server.origin}/mcp`);
  assert.equal((await mcp(server.origin, 'get_person', {}, bearer(tokens.access_token))).status, 200);
  now += 61_000;
  const expired = await mcp(server.origin, 'get_person', {}, bearer(tokens.access_token));
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
});

// ------------------------------------------------------- access-control matrix

const personalCalls: [string, Record<string, unknown>][] = [
  ['get_person', {}],
  ['get_my_inputs', {}],
  ['get_next_questions', { me: true, municipalityCodes: ['251207'] }],
  ['save_my_inputs', { data: { household: { size: 4 } }, confirmed: true }],
  ['save_my_habit', { id: 'cook-at-home', title: 'Cook at home', category: 'food', monthlySavingCents: 12_000 }],
  ['list_my_habits', {}],
  ['get_next_questions', { me: true }],
  ['plan_home_savings', { me: true }],
  ['get_bank_summary', { from: '2026-08-01', to: '2026-10-31' }],
  ['get_bank_updates', {}],
  ['get_bank_runtime', {}],
  ['plan_home_savings', { me: true, municipalityCodes: ['251207'] }],
  ['list_connectable_banks', {}],
  ['list_my_bank_connections', {}],
  ['get_my_bank_accounts', {}],
  ['list_my_statement_imports', {}],
  ['sync_my_bank', {}],
  ['preview_statement_import', { csv: 'date,description,amount\n2026-10-01,Salary,1000.00\n2026-10-02,Rent,-500.00' }],
];

test('access-control matrix: MCP tools', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin } = server;
  const a = new Browser(origin);
  const b = new Browser(origin);
  await a.signUp('a@example.com');
  await b.signUp('b@example.com');
  const idOf = (email: string) =>
    server.db.get<{ user_id: string }>('SELECT user_id FROM accounts WHERE email = ?', email)!.user_id;
  const [aId, bId] = [idOf('a@example.com'), idOf('b@example.com')];
  const tokenA = (await connectClient(a, everyScope)).tokens.access_token;
  const tokenB = (await connectClient(b, everyScope)).tokens.access_token;
  await mcp(
    origin,
    'save_my_inputs',
    { data: { finance: { monthlyIncomeCents: 111_100 } }, confirmed: true },
    bearer(tokenA),
  );
  await mcp(
    origin,
    'save_my_inputs',
    { data: { finance: { monthlyIncomeCents: 999_900 } }, confirmed: true },
    bearer(tokenB),
  );
  const serialized = (value: unknown) => JSON.stringify(value);

  for (const [name, args] of personalCalls) {
    // Anonymous: 401 with the challenge; nothing about anybody.
    const anonymous = await mcp(origin, name, args);
    assert.equal(anonymous.status, 401, `${name} anonymous`);
    assert.match(anonymous.headers.get('www-authenticate') ?? '', /resource_metadata=/, name);
    assert(!serialized(anonymous).includes(aId) && !serialized(anonymous).includes('111100'), name);

    // Account A: its own data only.
    const own = await mcp(origin, name, args, bearer(tokenA));
    assert.equal(own.status, 200, `${name} as A`);
    assert(!own.result?.isError, `${name} as A: ${serialized(own.result?.content)}`);
    assert(!serialized(own).includes(bId) && !serialized(own).includes('999900'), `${name} leaks B`);

    // Account A naming B (or a demo id) as userId: the argument does not exist, so the call is rejected.
    for (const userId of [bId, 'user-001']) {
      const cross = await mcp(origin, name, { ...args, userId }, bearer(tokenA));
      const text = serialized(cross);
      assert(cross.error || cross.result?.isError, `${name} accepted userId ${userId}`);
      assert(!text.includes('999900') && !text.includes('"householdSize"'), `${name} returned data for ${userId}`);
    }
  }
  // A's write never reached B, and each sees their own figure.
  const incomeOf = async (token: string) =>
    (
      (await mcp(origin, 'get_person', {}, bearer(token))).result?.structuredContent?.finances as
        | { monthlyIncomeCents: number }
        | undefined
    )?.monthlyIncomeCents;
  assert.deepEqual([await incomeOf(tokenA), await incomeOf(tokenB)], [111_100, 999_900]);
  // The habit A saved is A's alone: B lists none, and a connection without the write scope cannot save one.
  const habitsOf = async (token: string) =>
    ((await mcp(origin, 'list_my_habits', {}, bearer(token))).result?.structuredContent?.habits ?? []) as {
      id: string;
    }[];
  assert.deepEqual([(await habitsOf(tokenA)).map(habit => habit.id), await habitsOf(tokenB)], [['cook-at-home'], []]);
  const readOnlyA = (await connectClient(a, 'person:read')).tokens.access_token;
  const refusedHabit = await mcp(
    origin,
    'save_my_habit',
    { id: 'tea', title: 'Tea at home', category: 'food' },
    bearer(readOnlyA),
  );
  assert.equal(refusedHabit.status, 403);
  assert.match(refusedHabit.headers.get('www-authenticate') ?? '', /error="insufficient_scope"/);
  assert.deepEqual(
    (await habitsOf(tokenA)).map(habit => habit.id),
    ['cook-at-home'],
  );
  // A refusal also carries one sentence an assistant can say aloud about connecting the account.
  const refusal = await mcp(origin, 'save_my_habit', { id: 'tea', title: 'Tea at home', category: 'food' });
  assert.equal(refusal.status, 401);
  assert.match(refusal.result?.content?.[1]?.text ?? '', /connect your account first/);
  assert.match(serialized(refusal.result?._meta), /mcp\/www_authenticate/);
  assert.match(serialized(refusal.result?._meta), /connectar el teu compte/);
  assert.equal((await mcp(origin, 'get_person', {}, bearer(tokenB))).result?.structuredContent?.householdSize, null);

  // The session cookie of a same-origin page works like a token; from another origin it is not used.
  const sameOrigin = { Cookie: `rc_session=${a.cookies.get('rc_session')}`, Origin: origin };
  assert.equal((await mcp(origin, 'get_person', {}, sameOrigin)).result?.structuredContent?.id, aId);
  assert.equal(
    (await mcp(origin, 'get_person', {}, { Cookie: sameOrigin.Cookie })).status,
    401,
    'no Origin: not a page of this site',
  );
  assert.equal((await mcp(origin, 'get_person', {}, { ...sameOrigin, Origin: 'https://evil.example' })).status, 403);

  // Demo personas: readable without an account, fictional, and only from the allowlist.
  const demo = await mcp(origin, 'get_demo_person', { demoId: 'user-001' });
  assert.equal(demo.status, 200);
  assert.deepEqual([demo.result?.structuredContent?.id, demo.result?.structuredContent?.synthetic], ['user-001', true]);
  for (const name of ['get_demo_bank_updates', 'get_demo_bank_runtime'])
    assert(!(await mcp(origin, name, { demoId: 'user-002' })).result?.isError, name);
  assert(
    !(await mcp(origin, 'get_demo_bank_summary', { demoId: 'user-002', from: '2026-08-01', to: '2026-10-31' })).result
      ?.isError,
  );
  const demoPlan = await mcp(origin, 'plan_home_savings', { demoId: 'user-003', municipalityCodes: ['251207'] });
  assert.equal((demoPlan.result?.structuredContent?.person as { id: string } | undefined)?.id, 'user-003');
  for (const name of ['get_demo_person', 'get_demo_bank_updates', 'get_demo_bank_runtime']) {
    for (const demoId of [aId, bId, 'user-005']) {
      const escaped = await mcp(origin, name, { demoId }, bearer(tokenA));
      assert(escaped.error || escaped.result?.isError, `${name} accepted ${demoId}`);
      assert(!serialized(escaped).includes('111100') && !serialized(escaped).includes('999900'));
    }
  }
  const escapedPlan = await mcp(origin, 'plan_home_savings', { demoId: bId, municipalityCodes: ['251207'] });
  assert(escapedPlan.error || escapedPlan.result?.isError);
  assert(!serialized(escapedPlan).includes('999900'));
  // There is no demo tool that writes, and no tool lists people.
  const listed = (await (
    await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  ).json()) as {
    result: {
      tools: {
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
        _meta?: { securitySchemes?: { type: string }[] };
      }[];
    };
  };
  for (const tool of listed.result.tools) {
    assert(!('userId' in (tool.inputSchema.properties ?? {})), `${tool.name} takes a userId`);
    if (tool.name.includes('demo'))
      assert(!/save|write|delete|start|stop/.test(tool.name.replace('update_demo', '')), tool.name);
  }
  const security = Object.fromEntries(
    listed.result.tools.map(tool => [tool.name, tool._meta?.securitySchemes?.map(s => s.type)]),
  );
  assert.deepEqual(security.get_person, ['oauth2']);
  assert.deepEqual(security.plan_home_savings, ['noauth', 'oauth2']);
  assert.deepEqual(security.get_demo_person, ['noauth']);

  // Public tools stay anonymous, including an inline plan.
  assert.equal((await mcp(origin, 'list_catalonia_municipalities')).status, 200);
  const inline = (demo.result?.structuredContent ?? {}) as Record<string, unknown>;
  const inlinePlan = await mcp(origin, 'plan_home_savings', { person: inline, municipalityCodes: ['251207'] });
  assert(!inlinePlan.result?.isError, serialized(inlinePlan));
});

test('anonymous get_person on a demo id works only in public-demo mode and never reaches a real person', async t => {
  const refusedOrError = (reply: Awaited<ReturnType<typeof mcp>>) => Boolean(reply.error || reply.result?.isError);
  const on = await startApp();
  const browser = new Browser(on.origin);
  await browser.signUp('ada@example.com');
  const realId = on.db.get<{ user_id: string }>('SELECT user_id FROM accounts')!.user_id;
  // The old attack: get_person { userId: 'user-001' } without credentials.
  assert.equal((await mcp(on.origin, 'get_person', { userId: 'user-001' })).status, 401);
  assert.equal(
    (await mcp(on.origin, 'get_demo_person', { demoId: 'user-001' })).result?.structuredContent?.id,
    'user-001',
  );
  const real = await mcp(on.origin, 'get_demo_person', { demoId: realId });
  assert(refusedOrError(real), 'a real person is never a demo persona');
  assert(!JSON.stringify(real).includes('householdSize'));
  await on.close();

  // A narrower allowlist is respected.
  const narrow = await startApp({ accessEnv: { DEMO_USER_IDS: 'user-001' } });
  assert.equal(
    (await mcp(narrow.origin, 'get_demo_person', { demoId: 'user-001' })).result?.structuredContent?.id,
    'user-001',
  );
  assert(refusedOrError(await mcp(narrow.origin, 'get_demo_person', { demoId: 'user-002' })), 'outside the allowlist');
  await narrow.close();

  const off = await startApp({ accessEnv: { PUBLIC_DEMO: 'off' } });
  t.after(() => off.close());
  const refused = await mcp(off.origin, 'get_demo_person', { demoId: 'user-001' });
  assert(refusedOrError(refused), 'the demo tool does not exist when the demo is off');
  assert(!JSON.stringify(refused).includes('householdSize'));
  const offPlan = await mcp(off.origin, 'plan_home_savings', { demoId: 'user-001', municipalityCodes: ['251207'] });
  assert(refusedOrError(offPlan));
  const view = (await mcp(off.origin, 'open_demo', {})).result?.structuredContent as { connection: { mode: string } };
  assert.equal(view.connection.mode, 'scripted_demo', 'the board is purely scripted without the public demo');
});

test('a demo id that an account owns is never served as a demo persona', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const browser = new Browser(server.origin);
  await browser.signUp('ada@example.com');
  // Force the worst misconfiguration: an account owning a persona id.
  server.db.run("UPDATE accounts SET user_id = 'user-004'");
  const demo = await mcp(server.origin, 'get_demo_person', { demoId: 'user-004' });
  assert(demo.result?.isError, 'refused');
  assert(!JSON.stringify(demo).includes('householdSize'));
  assert.equal(
    (await mcp(server.origin, 'get_demo_person', { demoId: 'user-001' })).result?.structuredContent?.id,
    'user-001',
  );
});

test('access-control matrix: /api', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin } = server;
  const a = new Browser(origin);
  const b = new Browser(origin);
  await a.signUp('a@example.com');
  await b.signUp('b@example.com');
  const idOf = (email: string) =>
    server.db.get<{ user_id: string }>('SELECT user_id FROM accounts WHERE email = ?', email)!.user_id;
  const [aId, bId] = [idOf('a@example.com'), idOf('b@example.com')];
  const write = (await connectClient(a)).tokens.access_token;
  const readOnly = (await connectClient(a, 'person:read')).tokens.access_token;
  const admin = bearer('admin-test-token');
  const api = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) =>
    fetch(`${origin}/api${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const input = (id: string) => ({
    inputs: [
      {
        id,
        source: 'manual',
        observedAt: '2026-11-22T10:00:00Z',
        confirmed: true,
        synthetic: true,
        data: { household: { size: 2 } },
      },
    ],
  });
  const goal = {
    id: 'coffee',
    title: 'Coffee',
    action: 'Brew at home',
    category: 'food',
    targetDaysPerWeek: 3,
    active: true,
  };
  const reads = ['', '/context', '/inputs', '/bank/accounts', '/bank/events', '/bank/runtime', '/habits', '/details'];

  for (const id of [aId, bId, 'user-001']) {
    for (const path of reads) {
      // Anonymous and wrong tokens: 401, for existing and unknown ids alike.
      assert.equal((await api(`/users/${id}${path}`)).status, 401, `anonymous ${id}${path}`);
      assert.equal((await api(`/users/${id}${path}`, bearer('rc_at_wrong'))).status, 401);
      // The admin token reads everything.
      assert.equal((await api(`/users/${id}${path}`, admin)).status, 200, `admin ${id}${path}`);
      // Account A: own id 200, any other id 403.
      const expected = id === aId ? 200 : 403;
      assert.equal((await api(`/users/${id}${path}`, bearer(write))).status, expected, `A ${id}${path}`);
      assert.equal((await api(`/users/${id}${path}`, bearer(readOnly))).status, expected, `A read-only ${id}${path}`);
    }
  }
  // An unknown id answers exactly like somebody else's, so ids cannot be probed.
  assert.equal((await api('/users/p-000000000000000000000000000000/context', bearer(write))).status, 403);
  for (const path of ['/users', '/bank/providers', '/limits']) {
    assert.equal((await api(path, bearer(write))).status, 403, path);
    assert.equal((await api(path)).status, 401, path);
    assert.equal((await api(path, admin)).status, 200, path);
  }

  // Writes: own inputs and habits with the write scope; nothing else, and never another id.
  assert.equal((await api(`/users/${aId}/inputs`, bearer(write), 'POST', input('one'))).status, 200);
  assert.equal((await api(`/users/${aId}/inputs`, bearer(readOnly), 'POST', input('two'))).status, 403);
  assert.equal((await api(`/users/${bId}/inputs`, bearer(write), 'POST', input('three'))).status, 403);
  assert.equal((await api('/users/user-001/inputs', bearer(write), 'POST', input('four'))).status, 403);
  assert.equal((await api(`/users/${aId}/habits`, bearer(write), 'POST', goal)).status, 201);
  assert.equal((await api(`/users/${bId}/habits`, bearer(write), 'POST', goal)).status, 403);
  assert.equal((await api(`/users/${aId}/habits`, bearer(readOnly), 'POST', { ...goal, id: 'tea' })).status, 403);
  for (const [path, body] of [
    ['/bank/demo', {}],
    ['/bank/runtime', { enabled: true }],
    ['/bank/transactions', { transactions: [] }],
    ['/bank/connections', { providerId: 'synthetic', ref: 'x' }],
  ] as const)
    assert.equal((await api(`/users/${aId}${path}`, bearer(write), 'POST', body)).status, 403, path);
  assert.equal(
    (await api(`/users/${aId}/details`, bearer(write), 'PUT', { schemaVersion: 1, synthetic: true, id: aId })).status,
    403,
  );
  assert.equal((await api('/users', bearer(write), 'POST', {})).status, 403);
  // The paid suggestion source is the operator's.
  const summary = { months: 3, incomeCents: 1, expenseCents: 1, spendingByCategory: {} };
  const paid = await api(`/users/${aId}/habits/suggestions`, bearer(write), 'POST', { source: 'openai', summary });
  assert([400, 403].includes(paid.status));

  // Session cookie: reads work; a write needs the CSRF header and this origin.
  const cookie = { Cookie: `rc_session=${a.cookies.get('rc_session')}` };
  assert.equal((await api(`/users/${aId}/context`, cookie)).status, 200);
  assert.equal((await api(`/users/${bId}/context`, cookie)).status, 403);
  assert.equal((await api(`/users/${aId}/context`, { ...cookie, Origin: 'https://evil.example' })).status, 401);
  assert.equal((await api(`/users/${aId}/inputs`, { ...cookie, Origin: origin }, 'POST', input('five'))).status, 403);
  const csrf = await a.csrf('/account');
  assert.equal(
    (await api(`/users/${aId}/inputs`, { ...cookie, 'X-CSRF-Token': csrf }, 'POST', input('six'))).status,
    403,
  );
  assert.equal(
    (await api(`/users/${aId}/inputs`, { ...cookie, Origin: origin, 'X-CSRF-Token': csrf }, 'POST', input('seven')))
      .status,
    200,
  );

  const stored = (await (await api(`/users/${aId}/inputs`, admin)).json()) as { inputs: { id: string }[] };
  assert.deepEqual(
    stored.inputs.map(item => item.id),
    ['one', 'seven'],
  );
  for (const id of [bId, 'user-001'])
    assert.equal(
      ((await (await api(`/users/${id}/inputs`, admin)).json()) as { inputs: unknown[] }).inputs.length,
      0,
      id,
    );
  // The context of an account's person is not labelled fictional; a demo persona's is.
  assert.equal(((await (await api(`/users/${aId}/context`, admin)).json()) as { synthetic: boolean }).synthetic, false);
  assert.equal(
    ((await (await api('/users/user-001/context', admin)).json()) as { synthetic: boolean }).synthetic,
    true,
  );
  // Bank webhooks keep their provider-signature check: no token gets one through.
  const hook = await api('/webhooks/bank/demo-bank', bearer(write), 'POST', {});
  assert([401, 404, 503].includes(hook.status));
});

// ---------------------------------------------------------------- board attacks

/** Everything stored about the demo personas that the old attacks could change. */
function storedState(db: ReturnType<typeof open>) {
  return JSON.stringify({
    inputs: db.all('SELECT user_id, id, data FROM input_records ORDER BY row_id'),
    sections: db.all('SELECT user_id, section, document FROM profile_sections ORDER BY user_id, section'),
    ledgers: db.all('SELECT user_id, revision FROM bank_ledgers ORDER BY user_id'),
    movements: db.get('SELECT COUNT(*) AS n FROM bank_transactions'),
    connections: db.all('SELECT user_id, id, poll_interval_ms FROM bank_connections ORDER BY user_id, id'),
  });
}

const boardAction = (origin: string, name: string, args: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}/preview/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ name, args }),
  }).then(
    response =>
      response.json() as Promise<{
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content: { text: string }[];
      }>,
  );

test('replayed attacks: an anonymous board cannot change any stored person', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin, db } = server;
  const before = storedState(db);

  for (const call of [
    (name: string, args: unknown) => boardAction(origin, name, args),
    (name: string, args: unknown) => mcp(origin, name, args as Record<string, unknown>).then(r => r.result!),
  ]) {
    const opened = await call('open_demo', {});
    const runId = opened.structuredContent?.runId as string;
    const connection = opened.structuredContent?.connection as { mode: string; readOnly: boolean; userId: string };
    assert.deepEqual([connection.mode, connection.readOnly, connection.userId], ['public_demo', true, 'user-001']);
    assert(
      !('profileContext' in (opened.structuredContent ?? {})),
      'the resolved context is not dumped into the board',
    );

    // update_demo answer_batch used to append confirmed interview answers to user-001.
    const batch = await call('update_demo', {
      runId,
      action: 'answer_batch',
      answers: { town: 'Lleida', bedrooms: 3, household: 4, income: 5000, spending: 1000, savings: 90000 },
    });
    assert(!batch.isError, JSON.stringify(batch.content));
    assert.equal(
      (batch.structuredContent?.answers as { income: number } | undefined)?.income,
      5000,
      'kept in the run’s own state',
    );
    const single = await call('update_demo', { runId, action: 'answer', question: 'employment', answer: 'Nurse' });
    assert(!single.isError, JSON.stringify(single.content));
    // sample_bank used to seed a ledger; start/stop used to control the feed.
    assert(!(await call('update_demo', { runId, action: 'sample_bank' })).isError);
    for (const action of ['start_bank_runtime', 'stop_bank_runtime']) {
      const refused = await call('update_demo', { runId, action });
      assert(refused.isError, action);
      assert.match(refused.content?.[0].text ?? '', /read-only/);
    }
    for (const action of ['refresh_data', 'restart_all'])
      assert(!(await call('update_demo', { runId, action })).isError, action);
  }
  assert.equal(storedState(db), before, 'no stored person, ledger or feed changed');

  // /preview/state: same-origin only, and nothing but the board view.
  const opened = await boardAction(origin, 'open_demo', { newRun: true });
  const state = await fetch(`${origin}/preview/state?run=${opened.structuredContent?.runId}`);
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('access-control-allow-origin'), null);
  const text = await state.text();
  assert(!text.includes('admin-test-token') && !text.includes('"transactions":') && !text.includes('profileContext'));
});

test('replayed attacks: a stranger cannot reset, read or evict another visitor’s board run', async t => {
  // The configuration of a public origin: no shared board.
  const server = await startApp({ accessEnv: { SHARED_BOARD: 'off' } });
  t.after(() => server.close());
  const { origin } = server;
  const visitor = { 'X-Forwarded-For': '203.0.113.10' };
  const stranger = { 'X-Forwarded-For': '198.51.100.20' };

  const mine = await boardAction(origin, 'open_demo', {}, visitor);
  const runId = mine.structuredContent?.runId as string;
  assert.equal(mine.structuredContent?.sharedBoard, false);
  await boardAction(origin, 'update_demo', { runId, action: 'answer', question: 'household', answer: 3 }, visitor);

  // The stranger gets a run of their own, and nothing tells them the visitor's id.
  const theirs = await boardAction(origin, 'open_demo', {}, stranger);
  assert.notEqual(theirs.structuredContent?.runId, runId);
  assert.equal(
    (await fetch(`${origin}/preview/state`, { headers: stranger })).status,
    400,
    'no shared board to fall back to',
  );
  assert.equal((await fetch(`${origin}/preview/state?run=${crypto.randomUUID()}`, { headers: stranger })).status, 404);
  // Restarting "everything" restarts only the stranger's own run.
  await boardAction(origin, 'update_demo', { runId: theirs.structuredContent?.runId, action: 'restart_all' }, stranger);
  const guess = await boardAction(
    origin,
    'update_demo',
    { runId: crypto.randomUUID(), action: 'restart_all' },
    stranger,
  );
  assert(guess.isError);
  const still = (await (await fetch(`${origin}/preview/state?run=${runId}`, { headers: visitor })).json()) as {
    answers: { household: number };
    revision: number;
  };
  assert.equal(still.answers.household, 3);

  // Opening boards without end is cut off per address, long before the store could push the visitor's run out.
  let refused = 0;
  for (let n = 0; n < 60; n++)
    if ((await boardAction(origin, 'open_demo', { newRun: true }, stranger)).isError) refused++;
  assert(refused >= 25, `only ${refused} of 60 new runs were refused`);
  assert.equal((await fetch(`${origin}/preview/state?run=${runId}`, { headers: visitor })).status, 200);
  // The visitor is not affected by the stranger's limit, and joining an existing run is never limited.
  assert(!(await boardAction(origin, 'open_demo', { runId }, stranger)).isError);
  assert(!(await boardAction(origin, 'open_demo', { newRun: true }, visitor)).isError);
});

// -------------------------------------------------------------- server hardening

/** A raw request, because `fetch` does not let a test choose the Host header. */
function rawGet(port: number, path: string, host: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers: { Host: host } }, response => {
      let body = '';
      response.on('data', chunk => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('a forged Host is refused; the public origin and configured hosts are served', async t => {
  const server = await startApp({
    publicOrigin: 'https://www.relo.cat',
    accessEnv: { ALLOWED_HOSTS: 'tunnel.example' },
  });
  t.after(() => server.close());
  for (const host of [
    'evil.example',
    `evil.example:${server.port}`,
    'www.relo.cat.evil.example',
    '127.0.0.1:1',
    'localhost',
  ])
    for (const path of ['/health', '/mcp', '/preview', '/api/users', '/login'])
      assert.equal((await rawGet(server.port, path, host)).status, 421, `${host}${path}`);
  for (const host of [
    `127.0.0.1:${server.port}`,
    `localhost:${server.port}`,
    'www.relo.cat',
    'WWW.RELO.CAT',
    'tunnel.example',
  ])
    assert.equal((await rawGet(server.port, '/health', host)).status, 200, host);
  // Links are built from the configured origin, never from the Host header.
  const metadata = JSON.parse(
    (await rawGet(server.port, '/.well-known/oauth-authorization-server', 'tunnel.example')).body,
  );
  assert.equal(metadata.issuer, 'https://www.relo.cat');
});

test('bank webhooks are rate limited before their signature is checked, on their own budget', async t => {
  const server = await startApp({ rateLimit: { perMinute: 1000, webhooksPerMinute: 5 } });
  t.after(() => server.close());
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.99' };
  const statuses: number[] = [];
  for (let n = 0; n < 8; n++)
    statuses.push(
      (await fetch(`${server.origin}/api/webhooks/bank/demo-bank`, { method: 'POST', headers, body: '{}' })).status,
    );
  assert(
    statuses.slice(0, 5).every(status => status !== 429),
    statuses.join(),
  );
  assert.deepEqual(statuses.slice(5), [429, 429, 429]);
  // Ordinary requests from the same address still have their own allowance.
  assert.equal((await fetch(`${server.origin}/health`, { headers })).status, 200);
  assert.equal((await fetch(`${server.origin}/connect`, { headers })).status, 200);
});

// ------------------------------------------- availability, in the deployed shape
//
// The scenarios a second review ran against a production-shaped server. Each test states what the
// stranger does and asserts that the people who did nothing wrong are not affected.

const accountOf = (server: { db: TestApp['db'] }, email: string) =>
  server.db.get<{ id: string; userId: string }>('SELECT id, user_id AS userId FROM accounts WHERE email = ?', email)!;

test('scenario 1: wrong passwords from a stranger do not lock the person out of signing in or of deleting', async t => {
  const server = await startProductionApp();
  t.after(() => server.close());
  const victim = server.browser('203.0.113.5');
  await victim.signUp('ada@example.com');
  // The stranger sends more wrong passwords than any limit allows, from an address of their own.
  const stranger = server.browser('198.51.100.66');
  const statuses: number[] = [];
  for (let n = 0; n < 9; n++) statuses.push((await stranger.login('ada@example.com', `guess number ${n}`)).status);
  assert.deepEqual(statuses.slice(0, 6), [400, 400, 400, 400, 400, 400]);
  assert.deepEqual(statuses.slice(6), [429, 429, 429], 'the stranger, and only the stranger, is made to wait');
  const waiting = await stranger.login('ada@example.com', 'another guess');
  const retryAfter = Number(waiting.headers.get('retry-after'));
  assert(retryAfter > 20 && retryAfter <= 30, `the first wait is 30 seconds, got ${retryAfter}`);
  // The person, signed in already, deletes a connection and signs in again elsewhere: nothing is locked.
  assert.equal((await victim.request('/account')).status, 200);
  const elsewhere = server.browser('203.0.113.6');
  assert.equal((await elsewhere.login('ada@example.com')).status, 303);
  // And the account can be deleted, with the password, while the stranger keeps trying.
  await stranger.login('ada@example.com', 'still guessing');
  const csrf = await victim.csrf('/account');
  const deleted = await victim.request('/account/delete', { form: { csrf, password, confirm: 'yes' } });
  assert.equal(deleted.status, 200);
  assert.equal(server.db.get('SELECT 1 FROM accounts'), undefined);
  assert.deepEqual(server.warnings, [], 'every request carried a client address');
});

test('scenario 1b: wrong passwords on the delete form are counted for that session only', async t => {
  const server = await startProductionApp();
  t.after(() => server.close());
  const browser = server.browser('203.0.113.5');
  await browser.signUp('ada@example.com');
  const second = server.browser('203.0.113.7');
  await second.login('ada@example.com');
  const csrf = await browser.csrf('/account');
  const statuses: number[] = [];
  for (let n = 0; n < 7; n++)
    statuses.push(
      (await browser.request('/account/delete', { form: { csrf, password: 'not it', confirm: 'yes' } })).status,
    );
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 400, 429]);
  // The other session of the same person is not affected, and signing in is not either.
  assert.equal((await server.browser('203.0.113.8').login('ada@example.com')).status, 303);
  const deleted = await second.request('/account/delete', {
    form: { csrf: await second.csrf('/account'), password, confirm: 'yes' },
  });
  assert.equal(deleted.status, 200);
});

for (const proxy of ['no-address', 'nginx-default'] as const)
  test(`scenario 2: behind a proxy that states no client address (${proxy}), one stranger cannot close sign-in and sign-up for everybody`, async t => {
    // nginx's default rewrites Host as well, so the server is reached under its local name: forms are
    // exercised straight on that name here, and the Host problem has a test of its own below.
    const server = await startProductionApp({ proxy });
    t.after(() => server.close());
    const visitor = (address: string) =>
      proxy === 'nginx-default' ? new Browser(server.origin, server.direct, address) : server.browser(address);
    const existing = visitor('203.0.113.5');
    assert.equal((await existing.signUp('ada@example.com')).status, 303);
    // What locked everybody out for 15 minutes before: 20 failed sign-ins and 10 sign-ups from "one address".
    const stranger = visitor('198.51.100.66');
    for (let n = 0; n < 24; n++)
      assert.equal((await stranger.login(`nobody${n}@example.com`, 'wrong password')).status, 400, `attempt ${n}`);
    for (let n = 0; n < 12; n++) {
      const fresh = visitor('198.51.100.66');
      assert.equal((await fresh.signUp(`throwaway${n}@example.com`)).status, 303, `sign-up ${n}`);
    }
    // Everybody else still signs in and signs up.
    assert.equal((await visitor('203.0.113.9').login('ada@example.com')).status, 303);
    assert.equal((await visitor('203.0.113.10').signUp('bob@example.com')).status, 303);
    // The operator is told, in the log and in /health, that visitors cannot be told apart.
    assert.match(server.warnings[0] ?? '', /WARNING: \d+ request\(s\) arrived without a usable client address/);
    assert.match(server.warnings[0] ?? '', /x-forwarded-for/);
    const health = (await (await fetch(`${server.direct}/health`)).json()) as {
      clientAddress: { ok: boolean; mode: string; undeterminedRequests: number };
    };
    assert.equal(health.clientAddress.ok, false);
    assert(health.clientAddress.undeterminedRequests > 50);
  });

test('scenario 2b: with the address forwarded, /health reports the client address as determined', async t => {
  const server = await startProductionApp();
  t.after(() => server.close());
  await server.browser('203.0.113.5').signUp('ada@example.com');
  const health = (await (await fetch(`${server.origin}/health`)).json()) as Record<string, unknown>;
  assert.deepEqual(health.clientAddress, {
    mode: 'x-forwarded-for (1 trusted hop(s))',
    ok: true,
    undeterminedRequests: 0,
    lastUndeterminedAt: null,
  });
  // /health says which schema the database has, never where it is.
  assert.deepEqual(Object.keys(health).sort(), ['clientAddress', 'publicDemo', 'status']);
  assert.doesNotMatch(JSON.stringify(health), /\.db|memory|path/i);
});

test('scenario 3: a proxy on this machine that adds no forwarding header does not switch rate limiting off', async t => {
  for (const proxy of ['no-address', 'nginx-default'] as const) {
    const server = await startProductionApp({ proxy, rateLimit: { perMinute: 20 } });
    const statuses: number[] = [];
    for (let n = 0; n < 30; n++) statuses.push((await fetch(`${server.origin}/connect`)).status);
    await server.close();
    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200), proxy);
    assert.deepEqual(statuses.slice(20), Array(10).fill(429), `${proxy}: the 21st request is refused`);
  }
  // The same on a laptop: a request from this machine is counted like any other.
  const local = await startApp({ rateLimit: { perMinute: 5 } });
  t.after(() => local.close());
  const statuses: number[] = [];
  for (let n = 0; n < 8; n++) statuses.push((await fetch(`${local.origin}/connect`)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
  // Only the operator's own calls with the admin token are not counted; a wrong token is.
  for (let n = 0; n < 8; n++)
    assert.equal((await fetch(`${local.origin}/api/users`, { headers: bearer('admin-test-token') })).status, 200);
  assert.equal((await fetch(`${local.origin}/api/users`, { headers: bearer('admin-test-tokem') })).status, 429);
  // With the address forwarded, one noisy visitor does not use up another's allowance.
  const forwarded = await startProductionApp({ rateLimit: { perMinute: 5 } });
  t.after(() => forwarded.close());
  const noisy = forwarded.browser('198.51.100.66');
  const quiet = forwarded.browser('203.0.113.5');
  for (let n = 0; n < 8; n++) await noisy.request('/connect');
  assert.equal((await noisy.request('/connect')).status, 429);
  assert.equal((await quiet.request('/connect')).status, 200);
  // A visitor cannot pick their own address: what they write in X-Forwarded-For lands left of the proxy's entry.
  const forged = await noisy.request('/connect', { headers: { 'X-Forwarded-For': '203.0.113.200' } });
  assert.equal(forged.status, 429);
});

test('a proxy that replaces Host is told apart from a cross-site form, and the page says what to fix', async t => {
  const server = await startProductionApp({ proxy: 'nginx-default' });
  t.after(() => server.close());
  // The browser is on the public site; the proxy handed the request over under the upstream's name.
  const browser = server.browser('203.0.113.5');
  const csrf = await browser.csrf('/signup');
  const refused = await browser.request('/signup', { form: { csrf, email: 'ada@example.com', password } });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /proxy that does not pass the original Host header/);
  // A form from somewhere else gets the ordinary answer.
  const foreign = await browser.request('/signup', {
    form: { csrf, email: 'ada@example.com', password },
    headers: { Origin: 'https://evil.example' },
  });
  assert.match(await foreign.text(), /sent from another site/);
  assert.equal(server.db.get('SELECT 1 FROM accounts'), undefined);
});

test('scenario 4: the connect page offers the MCP address this server answers on', async t => {
  const production = await startProductionApp();
  t.after(() => production.close());
  const endpointOf = async (origin: string) =>
    /<input id="endpoint" type="url" value="([^"]*)"/.exec(await (await fetch(`${origin}/connect`)).text())?.[1];
  const offered = await endpointOf(production.origin);
  assert.equal(offered, `${productionSite}/mcp`);
  // The address offered is one the server accepts, and its OAuth metadata names the same resource.
  const metadata = (await (await fetch(`${production.origin}/.well-known/oauth-protected-resource`)).json()) as {
    resource: string;
  };
  assert.equal(metadata.resource, offered);
  // Locally the page offers the address it was opened on.
  const local = await startApp();
  t.after(() => local.close());
  assert.equal(await endpointOf(local.origin), `${local.origin}/mcp`);
  assert.match(
    (await rawGet(local.port, '/connect', `localhost:${local.port}`)).body,
    new RegExp(`<input id="endpoint" type="url" value="http://localhost:${local.port}/mcp"`),
  );
  // A Host that is not this machine is never echoed into the page.
  assert.equal(mcpEndpoint('evil.example', null), 'https://www.relo.cat/mcp');
  assert.equal(mcpEndpoint('127.0.0.1:8787.evil.example', null), 'https://www.relo.cat/mcp');
  assert.equal(mcpEndpoint('[::1]:8787', null), 'http://[::1]:8787/mcp');
  assert.equal(mcpEndpoint('evil.example', 'https://www.relo.cat'), 'https://www.relo.cat/mcp');
  // The page describes OAuth sign-in and no longer tells operators to add authentication themselves.
  const html = await (await fetch(`${local.origin}/connect`)).text();
  assert.doesNotMatch(html, /Add authentication and access controls|relo\.cat\/mcp"|settings supplied by the operator/);
  assert.match(html, /sign in with OAuth/);
});

/** A fictional bank with webhooks, to see what the sync engine keeps after a person is deleted. */
function webhookBank() {
  const secret = 'webhook-bank-secret';
  const calls = { fetches: 0 };
  const provider = defineBankProvider({
    id: 'hook-bank',
    displayName: 'Hook Bank',
    synthetic: true,
    env: [{ name: 'BANK_HOOK_BANK_WEBHOOK_SECRET', description: 'Fictional signing secret.' }],
    async listAccounts() {
      return [
        { id: 'hook-main', name: 'Main', currency: 'EUR' as const, openingBalanceCents: 0, openingDate: '2026-11-01' },
      ];
    },
    async fetchTransactions() {
      calls.fetches++;
      return { transactions: [] };
    },
    verifyWebhook: ({ headers }) => headers['x-hook-secret'] === secret,
    parseWebhook(rawBody) {
      const body = JSON.parse(rawBody) as { link?: unknown };
      return typeof body.link === 'string' ? { connectionRef: body.link, hint: 'movement' } : null;
    },
  });
  return { calls, secret, registry: createBankRegistry([provider], { BANK_HOOK_BANK_WEBHOOK_SECRET: secret }) };
}

test('scenario 5: deleting an account takes its bank connection out of the running engine', async t => {
  const bank = webhookBank();
  const server = await startProductionApp({
    profileApi: { bankRegistry: bank.registry, bankSync: { housekeepingMs: null } },
  });
  t.after(() => server.close());
  const admin = { ...bearer('admin-test-token'), 'Content-Type': 'application/json' };
  const link = (userId: string) =>
    fetch(`${server.origin}/api/users/${userId}/bank/connections`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ providerId: 'hook-bank', ref: 'link-ada' }),
    });
  const notify = () =>
    fetch(`${server.origin}/api/webhooks/bank/hook-bank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hook-secret': bank.secret },
      body: JSON.stringify({ link: 'link-ada' }),
    });
  const engine = server.app.profiles.bankSync;
  const queued = () => server.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bank_webhook_queue')!.n;

  const ada = server.browser('203.0.113.5');
  await ada.signUp('ada@example.com');
  const { userId } = accountOf(server, 'ada@example.com');
  assert.equal((await link(userId)).status, 201);
  assert.equal((await notify()).status, 202);
  await engine.idle();
  assert.equal(bank.calls.fetches, 1, 'the notification was synced');

  // While Ada has the connection nobody else can link the same bank reference.
  const bob = server.browser('203.0.113.6');
  await bob.signUp('bob@example.com');
  const bobId = accountOf(server, 'bob@example.com').userId;
  assert.equal((await link(bobId)).status, 409);

  const csrf = await ada.csrf('/account');
  assert.equal((await ada.request('/account/delete', { form: { csrf, password, confirm: 'yes' } })).status, 200);
  // The bank keeps notifying: nothing is queued, nothing is fetched, and nothing is written back.
  assert.equal((await notify()).status, 202, 'the answer does not reveal that the reference is gone');
  await engine.idle();
  await engine.runDue();
  assert.equal(queued(), 0);
  assert.equal(bank.calls.fetches, 1);
  assert.equal(server.db.get('SELECT 1 FROM bank_connections WHERE user_id = ?', userId), undefined);
  // The reference is free again without a restart.
  assert.equal((await link(bobId)).status, 201);
  assert.equal((await notify()).status, 202);
  await engine.idle();
  assert.equal(bank.calls.fetches, 2, 'the reference now feeds its new owner');

  // The engine also copes with rows that vanished without it being told (another process, a restore).
  server.db.run('DELETE FROM bank_connections WHERE user_id = ?', bobId);
  assert.deepEqual(await engine.acceptWebhook('hook-bank', { connectionRef: 'link-ada' }), {
    known: false,
    duplicate: false,
  });
  assert.equal(queued(), 0);
  const carol = server.browser('203.0.113.7');
  await carol.signUp('carol@example.com');
  assert.equal((await link(accountOf(server, 'carol@example.com').userId)).status, 201);
});

test('event streams: a cap per person, and they close on sign-out, revocation and deletion', async t => {
  const server = await startProductionApp();
  t.after(() => server.close());
  const browser = server.browser('203.0.113.5');
  await browser.signUp('ada@example.com');
  const { userId } = accountOf(server, 'ada@example.com');
  const path = `/api/users/${userId}/bank/events/stream`;
  const open = () => server.app.profiles.openStreams();
  /** Resolves when the server ends the stream. */
  const ended = async (response: Response) => {
    const reader = response.body!.getReader();
    while (!(await reader.read()).done);
  };
  const settle = async (count: number) => {
    for (let n = 0; n < 100 && open() !== count; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(open(), count);
  };

  // Five streams for one person; the sixth is refused, and another person still gets theirs.
  const streams = [];
  for (let n = 0; n < 5; n++) streams.push(await browser.request(path));
  assert.deepEqual(
    streams.map(stream => stream.status),
    [200, 200, 200, 200, 200],
  );
  const sixth = await browser.request(path);
  assert.equal(sixth.status, 429);
  const other = server.browser('203.0.113.6');
  await other.signUp('bob@example.com');
  const otherStream = await other.request(
    `/api/users/${accountOf(server, 'bob@example.com').userId}/bank/events/stream`,
  );
  assert.equal(otherStream.status, 200);
  await settle(6);

  // Signing out ends that person's streams; the other person's stays open.
  const csrf = await browser.csrf('/logout');
  assert.equal((await browser.request('/logout', { form: { csrf } })).status, 303);
  await Promise.all(streams.map(ended));
  await settle(1);

  // A stream opened with an access token ends when the grant is revoked.
  await browser.login('ada@example.com');
  const connected = await connectClient(browser);
  const byToken = await fetch(`${server.origin}${path}`, { headers: bearer(connected.tokens.access_token) });
  assert.equal(byToken.status, 200);
  await settle(2);
  await postForm(server.origin, '/oauth/revoke', {
    token: connected.tokens.access_token,
    client_id: connected.clientId,
  });
  await ended(byToken);
  await settle(1);
  assert.equal(
    (await fetch(`${server.origin}${path}`, { headers: bearer(connected.tokens.access_token) })).status,
    401,
  );

  // Deleting the account ends its streams too.
  const last = await browser.request(path);
  assert.equal(last.status, 200);
  const deleteCsrf = await browser.csrf('/account');
  await browser.request('/account/delete', { form: { csrf: deleteCsrf, password, confirm: 'yes' } });
  await ended(last);
  await settle(1);
});

test('client registration: a budget per address and for everybody, room made from unused registrations', async t => {
  let now = Date.parse('2026-11-22T10:00:00Z');
  const server = await startProductionApp({
    housekeepingMs: null,
    oauth: { now: () => new Date(now), maxClients: 4, registrations: { perAddress: 3, global: 7 } },
  });
  t.after(() => server.close());
  const register = (address: string) => registerClient(server.origin, {}, address);
  const count = (table: string) => server.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;

  // One address: three registrations an hour, then 429 with the time to wait.
  for (let n = 0; n < 3; n++) assert.equal((await register('198.51.100.66')).status, 201);
  const refused = await fetch(`${server.origin}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-client': '198.51.100.66' },
    body: JSON.stringify({ redirect_uris: ['https://client.example/callback'] }),
  });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '3600');
  assert.equal(((await refused.json()) as { error: string }).error, 'temporarily_unavailable');
  // Another address is not affected, and a client that somebody actually uses is never evicted.
  const browser = server.browser('203.0.113.5');
  await browser.signUp('ada@example.com');
  const used = await connectClient(browser);
  assert.equal(count('oauth_clients'), 4);
  // The table is full: a new registration pushes out the oldest one nobody authorised, not the used one.
  const oldest = server.db.get<{ id: string }>('SELECT id FROM oauth_clients ORDER BY created_at, rowid LIMIT 1')!.id;
  now += 1000;
  assert.equal((await register('203.0.113.9')).status, 201);
  assert.equal(count('oauth_clients'), 4);
  assert.equal(server.db.get('SELECT 1 FROM oauth_clients WHERE id = ?', oldest), undefined);
  assert(server.db.get('SELECT 1 FROM oauth_clients WHERE id = ?', used.clientId));
  // Everybody together: seven an hour. Rotating addresses meets that ceiling.
  assert.equal((await register('203.0.113.10')).status, 201);
  assert.equal((await register('203.0.113.11')).status, 201);
  assert.equal((await register('203.0.113.12')).status, 429);
  now += 61 * 60_000;
  assert.equal((await register('203.0.113.12')).status, 201);

  // Housekeeping: a revoked grant goes, and so do expired codes and tokens and the grants they leave empty.
  const second = await connectClient(browser);
  assert.equal(count('oauth_grants'), 2);
  await postForm(server.origin, '/oauth/revoke', { token: second.tokens.access_token, client_id: second.clientId });
  assert.equal(count('oauth_grants'), 2, 'a revoked grant stays until the next pass');
  assert(server.app.housekeeping());
  assert.equal(count('oauth_grants'), 1);
  assert.equal((await mcp(server.origin, 'get_person', {}, bearer(used.tokens.access_token))).status, 401, 'expired');
  assert(count('oauth_clients') > 0);
  now += 31 * 24 * 60 * 60_000;
  assert(server.app.housekeeping());
  assert.deepEqual([count('oauth_grants'), count('oauth_tokens'), count('oauth_codes')], [0, 0, 0]);
  // Clients left without a grant and unused for 30 days are forgotten as well.
  assert.equal(count('oauth_clients'), 0);
});

test('housekeeping runs on a timer, without any request, and stops when the app closes', async t => {
  const server = await startApp({ housekeepingMs: 15 });
  t.after(() => server.close());
  const count = () => server.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_throttle')!.n;
  const stale = () =>
    server.db.run(
      "INSERT INTO auth_throttle (key, failures, window_start) VALUES ('pair:stale|203.0.113.1', 3, '2020-01-01T00:00:00.000Z')",
    );
  stale();
  server.db.run(
    "INSERT INTO oauth_clients (id, name, redirect_uris, auth_method, created_at) VALUES ('client-old', 'Old', '[]', 'none', '2020-01-01T00:00:00.000Z')",
  );
  for (let n = 0; n < 200 && count() > 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(count(), 0, 'no sign-in happened, and the stale counter is gone');
  assert.equal(server.db.get("SELECT 1 FROM oauth_clients WHERE id = 'client-old'"), undefined);
  // The timer ends with the app.
  await server.app.close();
  stale();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(count(), 1, 'after close no pass runs');
});

test('token endpoint: malformed Basic credentials are 401, and a refresh may ask for less, never for more', async t => {
  const server = await startProductionApp();
  t.after(() => server.close());
  const { origin } = server;
  const browser = server.browser('203.0.113.5');
  await browser.signUp('ada@example.com');
  const basic = (text: string) => ({ Authorization: `Basic ${Buffer.from(text).toString('base64')}` });
  // Percent-encoding that does not decode is a wrong credential, not a server error.
  for (const path of ['/oauth/token', '/oauth/revoke'])
    for (const credentials of ['%E0%A4%A:secret', 'client-x:%', '%:%']) {
      const response = await postForm(origin, path, { grant_type: 'refresh_token', token: 'x' }, basic(credentials));
      assert.deepEqual([response.status, response.body.error], [401, 'invalid_client'], `${path} ${credentials}`);
    }
  // A well-formed Basic header still authenticates a confidential client.
  const confidential = await registerClient(origin, { token_endpoint_auth_method: 'client_secret_basic' });
  const unknownToken = await postForm(
    origin,
    '/oauth/token',
    { grant_type: 'refresh_token', refresh_token: 'rc_rt_unknown' },
    basic(`${encodeURIComponent(confidential.body.client_id)}:${encodeURIComponent(confidential.body.client_secret)}`),
  );
  assert.deepEqual([unknownToken.status, unknownToken.body.error], [400, 'invalid_grant']);

  const granted = await connectClient(browser, 'person:read person:write');
  const refresh = (refresh_token: string, scope?: string) =>
    postForm(origin, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token,
      client_id: granted.clientId,
      ...(scope === undefined ? {} : { scope }),
    });
  const save = (token: string) =>
    mcp(origin, 'save_my_inputs', { data: { household: { size: 3 } }, confirmed: true }, bearer(token));
  // Asking for less is applied: the new access token cannot write.
  const narrowed = await refresh(granted.tokens.refresh_token, 'person:read');
  assert.equal(narrowed.status, 200);
  assert.equal(narrowed.body.scope, 'person:read');
  assert.equal((await mcp(origin, 'get_person', {}, bearer(narrowed.body.access_token))).status, 200);
  const refusedWrite = await save(narrowed.body.access_token);
  assert.equal(refusedWrite.status, 403);
  assert.match(refusedWrite.headers.get('www-authenticate') ?? '', /insufficient_scope/);
  // The narrowing is part of what the server stored: changing the token's prefix makes it unknown.
  const tampered = narrowed.body.access_token.replace(/^rc_at_s\d+_/, 'rc_at_');
  assert.notEqual(tampered, narrowed.body.access_token);
  assert.equal((await save(tampered)).status, 401);
  // Asking for more than was granted, or for nothing this server has, is refused and uses nothing up.
  const readOnly = await connectClient(browser, 'person:read');
  const wider = await postForm(origin, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: readOnly.tokens.refresh_token,
    client_id: readOnly.clientId,
    scope: 'person:read person:write',
  });
  assert.deepEqual([wider.status, wider.body.error], [400, 'invalid_scope']);
  const unknown = await refresh(narrowed.body.refresh_token, 'admin');
  assert.deepEqual([unknown.status, unknown.body.error], [400, 'invalid_scope']);
  // The refresh token kept the scope of the grant: left out, `scope` means everything that was granted.
  const full = await refresh(narrowed.body.refresh_token);
  assert.equal(full.body.scope, 'person:read person:write');
  assert.equal((await save(full.body.access_token)).result?.structuredContent?.saved, true);
});

// ------------------------------------------------------- a person's own bank data

const statement = [
  'date,description,amount',
  '2026-09-01,Salary September,2100.00',
  '2026-09-03,Rent,-800.00',
  '2026-09-12,Mercadona,-64.20',
  '2026-10-01,Salary October,2100.00',
  '2026-10-03,Rent,-800.00',
  '2026-10-31,Netflix,-12.99',
].join('\n');

/** An app with the consent bank and the synthetic feed, and two people with tokens of every kind. */
async function bankWorld(start: typeof startApp | typeof startProductionApp = startApp) {
  const bank = consentBank();
  const server = await start({
    profileApi: { bankRegistry: bank.registry([synthetic]), bankSync: { housekeepingMs: null } },
  });
  const a = server.browser('203.0.113.21');
  const b = server.browser('203.0.113.22');
  await a.signUp('a@example.com');
  await b.signUp('b@example.com');
  const idOf = (email: string) =>
    server.db.get<{ user_id: string }>('SELECT user_id FROM accounts WHERE email = ?', email)!.user_id;
  const count = (table: string, userId: string) =>
    server.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId)!.n;
  return {
    server,
    bank,
    a,
    b,
    aId: idOf('a@example.com'),
    bId: idOf('b@example.com'),
    count,
    token: async (browser: Browser, scope: string) => (await connectClient(browser, scope)).tokens.access_token,
  };
}

test('access-control matrix: bank tools act on the caller alone and the ones that change something need bank:manage', async t => {
  const world = await bankWorld();
  t.after(() => world.server.close());
  const { server, a, b, aId, bId, count } = world;
  const { origin } = server;
  const full = await world.token(a, everyScope);
  const fullB = await world.token(b, everyScope);
  const noBank = await world.token(a, 'person:read person:write');
  const readOnly = await world.token(a, 'person:read');
  const text = (value: unknown) => JSON.stringify(value);
  /** The structured result of a tool call; empty when the call failed. */
  const content = (response: Awaited<ReturnType<typeof mcp>>) =>
    (response.result?.structuredContent ?? {}) as Record<string, any>;
  const changes: [string, Record<string, unknown>][] = [
    ['connect_my_bank', { providerId: 'synthetic' }],
    ['disconnect_my_bank', { connectionId: 'synthetic-12345678' }],
    ['sync_my_bank', {}],
    ['preview_statement_import', { csv: statement }],
    ['confirm_statement_import', { previewHash: 'a'.repeat(40) }],
    ['delete_statement_import', { importId: 'imp-000000000000000000000000' }],
  ];
  const reads = [
    'list_connectable_banks',
    'list_my_bank_connections',
    'get_my_bank_accounts',
    'list_my_statement_imports',
  ];

  for (const [name, args] of changes) {
    // Anonymous: 401. A token without bank:manage: 403 that names the scope to ask for.
    assert.equal((await mcp(origin, name, args)).status, 401, `${name} anonymous`);
    for (const token of [noBank, readOnly]) {
      const refused = await mcp(origin, name, args, bearer(token));
      assert.equal(refused.status, 403, `${name} without bank:manage`);
      const header = refused.headers.get('www-authenticate') ?? '';
      assert.match(header, /error="insufficient_scope"/, name);
      assert.match(header, /scope="[^"]*bank:manage[^"]*"/, name);
    }
    // No tool takes a person: the argument does not exist.
    const cross = await mcp(origin, name, { ...args, userId: bId }, bearer(full));
    assert(cross.error || cross.result?.isError, `${name} accepted a userId`);
  }
  for (const name of reads) {
    assert.equal((await mcp(origin, name)).status, 401, `${name} anonymous`);
    assert.equal((await mcp(origin, name, {}, bearer(readOnly))).status, 200, `${name} read-only`);
  }
  // Nothing above changed anything for anybody.
  for (const table of ['bank_connections', 'bank_import_previews', 'bank_imports', 'bank_transactions'])
    assert.deepEqual([count(table, aId), count(table, bId)], [0, 0], table);

  // The bank that needs a consent is not connected by a tool: the person continues in their browser.
  const banks = content(await mcp(origin, 'list_connectable_banks', {}, bearer(readOnly)));
  assert.deepEqual(
    (banks.banks as { id: string; synthetic: boolean; connect: string }[]).map(item => [
      item.id,
      item.synthetic,
      item.connect,
    ]),
    [
      ['consent-bank', false, 'consent_at_bank'],
      ['synthetic', true, 'direct'],
    ],
  );
  const consent = await mcp(origin, 'connect_my_bank', { providerId: 'consent-bank' }, bearer(full));
  assert.deepEqual([content(consent).status, content(consent).continueUrl], ['consent_required', `${origin}/account`]);
  assert.equal(world.bank.state.begun.length, 0, 'no consent was started by the tool');
  assert.equal(count('bank_consents', aId), 0);
  // A reference is never an input.
  const withRef = await mcp(origin, 'connect_my_bank', { providerId: 'synthetic', ref: `self-${bId}` }, bearer(full));
  assert(withRef.error || withRef.result?.isError);

  // A connects the synthetic feed, syncs and imports a statement; B's ledger never moves.
  const connected = await mcp(origin, 'connect_my_bank', { providerId: 'synthetic' }, bearer(full));
  assert.equal(content(connected).status, 'connected', text(connected.result));
  const connectionId = content(connected).connection.id as string;
  const synced = await mcp(origin, 'sync_my_bank', {}, bearer(full));
  assert.equal(content(synced).results[0].status, 'synced', text(synced.result));
  const preview = await mcp(origin, 'preview_statement_import', { csv: statement }, bearer(full));
  const summary = content(preview);
  assert.deepEqual(
    [
      summary.rowCount,
      summary.newRows,
      summary.coveredFrom,
      summary.coveredTo,
      summary.synthetic,
      summary.averageBasis,
    ],
    [6, 6, '2026-09-01', '2026-10-31', false, 'complete_months'],
  );
  assert.equal(count('bank_transactions', aId), 1, 'a preview writes no movement (one came from the feed)');
  const previewHash = summary.previewHash as string;
  // B cannot confirm A's preview, with A's hash or any other.
  const hijack = await mcp(origin, 'confirm_statement_import', { previewHash }, bearer(fullB));
  assert.equal(hijack.result?.isError, true);
  assert.equal(count('bank_transactions', bId), 0);
  const confirmed = await mcp(origin, 'confirm_statement_import', { previewHash }, bearer(full));
  assert.deepEqual([content(confirmed).inserted, content(confirmed).duplicates], [6, 0], text(confirmed.result));
  // A confirmation is used up with its preview.
  assert.equal((await mcp(origin, 'confirm_statement_import', { previewHash }, bearer(full))).result?.isError, true);
  assert.equal(count('bank_transactions', aId), 7);
  const imports = await mcp(origin, 'list_my_statement_imports', {}, bearer(full));
  const importId = content(imports).imports[0].id as string;
  assert.equal(content(await mcp(origin, 'list_my_statement_imports', {}, bearer(fullB))).imports.length, 0);

  // No tool result carries a movement: descriptions never leave through a tool.
  const outputs = [preview, confirmed, synced, imports];
  for (const name of [...reads, 'get_bank_summary', 'get_bank_updates'])
    outputs.push(
      await mcp(
        origin,
        name,
        name === 'get_bank_summary' ? { from: '2026-09-01', to: '2026-10-31' } : {},
        bearer(full),
      ),
    );
  for (const output of outputs)
    assert.doesNotMatch(text(output).toLowerCase(), /mercadona|netflix|salary september|synthetic runtime grocery/);
  const accounts = content(await mcp(origin, 'get_my_bank_accounts', {}, bearer(full)));
  assert.deepEqual(
    (accounts.accounts as { id: string; synthetic: boolean }[]).map(account => [account.id, account.synthetic]),
    [
      ['synthetic-feed', true],
      ['manual-import', false],
    ],
  );
  assert.equal(accounts.synthetic, false, 'real data is in the ledger now');

  // B cannot delete A's import or disconnect A's bank, even knowing the ids.
  assert.equal((await mcp(origin, 'delete_statement_import', { importId }, bearer(fullB))).result?.isError, true);
  assert.equal((await mcp(origin, 'disconnect_my_bank', { connectionId }, bearer(fullB))).result?.isError, true);
  assert.deepEqual([count('bank_imports', aId), count('bank_connections', aId)], [1, 1]);
  const removed = await mcp(origin, 'delete_statement_import', { importId }, bearer(full));
  assert.equal(content(removed).removedMovements, 6);
  assert.equal(count('bank_transactions', aId), 1);
  assert.equal((await mcp(origin, 'disconnect_my_bank', { connectionId }, bearer(full))).result?.isError, undefined);
  assert.equal(count('bank_connections', aId), 0);

  // The session of a page on this origin may do the same; from another origin it may not.
  const page = { Cookie: `rc_session=${a.cookies.get('rc_session')}`, Origin: origin };
  assert.equal((await mcp(origin, 'sync_my_bank', {}, page)).status, 200);
  assert.equal((await mcp(origin, 'sync_my_bank', {}, { ...page, Origin: 'https://evil.example' })).status, 403);

  // Every bank tool declares that it needs sign-in, and the scope it needs.
  const listed = (await (
    await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  ).json()) as {
    result: {
      tools: {
        name: string;
        description: string;
        _meta?: { securitySchemes?: { type: string; scopes?: string[] }[] };
      }[];
    };
  };
  const tools = new Map(listed.result.tools.map(tool => [tool.name, tool]));
  for (const [name] of changes)
    assert.deepEqual(tools.get(name)?._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['bank:manage'] }], name);
  for (const name of reads)
    assert.deepEqual(tools.get(name)?._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['person:read'] }], name);
  for (const name of ['list_my_bank_connections', 'get_my_bank_accounts', 'sync_my_bank', 'preview_statement_import'])
    assert.match(tools.get(name)?.description ?? '', /individual movements are never returned by a tool/, name);

  // The scope is advertised, and the consent page says in plain words what it allows and what it does not.
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
    const metadata = (await (await fetch(origin + path)).json()) as { scopes_supported: string[] };
    assert.deepEqual(metadata.scopes_supported, ['person:read', 'person:write', 'bank:manage'], path);
  }
  const { body: client } = await registerClient(origin);
  const asked = (scope: string) =>
    a
      .request(
        `/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: 'https://client.example/callback',
          code_challenge: pkce().challenge,
          code_challenge_method: 'S256',
          scope,
        })}`,
      )
      .then(response => response.text());
  const consentPage = await asked(everyScope);
  assert.match(
    consentPage,
    /<li>Manage your bank data for you: start connecting a bank \(you still approve at the bank yourself\)/,
  );
  assert.match(consentPage, /a bank is only connected after you approve on the bank’s own page yourself/);
  assert.match(consentPage, /not your individual movements, and nothing it can do moves money/);
  assert.doesNotMatch(
    await asked('person:read person:write'),
    /bank data/i,
    'nothing about banks unless it is asked for',
  );
  // The account page lists what a connected assistant may do, the bank scope included.
  assert.match(
    await (await a.request('/account')).text(),
    /Test client<\/strong>[\s\S]{0,400}Manage your bank data for you/,
  );
});

test('access-control matrix: a person’s own bank routes on /api', async t => {
  const world = await bankWorld();
  t.after(() => world.server.close());
  const { server, a, aId, bId, count } = world;
  const { origin } = server;
  const bankToken = await world.token(a, everyScope);
  const write = await world.token(a, 'person:read person:write');
  const readOnly = await world.token(a, 'person:read');
  const bankOnly = await world.token(a, 'bank:manage');
  const admin = bearer('admin-test-token');
  const api = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) =>
    fetch(`${origin}/api${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (response: Response) => (await response.json()) as Record<string, any>;

  const reads = [
    '/bank/banks',
    '/bank/connections',
    '/bank/consents',
    '/bank/imports',
    '/bank/transactions',
    '/export',
  ];
  for (const id of [aId, bId, 'user-001'])
    for (const path of reads) {
      assert.equal((await api(`/users/${id}${path}`)).status, 401, `anonymous ${id}${path}`);
      assert.equal((await api(`/users/${id}${path}`, admin)).status, 200, `admin ${id}${path}`);
      for (const token of [bankToken, readOnly])
        assert.equal((await api(`/users/${id}${path}`, bearer(token))).status, id === aId ? 200 : 403, `${id}${path}`);
    }
  // A token that was granted bank:manage alone manages bank data and reads nothing.
  for (const path of ['/context', '/export', '/bank/transactions'])
    assert.equal((await api(`/users/${aId}${path}`, bearer(bankOnly))).status, 403, path);

  // Every bank change: refused for another person's id, for an unknown id, and without bank:manage.
  const writes: [string, string, unknown][] = [
    ['POST', '/bank/connections', { providerId: 'synthetic' }],
    ['DELETE', '/bank/connections/synthetic-12345678', undefined],
    ['POST', '/bank/sync', {}],
    ['POST', '/bank/imports/preview', { csv: statement }],
    ['POST', '/bank/imports', { previewHash: 'a'.repeat(40) }],
    ['DELETE', '/bank/imports/imp-000000000000000000000000', undefined],
    ['PATCH', '/bank/transactions/some-movement', { category: 'other' }],
    ['DELETE', '/bank/transactions/some-movement', undefined],
  ];
  for (const [method, path, body] of writes) {
    assert.equal((await api(`/users/${aId}${path}`, {}, method, body)).status, 401, `anonymous ${method} ${path}`);
    for (const id of [bId, 'user-001', 'p-000000000000000000000000000000'])
      assert.equal(
        (await api(`/users/${id}${path}`, bearer(bankToken), method, body)).status,
        403,
        `${method} ${id}${path}`,
      );
    for (const token of [write, readOnly])
      assert.equal(
        (await api(`/users/${aId}${path}`, bearer(token), method, body)).status,
        403,
        `${method} ${path} without bank:manage`,
      );
  }
  // What stays with the operator, whatever the scope: raw ledger writes and the demo feed.
  for (const [method, path, body] of [
    ['POST', '/bank/transactions', { transactions: [] }],
    ['POST', '/bank/accounts', {}],
    ['PUT', '/bank/transactions/some-movement', {}],
    ['POST', '/bank/runtime', { enabled: true }],
    ['POST', '/bank/demo', {}],
  ] as const)
    assert.equal((await api(`/users/${aId}${path}`, bearer(bankToken), method, body)).status, 403, `${method} ${path}`);
  for (const table of ['bank_connections', 'bank_import_previews', 'bank_transactions'])
    assert.deepEqual([count(table, aId), count(table, bId)], [0, 0], table);

  // Connecting: a person names the bank and nothing else.
  for (const body of [
    { providerId: 'synthetic', ref: `self-${bId}` },
    { providerId: 'consent-bank', ref: 'CREDENTIAL-bob-52aa0d4c' },
    { providerId: 'synthetic', id: 'mine' },
    { providerId: 'synthetic', pollIntervalMs: 1000 },
  ])
    assert.equal(
      (await api(`/users/${aId}/bank/connections`, bearer(bankToken), 'POST', body)).status,
      403,
      JSON.stringify(body),
    );
  const needsConsent = await api(`/users/${aId}/bank/connections`, bearer(bankToken), 'POST', {
    providerId: 'consent-bank',
  });
  assert.equal(needsConsent.status, 202);
  assert.deepEqual([(await json(needsConsent)).status, world.bank.state.begun.length], ['consent_required', 0]);
  assert.equal(
    (await api(`/users/${aId}/bank/connections`, bearer(bankToken), 'POST', { providerId: 'nope' })).status,
    404,
  );
  const connected = await api(`/users/${aId}/bank/connections`, bearer(bankToken), 'POST', { providerId: 'synthetic' });
  assert.equal(connected.status, 201);
  const connectionId = (await json(connected)).connection.id as string;
  assert.equal((await api(`/users/${aId}/bank/sync`, bearer(bankToken), 'POST', {})).status, 200);
  const feedMovement = server.db.get<{ id: string }>('SELECT id FROM bank_transactions WHERE user_id = ?', aId)!.id;

  // A statement: preview, confirm, the same again changes nothing, an overlapping one adds only what is new.
  const previewed = await json(
    await api(`/users/${aId}/bank/imports/preview`, bearer(bankToken), 'POST', { csv: statement }),
  );
  assert.deepEqual([previewed.rowCount, previewed.newRows, previewed.alreadyImported], [6, 6, false]);
  assert.equal(count('bank_transactions', aId), 1, 'the preview wrote nothing');
  const first = await api(`/users/${aId}/bank/imports`, bearer(bankToken), 'POST', {
    previewHash: previewed.previewHash,
  });
  assert.equal(first.status, 201);
  assert.deepEqual(
    (({ inserted, duplicates, alreadyImported }) => [inserted, duplicates, alreadyImported])(await json(first)),
    [6, 0, false],
  );
  assert.equal(
    (await api(`/users/${aId}/bank/imports`, bearer(bankToken), 'POST', { previewHash: previewed.previewHash })).status,
    409,
  );
  const again = await json(
    await api(`/users/${aId}/bank/imports/preview`, bearer(bankToken), 'POST', { csv: statement }),
  );
  assert.deepEqual([again.newRows, again.alreadyInLedger, again.alreadyImported], [0, 6, true]);
  const repeated = await json(
    await api(`/users/${aId}/bank/imports`, bearer(bankToken), 'POST', { previewHash: again.previewHash }),
  );
  assert.deepEqual([repeated.inserted, repeated.alreadyImported], [0, true]);
  assert.equal(count('bank_transactions', aId), 7);
  const listed = await json(
    await api(`/users/${aId}/bank/transactions?from=2026-09-01&to=2026-09-30&limit=2&offset=1`, bearer(readOnly)),
  );
  assert.deepEqual([listed.total, listed.transactions.length, listed.synthetic], [3, 2, false]);

  // Corrections: the category of a movement, a transfer between own accounts, deleting what was imported.
  const rent = server.db.get<{ id: string }>(
    "SELECT id FROM bank_transactions WHERE user_id = ? AND description = 'rent' ORDER BY date",
    aId,
  )!.id;
  const patch = (id: string, category: string, token = bankToken) =>
    api(`/users/${aId}/bank/transactions/${id}`, bearer(token), 'PATCH', { category });
  assert.equal((await patch(rent, 'internal_transfer')).status, 200);
  assert.equal((await patch(rent, 'income')).status, 400, 'money out is never income');
  assert.equal((await patch(rent, 'nonsense')).status, 400);
  assert.equal((await patch('csv-unknown', 'other')).status, 404);
  assert.equal(
    server.db.get<{ category: string }>(
      'SELECT category FROM bank_transactions WHERE user_id = ? AND id = ?',
      aId,
      rent,
    )?.category,
    'internal_transfer',
  );
  assert.equal(
    (await api(`/users/${aId}/bank/transactions/${feedMovement}`, bearer(bankToken), 'DELETE')).status,
    403,
    'a bank movement is corrected, not deleted',
  );
  assert.equal((await api(`/users/${aId}/bank/transactions/${rent}`, bearer(bankToken), 'DELETE')).status, 200);
  assert.equal(count('bank_transactions', aId), 6);

  // The session cookie: reads work; every change needs this origin and the CSRF token.
  const cookie = { Cookie: `rc_session=${a.cookies.get('rc_session')}` };
  const csrf = await a.csrf('/account');
  assert.equal((await api(`/users/${aId}/bank/connections`, cookie)).status, 200);
  assert.equal((await api(`/users/${bId}/bank/connections`, cookie)).status, 403);
  assert.equal((await api(`/users/${bId}/export`, cookie)).status, 403);
  assert.equal(
    (await api(`/users/${aId}/bank/sync`, { ...cookie, Origin: origin }, 'POST', {})).status,
    403,
    'no CSRF token',
  );
  assert.equal(
    (await api(`/users/${aId}/bank/sync`, { ...cookie, 'X-CSRF-Token': csrf }, 'POST', {})).status,
    403,
    'no Origin',
  );
  assert.equal(
    (
      await api(
        `/users/${aId}/bank/sync`,
        { ...cookie, Origin: 'https://evil.example', 'X-CSRF-Token': csrf },
        'POST',
        {},
      )
    ).status,
    401,
  );
  assert.equal(
    (await api(`/users/${aId}/bank/sync`, { ...cookie, Origin: origin, 'X-CSRF-Token': csrf }, 'POST', {})).status,
    200,
  );
  assert.equal(
    (await api(`/users/${bId}/bank/sync`, { ...cookie, Origin: origin, 'X-CSRF-Token': csrf }, 'POST', {})).status,
    403,
  );

  // Deleting the import removes its movements; disconnecting removes the link.
  const importId = (await json(await api(`/users/${aId}/bank/imports`, bearer(readOnly)))).imports[0].id as string;
  const removed = await json(await api(`/users/${aId}/bank/imports/${importId}`, bearer(bankToken), 'DELETE'));
  assert.equal(removed.removedMovements, 5, 'the five that were left of the six');
  assert.equal((await api(`/users/${aId}/bank/connections/${connectionId}`, bearer(bankToken), 'DELETE')).status, 200);
  assert.deepEqual(
    [count('bank_imports', aId), count('bank_import_rows', aId), count('bank_connections', aId)],
    [0, 0, 0],
  );
  // B was never touched.
  for (const table of ['bank_connections', 'bank_transactions', 'bank_imports', 'bank_import_previews'])
    assert.equal(count(table, bId), 0, table);

  // The export through /api is the person's own, and names nobody else.
  const exported = await api(`/users/${aId}/export`, bearer(readOnly));
  assert.match(exported.headers.get('content-disposition') ?? '', /attachment/);
  const body = await exported.text();
  assert(body.includes(aId) && body.includes('a@example.com'));
  assert(!body.includes(bId) && !body.includes('b@example.com'));
});

for (const shape of shapes)
  test(`the account page: bank, statement, password and export forms act on the session’s person and need its CSRF token [${shape.name}]`, async t => {
    const world = await bankWorld(shape.start);
    t.after(() => world.server.close());
    const { server, a, b, aId, bId, count } = world;
    const csrf = await a.csrf('/account');
    const forms: [string, Record<string, string>][] = [
      ['/account/password', { current: password, next: 'another passphrase' }],
      ['/account/export', {}],
      ['/account/bank/connect', { provider: 'synthetic' }],
      ['/account/bank/sync', {}],
      ['/account/bank/disconnect', { connection: 'synthetic-12345678' }],
      ['/account/bank/import/confirm', { preview: 'a'.repeat(40) }],
      ['/account/bank/import/cancel', { preview: 'a'.repeat(40) }],
      ['/account/bank/import/delete', { import: 'imp-000000000000000000000000' }],
      ['/account/bank/movement', { movement: 'x', category: 'other' }],
      ['/account/bank/movement/delete', { movement: 'x' }],
    ];
    const anonymous = server.browser('203.0.113.99');
    for (const [path, fields] of forms) {
      // Not signed in: to the sign-in page. Signed in without the token, with another session's
      // token, or from another site: refused.
      const signedOut = await anonymous.request(path, { form: fields });
      assert.deepEqual([signedOut.status, signedOut.headers.get('location')], [303, '/login?next=%2Faccount'], path);
      assert.equal((await a.request(path, { form: fields })).status, 403, `${path} without a token`);
      assert.equal(
        (await a.request(path, { form: { ...fields, csrf: await b.csrf('/account') } })).status,
        403,
        `${path} with B's token`,
      );
      const crossSite = await a.request(path, {
        form: { ...fields, csrf },
        headers: { Origin: 'https://evil.example' },
      });
      assert.equal(crossSite.status, 403, `${path} from another site`);
    }
    const upload = (browser: Browser, fields: Record<string, string>, content = statement) =>
      browser.request('/account/bank/import', {
        upload: { fields, name: 'statement', filename: 'statement <b>.csv', content },
      });
    assert.equal((await upload(a, {})).status, 403, 'the upload needs the token too');
    assert.equal((await upload(anonymous, { csrf })).status, 303);
    assert.equal((await a.request('/bank/consent/callback?state=x', { method: 'POST' })).status, 405);
    for (const table of ['bank_connections', 'bank_import_previews', 'bank_transactions'])
      assert.deepEqual([count(table, aId), count(table, bId)], [0, 0], table);
    assert.equal(
      (await server.browser('203.0.113.21').login('a@example.com')).status,
      303,
      'the password is unchanged',
    );
    const token = csrf;

    // The page: strict headers, no script, and the bank section with what can be connected.
    const page = await a.request('/account');
    const html = await page.text();
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'.*form-action 'self'$/);
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /Consent Bank/);
    assert.match(html, /Synthetic demo feed<\/strong> <span class="tag">fictional data<\/span>/);
    assert.match(html, /No bank is connected\./);
    assert.match(html, /Download everything as JSON/);
    assert.match(html, /Change your password/);

    // Connect the feed, fetch, and read a statement: a summary first, nothing saved.
    const connect = await a.request('/account/bank/connect', { form: { csrf: token, provider: 'synthetic' } });
    assert.deepEqual([connect.status, connect.headers.get('location')], [303, '/account?done=bank-connected#bank']);
    assert.equal((await a.request('/account/bank/sync', { form: { csrf: token } })).status, 303);
    const preview = await upload(a, { csrf: token });
    const previewHtml = await preview.text();
    assert.equal(preview.status, 200);
    assert.match(previewHtml, /Nothing has been saved yet/);
    assert.match(previewHtml, /statement &lt;b&gt;\.csv/, 'the file name is escaped');
    assert.match(previewHtml, /2026-09-01 to 2026-10-31 \(61 days\)/);
    assert.match(previewHtml, /Monthly figures are averages of 2 complete month\(s\)/);
    assert.match(previewHtml, /<td>Housing<\/td><td class="num">2<\/td><td class="num">−€1,600\.00<\/td>/);
    assert.doesNotMatch(previewHtml, /<script/i);
    assert.equal(count('bank_transactions', aId), 1);
    const previewHash = /name="preview" value="([0-9a-f]{40})"/.exec(previewHtml)![1];
    // B cannot confirm what A uploaded.
    const hijack = await b.request('/account/bank/import/confirm', {
      form: { csrf: await b.csrf('/account'), preview: previewHash },
    });
    assert.equal(hijack.status, 409);
    assert.equal(count('bank_transactions', bId), 0);
    const confirmed = await a.request('/account/bank/import/confirm', { form: { csrf: token, preview: previewHash } });
    assert.deepEqual([confirmed.status, confirmed.headers.get('location')], [303, '/account?done=imported#movements']);
    assert.equal(count('bank_transactions', aId), 7);

    // The movements are listed for their owner only, newest first, with a filter and pages.
    const listed = await (await a.request('/account?from=2026-09-01&to=2026-10-31')).text();
    assert.match(listed, /6 movement\(s\) · page 1 of 1/);
    assert(listed.indexOf('netflix') < listed.indexOf('salary september'), 'newest first');
    assert.doesNotMatch(await (await b.request('/account')).text(), /netflix|mercadona/);
    // A statement too short for a monthly figure says so, and one that is not a statement is refused.
    const short = await (await upload(a, { csrf: token }, 'date,description,amount\n2026-11-03,Coffee,-2.10')).text();
    assert.match(
      short,
      /rc-note--warn">The statement runs from 2026-11-03 to 2026-11-03: 1 day\(s\)\. That is too short for a monthly figure/,
    );
    const broken = await upload(a, { csrf: token }, 'not,a,statement\n1,2,3');
    assert.equal(broken.status, 400);
    assert.match(await broken.text(), /Use a CSV with date, description, and amount columns/);
    assert.equal(
      (await upload(a, { csrf: token }, `date,description,amount\n${'2026-11-03,Coffee,-2.10\n'.repeat(12_000)}`))
        .status,
      413,
    );

    // Corrections from the page, and only on the person's own movements.
    const id = (description: string) =>
      server.db.get<{ id: string }>(
        'SELECT id FROM bank_transactions WHERE user_id = ? AND description = ?',
        aId,
        description,
      )!.id;
    const saved = await a.request('/account/bank/movement', {
      form: { csrf: token, movement: id('mercadona'), category: 'internal_transfer', from: '2026-09-01', page: '1' },
    });
    assert.deepEqual(
      [saved.status, saved.headers.get('location')],
      [303, '/account?done=category&from=2026-09-01&page=1#movements'],
    );
    assert.match(await (await a.request('/account')).text(), /<span class="tag">your choice<\/span>/);
    const notMine = await b.request('/account/bank/movement', {
      form: { csrf: await b.csrf('/account'), movement: id('mercadona'), category: 'other' },
    });
    assert.equal(notMine.status, 404, 'B cannot touch a movement of A, even knowing its id');
    assert.equal(
      (
        await b.request('/account/bank/movement/delete', {
          form: { csrf: await b.csrf('/account'), movement: id('netflix') },
        })
      ).status,
      404,
    );
    assert.equal(
      (await a.request('/account/bank/movement/delete', { form: { csrf: token, movement: id('netflix') } })).status,
      303,
    );
    const feed = server.db.get<{ id: string }>(
      "SELECT id FROM bank_transactions WHERE user_id = ? AND account_id = 'synthetic-feed'",
      aId,
    )!.id;
    const kept = await a.request('/account/bank/movement/delete', { form: { csrf: token, movement: feed } });
    assert.equal(kept.status, 403);
    assert.match(await kept.text(), /Only movements you imported yourself can be deleted/);
    assert.equal(count('bank_transactions', aId), 6);

    // The download: one JSON file with everything of this person and nothing of anybody else.
    const download = await a.request('/account/export', { form: { csrf: token } });
    assert.equal(download.status, 200);
    assert.match(
      download.headers.get('content-disposition') ?? '',
      /^attachment; filename="relocat-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    assert.equal(download.headers.get('cache-control'), 'no-store');
    const text = await download.text();
    const exported = JSON.parse(text) as {
      tables: Record<string, Record<string, unknown>[]>;
      redacted: { columns: Record<string, string[]> };
    };
    assert.equal(exported.tables.accounts[0].email, 'a@example.com');
    assert.deepEqual(
      [
        exported.tables.bank_transactions.length,
        exported.tables.bank_imports.length,
        exported.tables.bank_connections.length,
      ],
      [6, 1, 1],
    );
    assert(!text.includes(bId) && !text.includes('b@example.com'));
    assert(!/password_hash|scrypt\$/.test(JSON.stringify(exported.tables)), 'the password hash is not exported');
    assert.deepEqual(exported.redacted.columns.accounts, ['password_hash']);

    // Disconnect and delete the import from the page.
    const connectionId = server.db.get<{ id: string }>('SELECT id FROM bank_connections WHERE user_id = ?', aId)!.id;
    const foreign = await b.request('/account/bank/disconnect', {
      form: { csrf: await b.csrf('/account'), connection: connectionId },
    });
    assert.equal(foreign.status, 404);
    assert.equal(count('bank_connections', aId), 1);
    assert.equal(
      (await a.request('/account/bank/disconnect', { form: { csrf: token, connection: connectionId } })).status,
      303,
    );
    const importId = server.db.get<{ id: string }>('SELECT id FROM bank_imports WHERE user_id = ?', aId)!.id;
    assert.equal(
      (await b.request('/account/bank/import/delete', { form: { csrf: await b.csrf('/account'), import: importId } }))
        .status,
      404,
    );
    assert.equal(
      (await a.request('/account/bank/import/delete', { form: { csrf: token, import: importId } })).status,
      303,
    );
    assert.deepEqual(
      [count('bank_connections', aId), count('bank_imports', aId), count('bank_transactions', aId)],
      [0, 0, 1],
    );

    // Deleting the account leaves nothing: no upload waiting, no consent in progress, no credential.
    await upload(a, { csrf: token });
    world.bank.state.expiresAt = null;
    const leave = await a.request('/account/bank/connect', { form: { csrf: token, provider: 'consent-bank' } });
    assert.equal(leave.status, 200);
    assert.match(await leave.text(), /href="https:\/\/bank\.example\/authorize\?state=/);
    const pending = world.bank.lastState();
    assert.deepEqual([count('bank_import_previews', aId), count('bank_consents', aId)], [2, 1], 'two uploads wait');
    const back = await a.request(`/bank/consent/callback?state=${pending}&code=code-ada`);
    assert.deepEqual([back.status, back.headers.get('location')], [302, '/account?done=bank-connected#bank']);
    await a.request('/account/bank/connect', { form: { csrf: token, provider: 'consent-bank' } });
    assert.deepEqual([count('bank_credentials', aId), count('bank_consents', aId)], [1, 1]);
    const account = server.db.get<{ id: string }>("SELECT id FROM accounts WHERE email = 'a@example.com'")!;
    const deleted = await a.request('/account/delete', { form: { csrf: token, password, confirm: 'yes' } });
    assert.equal(deleted.status, 200);
    assert.equal(remainingRows(server.db, account.id, aId), 0);
    for (const table of ['bank_credentials', 'bank_consents', 'bank_import_previews', 'bank_connections'])
      assert.equal(server.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n, 0, table);
    // The consent that was in progress is worthless now, to anybody.
    const late = await b.request(`/bank/consent/callback?state=${world.bank.lastState()}&code=code-ada`);
    assert.equal(late.status, 400);
    assert.equal(count('bank_connections', bId), 0);
  });

test('changing the password needs the current one, ends other sessions and every token, and has its own throttle', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin } = server;
  const here = server.browser();
  await here.signUp('ada@example.com');
  const elsewhere = server.browser();
  assert.equal((await elsewhere.login('ada@example.com')).status, 303);
  const client = await connectClient(elsewhere, everyScope);
  const bystander = server.browser();
  await bystander.signUp('bob@example.com');
  const bystanderToken = (await connectClient(bystander)).tokens.access_token;
  const csrf = await here.csrf('/account');
  const change = (current: string, next: string) =>
    here.request('/account/password', { form: { csrf, current, next } });
  const next = 'a brand new passphrase';

  // A wrong current password, or a new one that is too weak, changes nothing.
  const wrong = await change('not the password', next);
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /The current password is not right\. Nothing was changed\./);
  for (const [weak, reason] of [
    ['short', /10 to 200 characters/],
    ['ada@example.com', /must differ from the email/],
    [password, /must differ from the current one/],
  ] as const) {
    const refused = await change(password, weak);
    assert.equal(refused.status, 400, weak);
    assert.match(await refused.text(), reason);
  }
  assert.equal((await elsewhere.request('/account')).status, 200, 'nothing ended yet');
  assert.equal((await mcp(origin, 'get_person', {}, bearer(client.tokens.access_token))).status, 200);

  // Wrong guesses are counted for this session: five are free, the next one makes it wait. Signing in is not affected.
  for (let n = 0; n < 6; n++) assert.equal((await change('wrong guess', next)).status, 400);
  const waiting = await change(password, next);
  assert.equal(waiting.status, 429);
  assert.equal(waiting.headers.get('retry-after'), '30');
  assert.equal((await server.browser().login('ada@example.com')).status, 303, 'sign-in has its own counters');
  const other = server.browser();
  await other.login('ada@example.com');
  const otherCsrf = await other.csrf('/account');

  // From a session that is not waiting, with the right password: changed.
  const changed = await other.request('/account/password', { form: { csrf: otherCsrf, current: password, next } });
  assert.deepEqual([changed.status, changed.headers.get('location')], [303, '/account?done=password']);
  assert.match(await (await other.request('/account?done=password')).text(), /Your password was changed/);
  // Every other browser is signed out; this one stays.
  for (const browser of [here, elsewhere])
    assert.equal((await browser.request('/account')).headers.get('location'), '/login?next=%2Faccount');
  assert.equal((await other.request('/account')).status, 200);
  // Every token issued before is dead, access and refresh alike, and no assistant is listed.
  assert.equal((await mcp(origin, 'get_person', {}, bearer(client.tokens.access_token))).status, 401);
  const refresh = await postForm(origin, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: client.tokens.refresh_token,
    client_id: client.clientId,
  });
  assert.equal(refresh.status, 400);
  assert.match(await (await other.request('/account')).text(), /No assistant or application is connected/);
  // The old password is refused, the new one signs in, and nobody else noticed anything.
  assert.equal((await server.browser().login('ada@example.com')).status, 400);
  assert.equal((await server.browser().login('ada@example.com', next)).status, 303);
  assert.equal((await bystander.request('/account')).status, 200);
  assert.equal((await mcp(origin, 'get_person', {}, bearer(bystanderToken))).status, 200);
});

test('a new account’s documents say synthetic: false by themselves, with or without the trigger behind them', async () => {
  const db = open(':memory:');
  db.run('DROP TRIGGER accounts_own_real_people');
  const account = await createAccounts(db).signUp({ email: 'ada@example.com', password, address: 'a' });
  const sections = db.all<{ synthetic: number; document: string }>(
    'SELECT synthetic, document FROM profile_sections WHERE user_id = ?',
    account.userId,
  );
  assert.equal(sections.length, 3);
  for (const section of sections)
    assert.deepEqual([section.synthetic, JSON.parse(section.document).synthetic], [0, false]);
  db.close();
});

// ------------------------------------------------------------------ languages

const plainSpaces = (text: string) => text.replace(/[  ]/g, ' ');

test('account pages are written in the language of the request, and English is the default', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${server.origin}${path}`, { headers });

  const english = await get('/signup');
  const englishHtml = await english.text();
  assert.match(englishHtml, /<html lang="en">/);
  assert.match(englishHtml, /<h1>Create your account<\/h1>/);
  assert.equal(english.headers.get('content-language'), 'en');
  assert.equal(english.headers.get('vary'), 'Accept-Language, Cookie');
  assert.match(english.headers.get('content-security-policy') ?? '', /^default-src 'none'; style-src 'unsafe-inline'/);
  assert.doesNotMatch(englishHtml, /<script/i);
  // The switcher: three links to this page, the current one marked.
  assert.match(englishHtml, /<a href="\/signup\?lang=ca" lang="ca" hreflang="ca">Català<\/a>/);
  assert.match(englishHtml, /<a href="\/signup\?lang=en" lang="en" hreflang="en" aria-current="true">English<\/a>/);

  // The browser's preference decides when nothing was chosen; it sets no cookie.
  const catalan = await get('/signup', { 'Accept-Language': 'ca-ES,ca;q=0.9,en;q=0.5' });
  const catalanHtml = await catalan.text();
  assert.match(catalanHtml, /<html lang="ca">/);
  assert.match(catalanHtml, /<h1>Crea el teu compte<\/h1>/);
  assert.match(catalanHtml, /Com a mínim 10 caràcters\./);
  assert.equal(catalan.headers.get('content-language'), 'ca');
  assert(!catalan.headers.getSetCookie().some(cookie => cookie.startsWith('rc_lang=')));
  // Same form, same field names, whatever the language.
  for (const field of ['name="csrf"', 'name="email"', 'name="password"', 'action="/signup"'])
    assert(catalanHtml.includes(field), field);

  // `?lang=` wins over the browser and is remembered, next to the CSRF cookie of the form.
  const spanish = await get('/login?lang=es', { 'Accept-Language': 'ca' });
  const spanishHtml = await spanish.text();
  assert.match(spanishHtml, /<html lang="es">/);
  assert.match(spanishHtml, /<h1>Iniciar sesión<\/h1>/);
  const cookies = spanish.headers.getSetCookie();
  assert(cookies.includes('rc_lang=es; Path=/; Max-Age=31536000; SameSite=Lax'), cookies.join(' | '));
  assert(
    cookies.some(cookie => cookie.startsWith('rc_pre=') && cookie.includes('HttpOnly')),
    cookies.join(' | '),
  );

  // Anything that is not one of the three languages is ignored: never reflected, never stored.
  for (const bad of ['%22%3E%3Cscript%3Ealert(1)%3C/script%3E', 'fr', 'zz%0d%0aSet-Cookie:x=1', '']) {
    const response = await get(`/login?lang=${bad}`);
    const html = await response.text();
    assert.match(html, /<html lang="en">/, bad);
    assert.doesNotMatch(html, /<script|alert\(1\)/i, bad);
    assert(!response.headers.getSetCookie().some(cookie => cookie.startsWith('rc_lang=')), bad);
  }
  // A regional tag is reduced to its language: the cookie only ever holds one of the three values.
  const regional = await get('/login?lang=CA-es');
  assert(regional.headers.getSetCookie().includes('rc_lang=ca; Path=/; Max-Age=31536000; SameSite=Lax'));

  // `next` is handled as before: an outside address is dropped, an accepted one is kept.
  const outside = await (await get('/login?lang=ca&next=https://evil.example/')).text();
  assert.doesNotMatch(outside, /evil\.example/);
  const inside = await (await get('/login?lang=ca&next=%2Faccount')).text();
  assert.match(inside, /name="next" value="\/account"/);
  assert.match(inside, /<a href="\/login\?next=%2Faccount&#38;lang=es" lang="es"/);
});

test('a chosen language survives form posts and redirects, and refusals are translated', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const browser = server.browser();
  await browser.request('/login?lang=es');

  // A POST carries no `?lang`: the cookie decides. The session and CSRF cookies still work.
  const wrong = await browser.login('nobody@example.com', 'not the password');
  assert.equal(wrong.status, 400);
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /<html lang="es">/);
  assert.match(wrongHtml, /role="alert">El correo electrónico o la contraseña no son correctos\.</);
  assert.equal(wrong.headers.get('content-language'), 'es');

  const short = await browser.signUp('idioma@example.com', 'short');
  assert.equal(short.status, 400);
  assert.match(await short.text(), /Elige una contraseña de entre 10 y 200 caracteres\./);

  const signedUp = await browser.signUp('idioma@example.com');
  assert.equal(signedUp.status, 303);
  assert.equal(signedUp.headers.get('location'), '/account');
  const account = await (await browser.request('/account')).text();
  assert.match(account, /<html lang="es">/);
  assert.match(account, /<h1>Tu cuenta<\/h1>/);
  assert.match(account, /<dt>Último inicio de sesión<\/dt>/);
  assert.match(account, /<dt>Movimientos bancarios<\/dt><dd>0<\/dd>/);
  assert.match(account, /No hay ningún banco conectado\./);
  assert.match(account, /<a href="\/account\?lang=ca" lang="ca" hreflang="ca">Català<\/a>/);

  // Switching on the account page keeps the session, and the next refusal comes in the new language.
  const switched = await browser.request('/account?lang=ca&done=category');
  const switchedHtml = await switched.text();
  assert.match(switchedHtml, /<h1>El teu compte<\/h1>/);
  assert.match(switchedHtml, /role="status">S’ha desat la categoria\.</);
  assert.doesNotMatch(switchedHtml, /href="\/account\?done=/, 'the switcher does not repeat a notice');
  const csrf = /name="csrf" value="([^"]+)"/.exec(switchedHtml)?.[1] ?? '';
  const refusedChange = await browser.request('/account/password', {
    form: { csrf, current: 'not the password', next: 'another long password' },
  });
  assert.equal(refusedChange.status, 400);
  assert.match(await refusedChange.text(), /La contrasenya actual no és correcta\. No s’ha canviat res\./);
  const forged = await browser.request('/account/password', { form: { csrf: 'forged', current: 'x', next: 'y' } });
  assert.equal(forged.status, 403);
  assert.match(await forged.text(), /Aquest formulari ha caducat\./);

  // The consent screen: the same hidden fields and decisions, the scopes in Catalan.
  const { body: client } = await registerClient(server.origin);
  const { challenge } = pkce();
  const params = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: 'https://client.example/callback',
    state: 'state-123',
    scope: everyScope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${server.site}/mcp`,
  };
  const consent = await browser.request(`/oauth/authorize?${new URLSearchParams(params)}`);
  const consentHtml = await consent.text();
  assert.equal(consent.status, 200);
  assert.match(consentHtml, /<h1>Vols connectar Test client\?<\/h1>/);
  assert.match(
    consentHtml,
    /<li>Llegir les dades de la teva llar, les teves finances, el resum bancari i els teus hàbits<\/li>/,
  );
  assert.match(consentHtml, /mai els teus moviments individuals, i no pot moure diners<\/li>/);
  assert.match(consentHtml, /name="decision" value="allow">Permet l’accés</);
  assert.match(consentHtml, /name="decision" value="deny">Denega l’accés</);
  for (const name of Object.keys(params)) assert(consentHtml.includes(`name="${name}"`), name);
  assert.match(consent.headers.get('content-security-policy') ?? '', /form-action 'self' https:\/\/client\.example$/);
  const allowed = await browser.request('/oauth/authorize', {
    form: { ...params, csrf: /name="csrf" value="([^"]+)"/.exec(consentHtml)?.[1] ?? '', decision: 'allow' },
  });
  assert.equal(allowed.status, 303);
  assert.match(allowed.headers.get('location') ?? '', /^https:\/\/client\.example\/callback\?code=/);

  // An unknown application is refused in the person's language too.
  const unknown = await browser.request(`/oauth/authorize?${new URLSearchParams({ ...params, client_id: 'nobody' })}`);
  assert.equal(unknown.status, 400);
  assert.match(await unknown.text(), /Aquesta aplicació no està registrada a ReloCat\./);
});

test('the page functions: English by default, dates, counts and money per language, unknown as a word', () => {
  const bank: BankSection = {
    available: true,
    banks: [{ id: 'demo', displayName: 'Banc <Demo>', synthetic: true, connect: 'consent_at_bank' }],
    connections: [],
    pendingConsents: [{ providerId: 'demo', expiresAt: '2026-11-23T10:15:00.000Z' }],
    accounts: [
      { id: 'a1', name: 'Compte corrent', balanceCents: null, synthetic: true },
      { id: 'manual-import', name: 'Statements you imported', balanceCents: -1_840_055, synthetic: false },
    ],
    imports: [
      {
        id: 'i1',
        createdAt: '2026-11-20T10:00:00.000Z',
        rowCount: 1,
        coveredFrom: '2026-09-01',
        coveredTo: '2026-10-31',
      },
    ],
    movements: [
      {
        id: 'm1',
        accountId: 'a1',
        date: '2026-11-21',
        description: 'Nòmina',
        amountCents: 290_000,
        category: 'income',
        status: 'pending',
        synthetic: true,
        categoryChosen: true,
      },
    ],
    total: 1482,
    page: 1,
    pageSize: 25,
    manualAccountId: 'manual-import',
  };
  const input = {
    csrf: 'token',
    account: { email: 'a@example.com' },
    stored: { userId: 'p1', createdAt: '2026-10-02T09:14:00.000Z', lastLoginAt: null, counts: [], answers: [] },
    clients: [
      { grantId: 'g', clientName: 'ChatGPT', scopes: ['person:read'] as Scope[], connectedAt: '2026-11-01T12:00:00Z' },
    ],
    bank,
  };
  const en = accountPage(input);
  assert.equal(accountPage(input, { locale: 'en' }), en);
  assert.doesNotMatch(en, /rc-lang" aria-label/, 'a page rendered without a path has no switcher');
  assert.match(en, /<dd>2026-10-02<\/dd>/);
  assert.match(en, /<dt>Last sign-in<\/dt><dd>never<\/dd>/);
  assert.match(en, /<td class="num">unknown<\/td>/);
  assert.match(en, /<td class="num">−€18,400\.55<\/td>/);
  assert.match(en, /1 authorisation\(s\) started at a bank and not finished; they lapse by 2026-11-23 10:15 UTC\./);
  assert.match(en, /2026-09-01 to 2026-10-31 · 1 rows/);
  assert.match(en, /1482 movement\(s\) · page 1 of 60/);
  assert.match(en, /Connected 2026-11-01 · Read your household, finances, bank summary and habits/);
  assert.match(en, /aria-label="Connect Banc &lt;Demo&gt;">Connect</);

  const ca = plainSpaces(accountPage(input, { locale: 'ca', path: '/account' }));
  assert.match(ca, /<html lang="ca">/);
  assert.match(ca, /<dt>Darrer inici de sessió<\/dt><dd>mai<\/dd>/);
  assert.match(ca, /<td class="num">desconegut<\/td>/);
  assert.match(ca, /<td class="num">−18\.400,55 €<\/td>/);
  assert.match(ca, /Extractes que has importat <span class="tag">net dels moviments importats<\/span>/);
  assert.match(
    ca,
    /Hi ha 1 autorització iniciada en un banc i no acabada; caduca com a molt tard el 23 [^<]*2026, 10:15 UTC\./,
  );
  assert.match(ca, /· 1 fila\n/);
  assert.match(ca, /1\.482 moviments · pàgina 1 de 60/);
  assert.match(ca, /<span class="tag">pendent<\/span> <span class="tag">dades fictícies<\/span>/);
  assert.match(ca, /<option value="income" selected>Ingressos<\/option>/);
  assert.match(ca, /aria-label="Connecta Banc &lt;Demo&gt;">Connecta</);
  // What a form sends is the same in every language.
  const fields = (html: string) =>
    [...html.matchAll(/<(?:form|input|select|option|button)\b[^>]*>/g)].map(match =>
      match[0].replace(/ aria-label="[^"]*"/, ''),
    );
  assert.deepEqual(fields(ca), fields(en));

  const es = plainSpaces(accountPage(input, { locale: 'es' }));
  assert.match(es, /<td class="num">desconocido<\/td>/);
  assert.match(es, /<td class="num">−18\.400,55 €<\/td>/);
  // Spanish groups thousands only from five digits on.
  assert.match(es, /1482 movimientos · página 1 de 60/);
  assert.match(es, /<dd>nunca<\/dd>/);
  assert.deepEqual(fields(es), fields(en));
  assert.equal(euros(-1234), '−€12.34');
  assert.equal(plainSpaces(euros(-1234, 'es')), '−12,34 €');

  // Whatever a person, an application or a bank wrote is escaped in every language.
  for (const locale of ['en', 'ca', 'es'] as const) {
    const consent = consentPage(
      {
        csrf: 'token',
        account: { email: 'a@example.com' },
        client: { name: '<img src=x onerror=1>' },
        redirectUri: 'http://localhost:1/cb',
        scopes: ['person:read', 'bank:manage'],
        params: { state: '"><script>' },
      },
      { locale, path: '/oauth/authorize?state="><script>' },
    );
    assert.doesNotMatch(consent, /<img|<script/, locale);
    assert.match(consent, new RegExp(`<html lang="${locale}">`));
  }
});

test('catalogs of the account pages: the scopes match the grants, markup is plain, refusals still exist', () => {
  // What the consent screen says in English is exactly what `packages/auth` defines for each scope.
  for (const scope of allScopes) assert.equal(consentMessages.en[scopeMessage[scope]], scopes[scope], scope);
  // Each translation of the bank scope keeps the three limits: approval at the bank, totals only, no money moved.
  assert.match(
    consentMessages.ca.scopeBankManage,
    /tu mateix al banc.*mai els teus moviments individuals.*no pot moure diners/,
  );
  assert.match(
    consentMessages.es.scopeBankManage,
    /tú mismo en el banco.*nunca tus movimientos individuales.*no puede mover dinero/,
  );

  // Messages are written into pages as they are: none may carry a quote or any tag but <strong>.
  const written = { authMessages, consentMessages, accountMessages, bankMessages, consentPageMessages };
  for (const [name, catalog] of Object.entries(written))
    for (const locale of ['en', 'ca', 'es'] as const)
      for (const [key, message] of Object.entries(catalog[locale] as Record<string, string>)) {
        assert.doesNotMatch(message, /["&]/, `${name}.${locale}.${key}`);
        assert.doesNotMatch(message.replace(/<\/?strong>/g, ''), /[<>]/, `${name}.${locale}.${key}`);
      }

  // A refusal worded by another layer is recognised by its English text; that text must still be in the source.
  const sources = [
    'packages/auth/accounts.ts',
    'packages/auth/oauth.ts',
    'packages/banks/sync.ts',
    'packages/finance/csv.ts',
    'packages/http/server.ts',
    'apps/profile-api/bank.ts',
    'apps/profile-api/statements.ts',
  ]
    .map(file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    .join('\n');
  for (const [key, english] of Object.entries(refusalMessages.en))
    for (const part of english.split(/\{\w+\}/))
      assert(sources.includes(part), `${key}: "${part}" is no longer thrown`);

  assert.equal(localizeRefusal('Enter a valid email address.', 'en'), 'Enter a valid email address.');
  assert.equal(
    localizeRefusal('Choose a new password of 10 to 200 characters.', 'ca'),
    'Tria una contrasenya nova d’entre 10 i 200 caràcters.',
  );
  assert.equal(
    localizeRefusal('Invalid transaction on data row 7. Use YYYY-MM-DD dates and signed amounts.', 'es'),
    'Movimiento no válido en la fila de datos 7. Usa fechas AAAA-MM-DD e importes con signo.',
  );
  // A wording nobody listed falls back to the error code, and without one stays as it was thrown.
  assert.equal(localizeRefusal('Slow down.', 'ca', 'throttled'), 'Massa intents. Espera una mica i torna-ho a provar.');
  assert.equal(localizeRefusal('Something a bank said', 'ca'), 'Something a bank said');
});
