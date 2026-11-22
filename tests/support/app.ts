import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AppOptions } from '../../apps/server/app.ts';
import { createApp } from '../../apps/server/app.ts';
import { accessConfig } from '../../packages/config/env.ts';
import { open } from '../../packages/db/database.ts';
import { createStore } from '../../packages/profiles/store.ts';

/**
 * The real ReloCat request handler over a private in-memory database, listening on a free port.
 * Four fictional personas (`user-001`…`user-004`) are created the way the fixtures are, so the
 * public demo has something to show. Nothing touches `data/` or the ports of a running server.
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
  const app = createApp({
    db,
    adminToken: 'admin-test-token',
    publicOrigin: null,
    port: () => port,
    access: accessConfig({ ...accessEnv }),
    // Every test request comes from this machine; the sign-in limits get their own tests.
    accounts: { throttle: { perAddress: 10_000, signUpsPerAddress: 10_000 } },
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
    origin,
    port,
    async close() {
      await app.close().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

/** A browser as far as these tests need one: a cookie jar and form posts that never follow redirects. */
export class Browser {
  cookies = new Map<string, string>();
  origin: string;
  constructor(origin: string) {
    this.origin = origin;
  }
  async request(
    path: string,
    init: { method?: string; form?: Record<string, string>; headers?: Record<string, string>; json?: unknown } = {},
  ) {
    const headers: Record<string, string> = { ...init.headers };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    let body: string | undefined;
    if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers.Origin ??= this.origin;
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
export async function registerClient(origin: string, metadata: Record<string, unknown> = {}) {
  const response = await fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    resource: `${browser.origin}/mcp`,
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
    resource: `${browser.origin}/mcp`,
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

export async function postForm(origin: string, path: string, fields: Record<string, string>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
