import type { Database } from './database.ts';
import { deletePersonRows, personRowCounts } from './person-data.ts';

/**
 * Queries for accounts, browser sessions, sign-in throttling and OAuth (clients, grants, codes and
 * tokens). Every secret arrives here already hashed; this file never sees a password or a token.
 * Timestamps are ISO 8601 text, compared as strings.
 */

export type AccountRecord = {
  id: string;
  email: string;
  passwordHash: string;
  /** The one person record this account owns. */
  userId: string;
  createdAt: string;
  lastLoginAt: string | null;
};

const accountColumns =
  'id, email, password_hash AS passwordHash, user_id AS userId, created_at AS createdAt, last_login_at AS lastLoginAt';

export function accountByEmail(db: Database, email: string) {
  return db.get<AccountRecord>(`SELECT ${accountColumns} FROM accounts WHERE email = ?`, email);
}

export function accountById(db: Database, id: string) {
  return db.get<AccountRecord>(`SELECT ${accountColumns} FROM accounts WHERE id = ?`, id);
}

/** The account that owns a person record, or undefined for a demo fixture. */
export function accountIdOfUser(db: Database, userId: string) {
  return db.get<{ id: string }>('SELECT id FROM accounts WHERE user_id = ?', userId)?.id;
}

export function insertAccount(db: Database, account: Omit<AccountRecord, 'lastLoginAt'>) {
  db.run(
    'INSERT INTO accounts (id, email, password_hash, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
    account.id,
    account.email,
    account.passwordHash,
    account.userId,
    account.createdAt,
  );
}

export function touchLogin(db: Database, accountId: string, now: string) {
  db.run('UPDATE accounts SET last_login_at = ? WHERE id = ?', now, accountId);
}

export function updatePasswordHash(db: Database, accountId: string, passwordHash: string) {
  db.run('UPDATE accounts SET password_hash = ? WHERE id = ?', passwordHash, accountId);
}

/**
 * Delete an account and everything stored about its person: every table of `personTables`
 * (`person-data.ts`), in one transaction. Returns the number of rows removed per table.
 *
 * The caller disconnects the person's bank connections from the running sync engine first
 * (`forgetUser` in `packages/banks/sync.ts`); this function removes whatever rows are left,
 * including sealed bank credentials, pending bank consents and unconfirmed statement uploads.
 */
export function deleteAccountAndPerson(db: Database, accountId: string) {
  return db.transaction(() => {
    const account = accountById(db, accountId);
    if (!account) return null;
    const { userId } = account;
    return { userId, removed: deletePersonRows(db, { userId, accountId }) };
  });
}

/** Rows that still mention a person or an account anywhere; used to prove a deletion was complete. */
export function remainingRows(db: Database, accountId: string, userId: string) {
  let total = Object.values(personRowCounts(db, { userId, accountId })).reduce((sum, rows) => sum + rows, 0);
  total += db.get<{ total: number }>(
    `
      SELECT COUNT(*) AS total FROM oauth_tokens t
      WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = t.grant_id)
    `,
  )!.total;
  return total;
}

// ----------------------------------------------------------------- sessions

export type SessionRecord = { accountId: string; createdAt: string; lastSeenAt: string; expiresAt: string };

export function insertSession(db: Database, idHash: string, session: SessionRecord) {
  db.run(
    'INSERT INTO auth_sessions (id_hash, account_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    idHash,
    session.accountId,
    session.createdAt,
    session.lastSeenAt,
    session.expiresAt,
  );
}

export function sessionByHash(db: Database, idHash: string) {
  return db.get<SessionRecord>(
    `
      SELECT account_id AS accountId, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt
      FROM auth_sessions WHERE id_hash = ?
    `,
    idHash,
  );
}

export function touchSession(db: Database, idHash: string, now: string) {
  db.run('UPDATE auth_sessions SET last_seen_at = ? WHERE id_hash = ?', now, idHash);
}

export function deleteSession(db: Database, idHash: string) {
  db.run('DELETE FROM auth_sessions WHERE id_hash = ?', idHash);
}

export function deleteSessionsOfAccount(db: Database, accountId: string) {
  db.run('DELETE FROM auth_sessions WHERE account_id = ?', accountId);
}

