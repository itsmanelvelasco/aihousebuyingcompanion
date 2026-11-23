import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountsOptions } from '../../packages/auth/accounts.ts';
import { createAccounts } from '../../packages/auth/accounts.ts';
import type { OAuthOptions } from '../../packages/auth/oauth.ts';
import { createOAuth } from '../../packages/auth/oauth.ts';
import { safeEqual, verifyCsrf } from '../../packages/auth/secrets.ts';
import type { Vault } from '../../packages/banks/vault.ts';
import { developmentVault, lazyVault } from '../../packages/banks/vault.ts';
import type { accessConfig } from '../../packages/config/env.ts';
import { listingBudgetConfig, listingSearchConfig } from '../../packages/config/env.ts';
import type { Database } from '../../packages/db/database.ts';
import { DatabaseBusyError } from '../../packages/db/database.ts';
import type { RateLimitOptions } from '../../packages/http/rate-limit.ts';
import { createRateLimiter } from '../../packages/http/rate-limit.ts';
import type { ApiAccess } from '../../packages/http/server.ts';
import { bearerToken, sendHtml, sendJson } from '../../packages/http/server.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { requestLocale } from '../../packages/i18n/server.ts';
import { createListingBudget } from '../../packages/listings/budget.ts';
import type { BoardOptions, CallerResolution } from '../board/server.ts';
import { createBoardApp } from '../board/server.ts';
import type { HabitsOptions } from '../habits-agent/server.ts';
import { createHabitsHandler } from '../habits-agent/server.ts';
import type { Caller } from '../mcp-server/identity.ts';
import type { ProfileApiOptions } from '../profile-api/server.ts';
import { createProfileApiHandler } from '../profile-api/server.ts';
import { createAccountRoutes } from './account-routes.ts';
import { routeMessages } from './errors.messages.ts';
import { messagePage } from './pages.ts';
import { createPeople } from './people.ts';

/**
 * Everything ReloCat serves on its one origin, as a request handler: accounts and OAuth, `/mcp`,
 * the board, the workspace, `/api` and `/health`. `index.ts` reads the environment, opens the
 * database and listens; tests build the same handler over a temporary database.
 *
 * The identity rule is enforced here. Each request is resolved to a caller once (OAuth access token,
 * or the session cookie of a same-origin page) and the MCP tools receive handles bound to that
 * caller's own person. Nothing below this file addresses a person by an id that came from a request,
 * except `/api`, which checks the id against the credential.
 */
export type AppOptions = {
  db: Database;
  /** The operator's service token for `/api` (`PROFILE_API_TOKEN`). Never given to a tool or a page. */
  adminToken: string;
  /** `https://www.relo.cat` in production; null for a local server. */
  publicOrigin: string | null;
  /** The port the server listens on, read per request so tests can bind port 0 first. */
  port: () => number;
  access: ReturnType<typeof accessConfig>;
  allowedOrigins?: Set<string>;
  data?: BoardOptions['data'];
  dataStatus?: BoardOptions['dataStatus'];
  /** Voice and guided interview, mounted under `/interview`. */
  interviewer?: (request: IncomingMessage, response: ServerResponse) => unknown;
  /** Extra fields of `GET /health`. */
  health?: () => Record<string, unknown>;
  rateLimit?: { perMinute?: number; webhooksPerMinute?: number } & Pick<
    RateLimitOptions,
    'trustProxy' | 'clientAddress'
  >;
  habits?: Pick<HabitsOptions, 'openai' | 'dailyCalls'>;
  profileApi?: Omit<ProfileApiOptions, 'authorize' | 'ownedByAccount' | 'vault'>;
  /**
   * Seals bank credentials at rest (`DATA_ENCRYPTION_KEY`). Omitted outside production: a
   * development key kept in the database. Omitted in production: nobody can connect a bank through
   * a consent, and `index.ts` refuses to start when a bank that needs one is configured.
   */
  vault?: Vault;
  accounts?: AccountsOptions;
  oauth?: Omit<OAuthOptions, 'issuer' | 'redirectSchemes' | 'onRevoke'>;
  /**
   * Milliseconds between housekeeping passes (expired sessions, sign-in counters, OAuth codes,
   * tokens, dead grants and idle clients). Default ten minutes; null runs none, for tests that
   * call `housekeeping()` themselves.
   */
  housekeepingMs?: number | null;
  /** Where operator warnings go. Default `console.warn`. */
  warn?: (message: string) => void;
};

/** How long a warning about undetermined client addresses stays quiet before it is repeated. */
const warningEveryMs = 5 * 60_000;

const apiPrefix = '/api';

