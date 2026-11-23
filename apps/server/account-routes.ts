import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Accounts, AuthErrorCode } from '../../packages/auth/accounts.ts';
import { AuthError } from '../../packages/auth/accounts.ts';
import type { OAuth } from '../../packages/auth/oauth.ts';
import { OAuthError } from '../../packages/auth/oauth.ts';
import { csrfToken, newSecret, verifyCsrf } from '../../packages/auth/secrets.ts';
import type { BankSync } from '../../packages/banks/sync.ts';
import { storedCounts } from '../../packages/db/auth.ts';
import type { Database } from '../../packages/db/database.ts';
import { DatabaseBusyError } from '../../packages/db/database.ts';
import {
  ApiError,
  parseCookies,
  readForm,
  readJson,
  readMultipart,
  redirect,
  sendHtml,
  serializeCookie,
} from '../../packages/http/server.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { localeCookie, requestLocale } from '../../packages/i18n/server.ts';
import type { createBankStore } from '../profile-api/bank.ts';
import { dateSchema, manualAccountId } from '../profile-api/bank.ts';
import type { StatementImports } from '../profile-api/statements.ts';
import { maxStatementBytes } from '../profile-api/statements.ts';
import { accountMessages, type StoredCountKey } from './account.messages.ts';
import { localizeRefusal, noticeMessages, routeMessages } from './errors.messages.ts';
import type { BankSection, PageLanguage, StatementPreview, StoredSummary } from './pages.ts';
import {
  accountPage,
  bankLeavePage,
  consentPage,
  loginPage,
  logoutPage,
  messagePage,
  signUpPage,
  statementPreviewPage,
} from './pages.ts';

/**
 * HTTP routes for accounts and OAuth on the one origin:
 *
 *   /signup /login /logout /account            server-rendered pages and their forms
 *   /account/password /account/export          change the password; download everything stored
 *   /account/bank/*                            the person's own bank data: connect, sync, import, correct
 *   /bank/consent/callback                     where a bank sends the person back after a consent
 *   /oauth/authorize                           sign-in and consent for an MCP client
 *   /oauth/register /oauth/token /oauth/revoke machine endpoints (JSON or form bodies)
 *   /.well-known/oauth-protected-resource[/mcp]  /.well-known/oauth-authorization-server
 *
 * The logic lives in `packages/auth`; this file reads requests, sets cookies and renders pages.
 *
 * A page is written in the language of its request (`requestLocale`: `?lang=`, the `rc_lang`
 * cookie, then `Accept-Language`). `?lang=` also sets the cookie, so the choice survives the form
 * posts and redirects that follow. The machine endpoints answer in English.
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
  /**
   * The person's own bank data. Every call below passes the user id of the signed-in session and
   * nothing a form sent can change which person that is.
   */
  bank?: { sync: BankSync; ledger: ReturnType<typeof createBankStore>; statements: StatementImports };
  /** Everything stored about a person, for the download. */
  exportPerson?: (userId: string) => unknown;
};

/** Movements shown per page of the account page. */
const movementsPerPage = 25;
/** What is counted for "what is stored about you", in the order shown. */
const storedCountKeys: [StoredCountKey, keyof ReturnType<typeof storedCounts>][] = [
  ['countInputs', 'inputs'],
  ['countBankAccounts', 'bankAccounts'],
  ['countBankMovements', 'bankMovements'],
  ['countBankConnections', 'bankConnections'],
  ['countBankImports', 'bankImports'],
  ['countHabitGoals', 'habitGoals'],
  ['countHabitCheckins', 'habitCheckins'],
];

/**
 * One page request: its language, the texts of these routes in that language, and where the
 * language switcher of the answer links to (`self`, set only when the request is a GET that can
 * simply be made again).
 */
type Visit = {
  locale: Locale;
  t: ReturnType<typeof translator<keyof typeof routeMessages.en>>;
  /** A refusal worded by another layer, in the language of the page. */
  refusal: (message: string, code?: AuthErrorCode) => string;
  /** The notice of a `done` code after a redirect, or undefined. */
  notice: (done: string | null) => string | undefined;
  self: string | undefined;
  /** The language of a page whose switcher links to `path`; without a path the page has no switcher. */
  page: (path?: string) => PageLanguage;
};