/** Remove sessions past their absolute end or idle for longer than allowed. */
export function deleteExpiredSessions(db: Database, now: string, idleBefore: string) {
  db.run('DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ?', now, idleBefore);
}

// ----------------------------------------------------------------- throttle

export type ThrottleRecord = { failures: number; windowStart: string; lockedUntil: string | null };

export function readThrottle(db: Database, key: string) {
  return db.get<ThrottleRecord>(
    'SELECT failures, window_start AS windowStart, locked_until AS lockedUntil FROM auth_throttle WHERE key = ?',
    key,
  );
}

export function writeThrottle(db: Database, key: string, record: ThrottleRecord) {
  db.run(
    `
      INSERT INTO auth_throttle (key, failures, window_start, locked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET
        failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until
    `,
    key,
    record.failures,
    record.windowStart,
    record.lockedUntil,
  );
}

export function clearThrottle(db: Database, key: string) {
  db.run('DELETE FROM auth_throttle WHERE key = ?', key);
}

/** Remove counters last written before `before` whose wait, if any, is over at `now`. */
export function deleteStaleThrottles(db: Database, before: string, now = before) {
  db.run(
    'DELETE FROM auth_throttle WHERE window_start <= ? AND (locked_until IS NULL OR locked_until <= ?)',
    before,
    now,
  );
}

export function countThrottles(db: Database) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM auth_throttle')!.total;
}

/** Remove the `count` counters written longest ago, to keep the table bounded. */
export function deleteOldestThrottles(db: Database, count: number) {
  db.run('DELETE FROM auth_throttle WHERE key IN (SELECT key FROM auth_throttle ORDER BY window_start LIMIT ?)', count);
}

// -------------------------------------------------------------------- oauth

export type ClientRecord = {
  id: string;
  secretHash: string | null;
  name: string;
  redirectUris: string[];
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  createdAt: string;
};

export function insertClient(db: Database, client: ClientRecord) {
  db.run(
    'INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    client.id,
    client.secretHash,
    client.name,
    JSON.stringify(client.redirectUris),
    client.authMethod,
    client.createdAt,
  );
}

export function clientById(db: Database, id: string): ClientRecord | undefined {
  const row = db.get<Omit<ClientRecord, 'redirectUris'> & { redirectUris: string }>(
    `
      SELECT id, secret_hash AS secretHash, name, redirect_uris AS redirectUris, auth_method AS authMethod,
        created_at AS createdAt
      FROM oauth_clients WHERE id = ?
    `,
    id,
  );
  return row && { ...row, redirectUris: JSON.parse(row.redirectUris) as string[] };
}

export function countClients(db: Database) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM oauth_clients')!.total;
}

/**
 * Clients without any grant, registered and last used before `before`: abandoned registrations,
 * and clients whose grants were all revoked or ran out (`deleteDeadGrants` removes those first).
 */
export function deleteUnusedClients(db: Database, before: string) {
  return db.run(
    `
      DELETE FROM oauth_clients
      WHERE created_at <= ? AND (last_used_at IS NULL OR last_used_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)
    `,
    before,
    before,
  );
}

/** Remove the `count` clients without any grant that were registered longest ago. */
export function deleteOldestUnusedClients(db: Database, count: number) {
  db.run(
    `
      DELETE FROM oauth_clients WHERE id IN (
        SELECT c.id FROM oauth_clients c
        WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
        ORDER BY c.created_at, c.rowid LIMIT ?
      )
    `,
    count,
  );
}

/**
 * Remove grants nothing can use any more: revoked ones, and ones whose codes and tokens have all
 * expired and been purged (`deleteExpiredOauth` runs first). A grant approved a moment ago still
 * has its code, so it stays.
 */
export function deleteDeadGrants(db: Database) {
  db.run(
    `
      DELETE FROM oauth_grants
      WHERE revoked_at IS NOT NULL
        OR (NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id)
          AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.grant_id = oauth_grants.id))
    `,
  );
}

export type GrantRecord = {
  id: string;
  accountId: string;
  clientId: string;
  scopes: string;
  resource: string;
  createdAt: string;
  revokedAt: string | null;
};

