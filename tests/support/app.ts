import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { AppOptions } from '../../apps/server/app.ts';
import { createApp } from '../../apps/server/app.ts';
import { accessConfig } from '../../packages/config/env.ts';
import { open } from '../../packages/db/database.ts';
import { createStore } from '../../packages/profiles/store.ts';

/**
 * The real ReloCat request handler over a private in-memory database, listening on a free port.
 * Four fictional personas (`user-001`…`user-004`) are created the way the fixtures are, so the
 * public demo has something to show. Nothing touches `data/` or the ports of a running server.
 *
 * This is the local shape: no `PUBLIC_ORIGIN`, every request straight from this machine, and the
 * sign-in limits at their defaults. `startProductionApp` is the deployed shape.
 */
export async function startApp(overrides: Partial<AppOptions> & { accessEnv?: Record<string, string> } = {}) {
  const db = open(':memory:');
  const doc = { schemaVersion: 1, synthetic: true };
  for (let n = 1; n <= 4; n++) {
    const id = `user-00${n}`;
    await createStore(db).create(id, {
      details: { ...doc, id, householdSize: 3, currentMunicipality: 'Lleida' },
      preferences: { ...doc, goal: 'buy_primary_home', housingBudgetCents: 13_000_000, minimumBedrooms: 2 },
      'bank-account': {
        ...doc,
        snapshotDate: '2026-11-01',
        balanceCents: 1_840_000,
        monthlyIncomeCents: 290_000,
        monthlyExpensesCents: 208_000,
        debtPaymentsCents: 10_000,
      },
    });
  }
  let port = 0;
  const { accessEnv, ...options } = overrides;
  /** Operator warnings the app raised, kept out of the test output. */
  const warnings: string[] = [];
  const app = createApp({
    db,
    adminToken: 'admin-test-token',
    publicOrigin: null,
    port: () => port,
    access: accessConfig({ ...accessEnv }),
    warn: message => void warnings.push(message),
    ...options,
  });
  const server = createServer(app.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  port = address.port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    app,
    db,
    /** Where requests are sent. */
    origin,
    /** The origin the server believes it has: links, the OAuth issuer and the `Origin` of its own forms. */
    site: options.publicOrigin ?? origin,
    sessionCookie: 'rc_session',
    secure: false,
    shape: 'local' as string,
    warnings,
    port,
    browser: (client?: string) => new Browser(origin, options.publicOrigin ?? origin, client),
    async close() {
      await app.close().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

/** The header a test puts on a request to say which visitor it is; the test proxy turns it into `X-Forwarded-For`. */
const clientHeader = 'x-test-client';
export const productionSite = 'https://relocat.test';

export type ProxyMode =
  /** A correctly configured reverse proxy: the original `Host` is passed on and the visitor is appended to `X-Forwarded-For`. */
  | 'forwarding'
  /** A proxy that passes `Host` but states no client address at all. */
  | 'no-address'
  /** nginx's default `proxy_pass`: `Host` becomes the upstream's and no forwarding header is added. */
  | 'nginx-default';

/**
 * A small reverse proxy in front of an app, so the app sees what it sees when deployed: every
 * connection comes from the proxy's address, with the public host name in `Host`. Visitors are
 * told apart only by what the proxy writes in `X-Forwarded-For`.
 */
export async function startProxy(upstreamPort: number, mode: ProxyMode, publicHost: string) {
  const server: Server = createServer((incoming, outgoing) => {
    const headers: Record<string, string | string[] | undefined> = { ...incoming.headers };
    const visitor = String(headers[clientHeader] ?? '198.51.100.7');
    delete headers[clientHeader];
    // Whatever a visitor wrote in these headers stays; a real proxy appends to it or leaves it.
    if (mode === 'forwarding') {
      const sent = headers['x-forwarded-for'];
      headers['x-forwarded-for'] = sent ? `${String(sent)}, ${visitor}` : visitor;
      headers['x-forwarded-proto'] = 'https';
    }
    headers.host = mode === 'nginx-default' ? `127.0.0.1:${upstreamPort}` : publicHost;
    const forwarded = httpRequest(
      { host: '127.0.0.1', port: upstreamPort, method: incoming.method, path: incoming.url, headers },
      answer => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    forwarded.on('error', () => outgoing.writeHead(502).end());
    outgoing.on('close', () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/**
 * The deployed shape: `NODE_ENV=production`, a `PUBLIC_ORIGIN`, every limit at its default, and
 * every request arriving through a reverse proxy on this machine. `proxy` chooses how well that
 * proxy is configured; `clientAddress` is the server's `CLIENT_IP_HEADER` setting.
 */
export async function startProductionApp(
  overrides: Partial<AppOptions> & { accessEnv?: Record<string, string>; proxy?: ProxyMode } = {},
) {
  const { proxy: mode = 'forwarding', accessEnv, ...options } = overrides;
  const server = await startApp({
    publicOrigin: productionSite,
    accessEnv: { NODE_ENV: 'production', PUBLIC_ORIGIN: productionSite, ...accessEnv },
    ...options,
    rateLimit: { clientAddress: { kind: 'x-forwarded-for', trustedHops: 1 }, ...options.rateLimit },
  });
  const proxy = await startProxy(server.port, mode, new URL(productionSite).host);
  return {
    ...server,
    /** Where requests are sent: the proxy. */
    origin: proxy.origin,
    /** Straight to the server, around the proxy. */
    direct: server.origin,
    site: productionSite,
    sessionCookie: '__Host-rc_session',
    secure: true,
    shape: `production (${mode})`,
    browser: (client?: string) => new Browser(proxy.origin, productionSite, client),
    async close() {
      await proxy.close();
      await server.close();
    },
  };
}

/** Both shapes, for tests that must hold on a laptop and behind a proxy alike. */
export const shapes = [
  { name: 'local', start: startApp },
  { name: 'production', start: startProductionApp },
] as const;

/** A browser as far as these tests need one: a cookie jar and form posts that never follow redirects. */
export class Browser {
  cookies = new Map<string, string>();
  /** Where requests are sent. */
  origin: string;
  /** The origin the pages believe they are on: the `Origin` header of a form post. */
  site: string;
  /** The visitor's address, as a test proxy reports it. */
  client: string | undefined;
  constructor(origin: string, site = origin, client?: string) {
    this.origin = origin;
    this.site = site;
    this.client = client;
  }
  async request(
    path: string,
    init: { method?: string; form?: Record<string, string>; headers?: Record<string, string>; json?: unknown } = {},
  ) {
    const headers: Record<string, string> = { ...init.headers };
    if (this.client) headers[clientHeader] = this.client;
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    let body: string | undefined;
    if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers.Origin ??= this.site;
      body = new URLSearchParams(init.form).toString();
    } else if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const response = await fetch(new URL(path, this.origin), {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      redirect: 'manual',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, ...value] = pair.split('=');
      if (/Max-Age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value.join('='));
    }
    return response;
  }
  /** The hidden CSRF field of the form on a page. */
  async csrf(path: string) {
    const html = await (await this.request(path)).text();
    const match = /name="csrf" value="([^"]+)"/.exec(html);
    if (!match) throw new Error(`No CSRF field on ${path}`);
    return match[1];
  }
  async signUp(email: string, password = 'correct horse battery') {
    const csrf = await this.csrf('/signup');
    return this.request('/signup', { form: { csrf, email, password } });
  }
  async login(email: string, password = 'correct horse battery') {
    const csrf = await this.csrf('/login');
    return this.request('/login', { form: { csrf, email, password } });
  }
}

export function pkce() {
  const verifier = randomBytes(40).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const redirectUri = 'https://client.example/callback';

/** Register a public client the way an MCP client does. */
export async function registerClient(origin: string, metadata: Record<string, unknown> = {}, client?: string) {
  const response = await fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(client ? { [clientHeader]: client } : {}) },
    body: JSON.stringify({ client_name: 'Test client', redirect_uris: [redirectUri], ...metadata }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

/**
 * The whole authorization-code flow for a signed-in browser: register a client, consent, exchange
 * the code. Returns the tokens and the client id.
 */
export async function connectClient(browser: Browser, scope = 'person:read person:write') {
  const { body: client } = await registerClient(browser.origin);
  const { verifier, challenge } = pkce();
  const params = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state: 'state-123',
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${browser.site}/mcp`,
  };
  const query = `/oauth/authorize?${new URLSearchParams(params)}`;
  const csrf = await browser.csrf(query);
  const decision = await browser.request('/oauth/authorize', { form: { ...params, csrf, decision: 'allow' } });
  const location = new URL(decision.headers.get('location') ?? 'http://missing');
  const code = location.searchParams.get('code') ?? '';
  const token = await postForm(browser.origin, '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: redirectUri,
    resource: `${browser.site}/mcp`,
  });
  return {
    clientId: client.client_id,
    redirectUri,
    location,
    code,
    verifier,
    tokens: token.body,
    status: token.status,
  };
}

export async function postForm(
  origin: string,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

/** One stateless `tools/call` (or any JSON-RPC method) against `/mcp`, with optional credentials. */
export async function mcp(
  origin: string,
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await response.json()) as {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: { text: string }[];
      _meta?: Record<string, unknown>;
    };
    error?: { code: number; message: string };
  };
  return { status: response.status, headers: response.headers, ...body };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
