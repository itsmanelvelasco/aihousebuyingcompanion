import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AccountRecord } from '../db/auth.ts';
import {
  accountByEmail,
  accountById,
  accountIdOfUser,
  clearThrottle,
  deleteAccountAndPerson,
  deleteExpiredSessions,
  deleteSession,
  deleteSessionsOfAccount,
  deleteStaleThrottles,
  insertAccount,
  insertSession,
  readThrottle,
  sessionByHash,
  touchLogin,
  touchSession,
  updatePasswordHash,
  writeThrottle,
} from '../db/auth.ts';
import type { Database } from '../db/database.ts';
import { insertUser, writeSection } from '../db/profiles.ts';
import { decoyHash, hashPassword, needsRehash, verifyPassword } from './passwords.ts';
import { csrfToken, hashSecret, newSecret } from './secrets.ts';

/**
 * Accounts and browser sessions. An account is an email and a password hash, and it owns exactly
 * one person record: a `users` row with an unguessable id, created empty at sign-up. Nothing here
 * touches an HTTP request; the server passes plain values in and sets cookies from what comes back.
 *
 * Deliberately missing (no mail service exists): email verification and password reset.
 */

export type AuthErrorCode = 'invalid_email' | 'weak_password' | 'email_taken' | 'invalid_credentials' | 'throttled';

/** A refusal with a message that is safe to show to the person. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** For `throttled`: seconds until another attempt is accepted. */
  readonly retryAfterSeconds: number;
  constructor(code: AuthErrorCode, message: string, retryAfterSeconds = 0) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type Account = Pick<AccountRecord, 'id' | 'email' | 'userId' | 'createdAt' | 'lastLoginAt'>;
export type Session = { id: string; expiresAt: Date };

export type AccountsOptions = {
  now?: () => Date;
  /** A session unused for this long ends. Default 14 days. */
  sessionIdleMs?: number;
  /** A session ends this long after sign-in whatever its use. Default 30 days. */
  sessionAbsoluteMs?: number;
  /** Failed sign-ins allowed per window before the key is locked. */
  throttle?: {
    perAccount?: number;
    perAddress?: number;
    windowMs?: number;
    lockMs?: number;
    signUpsPerAddress?: number;
  };
};

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const minPasswordLength = 10;
const maxPasswordLength = 200;
const day = 24 * 60 * 60 * 1000;

const publicAccount = ({ id, email, userId, createdAt, lastLoginAt }: AccountRecord): Account => ({
  id,
  email,
  userId,
  createdAt,
  lastLoginAt,
});

/** An id that fits `safeId` and cannot be guessed: a prefix and 120 random bits in lowercase hex. */
const randomId = (prefix: string) => `${prefix}-${randomBytes(15).toString('hex')}`;