function visitOf(request: IncomingMessage, url: URL, locale: Locale): Visit {
  const query = new URLSearchParams(url.search);
  // The switcher sets `lang` itself, and a notice is said once.
  query.delete('lang');
  query.delete('done');
  const repeatable = request.method === 'GET' && url.pathname !== '/bank/consent/callback';
  const notice = translator(noticeMessages, locale);
  return {
    locale,
    t: translator(routeMessages, locale),
    refusal: (message, code) => localizeRefusal(message, locale, code),
    notice: done =>
      done !== null && Object.hasOwn(noticeMessages.en, done)
        ? notice(done as keyof typeof noticeMessages.en)
        : undefined,
    self: repeatable ? `${url.pathname}${query.size ? `?${query}` : ''}` : undefined,
    page: path => ({ locale, path }),
  };
}

/** A page in the language of the visit: `Content-Language`, and a cache key that includes the language. */
function sendPage(response: ServerResponse, visit: Visit, status: number, html: string, formAction: string[] = []) {
  response.setHeader('Content-Language', visit.locale);
  response.setHeader('Vary', 'Accept-Language, Cookie');
  return sendHtml(response, status, html, formAction);
}

const sessionCookie = (secure: boolean) => (secure ? '__Host-rc_session' : 'rc_session');
const preCookie = (secure: boolean) => (secure ? '__Host-rc_pre' : 'rc_pre');
const openCors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };

