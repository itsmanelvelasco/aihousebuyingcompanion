import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AccountRecord } from '../db/auth.ts';
import {
  accountByEmail,
  accountById,
  accountIdOfUser,
  deleteAccountAndPerson,
  deleteExpiredSessions,
  deleteSession,
  deleteSessionsOfAccount,
  insertAccount,
  insertSession,
  sessionByHash,
  touchLogin,
  touchSession,
  updatePasswordHash,
} from '../db/auth.ts';
import { deleteOtherSessions } from '../db/bank-person.ts';
import type { Database } from '../db/database.ts';
import { insertUser, writeSection } from '../db/profiles.ts';
import { decoyHash, hashPassword, needsRehash, verifyPassword } from './passwords.ts';
import { csrfToken, hashSecret, newSecret } from './secrets.ts';
import { createThrottle } from './throttle.ts';

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
  /**
   * How guessing is slowed. Nothing here locks an account from outside: see "Throttling" in
   * `README.md` for the rules and what they leave open.
   */
  throttle?: {
    /** Wrong passwords one address may send for one account before each further one makes it wait. Default 5. */
    attempts?: number;
    /** The first wait; it doubles with every further failure. Default 30 seconds. */
    delayMs?: number;
    /** The longest wait. Default 15 minutes. */
    maxDelayMs?: number;
    /** A count is forgotten after this long without a failure. Default 1 hour. */
    quietMs?: number;
    /** Wrong passwords one address may send across all accounts before it starts to wait. Default 20. */
    perAddress?: number;
    /**
     * Wrong passwords for one account from all addresses together, per hour, before the account
     * turns careful: from then on every address gets one try and then the longest wait. Default 100.
     */
    accountCeiling?: number;
    /**
     * Failed sign-ins per five minutes through an address that may be every visitor at once (a
     * proxy that states no client address). Past it, sign-in through that address pauses until the
     * five minutes are over. Default 300.
     */
    sharedCeiling?: number;
    /** Accounts one address may create per 15 minutes. Default 10. */
    signUpsPerAddress?: number;
    /** The same for an address that may be every visitor at once. Default 60. */
    signUpsShared?: number;
    /** Accounts created per hour by everybody together. Default 300. */
    signUpsGlobal?: number;
    /** Counter rows kept at most. Default 50,000. */
    maxRows?: number;
  };
};