export function createApp(options: AppOptions) {
  const { db, publicOrigin, access } = options;
  const localOrigin = () => `http://127.0.0.1:${options.port()}`;
  const accounts = createAccounts(db, options.accounts);
  const oauth = createOAuth(db, {
    ...options.oauth,
    issuer: () => publicOrigin ?? localOrigin(),
    redirectSchemes: access.oauthRedirectSchemes,
    // A grant ended: the event streams it authorised are closed; one that is still allowed reconnects.
    onRevoke: accountId => {
      const account = accounts.account(accountId);
      if (account) profiles.closeStreams(account.userId);
    },
  });
  /** A public deployment: here a client address that cannot be determined is an operator's problem. */
  const publicService = access.production || publicOrigin !== null;
  const warn = options.warn ?? (message => console.warn(message));
  const ownedByAccount = (userId: string) => accounts.ownerOf(userId) !== undefined;
  const vault = options.vault ?? (access.production ? undefined : lazyVault(() => developmentVault(db, warn)));

  // ---------------------------------------------------------------- hosts

  /**
   * `Host` values this server answers to: the public origin, localhost on the listening port, and
   * configured extras. Anything else is refused, so a page on another domain that resolves to this
   * machine (DNS rebinding) cannot pass the same-origin checks, and no link is ever built from a
   * forged host.
   */
  function allowedHost(host: string | undefined) {
    if (!host) return false;
    const value = host.toLowerCase();
    const port = options.port();
    const local = ['127.0.0.1', 'localhost', '[::1]'].flatMap(name =>
      port === 80 ? [name, `${name}:80`] : [`${name}:${port}`],
    );
    return (
      local.includes(value) ||
      (publicOrigin !== null && new URL(publicOrigin).host === value) ||
      access.allowedHosts.includes(value)
    );
  }

  /** The origin a request was addressed to. Only meaningful after `allowedHost` passed. */
  function requestOrigin(request: IncomingMessage) {
    const host = String(request.headers.host ?? '').toLowerCase();
    if (publicOrigin && new URL(publicOrigin).host === host) return publicOrigin;
    // An extra host is a tunnel or proxy that terminates TLS; localhost is plain HTTP.
    const forwardedHttps = access.allowedHosts.includes(host) && request.headers['x-forwarded-proto'] === 'https';
    return `${forwardedHttps ? 'https' : 'http'}://${host}`;
  }

  // ----------------------------------------------------------- rate limits

  // Every request is counted, also one from this machine: a proxy on the same machine that adds no
  // forwarding header looks exactly like the server calling itself. Only the operator's own calls
  // with the admin token are exempt.
  const adminHeader = `Bearer ${options.adminToken}`;
  const limiterOptions = {
    windowMs: 60_000,
    trustProxy: options.rateLimit?.trustProxy,
    clientAddress: options.rateLimit?.clientAddress,
    exempt: (request: IncomingMessage) => safeEqual(request.headers.authorization ?? '', adminHeader),
  };
  const limiter = createRateLimiter({ ...limiterOptions, limit: options.rateLimit?.perMinute ?? 300 });
  // Bank webhooks are limited before their signature is checked, on a budget of their own, so an
  // unauthenticated flood cannot ride an exemption and a busy bank cannot use up the visitors' allowance.
  const webhookLimiter = createRateLimiter({ ...limiterOptions, limit: options.rateLimit?.webhooksPerMinute ?? 120 });
  // New board runs per address, so one visitor cannot fill the store and push other visitors' runs out.
  const newRuns = createRateLimiter({ ...limiterOptions, limit: 30, windowMs: 10 * 60_000, globalLimit: 1500 });
  /** Who a sign-in, sign-up or registration is counted as; `shared` when the key may be every visitor at once. */
  const client = (request: IncomingMessage) => {
    const { key, shared } = limiter.clientIdentity(request);
    return { address: key, shared };
  };

  /**
   * Requests that could not be told apart from other visitors. On a public deployment this means
   * the proxy does not state the client address the way `CLIENT_IP_HEADER` says: every visitor then
   * shares one rate-limit allowance, so it is logged (repeatedly, at most every five minutes) and
   * shown in `/health`.
   */
  const undetermined = { count: 0, lastAt: 0, lastPeer: '', warnedAt: 0, warnedCount: 0 };
  function noteClient(request: IncomingMessage) {
    if (!limiter.clientIdentity(request).shared) return;
    undetermined.count++;
    undetermined.lastAt = Date.now();
    undetermined.lastPeer = request.socket.remoteAddress ?? 'unknown';
    if (!publicService || undetermined.lastAt - undetermined.warnedAt < warningEveryMs) return;
    warn(
      `WARNING: ${undetermined.count - undetermined.warnedCount} request(s) arrived without a usable client address ` +
        `(CLIENT_IP_HEADER=${describeSource()}, last peer ${undetermined.lastPeer}). All such visitors share one ` +
        'rate-limit allowance and sign-in is throttled per account only. Make the proxy send the header, or fix ' +
        'CLIENT_IP_HEADER / TRUSTED_PROXY_HOPS; see docs/areas/integration-deployment.md.',
    );
    undetermined.warnedAt = undetermined.lastAt;
    undetermined.warnedCount = undetermined.count;
  }
  function describeSource() {
    const source = limiter.source;
    if (source.kind === 'x-forwarded-for') return `x-forwarded-for (${source.trustedHops} trusted hop(s))`;
    return source.kind === 'header' ? source.name : source.kind;
  }
  /** The `clientAddress` field of `/health`. `ok` is false while requests keep arriving without a client address. */
  function clientAddressStatus() {
    const recent = undetermined.lastAt > 0 && Date.now() - undetermined.lastAt < 2 * warningEveryMs;
    return {
      mode: describeSource(),
      ok: !(publicService && recent),
      undeterminedRequests: undetermined.count,
      lastUndeterminedAt: undetermined.lastAt ? new Date(undetermined.lastAt).toISOString() : null,
    };
  }

  // -------------------------------------------------------------- identity

  /** A person's credential on `/api`: an OAuth access token, or the session cookie (writes need the CSRF header). */
  function authorizeApi(request: IncomingMessage): ApiAccess | null {
    const token = bearerToken(request);
    if (token) {
      const grant = oauth.verifyAccessToken(token);
      return grant
        ? {
            userId: grant.userId,
            read: grant.scopes.includes('person:read'),
            write: grant.scopes.includes('person:write'),
            bank: grant.scopes.includes('bank:manage'),
          }
        : null;
    }
    if (request.headers.authorization) return null;
    const session = routes.sessionOf(request);
    if (!session) return null;
    const origin = request.headers.origin;
    const sameOrigin = origin === undefined || origin === requestOrigin(request);
    const write = sameOrigin && origin !== undefined && verifyCsrf(session.id, request.headers['x-csrf-token']);
    // A session may do everything the person may; every change needs the CSRF token of that session.
    return sameOrigin ? { userId: session.account.userId, read: true, write, bank: write } : null;
  }

  const profiles = createProfileApiHandler(db, options.adminToken, {
    ...options.profileApi,
    authorize: authorizeApi,
    ownedByAccount,
    vault,
  });
  const habits = createHabitsHandler({ ...options.habits, token: options.adminToken, db, authorize: authorizeApi });
  const people = createPeople(
    { ...profiles.people, habits: habits.read },
    { origin: () => publicOrigin ?? localOrigin() },
  );
  const demo = access.publicDemo ? people.demo(access.demoUserIds, ownedByAccount) : null;
  const routes = createAccountRoutes({
    db,
    accounts,
    oauth,
    requestOrigin,
    client,
    publicOrigin,
    context: profiles.people.context,
    signUps: access.signUps,
    onSignOut: userId => void profiles.closeStreams(userId),
    forgetPerson: userId => profiles.forgetPerson(userId),
    bank: { sync: profiles.bankSync, ledger: profiles.bank, statements: profiles.statements },
    exportPerson: userId => profiles.exportPerson(userId),
  });

  // ----------------------------------------------------------- housekeeping

  /** One pass over everything that expires. Never throws: a failed pass is tried again at the next one. */
  function housekeeping() {
    try {
      accounts.housekeeping();
      oauth.housekeeping();
      // Bank consents nobody finished and statements nobody confirmed.
      profiles.housekeeping();
      return true;
    } catch {
      return false;
    }
  }
  const housekeepingMs = options.housekeepingMs === undefined ? 10 * 60_000 : options.housekeepingMs;
  let housekeepingTimer: ReturnType<typeof setInterval> | undefined;
  if (housekeepingMs !== null) {
    housekeeping();
    housekeepingTimer = setInterval(housekeeping, housekeepingMs);
    // The timer alone must not keep the process alive.
    housekeepingTimer.unref();
  }

  /**
   * Who calls `/mcp`. A bearer token must be a valid access token for this server; a wrong one is
   * refused rather than treated as anonymous. Without a token, the session cookie counts only for
   * a request the browser marks as coming from this origin, so another site cannot borrow it.
   */
  function resolveCallerNow(request: IncomingMessage): CallerResolution {
    const challenge: Caller['challenge'] = (error, scopes) => oauth.challenge(error, scopes);
    const base = { demo, challenge };
    if (request.headers.authorization !== undefined) {
      const token = bearerToken(request);
      const grant = token ? oauth.verifyAccessToken(token) : null;
      if (!grant)
        return {
          unauthorized: oauth.challenge({
            code: 'invalid_token',
            description: 'The access token is invalid or expired',
          }),
        };
      return { caller: { ...base, me: people.own(grant.userId), scopes: grant.scopes } };
    }
    const sameOrigin =
      request.headers.origin === requestOrigin(request) ||
      (request.headers.origin === undefined && request.headers['sec-fetch-site'] === 'same-origin');
    const session = sameOrigin ? routes.sessionOf(request) : null;
    if (session)
      return {
        caller: {
          ...base,
          me: people.own(session.account.userId),
          scopes: ['person:read', 'person:write', 'bank:manage'],
        },
      };
    return { caller: { ...base, me: null, scopes: [] } };
  }

  /**
   * The caller of an `/mcp` request, resolved once. `route` resolves it before the board's handler
   * runs, so a failure of the lookup itself (a busy database) reaches the one place that answers it
   * instead of the handler's own catch-all.
   */
  const resolved = new WeakMap<IncomingMessage, CallerResolution>();
  function resolveCaller(request: IncomingMessage): CallerResolution {
    let resolution = resolved.get(request);
    if (!resolution) {
      resolution = resolveCallerNow(request);
      resolved.set(request, resolution);
    }
    return resolution;
  }

  const board = createBoardApp({
    publicOrigin,
    allowedOrigins: options.allowedOrigins,
    data: options.data,
    dataStatus: options.dataStatus,
    db,
    resolveCaller,
    demo,
    sharedBoard: access.sharedBoard,
    newRuns,
    // The paid search budget is kept in the database so a restart does not reset it.
    listings: { ...listingSearchConfig(), budget: createListingBudget(listingBudgetConfig(), db) },
  });

  // ---------------------------------------------------------------- routes

  function limited(response: ServerResponse, retryAfterSeconds: number) {
    response.setHeader('Retry-After', String(retryAfterSeconds));
    sendJson(response, 429, { error: 'Too many requests' });
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    const path = (request.url ?? '/').split('?')[0];
    if (!allowedHost(request.headers.host)) return sendJson(response, 421, { error: 'This host is not served here' });
    if (path === '/health' && request.method === 'GET')
      return sendJson(response, 200, {
        status: 'ok',
        ...options.health?.(),
        publicDemo: access.publicDemo,
        clientAddress: clientAddressStatus(),
      });
    const webhook = path.startsWith(`${apiPrefix}/webhooks/`);
    const { allowed, retryAfterSeconds } = (webhook ? webhookLimiter : limiter).check(request);
    if (!limiterOptions.exempt(request)) noteClient(request);
    if (!allowed) return limited(response, retryAfterSeconds);
    if (path === apiPrefix || path.startsWith(`${apiPrefix}/`)) {
      request.url = (request.url ?? '').slice(apiPrefix.length) || '/';
      const parts = request.url.split('?')[0].split('/').filter(Boolean);
      const isHabits = parts[0] === 'limits' || (parts[0] === 'users' && parts[2] === 'habits');
      return isHabits ? habits(request, response) : profiles.handle(request, response);
    }
    if (await routes.handle(request, response)) return;
    if (options.interviewer && (path === '/interview' || path.startsWith('/interview/')))
      return options.interviewer(request, response);
    if (path === '/mcp') resolveCaller(request);
    return board.handle(request, response);
  }

  /**
   * The one answer to a database that stayed busy (`DatabaseBusyError`): 503 with `Retry-After`,
   * as a page for a browser and as JSON for everything else. Nothing was written, so the same
   * request can simply be sent again. `/api` gives the same answer from its own handlers.
   */
  function busy(request: IncomingMessage, response: ServerResponse, error: DatabaseBusyError) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds));
    const page = request.method === 'GET' && String(request.headers.accept ?? '').includes('text/html');
    if (page) {
      const { locale } = requestLocale(request);
      const t = translator(routeMessages, locale);
      response.setHeader('Content-Language', locale);
      response.setHeader('Vary', 'Accept-Language, Cookie');
      return sendHtml(response, 503, messagePage(t('busyTitle'), t('busyMessage'), null, undefined, { locale }));
    }
    return sendJson(response, 503, { error: 'Storage is busy; try again shortly', retryable: true });
  }

  return {
    /** The request listener. A handler that throws becomes a 500 without detail. */
    handle(request: IncomingMessage, response: ServerResponse) {
      route(request, response).catch(error => {
        if (response.headersSent) response.destroy();
        else if (error instanceof DatabaseBusyError) busy(request, response, error);
        else sendJson(response, 500, { error: 'Internal server error' });
      });
    },
    profiles,
    accounts,
    oauth,
    /** The origin tokens are issued for; also where the MCP endpoint lives. */
    origin: () => publicOrigin ?? localOrigin(),
    housekeeping,
    clientAddressStatus,
    /** Stop the housekeeping timer, then the bank engine and its event streams. */
    close() {
      clearInterval(housekeepingTimer);
      return profiles.close();
    },
  };
}

export type App = ReturnType<typeof createApp>;
