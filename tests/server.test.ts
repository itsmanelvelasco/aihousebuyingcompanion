import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The real entry point, `apps/server/index.ts`, started as its own process the way a deployment
 * starts it: `NODE_ENV=production`, a `PUBLIC_ORIGIN`, a database file and spare ports. The test
 * plays the reverse proxy: every request comes from this machine with the public host name in
 * `Host` and the visitor in `X-Forwarded-For`. Nothing touches `data/` or a running server.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const site = 'https://relocat.test';
const publicHost = new URL(site).host;
const password = 'correct horse battery';

/** A port nothing listens on right now. */
async function sparePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  await new Promise(resolve => probe.close(resolve));
  if (!address || typeof address === 'string') throw new Error('No port');
  return address.port;
}

type Started = {
  child: ChildProcess;
  port: number;
  /** Everything the process wrote so far. */
  output: () => string;
  /** Resolves with the exit code. */
  exited: Promise<number | null>;
  stop: () => Promise<void>;
};

/** Start the entry point with a production-shaped environment in `directory`; `env` overrides it. */
function start(directory: string, port: number, env: Record<string, string | undefined> = {}): Started {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_ORIGIN: site,
    CLIENT_IP_HEADER: 'x-forwarded-for',
    TRUSTED_PROXY_HOPS: '1',
    DATABASE_FILE: join(directory, 'db', 'relocat.db'),
    DATA_CACHE_DIR: join(directory, 'cache'),
    PROFILE_DATA_DIR: join(directory, 'no-legacy-profiles'),
    HABITS_DATA_DIR: join(directory, 'no-legacy-habits'),
    LIVE_DATA: 'off',
    // Whatever the developer's shell has set must not leak into the shape under test.
    TRUST_PROXY: undefined,
    ALLOWED_HOSTS: undefined,
    ALLOWED_ORIGINS: undefined,
    PUBLIC_DEMO: undefined,
    SHARED_BOARD: undefined,
    SIGNUPS: undefined,
    PROFILE_API_TOKEN: undefined,
    OPENAI_API_KEY: undefined,
    TREG_TOKEN: undefined,
    NODE_TEST_CONTEXT: undefined,
    ...env,
  };
  for (const name of Object.keys(environment)) if (environment[name] === undefined) delete environment[name];
  const child = spawn(process.execPath, ['apps/server/index.ts'], {
    cwd: root,
    env: environment as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout?.on('data', chunk => (text += chunk));
  child.stderr?.on('data', chunk => (text += chunk));
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  return {
    child,
    port,
    output: () => text,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

/** One request as the reverse proxy would hand it over. */
function call(
  port: number,
  path: string,
  options: {
    method?: string;
    host?: string;
    visitor?: string | null;
    headers?: Record<string, string>;
    form?: Record<string, string>;
    json?: unknown;
  } = {},
) {
  const headers: Record<string, string> = { Host: options.host ?? publicHost, ...options.headers };
  if (options.visitor !== null) headers['X-Forwarded-For'] = options.visitor ?? '203.0.113.5';
  let body: string | undefined;
  if (options.form) {
    body = new URLSearchParams(options.form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers.Origin ??= site;
  } else if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['Content-Type'] = 'application/json';
  }
  if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
  return new Promise<Reply>((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers },
      response => {
        let text = '';
        response.on('data', chunk => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

/** The exit code, or `'still running'` when the process has not exited after `ms`. */
function exitWithin(server: Started, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>(resolve => {
    timer = setTimeout(resolve, ms, 'still running');
  });
  return Promise.race([server.exited, late]).finally(() => clearTimeout(timer));
}

/** Wait until the server answers `/health`, or fail with what it printed. */
async function ready(server: Started) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (server.child.exitCode !== null) break;
    const reply = await call(server.port, '/health').catch(() => null);
    if (reply?.status === 200) return JSON.parse(reply.body) as Record<string, unknown>;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await server.stop();
  return assert.fail(`The server did not become ready:\n${server.output()}`);
}

/** The cookies of a reply as a `Cookie` header, merged over the ones already held. */
function cookies(reply: Reply, held = new Map<string, string>()) {
  for (const cookie of reply.headers['set-cookie'] ?? []) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (/Max-Age=0/i.test(cookie)) held.delete(pair.slice(0, index));
    else held.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return held;
}
const cookieHeader = (held: Map<string, string>) => ({
  Cookie: [...held].map(([name, value]) => `${name}=${value}`).join('; '),
});
const csrfOf = (reply: Reply) => /name="csrf" value="([^"]+)"/.exec(reply.body)?.[1] ?? '';

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'relocat-server-'));
  return {
    directory,
    remove: () => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

test('the entry point in a production shape: sign-up, sign-in, a personal call, hosts and what it logs', async t => {
  const { directory, remove } = await scratch();
  const server = start(directory, await sparePort());
  t.after(async () => {
    await server.stop();
    await remove();
  });
  const health = await ready(server);
  const { port } = server;

  // /health: the schema version of the database, how client addresses are determined, and no path.
  assert.equal(health.status, 'ok');
  assert.equal(typeof (health.database as { schemaVersion: number }).schemaVersion, 'number');
  assert.deepEqual(Object.keys(health.database as object), ['schemaVersion']);
  assert.doesNotMatch(JSON.stringify(health), /relocat\.db|relocat-server-/);
  assert.equal(health.publicDemo, false, 'production closes the public demo unless it is switched on');
  assert.equal((health.clientAddress as { mode: string }).mode, 'x-forwarded-for (1 trusted hop(s))');

  // The Host allowlist: the public host and localhost on the port; nothing else, the apex included.
  for (const host of ['evil.example', 'test', `relocat.test.evil.example`, `127.0.0.1:${port + 1}`])
    assert.equal((await call(port, '/health', { host })).status, 421, host);
  for (const host of [publicHost, publicHost.toUpperCase(), `127.0.0.1:${port}`, `localhost:${port}`])
    assert.equal((await call(port, '/health', { host })).status, 200, host);

  // Sign up through the "proxy": the session cookie is Secure with the __Host- prefix.
  const page = await call(port, '/signup');
  assert.equal(page.status, 200);
  const jar = cookies(page);
  const created = await call(port, '/signup', {
    headers: cookieHeader(jar),
    form: { csrf: csrfOf(page), email: 'ada@example.com', password },
  });
  assert.equal(created.status, 303, created.body);
  const sessionCookie = (created.headers['set-cookie'] ?? []).find(value => value.startsWith('__Host-rc_session='));
  assert(sessionCookie && /; Secure/.test(sessionCookie) && /HttpOnly/.test(sessionCookie), String(sessionCookie));

  // Sign in from a fresh browser, with a wrong password first.
  const loginPage = await call(port, '/login');
  const browser = cookies(loginPage);
  const wrong = await call(port, '/login', {
    headers: cookieHeader(browser),
    form: { csrf: csrfOf(loginPage), email: 'ada@example.com', password: 'not the password' },
  });
  assert.equal(wrong.status, 400);
  const signedIn = await call(port, '/login', {
    headers: cookieHeader(browser),
    form: { csrf: csrfOf(loginPage), email: 'ada@example.com', password },
  });
  assert.equal(signedIn.status, 303, signedIn.body);
  cookies(signedIn, browser);
  assert(browser.has('__Host-rc_session'));

  // A personal call with that session: the MCP tool answers for the caller's own person...
  const mcp = (headers: Record<string, string>) =>
    call(port, '/mcp', {
      headers: { Accept: 'application/json, text/event-stream', ...headers },
      json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_person', arguments: {} } },
    });
  const anonymous = await mcp({});
  assert.equal(anonymous.status, 401);
  assert.match(String(anonymous.headers['www-authenticate']), /resource_metadata="https:\/\/relocat\.test\//);
  const mine = await mcp({ ...cookieHeader(browser), Origin: site });
  assert.equal(mine.status, 200, mine.body);
  const person = (JSON.parse(mine.body) as { result: { structuredContent: { id: string; synthetic: boolean } } }).result
    .structuredContent;
  assert.match(person.id, /^p-[0-9a-f]{30}$/);
  assert.equal(person.synthetic, false);
  // ...and /api serves that person to the session, and nobody else's.
  const context = await call(port, `/api/users/${person.id}/context`, { headers: cookieHeader(browser) });
  assert.equal(context.status, 200, context.body);
  assert.equal((await call(port, '/api/users/user-001/context', { headers: cookieHeader(browser) })).status, 403);
  assert.equal((await call(port, `/api/users/${person.id}/context`)).status, 401);

  // The connect page offers the address this deployment answers on, and OAuth metadata agrees.
  assert.match(
    (await call(port, '/connect')).body,
    /<input id="endpoint" type="url" value="https:\/\/relocat\.test\/mcp"/,
  );
  const metadata = JSON.parse((await call(port, '/.well-known/oauth-authorization-server')).body) as { issuer: string };
  assert.equal(metadata.issuer, site);

  // The start-up log says what a proxy has to match.
  const log = server.output();
  assert.match(log, /origin {4}https:\/\/relocat\.test/);
  assert.match(log, /client address from X-Forwarded-For, 1 trusted proxy/);
  assert.match(log, /must pass the original Host header \(relocat\.test\)/);
  assert.doesNotMatch(log, /WARNING/, 'every request carried a client address');
  assert(existsSync(join(directory, 'db', 'relocat.db')), 'the database is where DATABASE_FILE says');
});

test('the entry point refuses to start in production until it is told where client addresses come from', async t => {
  const { directory, remove } = await scratch();
  t.after(remove);
  const cases: Record<string, string | undefined>[] = [
    { CLIENT_IP_HEADER: undefined },
    { CLIENT_IP_HEADER: 'auto' },
    { CLIENT_IP_HEADER: '' },
    // A PUBLIC_ORIGIN alone makes it a public deployment, also without NODE_ENV.
    { CLIENT_IP_HEADER: undefined, NODE_ENV: undefined, DEMO_BANK: 'off' },
  ];
  for (const env of cases) {
    const server = start(directory, await sparePort(), env);
    const code = await exitWithin(server, 20_000);
    await server.stop();
    assert.equal(code, 1, `${JSON.stringify(env)}\n${server.output()}`);
    assert.match(server.output(), /The server did not start\./);
    assert.match(server.output(), /CLIENT_IP_HEADER=x-forwarded-for/);
    assert.match(server.output(), /CLIENT_IP_HEADER=none/);
  }
  assert(!existsSync(join(directory, 'db')), 'it stopped before creating a database');
});

test('with CLIENT_IP_HEADER=none the entry point starts, warns and flags /health when visitors cannot be told apart', async t => {
  const { directory, remove } = await scratch();
  const server = start(directory, await sparePort(), { CLIENT_IP_HEADER: 'none' });
  t.after(async () => {
    await server.stop();
    await remove();
  });
  const before = await ready(server);
  assert.equal((before.clientAddress as { ok: boolean }).ok, true, 'nothing was counted yet');
  assert.match(server.output(), /client address from the connecting address \(none\)/);
  assert.equal((await call(server.port, '/connect')).status, 200);
  const after = JSON.parse((await call(server.port, '/health')).body) as {
    clientAddress: { ok: boolean; mode: string; undeterminedRequests: number };
  };
  assert.deepEqual(
    [after.clientAddress.ok, after.clientAddress.mode, after.clientAddress.undeterminedRequests],
    [false, 'none', 1],
  );
  for (let attempt = 0; attempt < 50 && !/WARNING/.test(server.output()); attempt++)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(
    server.output(),
    /WARNING: 1 request\(s\) arrived without a usable client address \(CLIENT_IP_HEADER=none/,
  );
});

test('the entry point exits with status 1 when its port is taken', async t => {
  const { directory, remove } = await scratch();
  const holder = createServer((_request, response) => response.end('busy'));
  holder.listen(0, '127.0.0.1');
  await once(holder, 'listening');
  const address = holder.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const server = start(directory, address.port);
  t.after(async () => {
    await server.stop();
    await new Promise(resolve => holder.close(resolve));
    await remove();
  });
  const code = await exitWithin(server, 30_000);
  assert.equal(code, 1, server.output());
  assert.match(server.output(), new RegExp(`Port ${address.port} on 127\\.0\\.0\\.1 is already in use`));
});