/** Where a sign-in or sign-up comes from, as far as the server can tell. */
export type Origin = {
  /** The counting key of the client (`packages/http/rate-limit.ts`). */
  address: string;
  /** True when that key may stand for every visitor at once, so it must not be treated as one client. */
  shared?: boolean;
};

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const minPasswordLength = 10;
const maxPasswordLength = 200;
const minute = 60_000;
const day = 24 * 60 * minute;
const tooMany = 'Too many attempts. Wait a little and try again.';

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
    attempts: options.throttle?.attempts ?? 5,
    delayMs: options.throttle?.delayMs ?? 30_000,
    maxDelayMs: options.throttle?.maxDelayMs ?? 15 * minute,
    quietMs: options.throttle?.quietMs ?? 60 * minute,
    perAddress: options.throttle?.perAddress ?? 20,
    accountCeiling: options.throttle?.accountCeiling ?? 100,
    sharedCeiling: options.throttle?.sharedCeiling ?? 300,
    signUpsPerAddress: options.throttle?.signUpsPerAddress ?? 10,
    signUpsShared: options.throttle?.signUpsShared ?? 60,
    signUpsGlobal: options.throttle?.signUpsGlobal ?? 300,
  };
  const throttle = createThrottle(db, now, options.throttle?.maxRows);
  const delays = { delayMs: limits.delayMs, maxDelayMs: limits.maxDelayMs, quietMs: limits.quietMs };
  /** One address guessing one account. */
  const pairRule = { ...delays, free: limits.attempts };
  /** One address guessing across accounts. */
  const addressRule = { ...delays, free: limits.perAddress };
  const accountWindowMs = 60 * minute;
  const sharedWindowMs = 5 * minute;
  const signUpWindowMs = 15 * minute;
  const signUpGlobalWindowMs = 60 * minute;

  /** Emails are hashed in counter keys: the table then holds nothing a person typed. */
  const emailKey = (email: string) => hashSecret(`email:${email}`).slice(0, 32);
  const refuse = (seconds: number): never => {
    throw new AuthError('throttled', tooMany, Math.max(1, seconds));
  };

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
    async signUp(input: { email: unknown; password: unknown } & Origin): Promise<Account> {
      // A shared address gets a budget sized for many visitors, and no budget locks for longer than its window.
      const signUpKey = `signup:${input.address}`;
      const allowed = input.shared ? limits.signUpsShared : limits.signUpsPerAddress;
      if (throttle.spent(signUpKey, signUpWindowMs) >= allowed)
        refuse(throttle.windowEndsIn(signUpKey, signUpWindowMs));
      if (throttle.spent('signup:all', signUpGlobalWindowMs) >= limits.signUpsGlobal)
        refuse(throttle.windowEndsIn('signup:all', signUpGlobalWindowMs));
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
      throttle.spend(signUpKey, signUpWindowMs);
      throttle.spend('signup:all', signUpGlobalWindowMs);
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
        // The profile store requires its three documents; they start empty. A person who signs up
        // is real, so the documents say `synthetic: false`. The trigger `accounts_own_real_people`
        // (migration 3) stays as a backstop: it corrects the flag for any account row, whatever a
        // future caller, an import or a restore wrote into the documents first.
        const empty = { schemaVersion: 1, synthetic: false };
        const details = { ...empty, id: account.userId } as { synthetic: boolean };
        writeSection(db, account.userId, 'details', details, account.createdAt);
        writeSection(db, account.userId, 'preferences', empty, account.createdAt);
        writeSection(db, account.userId, 'bank-account', empty, account.createdAt);
        insertAccount(db, account);
      });
      return publicAccount(account);
    },

    /**
     * Check an email and password. A new session is always created (rotation): a session id from
     * before the sign-in is never promoted.
     *
     * Wrong passwords are counted for the pair (account, address), and that pair is what waits:
     * five are free, then each further one doubles the wait up to 15 minutes. Failures that other
     * addresses collect for the same account never stop this address from having its password
     * checked, so a stranger cannot lock a person out. Two wider counters back this up without
     * locking anybody: an address that fails across many accounts starts to wait as an address, and
     * an account that collects many failures from many addresses turns careful (one try per
     * address, then the longest wait). An address that may be every visitor at once (`shared`) is
     * never made to wait as an address; it only meets a ceiling sized for many people, for five
     * minutes at a time.
     */
    async login(input: { email: unknown; password: unknown } & Origin) {
      const parsed = emailSchema.safeParse(input.email);
      const email = parsed.success ? parsed.data : '';
      const account = emailKey(email);
      const pairKey = `pair:${account}|${input.address}`;
      const accountKey = `account:${account}`;
      const addressKey = `address:${input.address}`;
      const sharedKey = `shared:${input.address}`;
      if (input.shared) {
        if (throttle.spent(sharedKey, sharedWindowMs) >= limits.sharedCeiling)
          refuse(throttle.windowEndsIn(sharedKey, sharedWindowMs));
      } else if (throttle.waitSeconds(addressKey)) refuse(throttle.waitSeconds(addressKey));
      // The only per-account refusal: this address has used up its own tries for this account.
      if (throttle.waitSeconds(pairKey)) refuse(throttle.waitSeconds(pairKey));
      const record = email ? accountByEmail(db, email) : undefined;
      const password = typeof input.password === 'string' ? input.password.slice(0, maxPasswordLength + 1) : '';
      // An unknown email still costs one hash, so the answer takes the same time either way.
      const matches = await verifyPassword(password, record?.passwordHash ?? (await decoyHash()));
      if (!record || !matches || password.length > maxPasswordLength) {
        const careful = throttle.spend(accountKey, accountWindowMs) > limits.accountCeiling;
        throttle.fail(pairKey, pairRule, careful);
        if (input.shared) throttle.spend(sharedKey, sharedWindowMs);
        else throttle.fail(addressKey, addressRule);
        throw new AuthError('invalid_credentials', 'The email or the password is not right.');
      }
      throttle.clear(pairKey);
      if (needsRehash(record.passwordHash)) updatePasswordHash(db, record.id, await hashPassword(password));
      const time = now();
      touchLogin(db, record.id, time.toISOString());
      return {
        account: publicAccount({ ...record, lastLoginAt: time.toISOString() }),
        session: startSession(record.id),
      };
    },

    /**
     * Housekeeping, run by the server on a timer: sessions past their end or idle too long, and
     * counters nobody has touched for a while. The counter table is bounded as well.
     */
    housekeeping() {
      const time = now();
      deleteExpiredSessions(db, time.toISOString(), new Date(time.getTime() - idleMs).toISOString());
      throttle.sweep(Math.max(limits.quietMs, accountWindowMs) * 2);
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

    /**
     * Change the password of a signed-in account. The current password is required, so a session
     * left open on a shared computer cannot take the account over. Wrong current passwords are
     * counted for the session that sends them, on a counter of their own (five free, then a wait
     * that doubles), apart from the sign-in and delete counters.
     *
     * On success every other session of the account ends; the caller (the server) also ends every
     * OAuth grant, so no token issued under the old password keeps working.
     */
    async changePassword(
      accountId: string,
      input: { current: unknown; next: unknown },
      context: { sessionId: string },
    ) {
      const record = accountById(db, accountId);
      const key = `password:${hashSecret(context.sessionId).slice(0, 32)}`;
      if (throttle.waitSeconds(key)) refuse(throttle.waitSeconds(key));
      const current = typeof input.current === 'string' ? input.current.slice(0, maxPasswordLength) : '';
      const matches = await verifyPassword(current, record?.passwordHash ?? (await decoyHash()));
      if (!record || !matches) {
        if (record) throttle.fail(key, pairRule);
        throw new AuthError('invalid_credentials', 'The current password is not right. Nothing was changed.');
      }
      throttle.clear(key);
      const next = typeof input.next === 'string' ? input.next : '';
      if (next.length < minPasswordLength || next.length > maxPasswordLength)
        throw new AuthError(
          'weak_password',
          `Choose a new password of ${minPasswordLength} to ${maxPasswordLength} characters.`,
        );
      if (next.toLowerCase() === record.email)
        throw new AuthError('weak_password', 'The password must differ from the email.');
      if (next === current) throw new AuthError('weak_password', 'The new password must differ from the current one.');
      const passwordHash = await hashPassword(next);
      const sessionsEnded = db.transaction(() => {
        updatePasswordHash(db, record.id, passwordHash);
        return deleteOtherSessions(db, record.id, hashSecret(context.sessionId));
      });
      return { sessionsEnded };
    },

    /** The account that owns a person record; undefined for a demo fixture or an unknown id. */
    ownerOf(userId: string) {
      return accountIdOfUser(db, userId);
    },

    /**
     * Delete the account and every row stored about its person, after the password is confirmed.
     * Returns the rows removed per table, or throws `invalid_credentials`.
     *
     * The caller is already signed in, so the sign-in counters play no part: no stranger can stop a
     * person from deleting their account. Wrong passwords are counted for the session that sends
     * them (`sessionId`), with the same five free tries and doubling wait as a sign-in.
     * `beforeDelete` runs once the password is confirmed and before any row goes: the server uses
     * it to disconnect the bank connections of the person and close their event streams.
     */
    async deleteAccount(
      accountId: string,
      password: unknown,
      context: { sessionId?: string; beforeDelete?: (userId: string) => Promise<unknown> | unknown } = {},
    ) {
      const record = accountById(db, accountId);
      const key = `reauth:${context.sessionId ? hashSecret(context.sessionId).slice(0, 32) : accountId}`;
      if (throttle.waitSeconds(key)) refuse(throttle.waitSeconds(key));
      const matches = await verifyPassword(
        typeof password === 'string' ? password.slice(0, maxPasswordLength) : '',
        record?.passwordHash ?? (await decoyHash()),
      );
      if (!record || !matches) {
        if (record) throttle.fail(key, pairRule);
        throw new AuthError('invalid_credentials', 'The password is not right. Nothing was deleted.');
      }
      throttle.clear(key);
      await context.beforeDelete?.(record.userId);
      const outcome = deleteAccountAndPerson(db, accountId);
      throttle.clear(`account:${emailKey(record.email)}`);
      return outcome;
    },
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
