import { randomBytes } from 'node:crypto';
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ClientRecord } from '../db/auth.ts';
import {
  accountById,
  activeGrants,
  clientById,
  codeByHash,
  countClients,
  deleteDeadGrants,
  deleteExpiredOauth,
  deleteOldestUnusedClients,
  deleteUnusedClients,
  grantById,
  insertClient,
  insertCode,
  insertGrant,
  insertToken,
  markCodeUsed,
  markTokenUsed,
  revokeGrant,
  tokenByHash,
  touchClient,
} from '../db/auth.ts';
import type { Database } from '../db/database.ts';
import { hashSecret, newSecret, safeEqual, verifyPkce } from './secrets.ts';
import { createThrottle } from './throttle.ts';

/**
 * The OAuth 2.1 authorization server that lets an MCP client (ChatGPT, Claude, Cursor…) act for one
 * account: dynamic client registration, the authorization-code flow with PKCE (S256 only), opaque
 * access tokens, rotating refresh tokens with reuse detection, and revocation. The same origin is
 * also the protected resource (`<origin>/mcp`), so every token is bound to that one audience.
 *
 * Pure logic over the database: the HTTP handlers in `apps/server` parse requests and call this.
 */

/** What a client may be allowed to do for a person. */
export const scopes = {
  'person:read': 'Read your household, finances, bank summary and habits',
  'person:write': 'Save answers and details to your profile',
} as const;
export type Scope = keyof typeof scopes;
export const allScopes = Object.keys(scopes) as Scope[];
const defaultScopes: Scope[] = ['person:read'];

/** An OAuth error as the token, registration and revocation endpoints return it. */
export class OAuthError extends Error {
  readonly error: string;
  readonly status: number;
  /** For a 429: seconds until the request may be tried again. */
  readonly retryAfterSeconds: number;
  constructor(error: string, description: string, status = 400, retryAfterSeconds = 0) {
    super(description);
    this.error = error;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type OAuthOptions = {
  /** The origin that issues tokens, without a trailing slash; read on every call so tests can bind a port first. */
  issuer: () => string;
  now?: () => Date;
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
  codeTtlMs?: number;
  /** Private-use redirect schemes accepted besides https and loopback http, such as `cursor`. */
  redirectSchemes?: string[];
  /** Registered clients kept at most; registrations without a grant are removed first, oldest first. */
  maxClients?: number;
  /**
   * Client registrations allowed per hour: from one address (default 60: many people reach this
   * server through the same agent service), from an address that may be every visitor at once
   * (default 300) and from everybody together (default 600).
   */
  registrations?: { perAddress?: number; shared?: number; global?: number };
  /** Called with the account whenever one of its grants ends, so the server can close what the grant had open. */
  onRevoke?: (accountId: string) => void;
};

/** Where a registration comes from; see `Origin` in `accounts.ts`. */
export type RegistrationOrigin = { address: string; shared?: boolean };

export type AuthorizeRequest = {
  client: { id: string; name: string };
  redirectUri: string;
  state: string | undefined;
  scopes: Scope[];
  resource: string;
  codeChallenge: string;
};

/** Why an authorization request cannot go on: shown on a page, or sent back to the client. */
export type AuthorizeFailure =
  | { kind: 'page'; message: string }
  | { kind: 'redirect'; location: string; error: string };

export type AccessGrant = {
  accountId: string;
  userId: string;
  clientId: string;
  grantId: string;
  scopes: Scope[];
  expiresAt: Date;
};

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const forbiddenSchemes = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'http', 'https']);
const text = (value: unknown) => (typeof value === 'string' && value.length <= 2048 ? value : undefined);