/** Where to go after signing in: only paths on this origin that a sign-in is meant to lead to. */
function safeNext(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000 || !value.startsWith('/') || /^\/[/\\]|[\r\n\\]/.test(value))
    return undefined;
  const path = value.split('?')[0];
  return ['/oauth/authorize', '/account', '/workspace', '/preview', '/bank/consent/callback'].includes(path)
    ? value
    : undefined;
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
  function assertForm(request: IncomingMessage, visit: Visit, key: string | undefined, fields: Record<string, string>) {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== options.requestOrigin(request)) {
      // The page is ours but the request arrived under another name: a proxy replaced `Host`.
      if (origin === options.publicOrigin) throw new ApiError(403, visit.t('proxyHost'));
      throw new ApiError(403, visit.t('otherSite'));
    }
    if (!verifyCsrf(key, fields.csrf)) throw new ApiError(403, visit.t('formExpired'));
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

  async function summary(
    account: { userId: string; createdAt: string; lastLoginAt: string | null },
    locale: Locale,
  ): Promise<StoredSummary> {
    const label = translator(accountMessages, locale);
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
      counts: storedCountKeys.map(([message, kind]) => ({ label: label(message), count: counts[kind] })),
      answers,
    };
  }

  /** The bank part of the account page for one person, with the page of movements the query asks for. */
  async function bankSection(
    userId: string,
    query: URLSearchParams | Record<string, string>,
  ): Promise<BankSection | undefined> {
    const bank = options.bank;
    if (!bank) return undefined;
    const read = (name: string) => (query instanceof URLSearchParams ? (query.get(name) ?? undefined) : query[name]);
    const date = (name: string) => {
      const parsed = dateSchema.safeParse(read(name));
      return parsed.success ? parsed.data : undefined;
    };
    const [from, to] = [date('from'), date('to')];
    const page = Math.min(400, Math.max(1, Math.trunc(Number(read('page')) || 1)));
    const empty = {
      banks: [],
      connections: [],
      pendingConsents: [],
      accounts: [],
      imports: [],
      movements: [],
      total: 0,
    };
    const frame = { page, pageSize: movementsPerPage, from, to, manualAccountId };
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [banks, connections, pendingConsents, balances, imports, recent] = await Promise.all([
        bank.sync.banks(),
        bank.sync.listConnections(userId),
        bank.sync.pendingConsents(userId),
        bank.ledger.balances(userId, today),
        bank.statements.list(userId),
        bank.ledger.recent(userId, { from, to }, { limit: movementsPerPage, offset: (page - 1) * movementsPerPage }),
      ]);
      return {
        available: true,
        ...frame,
        banks,
        connections,
        pendingConsents,
        accounts: balances.accounts.map(({ id, name, balanceCents, synthetic }) => ({
          id,
          name,
          balanceCents,
          synthetic,
        })),
        imports,
        movements: recent.movements,
        total: recent.total,
      };
    } catch (error) {
      if (error instanceof DatabaseBusyError) throw error;
      return { available: false, ...frame, ...empty };
    }
  }

  /** The account page of a session, with an optional notice or error and the status to answer with. */
  async function renderAccount(
    response: ServerResponse,
    visit: Visit,
    session: NonNullable<ReturnType<typeof sessionOf>>,
    view: { status?: number; notice?: string; error?: string; query?: URLSearchParams | Record<string, string> } = {},
  ) {
    const bank = await bankSection(session.account.userId, view.query ?? {});
    // After a form the switcher links to the account page itself, at the movements being shown.
    const shown = new URLSearchParams();
    if (bank?.from) shown.set('from', bank.from);
    if (bank?.to) shown.set('to', bank.to);
    if (bank && bank.page > 1) shown.set('page', String(bank.page));
    return sendPage(
      response,
      visit,
      view.status ?? 200,
      accountPage(
        {
          csrf: session.csrf,
          account: session.account,
          stored: await summary(session.account, visit.locale),
          clients: oauth.connectedClients(session.account.id),
          bank,
          notice: view.notice,
          error: view.error,
        },
        visit.page(`/account${shown.size ? `?${shown}` : ''}`),
      ),
    );
  }

  /** Back to the account page after a bank action, at the place the person was. */
  function backToAccount(response: ServerResponse, done: string, fields: Record<string, string> = {}, anchor = 'bank') {
    const query = new URLSearchParams({ done });
    for (const name of ['from', 'to', 'page']) if (fields[name]) query.set(name, fields[name]);
    return redirect(response, `/account?${query}#${anchor}`);
  }

  /**
   * `GET /bank/consent/callback`: the bank sent the person back. The engine accepts the state once,
   * and only in the browser session of the person who started the consent; anything else is refused
   * and nothing is connected.
   */
  async function consentCallback(request: IncomingMessage, response: ServerResponse, url: URL, visit: Visit) {
    if (request.method !== 'GET') throw new ApiError(405, visit.t('methodNotAllowed'));
    const bank = options.bank;
    if (!bank) throw new ApiError(404, visit.t('notFound'));
    const session = sessionOf(request);
    if (!session) {
      // Signing in starts a new session, and the consent is bound to the old one: it has to be started again.
      return redirect(response, '/login?next=%2Faccount', 302);
    }
    const params: Record<string, string> = {};
    for (const [name, value] of url.searchParams) if (!(name in params) && value.length <= 2000) params[name] = value;
    try {
      const outcome = await bank.sync.completeConsent(params, {
        userId: session.account.userId,
        sessionKey: session.id,
      });
      const done = { connected: 'bank-connected', renewed: 'bank-renewed', denied: 'bank-denied' }[outcome.status];
      return redirect(response, `/account?done=${done}#bank`, 302);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return sendPage(
        response,
        visit,
        error.status,
        messagePage(
          visit.t('bankNotConnectedTitle'),
          visit.refusal(error.message),
          session.account,
          session.csrf,
          visit.page(),
        ),
      );
    }
  }

  /** The forms of the bank section. Each acts on the signed-in person; a refusal is shown on the account page. */
  async function bankForms(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    session: NonNullable<ReturnType<typeof sessionOf>>,
    visit: Visit,
  ) {
    const bank = options.bank;
    if (!bank) throw new ApiError(404, visit.t('notFound'));
    const { userId } = session.account;
    let fields: Record<string, string> = {};
    let upload: { filename?: string; value: string } | undefined;
    if (path === '/account/bank/import') {
      // The only form with a file: its fields, the CSRF token included, arrive as multipart parts.
      const parts = await readMultipart(request, maxStatementBytes + 8192, visit.t('statementTooLarge'));
      for (const part of parts) {
        if (part.name === 'statement') upload = part;
        else if (!(part.name in fields)) fields[part.name] = part.value;
      }
    } else fields = await readForm(request);
    assertForm(request, visit, session.id, fields);
    try {
      if (path === '/account/bank/connect') {
        const provider = fields.provider ?? '';
        const choice = (await bank.sync.banks()).find(candidate => candidate.id === provider);
        if (!choice) throw new ApiError(404, visit.t('bankCannotConnect'));
        if (choice.connect === 'direct') {
          await bank.sync.connectSelf(userId, choice.id);
          return backToAccount(response, 'bank-connected');
        }
        const started = await bank.sync.beginConsent(userId, choice.id, {
          sessionKey: session.id,
          returnUrl: `${options.requestOrigin(request)}/bank/consent/callback`,
        });
        return sendPage(
          response,
          visit,
          200,
          bankLeavePage(
            {
              csrf: session.csrf,
              account: session.account,
              bank: choice,
              redirectUrl: started.redirectUrl,
              expiresAt: started.expiresAt,
            },
            visit.page(),
          ),
        );
      }
      if (path === '/account/bank/sync') {
        const { results } = await bank.sync.sync(userId, fields.connection || undefined);
        const failed = results.find(result => result.status === 'failed');
        if (failed && 'error' in failed)
          throw new ApiError(502, visit.t('bankFetchFailed', { error: visit.refusal(String(failed.error)) }));
        return backToAccount(response, 'synced');
      }
      if (path === '/account/bank/disconnect') {
        await bank.sync.disconnect(userId, fields.connection ?? '');
        return backToAccount(response, 'bank-disconnected');
      }
      if (path === '/account/bank/import') {
        if (!upload?.value.trim()) throw new ApiError(400, visit.t('chooseCsv'));
        const preview = (await bank.statements.preview(userId, upload.value)) as StatementPreview;
        return sendPage(
          response,
          visit,
          200,
          statementPreviewPage(
            {
              csrf: session.csrf,
              account: session.account,
              preview,
              filename: upload.filename?.slice(0, 120),
            },
            visit.page(),
          ),
        );
      }
      if (path === '/account/bank/import/confirm') {
        await bank.statements.confirm(userId, fields.preview);
        return backToAccount(response, 'imported', {}, 'movements');
      }
      if (path === '/account/bank/import/cancel') {
        await bank.statements.discard(userId, fields.preview ?? '');
        return backToAccount(response, 'discarded');
      }
      if (path === '/account/bank/import/delete') {
        await bank.statements.remove(userId, fields.import ?? '');
        return backToAccount(response, 'import-deleted');
      }
      if (path === '/account/bank/movement') {
        await bank.ledger.setCategory(userId, fields.movement ?? '', fields.category);
        return backToAccount(response, 'category', fields, 'movements');
      }
      if (path === '/account/bank/movement/delete') {
        await bank.ledger.deleteManual(userId, fields.movement ?? '');
        return backToAccount(response, 'movement-deleted', fields, 'movements');
      }
      throw new ApiError(404, visit.t('notFound'));
    } catch (error) {
      const known = error instanceof ApiError;
      // Anything that is not a refusal worded for the person is a fault, answered as one.
      if (!known && !(error instanceof z.ZodError)) throw error;
      return renderAccount(response, visit, session, {
        status: known ? error.status : 400,
        error: known ? visit.refusal(error.message) : visit.t('didNotWork'),
        query: fields,
      });
    }
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
      // A busy database is answered in one place for every route: `createApp`.
      else if (error instanceof DatabaseBusyError) throw error;
      else sendOAuth(response, 500, { error: 'server_error', error_description: 'The request could not be completed' });
    }
    return true;
  }

  /** `GET` and `POST /oauth/authorize`: validate, require a sign-in, show consent, then redirect back. */
  async function authorize(request: IncomingMessage, response: ServerResponse, url: URL, visit: Visit) {
    const posted = request.method === 'POST' ? await readForm(request) : null;
    const params = posted ?? Object.fromEntries(url.searchParams);
    const validated = oauth.validateAuthorize(params);
    if ('kind' in validated) {
      if (validated.kind === 'redirect') return redirect(response, validated.location, 302);
      return sendPage(
        response,
        visit,
        400,
        messagePage(
          visit.t('cannotContinueTitle'),
          visit.refusal(validated.message),
          null,
          undefined,
          visit.page(visit.self),
        ),
      );
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
      return sendPage(
        response,
        visit,
        200,
        consentPage(
          {
            csrf: session.csrf,
            account: session.account,
            client: validated.client,
            redirectUri: validated.redirectUri,
            scopes: validated.scopes,
            params: replay,
          },
          // The switcher repeats the validated request, so the consent is asked again in the new language.
          visit.page(`/oauth/authorize?${new URLSearchParams(replay)}`),
        ),
        formAction,
      );
    assertForm(request, visit, session.id, posted);
    const location = posted.decision === 'allow' ? oauth.approve(session.account.id, validated) : oauth.deny(validated);
    return redirect(response, location, 303);
  }

  async function pages(request: IncomingMessage, response: ServerResponse, url: URL, visit: Visit) {
    const path = url.pathname;
    const get = request.method === 'GET';
    const post = request.method === 'POST';
    if (!get && !post) throw new ApiError(405, visit.t('methodNotAllowed'));
    if (path === '/oauth/authorize') return authorize(request, response, url, visit);
    if (path === '/bank/consent/callback') return consentCallback(request, response, url, visit);
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
        // The switcher keeps only the destination that was accepted, never the raw query.
        const own = visit.page(`${path}${next ? `?${new URLSearchParams({ next })}` : ''}`);
        if (signUp) return sendPage(response, visit, 200, signUpPage({ csrf, next, closed: !options.signUps }, own));
        return sendPage(response, visit, 200, loginPage({ csrf, next }, own));
      }
      const fields = await readForm(request);
      const next = safeNext(fields.next);
      try {
        assertForm(request, visit, pre.cookie ? undefined : pre.key, fields);
        if (signUp) {
          if (!options.signUps) throw new ApiError(403, visit.t('signUpsClosed'));
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
        if (error instanceof DatabaseBusyError) throw error;
        const message =
          error instanceof AuthError
            ? visit.refusal(error.message, error.code)
            : error instanceof ApiError
              ? visit.refusal(error.message)
              : visit.t('somethingWrong');
        const status =
          error instanceof AuthError && error.code === 'throttled'
            ? 429
            : error instanceof ApiError
              ? error.status
              : 400;
        if (error instanceof AuthError && error.retryAfterSeconds)
          response.setHeader('Retry-After', String(error.retryAfterSeconds));
        const email = typeof fields.email === 'string' ? fields.email.slice(0, 254) : undefined;
        const own = visit.page(`${path}${next ? `?${new URLSearchParams({ next })}` : ''}`);
        const page = signUp
          ? signUpPage({ csrf, next, email, error: message }, own)
          : loginPage({ csrf, next, email, error: message }, own);
        return sendPage(response, visit, status, page);
      }
    }

    if (path === '/logout') {
      if (!session) return redirect(response, '/login');
      if (get)
        return sendPage(
          response,
          visit,
          200,
          logoutPage({ csrf: session.csrf, account: session.account }, visit.page('/logout')),
        );
      assertForm(request, visit, session.id, await readForm(request));
      accounts.logout(session.id);
      options.onSignOut?.(session.account.userId);
      const secure = secureOf(request);
      response.appendHeader('Set-Cookie', serializeCookie(sessionCookie(secure), '', { secure, maxAgeSeconds: 0 }));
      return redirect(response, '/login');
    }

    if (path === '/account' && get) {
      if (!session) return redirect(response, '/login?next=%2Faccount');
      const notice = visit.notice(url.searchParams.get('done'));
      return renderAccount(response, visit, session, { notice, query: url.searchParams });
    }

    if (path.startsWith('/account/bank/') && post) {
      if (!session) return redirect(response, '/login?next=%2Faccount');
      return bankForms(request, response, path, session, visit);
    }

    if (path === '/account/export' && post) {
      if (!session) return redirect(response, '/login?next=%2Faccount');
      assertForm(request, visit, session.id, await readForm(request));
      if (!options.exportPerson) throw new ApiError(404, visit.t('notFound'));
      const body = JSON.stringify(options.exportPerson(session.account.userId), null, 2);
      response
        .writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="relocat-export-${new Date().toISOString().slice(0, 10)}.json"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        .end(body);
      return;
    }

    if (path === '/account/password' && post) {
      if (!session) return redirect(response, '/login?next=%2Faccount');
      const fields = await readForm(request);
      assertForm(request, visit, session.id, fields);
      try {
        await accounts.changePassword(
          session.account.id,
          { current: fields.current, next: fields.next },
          { sessionId: session.id },
        );
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        if (error.retryAfterSeconds) response.setHeader('Retry-After', String(error.retryAfterSeconds));
        return renderAccount(response, visit, session, {
          status: error.code === 'throttled' ? 429 : 400,
          error: visit.refusal(error.message, error.code),
        });
      }
      // Nothing issued under the old password keeps working: every assistant has to be connected again.
      oauth.disconnectAll(session.account.id);
      options.onSignOut?.(session.account.userId);
      return redirect(response, '/account?done=password');
    }

    if ((path === '/account/disconnect' || path === '/account/delete') && post) {
      if (!session) return redirect(response, '/login?next=%2Faccount');
      const fields = await readForm(request);
      assertForm(request, visit, session.id, fields);
      if (path === '/account/disconnect') {
        oauth.disconnect(session.account.id, fields.grant ?? '');
        return redirect(response, '/account?done=disconnected');
      }
      try {
        if (fields.confirm !== 'yes') throw new AuthError('invalid_credentials', visit.t('tickToConfirm'));
        // Counted for this session only: no stranger's wrong guesses can stand between a person and this.
        await accounts.deleteAccount(session.account.id, fields.password, {
          sessionId: session.id,
          beforeDelete: options.forgetPerson,
        });
      } catch (error) {
        if (error instanceof DatabaseBusyError) throw error;
        const message =
          error instanceof AuthError ? visit.refusal(error.message, error.code) : visit.t('accountNotDeleted');
        if (error instanceof AuthError && error.retryAfterSeconds)
          response.setHeader('Retry-After', String(error.retryAfterSeconds));
        return renderAccount(response, visit, session, {
          status: error instanceof AuthError && error.code === 'throttled' ? 429 : 400,
          error: message,
        });
      }
      const secure = secureOf(request);
      response.appendHeader('Set-Cookie', serializeCookie(sessionCookie(secure), '', { secure, maxAgeSeconds: 0 }));
      return sendPage(
        response,
        visit,
        200,
        messagePage(visit.t('deletedTitle'), visit.t('deletedMessage'), null, undefined, visit.page()),
      );
    }
    throw new ApiError(404, visit.t('notFound'));
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
    '/account/password',
    '/account/export',
    '/account/bank/connect',
    '/account/bank/sync',
    '/account/bank/disconnect',
    '/account/bank/import',
    '/account/bank/import/confirm',
    '/account/bank/import/cancel',
    '/account/bank/import/delete',
    '/account/bank/movement',
    '/account/bank/movement/delete',
    '/bank/consent/callback',
    '/oauth/authorize',
  ]);

  return {
    sessionOf,
    /** Handle the request when it is an account or OAuth route. Returns false when it is not. */
    async handle(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (machinePaths.has(url.pathname)) return machine(request, response, url.pathname);
      if (!pagePaths.has(url.pathname)) return false;
      const language = requestLocale(request);
      const visit = visitOf(request, url, language.locale);
      // A language chosen with `?lang=` is remembered: the form posts and redirects that follow carry no query.
      const plain = (title: string, message: string) =>
        messagePage(title, message, null, undefined, visit.page(visit.self));
      try {
        if (language.chosen) response.appendHeader('Set-Cookie', localeCookie(language.locale, secureOf(request)));
        await pages(request, response, url, visit);
      } catch (error) {
        if (response.headersSent) response.destroy();
        // A busy database is answered in one place for every route: `createApp`.
        else if (error instanceof DatabaseBusyError) throw error;
        else if (error instanceof ApiError)
          sendPage(response, visit, error.status, plain(visit.t('didNotWorkTitle'), visit.refusal(error.message)));
        else sendPage(response, visit, 500, plain(visit.t('wrongTitle'), visit.t('tryInAMoment')));
      }
      return true;
    },
  };
}
