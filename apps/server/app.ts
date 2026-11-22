import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountsOptions } from '../../packages/auth/accounts.ts';
import { createAccounts } from '../../packages/auth/accounts.ts';
import type { OAuthOptions } from '../../packages/auth/oauth.ts';
import { createOAuth } from '../../packages/auth/oauth.ts';
import { verifyCsrf } from '../../packages/auth/secrets.ts';
import type { accessConfig } from '../../packages/config/env.ts';
import { listingBudgetConfig, listingSearchConfig } from '../../packages/config/env.ts';
import type { Database } from '../../packages/db/database.ts';
import type { RateLimitOptions } from '../../packages/http/rate-limit.ts';
import { createRateLimiter } from '../../packages/http/rate-limit.ts';
import type { ApiAccess } from '../../packages/http/server.ts';
import { bearerToken, sendJson } from '../../packages/http/server.ts';
import { createListingBudget } from '../../packages/listings/budget.ts';
import type { BoardOptions, CallerResolution } from '../board/server.ts';
import { createBoardApp } from '../board/server.ts';
import type { HabitsOptions } from '../habits-agent/server.ts';
import { createHabitsHandler } from '../habits-agent/server.ts';
import type { Caller } from '../mcp-server/identity.ts';
import type { ProfileApiOptions } from '../profile-api/server.ts';
import { createProfileApiHandler } from '../profile-api/server.ts';
import { createAccountRoutes } from './account-routes.ts';
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
  profileApi?: Omit<ProfileApiOptions, 'authorize' | 'ownedByAccount'>;
  accounts?: AccountsOptions;
  oauth?: Omit<OAuthOptions, 'issuer' | 'redirectSchemes'>;
};

const apiPrefix = '/api';

export function createApp(options: AppOptions) {
  const { db, publicOrigin, access } = options;
  const localOrigin = () => `http://127.0.0.1:${options.port()}`;
  const accounts = createAccounts(db, options.accounts);
  const oauth = createOAuth(db, {
    ...options.oauth,
    issuer: () => publicOrigin ?? localOrigin(),
    redirectSchemes: access.oauthRedirectSchemes,
  });
  const ownedByAccount = (userId: string) => accounts.ownerOf(userId) !== undefined;

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

  const limiterOptions = {
    windowMs: 60_000,
    trustProxy: options.rateLimit?.trustProxy,
    clientAddress: options.rateLimit?.clientAddress,
  };
  const limiter = createRateLimiter({ ...limiterOptions, limit: options.rateLimit?.perMinute ?? 300 });
  // Bank webhooks are limited before their signature is checked, on a budget of their own, so an
  // unauthenticated flood cannot ride an exemption and a busy bank cannot use up the visitors' allowance.
  const webhookLimiter = createRateLimiter({ ...limiterOptions, limit: options.rateLimit?.webhooksPerMinute ?? 120 });
  // New board runs per address, so one visitor cannot fill the store and push other visitors' runs out.
  const newRuns = createRateLimiter({ ...limiterOptions, limit: 30, windowMs: 10 * 60_000, globalLimit: 1500 });
  const clientAddress = (request: IncomingMessage) => limiter.clientKey(request) ?? 'local';

  // -------------------------------------------------------------- identity

  /** A person's credential on `/api`: an OAuth access token, or the session cookie (writes need the CSRF header). */
  function authorizeApi(request: IncomingMessage): ApiAccess | null {
    const token = bearerToken(request);
    if (token) {
      const grant = oauth.verifyAccessToken(token);
      return grant ? { userId: grant.userId, write: grant.scopes.includes('person:write') } : null;
    }
    if (request.headers.authorization) return null;
    const session = routes.sessionOf(request);
    if (!session) return null;
    const origin = request.headers.origin;
    const sameOrigin = origin === undefined || origin === requestOrigin(request);
    const write = sameOrigin && origin !== undefined && verifyCsrf(session.id, request.headers['x-csrf-token']);
    return sameOrigin ? { userId: session.account.userId, write } : null;
  }

  const profiles = createProfileApiHandler(db, options.adminToken, {
    ...options.profileApi,
    authorize: authorizeApi,
    ownedByAccount,
  });
  const habits = createHabitsHandler({ ...options.habits, token: options.adminToken, db, authorize: authorizeApi });
  const people = createPeople({ ...profiles.people, habits: habits.read });
  const demo = access.publicDemo ? people.demo(access.demoUserIds, ownedByAccount) : null;
  const routes = createAccountRoutes({
    db,
    accounts,
    oauth,
    requestOrigin,
    clientAddress,
    context: profiles.people.context,
    signUps: access.signUps,
  });

  /**
   * Who calls `/mcp`. A bearer token must be a valid access token for this server; a wrong one is
   * refused rather than treated as anonymous. Without a token, the session cookie counts only for
   * a request the browser marks as coming from this origin, so another site cannot borrow it.
   */
  function resolveCaller(request: IncomingMessage): CallerResolution {
    const challenge: Caller['challenge'] = error => oauth.challenge(error);
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
      return { caller: { ...base, me: people.own(session.account.userId), scopes: ['person:read', 'person:write'] } };
    return { caller: { ...base, me: null, scopes: [] } };
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
      return sendJson(response, 200, { status: 'ok', ...options.health?.(), publicDemo: access.publicDemo });
    const webhook = path.startsWith(`${apiPrefix}/webhooks/`);
    const { allowed, retryAfterSeconds } = (webhook ? webhookLimiter : limiter).check(request);
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
    return board.handle(request, response);
  }

  return {
    /** The request listener. A handler that throws becomes a 500 without detail. */
    handle(request: IncomingMessage, response: ServerResponse) {
      route(request, response).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'Internal server error' });
        else response.destroy();
      });
    },
    profiles,
    accounts,
    oauth,
    /** The origin tokens are issued for; also where the MCP endpoint lives. */
    origin: () => publicOrigin ?? localOrigin(),
    close: () => profiles.close(),
  };
}

export type App = ReturnType<typeof createApp>;
