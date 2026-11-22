import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createHabitStore } from '../apps/habits-agent/store.ts';
import { createMcpServer } from '../apps/mcp-server/tools.ts';
import { AuthError, createAccounts } from '../packages/auth/accounts.ts';
import { hashPassword, verifyPassword } from '../packages/auth/passwords.ts';
import { csrfToken, verifyCsrf } from '../packages/auth/secrets.ts';
import { accessConfig, envText, publicOriginConfig } from '../packages/config/env.ts';
import { remainingRows } from '../packages/db/auth.ts';
import { open } from '../packages/db/database.ts';
import { loadData } from '../packages/places/data.ts';
import { Browser, bearer, connectClient, mcp, pkce, postForm, registerClient, startApp } from './support/app.ts';

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

test('sign-in is throttled per account and per address, and unlocks after the lock time', async () => {
  const db = open(':memory:');
  let now = Date.parse('2026-11-22T10:00:00Z');
  const accounts = createAccounts(db, {
    now: () => new Date(now),
    throttle: { perAccount: 3, perAddress: 5, windowMs: 60_000, lockMs: 120_000 },
  });
  await accounts.signUp({ email: 'ada@example.com', password, address: 'signup' });
  await accounts.signUp({ email: 'bob@example.com', password, address: 'signup' });
  const attempt = (email: string, secret: string, address: string) =>
    accounts.login({ email, password: secret, address });
  for (let n = 0; n < 3; n++)
    await assert.rejects(attempt('ada@example.com', 'wrong', `ip-${n}`), { code: 'invalid_credentials' });
  // The right password does not get through a locked account, from any address.
  const locked = await attempt('ada@example.com', password, 'ip-9').catch(error => error as AuthError);
  assert(locked instanceof AuthError && locked.code === 'throttled' && locked.retryAfterSeconds > 0);
  // Another account is not affected by that lock.
  await attempt('bob@example.com', password, 'ip-9');
  now += 121_000;
  await attempt('ada@example.com', password, 'ip-9');

  // One address trying many accounts is locked as an address.
  for (let n = 0; n < 5; n++)
    await assert.rejects(attempt(`guess${n}@example.com`, 'wrong', 'attacker'), { code: 'invalid_credentials' });
  await assert.rejects(attempt('bob@example.com', password, 'attacker'), { code: 'throttled' });
  await attempt('bob@example.com', password, 'elsewhere');
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

test('sign-up, sign-in and sign-out over HTTP: cookies, CSRF and security headers', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const browser = new Browser(server.origin);

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
  assert.equal((await new Browser(server.origin).request('/signup', { form: { ...form, csrf } })).status, 403);
  const crossSite = await browser.request('/signup', {
    form: { ...form, csrf },
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(server.db.get('SELECT 1 FROM accounts'), undefined);

  const created = await browser.request('/signup', { form: { ...form, csrf } });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/account');
  const cookie = created.headers.getSetCookie().find(value => value.startsWith('rc_session='));
  assert(cookie && /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie) && /Path=\//.test(cookie));
  assert.doesNotMatch(cookie, /Secure/, 'plain HTTP on localhost cannot carry a Secure cookie');
  const firstSession = browser.cookies.get('rc_session');

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
  assert.notEqual(browser.cookies.get('rc_session'), firstSession);
  const stale = new Browser(server.origin);
  stale.cookies.set('rc_session', firstSession ?? '');
  assert.equal((await stale.request('/account')).status, 303);

  // An open redirect through ?next is not possible.
  for (const next of ['https://evil.example', '//evil.example', '/\\evil.example', '/api/users']) {
    const fresh = new Browser(server.origin);
    const token = await fresh.csrf('/login');
    const response = await fresh.request('/login', { form: { csrf: token, email: 'ada@example.com', password, next } });
    assert.equal(response.headers.get('location'), '/account', next);
  }
});

test('the account page escapes what it prints, lists connected clients, revokes them and deletes everything', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const browser = new Browser(server.origin);
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
  const stranger = new Browser(server.origin);
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

test('OAuth 2.1 for MCP: discovery, registration, PKCE, tokens, refresh rotation, reuse detection and revocation', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin } = server;

  // 1. An anonymous call to a personal tool is a 401 that tells the client where to start.
  const challenge = await mcp(origin, 'get_person');
  assert.equal(challenge.status, 401);
  const header = challenge.headers.get('www-authenticate') ?? '';
  assert.match(header, new RegExp(`^Bearer resource_metadata="${origin}/\\.well-known/oauth-protected-resource"`));
  assert.match(header, /scope="person:read person:write"/);
  assert.deepEqual(challenge.result?._meta?.['mcp/www_authenticate'], [header]);
  assert.equal(challenge.result?.isError, true);

  // 2. Discovery.
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const resource = (await (await fetch(origin + path)).json()) as Record<string, unknown>;
    assert.deepEqual(resource.authorization_servers, [origin]);
    assert.equal(resource.resource, `${origin}/mcp`);
  }
  const metadata = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as Record<
    string,
    unknown
  >;
  assert.equal(metadata.issuer, origin);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.registration_endpoint, `${origin}/oauth/register`);
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
    resource: `${origin}/mcp`,
  };
  const authorizeUrl = (params: Record<string, string>) => `/oauth/authorize?${new URLSearchParams(params)}`;
  const browser = new Browser(origin);
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
    assert.equal(back.searchParams.get('iss'), origin);
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
  assert.equal(back.searchParams.get('iss'), origin);

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
    resource: `${origin}/mcp`,
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
  const resolved = inputs.result?.structuredContent?.resolved as { data: { finance: { monthlyIncomeCents: number } } };
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
  const foreign = await postForm(origin, '/oauth/revoke', { token: third.tokens.access_token, client_id: otherClient });
  assert.equal(foreign.status, 200);
  assert.equal(
    (await mcp(origin, 'get_person', {}, bearer(third.tokens.access_token))).status,
    200,
    'another client cannot revoke it',
  );
  assert.equal(
    (await postForm(origin, '/oauth/revoke', { token: third.tokens.refresh_token, client_id: third.clientId })).status,
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
  ['save_my_inputs', { data: { household: { size: 4 } }, confirmed: true }],
  ['get_bank_summary', { from: '2026-08-01', to: '2026-10-31' }],
  ['get_bank_updates', {}],
  ['get_bank_runtime', {}],
  ['plan_home_savings', { me: true, municipalityCodes: ['251207'] }],
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
  const tokenA = (await connectClient(a)).tokens.access_token;
  const tokenB = (await connectClient(b)).tokens.access_token;
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