export function createOAuth(db: Database, options: OAuthOptions) {
  const now = options.now ?? (() => new Date());
  const accessTtl = options.accessTokenTtlMs ?? 60 * 60_000;
  const refreshTtl = options.refreshTokenTtlMs ?? 30 * 24 * 60 * 60_000;
  const codeTtl = options.codeTtlMs ?? 5 * 60_000;
  const extraSchemes = new Set(
    (options.redirectSchemes ?? []).map(s => s.toLowerCase()).filter(s => !forbiddenSchemes.has(s)),
  );
  const maxClients = options.maxClients ?? 5000;
  const registrations = {
    perAddress: options.registrations?.perAddress ?? 60,
    shared: options.registrations?.shared ?? 300,
    global: options.registrations?.global ?? 600,
  };
  const registrationWindowMs = 60 * 60_000;
  const throttle = createThrottle(db, now);
  /** A client without a grant that nobody has used for this long is forgotten by the housekeeping. */
  const idleClientMs = 30 * 24 * 60 * 60_000;
  const issuer = () => options.issuer().replace(/\/$/, '');
  /** The canonical URI of the MCP endpoint; the audience of every token (RFC 8707). */
  const resource = () => `${issuer()}/mcp`;

  /** A redirect URI is https, http on a loopback host, or an allowed private-use scheme; never with a fragment. */
  function acceptableRedirect(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.hash || url.username || url.password) return false;
    const scheme = url.protocol.slice(0, -1);
    if (scheme === 'https') return true;
    if (scheme === 'http') return loopbackHosts.has(url.hostname);
    return extraSchemes.has(scheme);
  }

  function parseScopes(value: unknown): Scope[] | null {
    if (value === undefined || value === '') return defaultScopes;
    if (typeof value !== 'string') return null;
    const names = [...new Set(value.split(/\s+/).filter(Boolean))];
    // Scopes this server does not have (openid, offline_access…) are dropped; a request left with none is refused.
    const known = names.filter((name): name is Scope => name in scopes);
    return known.length ? allScopes.filter(scope => known.includes(scope)) : null;
  }

  /** The resource a request names must be this server's MCP endpoint (or its origin). Absent means that endpoint. */
  function acceptResource(value: unknown) {
    if (value === undefined || value === '') return true;
    if (typeof value !== 'string') return false;
    const candidate = value.replace(/\/$/, '');
    return candidate === resource() || candidate === issuer();
  }

  /** End a grant: its codes and tokens are deleted, and the server is told so it can close open streams. */
  function endGrant(grant: { id: string; accountId: string }, stamp: string) {
    revokeGrant(db, grant.id, stamp);
    options.onRevoke?.(grant.accountId);
  }

  /**
   * Issue the token pair of a grant. `narrowed` is the subset of the grant's scopes a refresh asked
   * for: it applies to this access token only, and is written into the token's own prefix (a bit
   * per scope), which the stored hash covers. The refresh token keeps the scope of the grant.
   */
  function issueTokens(grantId: string, grantedScopes: string, narrowed?: Scope[]) {
    const time = now();
    const mask = narrowed?.reduce((bits, scope) => bits | (1 << allScopes.indexOf(scope)), 0);
    const accessToken = newSecret(mask === undefined ? 'rc_at_' : `rc_at_s${mask}_`);
    const refreshToken = newSecret('rc_rt_');
    db.transaction(() => {
      insertToken(db, hashSecret(accessToken), {
        grantId,
        kind: 'access',
        createdAt: time.toISOString(),
        expiresAt: new Date(time.getTime() + accessTtl).toISOString(),
      });
      insertToken(db, hashSecret(refreshToken), {
        grantId,
        kind: 'refresh',
        createdAt: time.toISOString(),
        expiresAt: new Date(time.getTime() + refreshTtl).toISOString(),
      });
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: Math.floor(accessTtl / 1000),
      refresh_token: refreshToken,
      scope: narrowed ? narrowed.join(' ') : grantedScopes,
    };
  }

  /** Identify the client of a token or revocation request; a confidential client must prove its secret. */
  function authenticateClient(params: Record<string, unknown>, basic?: { id: string; secret: string }) {
    const clientId = basic?.id ?? text(params.client_id);
    const client = clientId ? clientById(db, clientId) : undefined;
    if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (client.authMethod !== 'none') {
      const secret = basic?.secret ?? text(params.client_secret);
      if (!secret || !client.secretHash || !safeEqual(hashSecret(secret), client.secretHash))
        throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
    return client;
  }

  return {
    issuer,
    resource,

    /** RFC 9728 document served at `/.well-known/oauth-protected-resource`. */
    protectedResourceMetadata() {
      return {
        resource: resource(),
        authorization_servers: [issuer()],
        scopes_supported: allScopes,
        bearer_methods_supported: ['header'],
        resource_name: 'ReloCat',
      };
    },

    /** RFC 8414 document served at `/.well-known/oauth-authorization-server`. */
    authorizationServerMetadata() {
      const base = issuer();
      return {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/revoke`,
        scopes_supported: allScopes,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        // RFC 9207: every authorization response, success or error, carries `iss`.
        authorization_response_iss_parameter_supported: true,
      };
    },

    /** The `WWW-Authenticate` value of a 401 from the MCP endpoint. Never contains a token. */
    challenge(error?: { code: 'invalid_token' | 'insufficient_scope'; description: string }, scope = allScopes) {
      const parts = [
        `resource_metadata="${issuer()}/.well-known/oauth-protected-resource"`,
        `scope="${scope.join(' ')}"`,
      ];
      if (error) parts.push(`error="${error.code}"`, `error_description="${error.description.replace(/["\\]/g, '')}"`);
      return `Bearer ${parts.join(', ')}`;
    },

    /**
     * RFC 7591 dynamic client registration. Returns the response body; the secret appears only here.
     * Registrations are budgeted per hour for the address they come from and for everybody together.
     */
    registerClient(body: unknown, origin?: RegistrationOrigin) {
      const addressKey = `register:${origin?.address ?? 'unknown'}`;
      const allowed = origin?.shared ? registrations.shared : registrations.perAddress;
      for (const [key, limit] of [
        [addressKey, allowed],
        ['register:all', registrations.global],
      ] as const)
        if (throttle.spent(key, registrationWindowMs) >= limit)
          throw new OAuthError(
            'temporarily_unavailable',
            'Too many client registrations; try again later',
            429,
            throttle.windowEndsIn(key, registrationWindowMs),
          );
      const parsed = OAuthClientMetadataSchema.safeParse(body);
      if (!parsed.success) throw new OAuthError('invalid_client_metadata', 'The client metadata is not valid');
      const metadata = parsed.data;
      const redirectUris = [...new Set(metadata.redirect_uris)];
      if (redirectUris.length < 1 || redirectUris.length > 10 || !redirectUris.every(acceptableRedirect))
        throw new OAuthError(
          'invalid_redirect_uri',
          'Register 1 to 10 redirect URIs that use https, or http on localhost, without a fragment',
        );
      const authMethod = metadata.token_endpoint_auth_method ?? 'none';
      if (authMethod !== 'none' && authMethod !== 'client_secret_post' && authMethod !== 'client_secret_basic')
        throw new OAuthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
      const grantTypes = metadata.grant_types ?? ['authorization_code', 'refresh_token'];
      if (
        !grantTypes.includes('authorization_code') ||
        grantTypes.some(t => !['authorization_code', 'refresh_token'].includes(t))
      )
        throw new OAuthError(
          'invalid_client_metadata',
          'Only authorization_code and refresh_token grants are supported',
        );
      if (metadata.response_types?.some(type => type !== 'code'))
        throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported');
      const time = now();
      throttle.spend(addressKey, registrationWindowMs);
      throttle.spend('register:all', registrationWindowMs);
      if (countClients(db) >= maxClients) {
        // Make room: grants nobody can use any more, then the oldest registrations without a grant.
        deleteExpiredOauth(db, time.toISOString());
        deleteDeadGrants(db);
        const over = countClients(db) - maxClients + 1;
        if (over > 0) deleteOldestUnusedClients(db, over);
        if (countClients(db) >= maxClients)
          throw new OAuthError('temporarily_unavailable', 'Client registration is full; try again later', 503);
      }
      const secret = authMethod === 'none' ? null : newSecret('rc_cs_');
      // The name is shown on the consent page (escaped there); control characters are removed here.
      const name = (metadata.client_name ?? '')
        .replace(/\p{Cc}/gu, '')
        .trim()
        .slice(0, 80);
      const client: ClientRecord = {
        id: `client-${randomBytes(12).toString('hex')}`,
        secretHash: secret ? hashSecret(secret) : null,
        name: name || 'Unnamed client',
        redirectUris,
        authMethod,
        createdAt: time.toISOString(),
      };
      insertClient(db, client);
      return {
        client_id: client.id,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(time.getTime() / 1000),
        client_name: client.name,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: authMethod,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      };
    },

    /** Build the redirect back to a client: the given parameters plus `state` and `iss`. */
    redirectTo(redirectUri: string, state: string | undefined, params: Record<string, string>) {
      const url = new URL(redirectUri);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (state !== undefined) url.searchParams.set('state', state);
      url.searchParams.set('iss', issuer());
      return url.href;
    },

    /**
     * Validate the query of `GET /oauth/authorize`. An unknown client or a redirect URI that is not
     * registered exactly is never redirected to; every later problem goes back to the client.
     */
    validateAuthorize(query: Record<string, unknown>): AuthorizeRequest | AuthorizeFailure {
      const client = clientById(db, text(query.client_id) ?? '');
      if (!client) return { kind: 'page', message: 'This application is not registered with ReloCat.' };
      const redirectUri = text(query.redirect_uri);
      if (!redirectUri || !client.redirectUris.includes(redirectUri))
        return { kind: 'page', message: 'The return address of this request is not registered for the application.' };
      const state = text(query.state);
      const refuse = (error: string, description: string): AuthorizeFailure => ({
        kind: 'redirect',
        error,
        location: this.redirectTo(redirectUri, state, { error, error_description: description }),
      });
      if (query.response_type !== 'code')
        return refuse('unsupported_response_type', 'Only response_type=code is supported');
      const codeChallenge = text(query.code_challenge);
      if (!codeChallenge) return refuse('invalid_request', 'PKCE is required: code_challenge is missing');
      // A missing method means "plain" in RFC 7636; only S256 is accepted.
      if (query.code_challenge_method !== 'S256')
        return refuse('invalid_request', 'PKCE code_challenge_method must be S256');
      if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return refuse('invalid_request', 'Malformed code_challenge');
      const requested = parseScopes(query.scope);
      if (!requested) return refuse('invalid_scope', 'None of the requested scopes is supported');
      if (!acceptResource(query.resource)) return refuse('invalid_target', 'The resource is not this MCP server');
      return {
        client: { id: client.id, name: client.name },
        redirectUri,
        state,
        scopes: requested,
        resource: resource(),
        codeChallenge,
      };
    },

    /** The person consented: record the grant and return the redirect that carries the one-time code. */
    approve(accountId: string, request: AuthorizeRequest) {
      const time = now();
      const grantId = `grant-${randomBytes(12).toString('hex')}`;
      const code = newSecret('rc_ac_');
      db.transaction(() => {
        insertGrant(db, {
          id: grantId,
          accountId,
          clientId: request.client.id,
          scopes: request.scopes.join(' '),
          resource: request.resource,
          createdAt: time.toISOString(),
        });
        insertCode(db, hashSecret(code), {
          grantId,
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          expiresAt: new Date(time.getTime() + codeTtl).toISOString(),
        });
      });
      return this.redirectTo(request.redirectUri, request.state, { code });
    },

    /** The person refused: the redirect that tells the client so. */
    deny(request: AuthorizeRequest) {
      return this.redirectTo(request.redirectUri, request.state, {
        error: 'access_denied',
        error_description: 'The person did not allow access',
      });
    },

    /**
     * `POST /oauth/token`: exchange an authorization code, or rotate a refresh token. A code or a
     * refresh token presented twice revokes the whole grant, since one of the two parties stole it.
     */
    token(params: Record<string, unknown>, basic?: { id: string; secret: string }) {
      const client = authenticateClient(params, basic);
      const time = now();
      const stamp = time.toISOString();
      if (params.grant_type === 'authorization_code') {
        const code = text(params.code);
        const verifier = text(params.code_verifier);
        if (!code || !verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required');
        const codeHash = hashSecret(code);
        const stored = codeByHash(db, codeHash);
        const grant = stored && grantById(db, stored.grantId);
        if (!stored || !grant || grant.clientId !== client.id)
          throw new OAuthError('invalid_grant', 'The authorization code is not valid');
        if (stored.usedAt) {
          endGrant(grant, stamp);
          throw new OAuthError('invalid_grant', 'The authorization code was already used');
        }
        if (grant.revokedAt || stored.expiresAt <= stamp)
          throw new OAuthError('invalid_grant', 'The authorization code expired');
        if (text(params.redirect_uri) !== stored.redirectUri)
          throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !verifyPkce(verifier, stored.codeChallenge))
          throw new OAuthError('invalid_grant', 'PKCE verification failed');
        if (!acceptResource(params.resource))
          throw new OAuthError('invalid_target', 'The resource is not this MCP server');
        markCodeUsed(db, codeHash, stamp);
        touchClient(db, client.id, stamp);
        return issueTokens(grant.id, grant.scopes);
      }
      if (params.grant_type === 'refresh_token') {
        const refreshToken = text(params.refresh_token);
        if (!refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required');
        const tokenHash = hashSecret(refreshToken);
        const stored = tokenByHash(db, tokenHash);
        const grant = stored && grantById(db, stored.grantId);
        if (stored?.kind !== 'refresh' || !grant || grant.clientId !== client.id)
          throw new OAuthError('invalid_grant', 'The refresh token is not valid');
        if (stored.usedAt) {
          // Reuse of a rotated token: end the family so neither holder keeps access.
          endGrant(grant, stamp);
          throw new OAuthError('invalid_grant', 'The refresh token was already used; access was revoked');
        }
        if (grant.revokedAt || stored.expiresAt <= stamp)
          throw new OAuthError('invalid_grant', 'The refresh token expired');
        if (!acceptResource(params.resource))
          throw new OAuthError('invalid_target', 'The resource is not this MCP server');
        // RFC 6749 section 6: `scope` may ask for less than was granted, never for more; left out,
        // it means everything that was granted.
        const asked = params.scope === undefined || params.scope === '' ? undefined : parseScopes(params.scope);
        if (asked === null) throw new OAuthError('invalid_scope', 'None of the requested scopes is supported');
        if (asked?.some(scope => !grant.scopes.split(' ').includes(scope)))
          throw new OAuthError('invalid_scope', 'A refresh cannot widen the granted scopes');
        markTokenUsed(db, tokenHash, stamp);
        touchClient(db, client.id, stamp);
        return issueTokens(grant.id, grant.scopes, asked);
      }
      throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
    },

    /** RFC 7009: revoking either token of a grant ends the grant. Unknown tokens are not an error. */
    revoke(params: Record<string, unknown>, basic?: { id: string; secret: string }) {
      const client = authenticateClient(params, basic);
      const token = text(params.token);
      if (!token) throw new OAuthError('invalid_request', 'token is required');
      const stored = tokenByHash(db, hashSecret(token));
      const grant = stored && grantById(db, stored.grantId);
      if (grant && grant.clientId === client.id) endGrant(grant, now().toISOString());
    },

    /**
     * Who an access token speaks for, or null when it is unknown, expired, revoked, a refresh token,
     * or was issued for another resource.
     */
    verifyAccessToken(token: string): AccessGrant | null {
      const stored = tokenByHash(db, hashSecret(token));
      if (stored?.kind !== 'access' || stored.expiresAt <= now().toISOString()) return null;
      const grant = grantById(db, stored.grantId);
      if (!grant || grant.revokedAt || grant.resource !== resource()) return null;
      const account = accountById(db, grant.accountId);
      if (!account) return null;
      // An access token issued by a refresh that asked for less carries its own narrower scope.
      const narrowed = /^rc_at_s(\d+)_/.exec(token);
      const mask = narrowed ? Number(narrowed[1]) : undefined;
      return {
        accountId: account.id,
        userId: account.userId,
        clientId: grant.clientId,
        grantId: grant.id,
        scopes: grant.scopes
          .split(' ')
          .filter((scope): scope is Scope => scope in scopes)
          .filter(scope => mask === undefined || (mask & (1 << allScopes.indexOf(scope))) !== 0),
        expiresAt: new Date(stored.expiresAt),
      };
    },

    /** Clients an account has connected, for the account page. */
    connectedClients(accountId: string) {
      return activeGrants(db, accountId).map(grant => ({
        grantId: grant.id,
        clientName: grant.clientName,
        scopes: grant.scopes.split(' ').filter((scope): scope is Scope => scope in scopes),
        connectedAt: grant.createdAt,
      }));
    },

    /** Revoke one of an account's own grants. Returns false when the grant is not that account's. */
    disconnect(accountId: string, grantId: string) {
      const grant = grantById(db, grantId);
      if (!grant || grant.accountId !== accountId) return false;
      endGrant(grant, now().toISOString());
      return true;
    },

    /**
     * Housekeeping, run by the server on a timer: expired codes and tokens, grants nothing can use
     * any more (revoked, or with every code and token expired), and clients left without a grant
     * that nobody has used for 30 days.
     */
    housekeeping() {
      const time = now();
      db.transaction(() => {
        deleteExpiredOauth(db, time.toISOString());
        deleteDeadGrants(db);
        deleteUnusedClients(db, new Date(time.getTime() - idleClientMs).toISOString());
      });
    },
  };
}

export type OAuth = ReturnType<typeof createOAuth>;