const grantColumns =
  'id, account_id AS accountId, client_id AS clientId, scopes, resource, created_at AS createdAt, revoked_at AS revokedAt';

export function insertGrant(db: Database, grant: Omit<GrantRecord, 'revokedAt'>) {
  db.run(
    'INSERT INTO oauth_grants (id, account_id, client_id, scopes, resource, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    grant.id,
    grant.accountId,
    grant.clientId,
    grant.scopes,
    grant.resource,
    grant.createdAt,
  );
}

export function grantById(db: Database, id: string) {
  return db.get<GrantRecord>(`SELECT ${grantColumns} FROM oauth_grants WHERE id = ?`, id);
}

/** Active grants of an account with the client's name, newest first: the "connected clients" list. */
export function activeGrants(db: Database, accountId: string) {
  return db.all<GrantRecord & { clientName: string }>(
    `
      SELECT g.id, g.account_id AS accountId, g.client_id AS clientId, g.scopes, g.resource,
        g.created_at AS createdAt, g.revoked_at AS revokedAt, c.name AS clientName
      FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
      WHERE g.account_id = ? AND g.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id)
      ORDER BY g.created_at DESC, g.id
    `,
    accountId,
  );
}

/** Revoke a grant and remove every code and token issued under it. */
export function revokeGrant(db: Database, grantId: string, now: string) {
  db.transaction(() => {
    db.run('UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now, grantId);
    db.run('DELETE FROM oauth_tokens WHERE grant_id = ?', grantId);
    db.run('DELETE FROM oauth_codes WHERE grant_id = ?', grantId);
  });
}

export type CodeRecord = {
  grantId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: string;
  usedAt: string | null;
};

export function insertCode(db: Database, codeHash: string, code: Omit<CodeRecord, 'usedAt'>) {
  db.run(
    'INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
    codeHash,
    code.grantId,
    code.redirectUri,
    code.codeChallenge,
    code.expiresAt,
  );
}

export function codeByHash(db: Database, codeHash: string) {
  return db.get<CodeRecord>(
    `
      SELECT grant_id AS grantId, redirect_uri AS redirectUri, code_challenge AS codeChallenge,
        expires_at AS expiresAt, used_at AS usedAt
      FROM oauth_codes WHERE code_hash = ?
    `,
    codeHash,
  );
}

export function markCodeUsed(db: Database, codeHash: string, now: string) {
  db.run('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?', now, codeHash);
}

export type TokenRecord = {
  grantId: string;
  kind: 'access' | 'refresh';
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
};

export function insertToken(db: Database, tokenHash: string, token: Omit<TokenRecord, 'usedAt'>) {
  db.run(
    'INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    tokenHash,
    token.grantId,
    token.kind,
    token.createdAt,
    token.expiresAt,
  );
}

export function tokenByHash(db: Database, tokenHash: string) {
  return db.get<TokenRecord>(
    `
      SELECT grant_id AS grantId, kind, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt
      FROM oauth_tokens WHERE token_hash = ?
    `,
    tokenHash,
  );
}

export function markTokenUsed(db: Database, tokenHash: string, now: string) {
  db.run('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ?', now, tokenHash);
}

export function deleteToken(db: Database, tokenHash: string) {
  db.run('DELETE FROM oauth_tokens WHERE token_hash = ?', tokenHash);
}

export function touchClient(db: Database, clientId: string, now: string) {
  db.run('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?', now, clientId);
}

/** Housekeeping: expired codes and tokens. Used refresh tokens are kept until they expire, to detect reuse. */
export function deleteExpiredOauth(db: Database, now: string) {
  db.run('DELETE FROM oauth_codes WHERE expires_at <= ?', now);
  db.run('DELETE FROM oauth_tokens WHERE expires_at <= ?', now);
}

/** How many rows of each kind are stored about a person, for the account page. */
export function storedCounts(db: Database, userId: string) {
  const count = (table: string) =>
    db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ?`, userId)!.total;
  return {
    inputs: count('input_records'),
    bankAccounts: count('bank_accounts'),
    bankMovements: count('bank_transactions'),
    bankConnections: count('bank_connections'),
    bankImports: count('bank_imports'),
    habitGoals: count('habit_goals'),
    habitCheckins: count('habit_checkins'),
  };
}