export function createAccounts(db: Database, options: AccountsOptions = {}) {
  const now = options.now ?? (() => new Date());
  const idleMs = options.sessionIdleMs ?? 14 * day;
  const absoluteMs = options.sessionAbsoluteMs ?? 30 * day;
  const limits = {
    perAccount: options.throttle?.perAccount ?? 5,
    perAddress: options.throttle?.perAddress ?? 20,
    windowMs: options.throttle?.windowMs ?? 15 * 60_000,
    lockMs: options.throttle?.lockMs ?? 15 * 60_000,
    signUpsPerAddress: options.throttle?.signUpsPerAddress ?? 10,
  };

  /** Throws `throttled` while `key` is locked. */
  function assertNotLocked(key: string) {
    const record = readThrottle(db, key);
    const time = now();
    if (record?.lockedUntil && record.lockedUntil > time.toISOString()) {
      const seconds = Math.ceil((Date.parse(record.lockedUntil) - time.getTime()) / 1000);
      throw new AuthError('throttled', 'Too many attempts. Wait a few minutes and try again.', seconds);
    }
  }

  /** Count one failure for `key`; at `limit` failures inside the window the key is locked. */
  function recordFailure(key: string, limit: number) {
    db.transaction(() => {
      const time = now();
      const previous = readThrottle(db, key);
      const fresh = !previous || Date.parse(previous.windowStart) + limits.windowMs <= time.getTime();
      const failures = fresh ? 1 : previous.failures + 1;
      writeThrottle(db, key, {
        failures,
        windowStart: fresh ? time.toISOString() : previous.windowStart,
        lockedUntil: failures >= limit ? new Date(time.getTime() + limits.lockMs).toISOString() : null,
      });
    });
  }

  function startSession(accountId: string): Session {
    const id = newSecret('rc_s_');
    const time = now();
    const expiresAt = new Date(time.getTime() + absoluteMs);
    insertSession(db, hashSecret(id), {
      accountId,
      createdAt: time.toISOString(),
      lastSeenAt: time.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return { id, expiresAt };
  }

  return {
    /**
     * Create an account and its empty person record. The person starts from an empty template, not
     * from a fixture: three profile documents with nothing in them but their id.
     */
    async signUp(input: { email: unknown; password: unknown; address: string }): Promise<Account> {
      const signUpKey = `signup:${input.address}`;
      assertNotLocked(signUpKey);
      const email = emailSchema.safeParse(input.email);
      if (!email.success) throw new AuthError('invalid_email', 'Enter a valid email address.');
      const password = typeof input.password === 'string' ? input.password : '';
      if (password.length < minPasswordLength || password.length > maxPasswordLength)
        throw new AuthError(
          'weak_password',
          `Choose a password of ${minPasswordLength} to ${maxPasswordLength} characters.`,
        );
      if (password.toLowerCase() === email.data)
        throw new AuthError('weak_password', 'The password must differ from the email.');
      // Every attempt that reaches the hash counts, so an address cannot create accounts without bound.
      recordFailure(signUpKey, limits.signUpsPerAddress);
      const passwordHash = await hashPassword(password);
      const account: AccountRecord = {
        id: randomId('acct'),
        email: email.data,
        passwordHash,
        userId: randomId('p'),
        createdAt: now().toISOString(),
        lastLoginAt: null,
      };
      db.transaction(() => {
        if (accountByEmail(db, account.email))
          throw new AuthError('email_taken', 'An account with this email already exists. Sign in instead.');
        insertUser(db, account.userId, account.createdAt);
        // The profile store requires its three documents; they start empty. `synthetic` is the
        // store's required flag for every document; ownership by an account is what marks a person real.
        const empty = { schemaVersion: 1, synthetic: true };
        const details = { ...empty, id: account.userId } as { synthetic: boolean };
        writeSection(db, account.userId, 'details', details, account.createdAt);
        writeSection(db, account.userId, 'preferences', empty, account.createdAt);
        writeSection(db, account.userId, 'bank-account', empty, account.createdAt);
        insertAccount(db, account);
      });
      return publicAccount(account);
    },

    /**
     * Check an email and password. Failures are counted per account and per address, and both keys
     * lock for a while when the limit is reached. A new session is always created (rotation): a
     * session id from before the sign-in is never promoted.
     */
    async login(input: { email: unknown; password: unknown; address: string }) {
      const parsed = emailSchema.safeParse(input.email);
      const email = parsed.success ? parsed.data : '';
      const accountKey = `account:${email}`;
      const addressKey = `address:${input.address}`;
      assertNotLocked(addressKey);
      assertNotLocked(accountKey);
      const record = email ? accountByEmail(db, email) : undefined;
      const password = typeof input.password === 'string' ? input.password.slice(0, maxPasswordLength + 1) : '';
      // An unknown email still costs one hash, so the answer takes the same time either way.
      const matches = await verifyPassword(password, record?.passwordHash ?? (await decoyHash()));
      if (!record || !matches || password.length > maxPasswordLength) {
        recordFailure(addressKey, limits.perAddress);
        if (email) recordFailure(accountKey, limits.perAccount);
        throw new AuthError('invalid_credentials', 'The email or the password is not right.');
      }
      clearThrottle(db, accountKey);
      if (needsRehash(record.passwordHash)) updatePasswordHash(db, record.id, await hashPassword(password));
      const time = now();
      touchLogin(db, record.id, time.toISOString());
      deleteExpiredSessions(db, time.toISOString(), new Date(time.getTime() - idleMs).toISOString());
      deleteStaleThrottles(db, new Date(time.getTime() - Math.max(limits.windowMs, limits.lockMs) * 4).toISOString());
      return {
        account: publicAccount({ ...record, lastLoginAt: time.toISOString() }),
        session: startSession(record.id),
      };
    },

    startSession,

    /** The account behind a session cookie value, or null when it is unknown, idle too long or past its end. */
    session(sessionId: string | undefined): { account: Account; csrf: string; expiresAt: Date } | null {
      if (!sessionId) return null;
      const idHash = hashSecret(sessionId);
      const stored = sessionByHash(db, idHash);
      if (!stored) return null;
      const time = now();
      const idle = Date.parse(stored.lastSeenAt) + idleMs <= time.getTime();
      if (idle || stored.expiresAt <= time.toISOString()) {
        deleteSession(db, idHash);
        return null;
      }
      const account = accountById(db, stored.accountId);
      if (!account) return null;
      // One write a minute per session is enough to keep the idle clock honest.
      if (time.getTime() - Date.parse(stored.lastSeenAt) > 60_000) touchSession(db, idHash, time.toISOString());
      return { account: publicAccount(account), csrf: csrfToken(sessionId), expiresAt: new Date(stored.expiresAt) };
    },

    logout(sessionId: string | undefined) {
      if (sessionId) deleteSession(db, hashSecret(sessionId));
    },

    /** End every session of an account, for example after its password is confirmed for a deletion. */
    logoutEverywhere(accountId: string) {
      deleteSessionsOfAccount(db, accountId);
    },

    account(accountId: string) {
      const record = accountById(db, accountId);
      return record ? publicAccount(record) : null;
    },

    /** The account that owns a person record; undefined for a demo fixture or an unknown id. */
    ownerOf(userId: string) {
      return accountIdOfUser(db, userId);
    },

    /**
     * Delete the account and every row stored about its person, after the password is confirmed.
     * Returns the rows removed per table, or throws `invalid_credentials`.
     */
    async deleteAccount(accountId: string, password: unknown) {
      const record = accountById(db, accountId);
      const accountKey = `account:${record?.email ?? ''}`;
      assertNotLocked(accountKey);
      const matches = await verifyPassword(
        typeof password === 'string' ? password.slice(0, maxPasswordLength) : '',
        record?.passwordHash ?? (await decoyHash()),
      );
      if (!record || !matches) {
        if (record) recordFailure(accountKey, limits.perAccount);
        throw new AuthError('invalid_credentials', 'The password is not right. Nothing was deleted.');
      }
      return deleteAccountAndPerson(db, accountId);
    },
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
