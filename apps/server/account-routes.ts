import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Accounts } from '../../packages/auth/accounts.ts';
import { AuthError } from '../../packages/auth/accounts.ts';
import type { OAuth } from '../../packages/auth/oauth.ts';
import { OAuthError } from '../../packages/auth/oauth.ts';
import { csrfToken, newSecret, verifyCsrf } from '../../packages/auth/secrets.ts';
import { storedCounts } from '../../packages/db/auth.ts';
import type { Database } from '../../packages/db/database.ts';
import {
  ApiError,
  parseCookies,
  readForm,
  readJson,
  redirect,
  sendHtml,
  serializeCookie,
} from '../../packages/http/server.ts';
import type { StoredSummary } from './pages.ts';
import { accountPage, consentPage, loginPage, logoutPage, messagePage, signUpPage } from './pages.ts';

/**
 * HTTP routes for accounts and OAuth on the one origin:
 *
 *   /signup /login /logout /account            server-rendered pages and their forms
 *   /oauth/authorize                           sign-in and consent for an MCP client
 *   /oauth/register /oauth/token /oauth/revoke machine endpoints (JSON or form bodies)
 *   /.well-known/oauth-protected-resource[/mcp]  /.well-known/oauth-authorization-server
 *
 * The logic lives in `packages/auth`; this file reads requests, sets cookies and renders pages.
 */

export type AccountRouteOptions = {
  db: Database;
  accounts: Accounts;
  oauth: OAuth;
  /** The origin a request was addressed to (already checked against the allowed hosts). */
  requestOrigin: (request: IncomingMessage) => string;
  /** Who sign-in attempts and registrations are counted as, and whether that key may be every visitor at once. */
  client: (request: IncomingMessage) => { address: string; shared: boolean };
  /** `PUBLIC_ORIGIN`, to explain a proxy that does not pass the original `Host`. */
  publicOrigin?: string | null;
  /** A person signed out: the server closes what their session had open. */
  onSignOut?: (userId: string) => void;
  /** Runs before an account's rows are deleted: bank connections leave the sync engine, streams close. */
  forgetPerson?: (userId: string) => Promise<unknown>;
  /** The resolved context of a person, for "what is stored about me". */
  context: (userId: string) => Promise<Record<string, unknown>>;
  /** False closes `/signup`; existing accounts keep working. */
  signUps: boolean;
};

const sessionCookie = (secure: boolean) => (secure ? '__Host-rc_session' : 'rc_session');
const preCookie = (secure: boolean) => (secure ? '__Host-rc_pre' : 'rc_pre');
const openCors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };

/** Where to go after signing in: only paths on this origin that a sign-in is meant to lead to. */
function safeNext(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000 || !value.startsWith('/') || /^\/[/\\]|[\r\n\\]/.test(value))
    return undefined;
  const path = value.split('?')[0];
  return ['/oauth/authorize', '/account', '/workspace', '/preview'].includes(path) ? value : undefined;
}

export function createAccountRoutes(options: AccountRouteOptions) {
  const { accounts, oauth } = options;
  const secureOf = (request: IncomingMessage) => options.requestOrigin(request).startsWith('https:');

  /** The signed-in account of a request and the raw session id (the CSRF key), or null. */
  function sessionOf(request: IncomingMessage) {
    const id = parseCookies(request)[sessionCookie(secureOf(request))];
    const session = accounts.session(id);
    return session && id ? { ...session, id } : null;
  }

  /**
   * The CSRF key of a visitor who is not signed in: a random cookie set on the first form page.
   * Returns the key and, when it had to be created, the cookie to set.
   */
  function preSession(request: IncomingMessage) {
    const secure = secureOf(request);
    const existing = parseCookies(request)[preCookie(secure)];
    if (existing && existing.length >= 32) return { key: existing, cookie: undefined };
    const key = newSecret('rc_p_');
    return { key, cookie: serializeCookie(preCookie(secure), key, { secure, maxAgeSeconds: 3600 }) };
  }

  /** A form post must come from this origin and carry the CSRF token of the session (or pre-session). */
  function assertForm(request: IncomingMessage, key: string | undefined, fields: Record<string, string>) {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== options.requestOrigin(request)) {
      // The page is ours but the request arrived under another name: a proxy replaced `Host`.
      if (origin === options.publicOrigin)
        throw new ApiError(
          403,
          'This server is behind a proxy that does not pass the original Host header, so it cannot check where this form came from. The operator must configure the proxy to preserve Host.',
        );
      throw new ApiError(403, 'This form was sent from another site.');
    }
    if (!verifyCsrf(key, fields.csrf))
      throw new ApiError(403, 'This form expired. Go back, reload the page and try again.');
  }

  function startBrowserSession(
    request: IncomingMessage,
    response: ServerResponse,
    session: { id: string; expiresAt: Date },
  ) {
    const secure = secureOf(request);
    response.appendHeader(
      'Set-Cookie',
      serializeCookie(sessionCookie(secure), session.id, {
        secure,
        maxAgeSeconds: (session.expiresAt.getTime() - Date.now()) / 1000,
      }),
    );
    response.appendHeader('Set-Cookie', serializeCookie(preCookie(secure), '', { secure, maxAgeSeconds: 0 }));
  }

  async function summary(account: {
    userId: string;
    createdAt: string;
    lastLoginAt: string | null;
  }): Promise<StoredSummary> {
    const counts = storedCounts(options.db, account.userId);
    const context = await options.context(account.userId).catch(() => ({}) as Record<string, unknown>);
    const data = ((context.resolved as { data?: Record<string, Record<string, unknown>> } | undefined)?.data ??
      {}) as Record<string, Record<string, unknown>>;
    const answers = Object.entries(data).flatMap(([group, fields]) =>
      Object.entries(fields ?? {})
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([field, value]) => ({
          field: `${group}.${field}`,
          value: typeof value === 'object' ? JSON.stringify(value) : String(value),
        })),
    );
    return {
      userId: account.userId,
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
      counts: [
        { label: 'Saved answer records', count: counts.inputs },
        { label: 'Bank accounts', count: counts.bankAccounts },
        { label: 'Bank movements', count: counts.bankMovements },
        { label: 'Bank connections', count: counts.bankConnections },
        { label: 'Habit goals', count: counts.habitGoals },
        { label: 'Habit check-ins', count: counts.habitCheckins },
      ],
      answers,
    };
  }

  /** `client_id:client_secret` from an HTTP Basic header, for confidential OAuth clients. */
  function basicClient(request: IncomingMessage) {
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(request.headers.authorization ?? '');
    if (!match) return undefined;
    const [id, ...secret] = Buffer.from(match[1], 'base64').toString('utf8').split(':');
    try {
      return { id: decodeURIComponent(id), secret: decodeURIComponent(secret.join(':')) };
    } catch {
      // RFC 6749 section 2.3.1 form-encodes both parts; credentials that do not decode are wrong credentials.
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
  }

  function sendOAuth(response: ServerResponse, status: number, body: unknown) {
    response
      .writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        ...openCors,
      })
      .end(JSON.stringify(body));
  }

  /** The machine endpoints. They take no cookie, so any origin may call them. */
  async function machine(request: IncomingMessage, response: ServerResponse, path: string) {
    const wellKnown = path.startsWith('/.well-known/');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...openCors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }).end();
      return true;
    }
    try {
      if (wellKnown && request.method === 'GET') {
        const body =
          path === '/.well-known/oauth-authorization-server'
            ? oauth.authorizationServerMetadata()
            : oauth.protectedResourceMetadata();
        response
          .writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'max-age=300',
            ...openCors,
          })
          .end(JSON.stringify(body));
        return true;
      }
      if (request.method !== 'POST') throw new OAuthError('invalid_request', 'Use POST', 405);
      if (path === '/oauth/register') {
        sendOAuth(response, 201, oauth.registerClient(await readJson(request, 16_384), options.client(request)));
        return true;
      }
      const fields = await readForm(request);
      if (path === '/oauth/token') sendOAuth(response, 200, oauth.token(fields, basicClient(request)));
      else {
        oauth.revoke(fields, basicClient(request));
        sendOAuth(response, 200, {});
      }
    } catch (error) {
      if (error instanceof OAuthError) {
        if (error.status === 401) response.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
        if (error.retryAfterSeconds) response.setHeader('Retry-After', String(error.retryAfterSeconds));
        sendOAuth(response, error.status, { error: error.error, error_description: error.message });
      } else if (error instanceof ApiError)
        sendOAuth(response, error.status, { error: 'invalid_request', error_description: error.message });
      else sendOAuth(response, 500, { error: 'server_error', error_description: 'The request could not be completed' });
    }
    return true;
  }

  /** `GET` and `POST /oauth/authorize`: validate, require a sign-in, show consent, then redirect back. */
  async function authorize(request: IncomingMessage, response: ServerResponse, url: URL) {
    const posted = request.method === 'POST' ? await readForm(request) : null;
    const params = posted ?? Object.fromEntries(url.searchParams);
    const validated = oauth.validateAuthorize(params);
    if ('kind' in validated) {
      if (validated.kind === 'redirect') return redirect(response, validated.location, 302);
      return sendHtml(response, 400, messagePage('This connection cannot continue', validated.message));
    }
    const session = sessionOf(request);
    const replay: Record<string, string> = {};
    for (const name of [
      'response_type',
      'client_id',
      'redirect_uri',
      'state',
      'scope',
      'resource',
      'code_challenge',
      'code_challenge_method',
    ]) {
      if (typeof params[name] === 'string') replay[name] = params[name];
    }
    if (!session) {
      // Sign in first, then come back to this same request.
      const next = `/oauth/authorize?${new URLSearchParams(replay)}`;
      return redirect(response, `/login?next=${encodeURIComponent(next)}`, 302);
    }
    const target = new URL(validated.redirectUri);
    const formAction = [/^https?:$/.test(target.protocol) ? target.origin : target.protocol];
    if (!posted)
      return sendHtml(
        response,
        200,
        consentPage({
          csrf: session.csrf,
          account: session.account,
          client: validated.client,
          redirectUri: validated.redirectUri,
          scopes: validated.scopes,
          params: replay,
        }),
        formAction,
      );
    assertForm(request, session.id, posted);
    const location = posted.decision === 'allow' ? oauth.approve(session.account.id, validated) : oauth.deny(validated);
    return redirect(response, location, 303);
  }

  async function pages(request: IncomingMessage, response: ServerResponse, url: URL) {
    const path = url.pathname;
    const get = request.method === 'GET';
    const post = request.method === 'POST';
    if (!get && !post) throw new ApiError(405, 'Method not allowed');
    if (path === '/oauth/authorize') return authorize(request, response, url);
    const session = sessionOf(request);
    const client = options.client(request);

    if (path === '/signup' || path === '/login') {
      const signUp = path === '/signup';
      const pre = preSession(request);
      if (pre.cookie) response.appendHeader('Set-Cookie', pre.cookie);
      const csrf = csrfToken(pre.key);
      if (get) {
        const next = safeNext(url.searchParams.get('next'));
        if (session) return redirect(response, next ?? '/account');
        if (signUp) return sendHtml(response, 200, signUpPage({ csrf, next, closed: !options.signUps }));
        return sendHtml(response, 200, loginPage({ csrf, next }));
      }
      const fields = await readForm(request);
      const next = safeNext(fields.next);
      try {
        assertForm(request, pre.cookie ? undefined : pre.key, fields);
        if (signUp) {
          if (!options.signUps) throw new ApiError(403, 'New accounts are closed on this server.');
          const account = await accounts.signUp({ email: fields.email, password: fields.password, ...client });
          startBrowserSession(request, response, accounts.startSession(account.id));
        } else {
          const { session: started } = await accounts.login({
            email: fields.email,
            password: fields.password,
            ...client,
          });
          // Rotation: the browser leaves with a new session id; one it arrived with is ended.
          accounts.logout(parseCookies(request)[sessionCookie(secureOf(request))]);
          startBrowserSession(request, response, started);
        }
        return redirect(response, next ?? '/account');
      } catch (error) {
        const message =
          error instanceof AuthError || error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
        const status =
          error instanceof AuthError && error.code === 'throttled'
            ? 429
            : error instanceof ApiError
              ? error.status
              : 400;
        if (error instanceof AuthError && error.retryAfterSeconds)
          response.setHeader('Retry-After', String(error.retryAfterSeconds));
        const email = typeof fields.email === 'string' ? fields.email.slice(0, 254) : undefined;
        const page = signUp
          ? signUpPage({ csrf, next, email, error: message })
          : loginPage({ csrf, next, email, error: message });
        return sendHtml(response, status, page);
      }
    }

    if (path === '/logout') {
      if (!session) return redirect(response, '/login');
      if (get) return sendHtml(response, 200, logoutPage({ csrf: session.csrf, account: session.account }));
      assertForm(request, session.id, await readForm(request));
      accounts.logout(session.id);
      options.onSignOut?.(session.account.userId);
      const secure = secureOf(request);
      response.appendHeader('Set-Cookie', serializeCookie(sessionCookie(secure), '', { secure, maxAgeSeconds: 0 }));
      return redirect(response, '/login');
    }

    if (path === '/account' && get) {
      if (!session) return redirect(response, '/login?next=%2Faccount');
      const notice = { disconnected: 'Access removed.' }[url.searchParams.get('done') ?? ''];
      return sendHtml(
        response,
        200,
        accountPage({
          csrf: session.csrf,
          account: session.account,
          stored: await summary(session.account),
          clients: oauth.connectedClients(session.account.id),
          notice,
        }),
      );
    }

    if ((path === '/account/disconnect' || path === '/account/delete') && post) {
      if (!session) return redirect(response, '/login?next=%2Faccount');
      const fields = await readForm(request);
      assertForm(request, session.id, fields);
      if (path === '/account/disconnect') {
        oauth.disconnect(session.account.id, fields.grant ?? '');
        return redirect(response, '/account?done=disconnected');
      }
      try {
        if (fields.confirm !== 'yes')
          throw new AuthError('invalid_credentials', 'Tick the box to confirm the deletion.');
        // Counted for this session only: no stranger's wrong guesses can stand between a person and this.
        await accounts.deleteAccount(session.account.id, fields.password, {
          sessionId: session.id,
          beforeDelete: options.forgetPerson,
        });
      } catch (error) {
        const message = error instanceof AuthError ? error.message : 'The account could not be deleted.';
        if (error instanceof AuthError && error.retryAfterSeconds)
          response.setHeader('Retry-After', String(error.retryAfterSeconds));
        return sendHtml(
          response,
          error instanceof AuthError && error.code === 'throttled' ? 429 : 400,
          accountPage({
            csrf: session.csrf,
            account: session.account,
            stored: await summary(session.account),
            clients: oauth.connectedClients(session.account.id),
            error: message,
          }),
        );
      }
      const secure = secureOf(request);
      response.appendHeader('Set-Cookie', serializeCookie(sessionCookie(secure), '', { secure, maxAgeSeconds: 0 }));
      return sendHtml(
        response,
        200,
        messagePage(
          'Your account was deleted',
          'Your account, your answers and every connection were removed from ReloCat.',
        ),
      );
    }
    throw new ApiError(404, 'Not found');
  }

  const machinePaths = new Set([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/oauth/register',
    '/oauth/token',
    '/oauth/revoke',
  ]);
  const pagePaths = new Set([
    '/signup',
    '/login',
    '/logout',
    '/account',
    '/account/disconnect',
    '/account/delete',
    '/oauth/authorize',
  ]);

  return {
    sessionOf,
    /** Handle the request when it is an account or OAuth route. Returns false when it is not. */
    async handle(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (machinePaths.has(url.pathname)) return machine(request, response, url.pathname);
      if (!pagePaths.has(url.pathname)) return false;
      try {
        await pages(request, response, url);
      } catch (error) {
        if (response.headersSent) response.destroy();
        else if (error instanceof ApiError)
          sendHtml(response, error.status, messagePage('That did not work', error.message));
        else sendHtml(response, 500, messagePage('Something went wrong', 'Try again in a moment.'));
      }
      return true;
    },
  };
}
