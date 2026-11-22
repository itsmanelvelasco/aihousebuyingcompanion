import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { safeId } from '../contracts/ids.ts';
import {
  credentialExpiries,
  deleteConsentsOfUser,
  deleteCredential,
  deleteCredentialsOfUser,
  deleteExpiredConsents,
  getCredential,
  insertConsent,
  listConsents,
  putCredential,
  takeConsent,
  trimConsents,
} from '../db/bank-person.ts';
import {
  allConnections,
  clearWebhooks,
  connectionByRef,
  countConnections,
  countPendingWebhooks,
  deleteConnection,
  enqueueWebhook,
  getConnection,
  insertConnection,
  lastWebhookSeq,
  listConnections,
  pendingWebhooks,
  updateConnection,
} from '../db/bank-sync.ts';
import type { Database } from '../db/database.ts';
import { open } from '../db/database.ts';
import { insertUser } from '../db/profiles.ts';
import { transactionSchema } from '../finance/cashflow.ts';
import { ApiError } from '../http/server.ts';
import type { BankConnection, BankProvider, ProviderContext, WebhookSignal } from './provider.ts';
import { pollIntervalSchema, supportsConsent, supportsWebhooks } from './provider.ts';
import type { BankRegistry, RegisteredProvider } from './registry.ts';
import type { Vault } from './vault.ts';
import { sealedRefPrefix, VaultError } from './vault.ts';

/**
 * The bank sync engine: which user is connected to which provider, pulling movements from providers
 * into the ledger, polling providers that cannot call us, and telling listeners about new revisions.
 *
 * It is built to survive a real peer. A verified webhook is written to a persistent queue (a table
 * of the runtime database) before it is acknowledged, so a notification that arrives during a sync
 * or just before a restart is still processed; repeated notification IDs are ignored. A sync that fails is retried with
 * exponential backoff and its state is kept on the connection. A provider with webhooks is still
 * pulled when it has been silent for a while, so a lost notification only delays a movement.
 *
 * The engine never writes the ledger itself. It goes through the `SyncLedger` it is given, so the
 * profile API's ledger store stays the single writer and imports stay idempotent. Its own state
 * (connections, the webhook queue and the notification IDs already seen) lives in the database.
 *
 * A person can connect a bank themselves. A provider with the `consent` capability sends them to
 * the bank to authorise access (`beginConsent`, then `completeConsent` from the callback); what the
 * bank returns is sealed by the `Vault` and the connection row keeps only a keyed fingerprint of
 * it. A synthetic provider has no bank to ask and is connected directly (`connectSelf`). Any other
 * provider stays with the operator (`connect`).
 */

/** One persisted ledger revision, as returned by `GET /users/:id/bank/events`. */
export type LedgerEvent = {
  sequence: number;
  occurredAt: string;
  type: 'bank.updated';
  accountCount: number;
  transactionCount: number;
  /** Whether the whole ledger was synthetic at this revision. */
  synthetic: boolean;
};

/** What `onEvent` listeners receive after each ledger revision. */
export type BankEvent = { userId: string; event: LedgerEvent };
export type BankEventListener = (event: BankEvent) => void;

type Revision = { ledger: { revision: number } };

/** The part of the ledger store the engine needs. `apps/profile-api/bank.ts` implements it. */
export type SyncLedger = {
  /** Must reject (404) for an unknown user. */
  read(userId: string): Promise<{ revision: number; accounts: { id: string; openingDate: string }[] }>;
  /** The same answer without loading the movements. Optional; the engine prefers it over `read`. */
  head?(userId: string): Promise<{ revision: number; accounts: { id: string; openingDate: string }[] }>;
  createAccount(userId: string, account: unknown): Promise<Revision>;
  /**
   * Insert new movements, update changed ones, skip identical ones; one revision per changed batch.
   * An error with `retryable: false` (a full ledger) means the same batch can never succeed as
   * things are: the engine stops its automatic syncs of that connection until a caller syncs it.
   */
  upsertTransactions(
    userId: string,
    input: { transactions: unknown[] },
  ): Promise<Revision & { result: { inserted: number; updated: number; duplicates: number } }>;
  /** Delete the listed movements that exist and ignore the others. Needed only for `removedIds`. */
  removeTransactions?(userId: string, transactionIds: string[]): Promise<Revision & { result: { removed: number } }>;
  /** Subscribe to persisted revisions; returns the function that unsubscribes. */
  onEvent(listener: BankEventListener): () => void;
};

const refSchema = z.string().regex(/^[\x21-\x7e]{1,200}$/, 'Use 1-200 printable characters without spaces');
const connectionSchema = z
  .object({
    id: safeId,
    providerId: safeId,
    ref: refSchema,
    createdAt: z.string(),
    cursor: z.string().max(2000).nullable(),
    pollIntervalMs: pollIntervalSchema.nullable(),
    lastSyncAt: z.string().nullable(),
    lastError: z.string().nullable(),
    /** When the last sync was attempted, whether or not it succeeded. Absent in older files. */
    lastAttemptAt: z.string().nullable().default(null),
    /** Failed syncs since the last successful one. Absent in older files. */
    consecutiveFailures: z.number().int().nonnegative().default(0),
  })
  .strict();
type StoredConnection = z.infer<typeof connectionSchema>;

const eventIdSchema = z.string().min(1).max(200);
/** Connections one person may hold, whoever created them. */
export const maxConnections = 10;
/** Consents one person may have in progress; starting another drops the oldest. */
const maxPendingConsents = 5;
/** What a consent flow may return as the reference of a link: it is sealed, so it may be a long token. */
const grantedRefSchema = z.string().min(1).max(4000);
const expirySchema = z.iso.datetime({ offset: true }).nullable().optional();
/** Cadence of a synthetic feed a person connected themselves: slow enough to read. */
const selfSyntheticPollMs = 60_000;

/**
 * A sync that cannot succeed until the person acts (the consent ran out, the stored credential
 * cannot be read). `retryable: false` makes the engine stop its automatic syncs of the connection.
 */
export class ConnectionBlockedError extends ApiError {
  readonly retryable = false;
  constructor(message: string) {
    super(409, message);
  }
}
const consentExpiredMessage = 'The consent at the bank has expired. Connect this bank again to renew it.';

const hashState = (value: string) => createHash('sha256').update(value).digest('hex');
const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
/** The row a sealed credential belongs to; a ciphertext moved to another row does not open. */
const credentialAad = (userId: string, connectionId: string, providerId: string) =>
  `bank-credential\n${userId}\n${connectionId}\n${providerId}`;

/** Body of `POST /users/:id/bank/connections`. */
export const connectInputSchema = z
  .object({
    providerId: safeId,
    ref: refSchema,
    id: safeId.optional(),
    pollIntervalMs: pollIntervalSchema.nullable().optional(),
  })
  .strict();

/** Outcome of syncing one connection. */
export type SyncResult = {
  connectionId: string;
  providerId: string;
  accountsCreated: number;
  inserted: number;
  updated: number;
  duplicates: number;
  /** Movements deleted because the bank reported them declined or reverted. */
  removed: number;
  /** Ledger revision after the sync. Unchanged when nothing new arrived. */
  revision: number;
  syncedAt: string;
};

export type BankSyncOptions = {
  ledger: SyncLedger;
  /** A promise is accepted because provider discovery is asynchronous. */
  registry: BankRegistry | Promise<BankRegistry>;
  /**
   * The runtime database. Connections, the webhook queue and seen notification IDs persist there;
   * without it the engine keeps them in a private in-memory database that ends with the process.
   */
  db?: Database;
  /**
   * Seals what a consent flow returns. Without it no connection can be made through a consent at
   * the bank, and a sealed connection that is already stored cannot be synced.
   */
  vault?: Vault;
  /** How long a person has to finish a consent they started at the bank. Default 10 minutes. */
  consentTtlMs?: number;
  clock?: () => Date;
  /** Runs before each provider call, for example to seed an empty demo ledger for the synthetic feed. */
  beforeSync?: (userId: string, provider: BankProvider) => Promise<void>;
  /** Polling cadence for providers without webhooks that do not declare their own. */
  defaultPollIntervalMs?: number;
  /** Days before the last sync that are requested again, to pick up pending movements that were booked. */
  overlapDays?: number;
  /** Upper bound of polling timers in this process. */
  maxPolling?: number;
  /** Delay before the first retry of a failed sync; it doubles with every further failure. Default 2 s. */
  retryBaseMs?: number;
  /** Upper bound of the retry delay. Default 5 minutes. */
  retryMaxMs?: number;
  /**
   * A connection of a provider with webhooks is pulled anyway when nothing was attempted for this
   * long, so a lost notification only delays a movement. Default 5 minutes; null disables it.
   */
  fallbackPollMs?: number | null;
  /**
   * How often the engine looks for due retries and fallback pulls. Default 1 s. Null starts no timer:
   * the caller drives the engine with `runDue()`, which is how tests step an injected clock.
   */
  housekeepingMs?: number | null;
};

type Activity = {
  timer?: ReturnType<typeof setInterval>;
  running?: Promise<SyncResult>;
  /** A webhook arrived during a sync: run once more when it finishes. */
  queued: boolean;
  failures: number;
  stopAfterFailures: number;
  syncCount: number;
  /** Clock time (ms) of the next automatic retry after a failure, when one is scheduled. */
  nextRetryAt?: number;
  /** Clock time (ms) of the last attempt, or of the connection's creation. Drives the fallback pull. */
  lastActivityAt: number;
  /** The provider has webhooks: failed syncs are retried and silence triggers a fallback pull. */
  fallback: boolean;
  /**
   * The last sync failed with an error that retrying cannot fix (the ledger is full). Timers,
   * webhooks and fallback pulls skip the connection until a sync asked for by a caller succeeds.
   */
  blocked: boolean;
};

const key = (userId: string, connectionId: string) => `${userId}/${connectionId}`;
const refKey = (providerId: string, ref: string) => `${providerId}\n${ref}`;

/**
 * Persistence of connection records. Each change is one transaction, so two requests (or two
 * processes) cannot both link a reference or lose each other's update.
 */
function createConnectionStore(db: Database, registerUsers: boolean) {
  return {
    read(userId: string): StoredConnection[] {
      return listConnections(db, safeId.parse(userId));
    },
    find(userId: string, connectionId: string): StoredConnection | undefined {
      return getConnection(db, userId, connectionId);
    },
    /** Link a connection: 409 when its ID or bank reference is taken, 400 beyond the per-user limit. */
    add(userId: string, connection: StoredConnection, alsoWrite?: () => void) {
      const record = connectionSchema.parse(connection);
      db.transaction(() => {
        // A private engine database has no profile store in front of it to create the user row.
        if (registerUsers) insertUser(db, safeId.parse(userId), record.createdAt);
        if (connectionByRef(db, record.providerId, record.ref))
          throw new ApiError(409, 'This bank connection reference is already linked');
        if (getConnection(db, userId, record.id)) throw new ApiError(409, 'Bank connection already exists');
        if (countConnections(db, userId) >= maxConnections) throw new ApiError(400, 'Connection limit reached');
        insertConnection(db, userId, record);
        // The sealed credential of a consented connection is written with it, or neither is.
        alsoWrite?.();
      });
    },
    /** Change one stored connection and save it. Returns the saved record, or undefined when it is gone. */
    update(userId: string, connectionId: string, change: (connection: StoredConnection) => void) {
      return db.transaction(() => {
        const target = getConnection(db, userId, connectionId);
        if (!target) return undefined;
        change(target);
        const saved = connectionSchema.parse(target);
        updateConnection(db, userId, saved);
        return saved;
      });
    },
    /** Delete a connection and return what was stored, or undefined when there was none. */
    remove(userId: string, connectionId: string) {
      return db.transaction(() => {
        const target = getConnection(db, userId, connectionId);
        if (target) {
          // The stored credential goes with the link, and so do notifications queued for it.
          deleteCredential(db, userId, connectionId);
          deleteConnection(db, userId, connectionId);
          clearWebhooks(db, target.providerId, target.ref, lastWebhookSeq(db));
        }
        return target;
      });
    },
    /** Every stored connection, by user. */
    scan() {
      const found = new Map<string, StoredConnection[]>();
      for (const { userId, ...connection } of allConnections(db))
        found.set(userId, [...(found.get(userId) ?? []), connection]);
      return found;
    },
  };
}

/**
 * The persistent webhook queue: two small tables. A notification is committed before `add`
 * resolves, so "accepted" always means "will survive a restart".
 */
function createWebhookQueue(db: Database) {
  return {
    pending: () => pendingWebhooks(db),
    pendingCount: () => countPendingWebhooks(db),
    /** The highest sequence handed out so far; a sync covers the notifications up to it. */
    lastSeq: () => lastWebhookSeq(db),
    /**
     * Record a notification durably. Returns false, and stores nothing, when its event ID was
     * already accepted. Notifications for one connection collapse into a single pending item.
     * A database failure rejects: not durable means not accepted, and the bank delivers again.
     */
    async add(providerId: string, ref: string, eventId: string | undefined, receivedAt: string) {
      return enqueueWebhook(db, { providerId, ref, eventId, receivedAt });
    },
    /** Drop the notifications of a connection that a sync started after `throughSeq` has covered. */
    async clear(providerId: string, ref: string, throughSeq: number) {
      clearWebhooks(db, providerId, ref, throughSeq);
    },
  };
}

/** A message that is safe to store and show: provider errors may contain URLs, tokens or bank text. */
function sanitizedError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof z.ZodError) return 'The provider returned data that does not fit the ledger schema';
  return 'The provider request failed';
}

export function createBankSync(options: BankSyncOptions) {
  const { ledger } = options;
  // The engine needs the revision and the accounts, never the movements.
  const readLedger = ledger.head ?? ledger.read;
  const clock = options.clock ?? (() => new Date());
  const defaultPollIntervalMs = pollIntervalSchema.parse(options.defaultPollIntervalMs ?? 300_000);
  const overlapDays = options.overlapDays ?? 7;
  const maxPolling = options.maxPolling ?? 50;
  const retryBaseMs = options.retryBaseMs ?? 2000;
  const retryMaxMs = options.retryMaxMs ?? 300_000;
  const fallbackPollMs = options.fallbackPollMs === undefined ? 300_000 : options.fallbackPollMs;
  const housekeepingMs = options.housekeepingMs === undefined ? 1000 : options.housekeepingMs;
  // Without a database the engine keeps its state in memory, as a private database of its own.
  const db = options.db ?? open(':memory:');
  const { vault } = options;
  const consentTtlMs = options.consentTtlMs ?? 10 * 60_000;
  let loaded: BankRegistry | undefined;
  const store = createConnectionStore(db, !options.db);
  const queue = createWebhookQueue(db);
  const webhookCounts = { accepted: 0, duplicates: 0 };
  const activities = new Map<string, Activity>();
  const refs = new Map<string, { userId: string; connectionId: string }>();
  const listeners = new Set<BankEventListener>();
  let closed = false;

  const unsubscribe = ledger.onEvent(event => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // One failing listener must not stop the others.
      }
    }
  });

  function activity(userId: string, connectionId: string) {
    const id = key(userId, connectionId);
    let state = activities.get(id);
    if (!state) {
      state = {
        queued: false,
        failures: 0,
        stopAfterFailures: 5,
        syncCount: 0,
        lastActivityAt: clock().getTime(),
        fallback: false,
        blocked: false,
      };
      activities.set(id, state);
    }
    return state;
  }

  /**
   * Drop everything this process remembers about a connection: its timer, its retry state, the
   * bank reference it holds and the notifications queued for that reference. Used when the stored
   * connection is gone (its person was deleted, or another process removed it), so the reference
   * is free again and nothing is written for it later.
   */
  function forget(userId: string, connectionId: string) {
    const state = activities.get(key(userId, connectionId));
    if (state?.timer) clearInterval(state.timer);
    if (state) {
      state.timer = undefined;
      state.queued = false;
      state.nextRetryAt = undefined;
    }
    activities.delete(key(userId, connectionId));
    for (const [index, target] of refs) {
      if (target.userId !== userId || target.connectionId !== connectionId) continue;
      refs.delete(index);
      const [providerId, ref] = index.split('\n');
      try {
        clearWebhooks(db, providerId, ref, queue.lastSeq());
      } catch {
        // The queue row is harmless without its connection: the next start does not index it.
      }
    }
  }

  /** Delay before the retry that follows the given number of consecutive failures. */
  function retryDelay(failures: number) {
    return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(failures - 1, 30));
  }

  async function provider(providerId: string): Promise<RegisteredProvider> {
    const entry = (await options.registry).get(providerId);
    if (!entry) throw new ApiError(404, `Unknown bank provider: ${providerId}`);
    if (entry.status === 'unconfigured')
      throw new ApiError(409, `Bank provider ${providerId} is not configured; set ${entry.missingEnv.join(', ')}`);
    return entry;
  }

  async function find(userId: string, connectionId: string) {
    const connection = store.find(userId, connectionId);
    if (!connection) throw new ApiError(404, 'Bank connection not found');
    return connection;
  }

  /**
   * Whether a connection rests on a consent at the bank, and until when. `expired` means the engine
   * has stopped syncing it until the person consents again.
   */
  function consentOf(userId: string, connection: StoredConnection, expiries = credentialExpiries(db, userId)) {
    if (!expiries.has(connection.id))
      return { consent: 'not_required' as const, consentExpiresAt: null as string | null };
    const consentExpiresAt = expiries.get(connection.id) ?? null;
    const expired = consentExpiresAt !== null && consentExpiresAt <= clock().toISOString();
    return { consent: expired ? ('expired' as const) : ('granted' as const), consentExpiresAt };
  }

  function view(userId: string, connection: StoredConnection, expiries?: Map<string, string | null>) {
    const state = activities.get(key(userId, connection.id));
    const entry = loaded?.get(connection.providerId);
    return {
      id: connection.id,
      providerId: connection.providerId,
      /** The bank's name as people read it, and whether its records are fabricated. */
      displayName: entry?.provider.displayName ?? connection.providerId,
      synthetic: entry?.provider.synthetic ?? null,
      /** True when the bank tells ReloCat about new movements; false when it is polled or synced by hand. */
      webhooks: entry ? supportsWebhooks(entry.provider) : false,
      ...consentOf(userId, connection, expiries),
      createdAt: connection.createdAt,
      lastSyncAt: connection.lastSyncAt,
      lastError: connection.lastError,
      /** When a sync was last attempted, successful or not. */
      lastAttemptAt: connection.lastAttemptAt,
      /** Failed syncs since the last successful one; zero when the connection is healthy. */
      consecutiveFailures: connection.consecutiveFailures,
      /**
       * When the engine will retry on its own after a failure, or null when no retry is scheduled.
       * Null together with a `lastError` means the failure needs a person (for example a full ledger).
       */
      nextRetryAt: state?.nextRetryAt === undefined ? null : new Date(state.nextRetryAt).toISOString(),
      pollIntervalMs: connection.pollIntervalMs,
      /** Whether a polling timer is active in this process. */
      polling: Boolean(state?.timer),
      /** Successful syncs since this process started. */
      syncCount: state?.syncCount ?? 0,
    };
  }

  /** The lower date bound of the next fetch: a few days before the last successful sync. */
  function sinceDate(connection: StoredConnection) {
    if (!connection.lastSyncAt) return null;
    const since = new Date(connection.lastSyncAt);
    since.setUTCDate(since.getUTCDate() - overlapDays);
    return since.toISOString().slice(0, 10);
  }

  /**
   * The reference a provider is given. A consented connection stores it sealed: it is opened here,
   * for the length of one sync, and refused when the consent has run out or the key does not fit.
   */
  function openRef(userId: string, stored: StoredConnection, now: Date) {
    const credential = getCredential(db, userId, stored.id);
    if (!credential) {
      if (stored.ref.startsWith(sealedRefPrefix))
        throw new ConnectionBlockedError('The stored bank credential is missing. Connect this bank again.');
      return stored.ref;
    }
    if (credential.expiresAt !== null && credential.expiresAt <= now.toISOString())
      throw new ConnectionBlockedError(consentExpiredMessage);
    if (!vault)
      throw new ConnectionBlockedError('The stored bank credential cannot be read: no data encryption key is set.');
    try {
      return vault.open(credential.cipher, credentialAad(userId, stored.id, stored.providerId));
    } catch (error) {
      if (!(error instanceof VaultError)) throw error;
      throw new ConnectionBlockedError(
        'The stored bank credential cannot be read with the current data encryption key. Connect this bank again.',
      );
    }
  }

  /** Pull one connection from its provider into the ledger. */
  async function pull(userId: string, stored: StoredConnection): Promise<SyncResult> {
    const { provider: bank, env } = await provider(stored.providerId);
    await options.beforeSync?.(userId, bank);
    const now = clock();
    const connection: BankConnection = {
      id: stored.id,
      userId,
      ref: openRef(userId, stored, now),
      cursor: stored.cursor,
      pollIntervalMs: stored.pollIntervalMs,
    };
    let current = await readLedger(userId);
    let revision = current.revision;
    const context = (): ProviderContext => ({
      env,
      now,
      ledgerAccounts: current.accounts.map(account => ({ id: account.id, openingDate: account.openingDate })),
    });

    let accountsCreated = 0;
    for (const account of await bank.listAccounts(connection, context())) {
      if (current.accounts.some(existing => existing.id === account.id)) continue;
      const created = await ledger.createAccount(userId, {
        id: account.id,
        name: account.name,
        currency: account.currency,
        openingBalanceCents: account.openingBalanceCents,
        openingDate: account.openingDate,
        synthetic: bank.synthetic,
      });
      revision = created.ledger.revision;
      accountsCreated++;
    }
    if (accountsCreated) current = await readLedger(userId);

    const fetched = await bank.fetchTransactions(connection, { ...context(), since: sinceDate(stored) });
    const transactions = z.array(transactionSchema).parse(
      fetched.transactions.map(movement => ({
        id: movement.id,
        accountId: movement.accountId,
        date: movement.date,
        description: movement.description,
        amountCents: movement.amountCents,
        currency: 'EUR',
        category: movement.category,
        status: movement.status,
        synthetic: bank.synthetic,
      })),
    );
    const removedIds = z
      .array(safeId)
      .max(10_000)
      .parse(fetched.removedIds ?? []);
    const counts = { inserted: 0, updated: 0, duplicates: 0, removed: 0 };
    for (let start = 0; start < removedIds.length && ledger.removeTransactions; start += 500) {
      const outcome = await ledger.removeTransactions(userId, removedIds.slice(start, start + 500));
      counts.removed += outcome.result.removed;
      revision = outcome.ledger.revision;
    }
    for (let start = 0; start < transactions.length; start += 500) {
      const outcome = await ledger.upsertTransactions(userId, { transactions: transactions.slice(start, start + 500) });
      counts.inserted += outcome.result.inserted;
      counts.updated += outcome.result.updated;
      counts.duplicates += outcome.result.duplicates;
      revision = outcome.ledger.revision;
    }

    const syncedAt = now.toISOString();
    store.update(userId, stored.id, target => {
      if (fetched.nextCursor !== undefined) target.cursor = fetched.nextCursor;
      target.lastSyncAt = syncedAt;
      target.lastAttemptAt = syncedAt;
      target.lastError = null;
      target.consecutiveFailures = 0;
    });
    return { connectionId: stored.id, providerId: stored.providerId, accountsCreated, ...counts, revision, syncedAt };
  }

  /**
   * Sync one connection. Concurrent calls for the same connection share one run. `automatic` marks
   * the engine's own triggers (timer, webhook, retry, fallback): those leave a blocked connection
   * alone, while a sync a caller asks for always tries.
   */
  async function syncConnection(userId: string, connectionId: string, automatic = false): Promise<SyncResult> {
    safeId.parse(userId);
    if (closed) throw new ApiError(503, 'Bank sync is shutting down');
    const state = activity(userId, connectionId);
    if (state.running) return state.running;
    if (automatic && state.blocked) throw new ApiError(409, 'Bank sync is waiting for a manual sync');
    const operation = (async () => {
      const stored = store.find(userId, connectionId);
      if (!stored) {
        // The record is gone (its person was deleted): stop feeding it instead of failing forever.
        forget(userId, connectionId);
        throw new ApiError(404, 'Bank connection not found');
      }
      // Notifications accepted up to here are covered by this pull; later ones need another.
      const coveredSeq = queue.lastSeq();
      state.lastActivityAt = clock().getTime();
      state.nextRetryAt = undefined;
      try {
        const result = await pull(userId, stored);
        state.blocked = false;
        state.failures = 0;
        state.syncCount++;
        await queue.clear(stored.providerId, stored.ref, coveredSeq).catch(() => {});
        return result;
      } catch (error) {
        state.failures++;
        // The person, or the connection, was deleted while the provider was answering: nothing to retry.
        if (!store.find(userId, connectionId)) {
          forget(userId, connectionId);
          throw error;
        }
        const attemptedAt = clock();
        // A failure that retrying cannot fix: no backoff and no further automatic syncs. The message
        // stays on the connection as `lastError`, and the notifications stay queued for the sync
        // that follows once a caller has made room and asked for one.
        state.blocked = (error as { retryable?: unknown } | null)?.retryable === false;
        // Connections that are fed automatically retry with backoff; manual ones wait for the caller.
        const fed = state.fallback || Boolean(state.timer);
        if (fed && !state.blocked && state.failures < state.stopAfterFailures && !closed)
          state.nextRetryAt = attemptedAt.getTime() + retryDelay(state.failures);
        const message = sanitizedError(error);
        try {
          store.update(userId, connectionId, target => {
            target.lastError = message;
            target.lastAttemptAt = attemptedAt.toISOString();
            target.consecutiveFailures = state.failures;
          });
        } catch {
          // The sync failure is what the caller must see, not a failure to record it.
        }
        throw error;
      }
    })();
    state.running = operation;
    try {
      return await operation;
    } finally {
      state.running = undefined;
      if (state.queued && !closed && activities.get(key(userId, connectionId)) === state) {
        state.queued = false;
        void syncConnection(userId, connectionId, true).catch(() => {});
      }
    }
  }

  function stopTimer(userId: string, connectionId: string) {
    const state = activities.get(key(userId, connectionId));
    if (state?.timer) clearInterval(state.timer);
    if (state) state.timer = undefined;
    return state;
  }

  /** Start (or restart) the polling timer of a connection. Repeated failures stop it. */
  function startTimer(userId: string, connectionId: string, intervalMs: number, stopAfterFailures = 5) {
    const state = activity(userId, connectionId);
    const active = [...activities.values()].filter(item => item.timer).length;
    if (!state.timer && active >= maxPolling) throw new ApiError(400, `Maximum ${maxPolling} polled bank connections`);
    stopTimer(userId, connectionId);
    state.failures = 0;
    state.stopAfterFailures = stopAfterFailures;
    state.timer = setInterval(() => {
      if (state.blocked) return;
      void syncConnection(userId, connectionId, true).catch(() => {
        if (state.failures >= state.stopAfterFailures) stopTimer(userId, connectionId);
      });
    }, intervalMs);
    state.timer.unref();
  }

  /**
   * Run what is due on the engine's clock: retries of failed syncs, notifications left in the queue
   * and fallback pulls of silent webhook connections. Resolves when those syncs have finished and
   * never rejects; each outcome is on its connection. The housekeeping timer calls this.
   */
  async function runDue() {
    if (closed) return;
    const now = clock().getTime();
    const waiting = new Set(queue.pending().map(item => refKey(item.providerId, item.ref)));
    const started: Promise<unknown>[] = [];
    for (const [index, target] of refs) {
      const state = activities.get(key(target.userId, target.connectionId));
      if (!state || state.running || state.blocked) continue;
      const retryDue = state.nextRetryAt !== undefined && state.nextRetryAt <= now;
      const idle = state.nextRetryAt === undefined;
      // A queued notification whose sync is neither running nor waiting for a retry (after a restart).
      const queuedDue = idle && state.failures === 0 && waiting.has(index);
      const silentDue =
        idle &&
        state.fallback &&
        !state.timer &&
        fallbackPollMs !== null &&
        now - state.lastActivityAt >= fallbackPollMs;
      if (retryDue || queuedDue || silentDue)
        started.push(syncConnection(target.userId, target.connectionId, true).catch(() => {}));
    }
    await Promise.all(started);
  }

  /** Rebuild the webhook index and resume polling of real providers after a restart. */
  async function resume() {
    const registry = await options.registry;
    loaded = registry;
    for (const [userId, connections] of store.scan()) {
      for (const connection of connections) {
        refs.set(refKey(connection.providerId, connection.ref), { userId, connectionId: connection.id });
        const entry = registry.get(connection.providerId);
        const state = activity(userId, connection.id);
        state.fallback = Boolean(entry?.status === 'configured' && supportsWebhooks(entry.provider));
        state.lastActivityAt = new Date(connection.lastAttemptAt ?? connection.createdAt).getTime();
        state.failures = connection.consecutiveFailures;
        // A connection that was failing when the process stopped picks its retries up where it left them.
        if (state.fallback && state.failures > 0 && state.failures < state.stopAfterFailures)
          state.nextRetryAt = clock().getTime() + retryDelay(state.failures);
        // Real connections keep polling across restarts. Synthetic feeds are opt-in per process.
        const resumable = entry?.status === 'configured' && !entry.provider.synthetic && connection.pollIntervalMs;
        if (resumable && !closed) startTimer(userId, connection.id, connection.pollIntervalMs!);
      }
    }
  }
  const ready = resume().catch(() => {});
  let housekeeping: ReturnType<typeof setInterval> | undefined;
  if (housekeepingMs !== null) {
    housekeeping = setInterval(() => void ready.then(runDue).catch(() => {}), housekeepingMs);
    housekeeping.unref();
  }

  /**
   * Accept a verified webhook: store it durably, then start the sync in the background. Resolves as
   * soon as the notification is committed, so the route can acknowledge it without waiting for the bank.
   */
  async function acceptWebhook(providerId: string, signal: Pick<WebhookSignal, 'connectionRef' | 'eventId'>) {
    await ready;
    if (closed) throw new ApiError(503, 'Bank sync is shutting down');
    // A consented connection is indexed by the keyed fingerprint of its reference, never by the reference.
    const storedRef = refs.has(refKey(providerId, signal.connectionRef))
      ? signal.connectionRef
      : (vault?.fingerprint(signal.connectionRef) ?? signal.connectionRef);
    const target = refs.get(refKey(providerId, storedRef));
    if (!target) return { known: false, duplicate: false };
    // A reference whose connection no longer exists is unknown, and nothing is queued for it.
    if (!store.find(target.userId, target.connectionId)) {
      forget(target.userId, target.connectionId);
      return { known: false, duplicate: false };
    }
    const eventId = eventIdSchema.optional().parse(signal.eventId);
    const fresh = await queue.add(providerId, storedRef, eventId, clock().toISOString());
    if (!fresh) {
      webhookCounts.duplicates++;
      return { known: true, duplicate: true };
    }
    webhookCounts.accepted++;
    const state = activity(target.userId, target.connectionId);
    if (state.running) state.queued = true;
    else if (!state.blocked) void syncConnection(target.userId, target.connectionId, true).catch(() => {});
    return { known: true, duplicate: false };
  }

  return {
    /** Resolves when persisted connections have been indexed. Every method waits for it. */
    ready,

    async listConnections(userId: string) {
      await ready;
      await readLedger(userId);
      const expiries = credentialExpiries(db, userId);
      return store.read(userId).map(connection => view(userId, connection, expiries));
    },

    /**
     * The banks a person can connect themselves: configured providers a person authorises at the
     * bank, and synthetic ones, which have no bank to ask. Providers only an operator can link, and
     * unconfigured ones, are left out. No variable name or value is included.
     */
    async banks() {
      await ready;
      return (await options.registry)
        .list()
        .filter(bank => bank.status === 'configured' && (bank.consent || bank.synthetic))
        .map(bank => ({
          id: bank.id,
          displayName: bank.displayName,
          /** True when every record of this bank is fabricated demo data. */
          synthetic: bank.synthetic,
          /** `consent_at_bank`: the person approves access on the bank's own page. `direct`: nothing to approve. */
          connect: bank.consent ? ('consent_at_bank' as const) : ('direct' as const),
          webhooks: bank.webhooks,
        }));
    },

    /**
     * A person connects a bank that needs no consent: a synthetic provider. The reference is made
     * here, never taken from the caller, so nobody can attach a reference that is somebody else's.
     */
    async connectSelf(userId: string, providerId: string) {
      await ready;
      const { provider: bank } = await provider(safeId.parse(providerId));
      if (supportsConsent(bank))
        throw new ApiError(409, 'This bank is connected by authorising access at the bank itself');
      if (!bank.synthetic) throw new ApiError(403, 'This bank can only be connected by the operator');
      return this.connect(userId, {
        providerId: bank.id,
        ref: `self-${userId}`,
        pollIntervalMs: Math.max(bank.pollIntervalMs ?? 0, selfSyntheticPollMs),
      });
    },

    /**
     * Start a consent at the bank for a person. Returns the bank's page to send them to. Only the
     * hash of the single-use `state` is stored, bound to the person and to the browser session
     * (`sessionKey`) that started it; `completeConsent` accepts the callback from that session alone.
     */
    async beginConsent(userId: string, providerId: string, request: { sessionKey: string; returnUrl: string }) {
      await ready;
      await readLedger(userId);
      const entry = await provider(safeId.parse(providerId));
      if (!entry.provider.consent) throw new ApiError(409, 'This bank is not connected through a consent at the bank');
      if (!vault) throw new ApiError(503, 'Bank connections are unavailable: the server has no data encryption key');
      const mine = store.read(userId);
      // A renewal of a connection the person already has needs no free slot.
      if (mine.length >= maxConnections && !mine.some(connection => connection.providerId === entry.provider.id))
        throw new ApiError(400, 'Connection limit reached');
      const state = randomBytes(32).toString('base64url');
      const now = clock();
      let redirectUrl: string;
      try {
        const started = await entry.provider.consent.beginConsent(
          { returnUrl: request.returnUrl, state },
          { env: entry.env, now },
        );
        const url = new URL(started.redirectUrl);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not a web address');
        redirectUrl = url.href;
      } catch (error) {
        throw new ApiError(502, error instanceof ApiError ? error.message : 'The bank did not start the authorisation');
      }
      const expiresAt = new Date(now.getTime() + consentTtlMs).toISOString();
      db.transaction(() => {
        insertConsent(db, hashState(state), {
          userId,
          providerId: entry.provider.id,
          sessionHash: hashState(request.sessionKey),
          createdAt: now.toISOString(),
          expiresAt,
        });
        trimConsents(db, userId, maxPendingConsents);
      });
      return { providerId: entry.provider.id, displayName: entry.provider.displayName, redirectUrl, expiresAt };
    },

    /**
     * Finish a consent from the bank's callback. `params` are the callback's query parameters;
     * `who` is the signed-in person and browser session the callback arrived in.
     *
     * The state is taken out of the table before anything is checked, so it works once, whoever
     * presents it. It must then be unexpired and belong to this person and this session. Only after
     * that is the bank asked for the link, and what it returns is sealed before it is stored.
     */
    async completeConsent(params: Readonly<Record<string, string>>, who: { userId: string; sessionKey: string }) {
      await ready;
      const state = typeof params.state === 'string' && params.state.length <= 200 ? params.state : '';
      const pending = state ? takeConsent(db, hashState(state)) : undefined;
      const now = clock();
      if (!pending || pending.expiresAt <= now.toISOString())
        throw new ApiError(400, 'This bank authorisation is no longer valid. Start again from your account page.');
      if (pending.userId !== who.userId || !sameText(pending.sessionHash, hashState(who.sessionKey)))
        throw new ApiError(403, 'This bank authorisation was started by somebody else or in another browser session.');
      const entry = await provider(pending.providerId);
      const consent = entry.provider.consent;
      if (!consent || !vault) throw new ApiError(503, 'Bank connections are unavailable right now');
      const { state: _state, ...answer } = params;
      if (answer.error !== undefined)
        return { status: 'denied' as const, providerId: pending.providerId, displayName: entry.provider.displayName };
      let ref: string;
      let consentExpiresAt: string | null;
      try {
        const granted = await consent.completeConsent(answer, { env: entry.env, now });
        ref = grantedRefSchema.parse(granted.ref);
        const expiry = expirySchema.parse(granted.expiresAt);
        consentExpiresAt = expiry ? new Date(expiry).toISOString() : null;
      } catch (error) {
        throw new ApiError(
          502,
          error instanceof ApiError ? error.message : 'The bank did not confirm the authorisation',
        );
      }
      if (consentExpiresAt !== null && consentExpiresAt <= now.toISOString())
        throw new ApiError(502, 'The bank returned a consent that has already expired');
      const sealedRef = vault.fingerprint(ref);
      const providerId = entry.provider.id;
      const index = refKey(providerId, sealedRef);
      const taken = 'This bank login is already connected to a ReloCat account';
      // An operator may have linked the same reference in clear; it still belongs to one person only.
      if (connectionByRef(db, providerId, ref) || refs.has(refKey(providerId, ref))) throw new ApiError(409, taken);
      const holder = refs.get(index);
      if (holder && !store.find(holder.userId, holder.connectionId)) forget(holder.userId, holder.connectionId);
      const existing = connectionByRef(db, providerId, sealedRef);
      if (existing && existing.userId !== who.userId) throw new ApiError(409, taken);
      const seal = (connectionId: string) => ({
        connectionId,
        providerId,
        cipher: vault.seal(ref, credentialAad(who.userId, connectionId, providerId)),
        createdAt: now.toISOString(),
        expiresAt: consentExpiresAt,
      });
      let connectionId: string;
      if (existing) {
        // The same person consented again: the connection keeps its history and gets a fresh credential.
        connectionId = existing.connectionId;
        db.transaction(() => {
          putCredential(db, who.userId, seal(connectionId));
          store.update(who.userId, connectionId, target => {
            target.lastError = null;
            target.consecutiveFailures = 0;
          });
        });
        const renewed = activity(who.userId, connectionId);
        renewed.blocked = false;
        renewed.failures = 0;
        renewed.nextRetryAt = undefined;
      } else {
        if (refs.has(index)) throw new ApiError(409, taken);
        const short = sealedRef.slice(sealedRefPrefix.length, sealedRefPrefix.length + 8);
        connectionId = safeId.parse(`${providerId.slice(0, 50)}-${short}`);
        const webhooks = supportsWebhooks(entry.provider);
        const pollIntervalMs = webhooks ? null : (entry.provider.pollIntervalMs ?? defaultPollIntervalMs);
        const connection: StoredConnection = {
          id: connectionId,
          providerId,
          ref: sealedRef,
          createdAt: now.toISOString(),
          cursor: null,
          pollIntervalMs,
          lastSyncAt: null,
          lastError: null,
          lastAttemptAt: null,
          consecutiveFailures: 0,
        };
        refs.set(index, { userId: who.userId, connectionId });
        let written = false;
        try {
          store.add(who.userId, connection, () => putCredential(db, who.userId, seal(connectionId)));
          written = true;
          const fresh = activity(who.userId, connectionId);
          fresh.fallback = webhooks;
          fresh.lastActivityAt = now.getTime();
          if (pollIntervalMs) startTimer(who.userId, connectionId, pollIntervalMs);
        } catch (error) {
          refs.delete(index);
          if (written) {
            try {
              store.remove(who.userId, connectionId);
            } catch {
              // The original error is the one to report.
            }
          }
          throw error;
        }
      }
      // A first pull, so the person returns to an account page that already shows their bank. A
      // failure is not an error of the consent: it is recorded on the connection and retried.
      await syncConnection(who.userId, connectionId).catch(() => {});
      const stored = store.find(who.userId, connectionId);
      if (!stored) throw new ApiError(404, 'Bank connection not found');
      return {
        status: existing ? ('renewed' as const) : ('connected' as const),
        providerId,
        displayName: entry.provider.displayName,
        connection: view(who.userId, stored),
      };
    },

    /** A person's consents in progress: which bank, since when and until when. Never the state. */
    async pendingConsents(userId: string) {
      await ready;
      await readLedger(userId);
      return listConsents(db, userId, clock().toISOString());
    },

    /** Remove consents nobody finished in time. Returns how many. */
    housekeeping() {
      return deleteExpiredConsents(db, clock().toISOString());
    },

    /**
     * Link a user to a provider. Providers without webhooks are polled, at `pollIntervalMs` when
     * given, else the provider's own cadence; pass `pollIntervalMs: null` for manual syncs only.
     */
    async connect(userId: string, input: unknown, polling: { stopAfterFailures?: number } = {}) {
      await ready;
      await readLedger(userId);
      const request = connectInputSchema.parse(input);
      const { provider: bank } = await provider(request.providerId);
      const digest = createHash('sha256').update(request.ref).digest('hex').slice(0, 8);
      const id = request.id ?? safeId.parse(`${request.providerId.slice(0, 50)}-${digest}`);
      const pollIntervalMs =
        request.pollIntervalMs !== undefined
          ? request.pollIntervalMs
          : supportsWebhooks(bank)
            ? null
            : (bank.pollIntervalMs ?? defaultPollIntervalMs);
      const index = refKey(request.providerId, request.ref);
      // A reference still held in memory for a connection that no longer exists is free.
      const holder = refs.get(index);
      if (holder && !store.find(holder.userId, holder.connectionId)) forget(holder.userId, holder.connectionId);
      if (refs.has(index)) throw new ApiError(409, 'This bank connection reference is already linked');
      // The same reference may already be linked through a consent, where it is stored as a fingerprint.
      if (vault && refs.has(refKey(request.providerId, vault.fingerprint(request.ref))))
        throw new ApiError(409, 'This bank connection reference is already linked');
      const connection: StoredConnection = {
        id,
        providerId: request.providerId,
        ref: request.ref,
        createdAt: clock().toISOString(),
        cursor: null,
        pollIntervalMs,
        lastSyncAt: null,
        lastError: null,
        lastAttemptAt: null,
        consecutiveFailures: 0,
      };
      // Reserve the reference before the write so two concurrent requests cannot both link it.
      refs.set(index, { userId, connectionId: id });
      let written = false;
      try {
        store.add(userId, connection);
        written = true;
        const state = activity(userId, id);
        state.fallback = supportsWebhooks(bank);
        state.lastActivityAt = clock().getTime();
        if (pollIntervalMs) startTimer(userId, id, pollIntervalMs, polling.stopAfterFailures);
      } catch (error) {
        refs.delete(index);
        // Only undo a record this call wrote (the polling limit was hit after the write).
        if (written) {
          try {
            store.remove(userId, id);
          } catch {
            // The original error is the one to report.
          }
        }
        throw error;
      }
      return view(userId, connection);
    },

    /** Remove a link and stop its polling. Movements already imported stay in the ledger. */
    async disconnect(userId: string, connectionId: string) {
      await ready;
      await readLedger(userId);
      const state = stopTimer(userId, connectionId);
      await state?.running?.catch(() => {});
      const removed = store.remove(userId, connectionId);
      if (!removed) throw new ApiError(404, 'Bank connection not found');
      refs.delete(refKey(removed.providerId, removed.ref));
      activities.delete(key(userId, connectionId));
      return { deleted: connectionId };
    },

    /**
     * Remove every connection of a user, for an account deletion: timers stop, a sync in flight is
     * waited for, the records and their queued notifications go, and the bank references are free
     * again. Works whether or not the user's rows still exist. Returns how many were removed.
     */
    async forgetUser(userId: string) {
      await ready;
      const mine = () => [...refs.values()].filter(target => target.userId === userId);
      // Stop the timers first so nothing new starts, then wait for what is running.
      for (const target of mine()) stopTimer(userId, target.connectionId);
      await Promise.allSettled(mine().map(target => activities.get(key(userId, target.connectionId))?.running));
      let removed = 0;
      for (const connection of store.read(userId)) {
        store.remove(userId, connection.id);
        refs.set(refKey(connection.providerId, connection.ref), { userId, connectionId: connection.id });
        removed++;
      }
      for (const target of mine()) forget(userId, target.connectionId);
      for (const id of [...activities.keys()]) if (id.startsWith(`${userId}/`)) activities.delete(id);
      // Sealed credentials and consents in progress go too, whether or not a connection row was left.
      deleteCredentialsOfUser(db, userId);
      deleteConsentsOfUser(db, userId);
      return removed;
    },

    /** Change the polling cadence of a connection; null stops polling and persists that choice. */
    async setPolling(
      userId: string,
      connectionId: string,
      intervalMs: number | null,
      polling: { stopAfterFailures?: number } = {},
    ) {
      await ready;
      const pollIntervalMs = pollIntervalSchema.nullable().parse(intervalMs);
      await find(userId, connectionId);
      if (pollIntervalMs) startTimer(userId, connectionId, pollIntervalMs, polling.stopAfterFailures);
      else stopTimer(userId, connectionId);
      const connection = store.update(userId, connectionId, target => {
        target.pollIntervalMs = pollIntervalMs;
      });
      if (!connection) throw new ApiError(404, 'Bank connection not found');
      return view(userId, connection);
    },

    /** Stop the timer in this process, keep the configured cadence, and wait for a sync in flight. */
    async pausePolling(userId: string, connectionId: string) {
      const state = stopTimer(userId, connectionId);
      await state?.running?.catch(() => {});
    },

    /** Read one connection, or null when the user has no such connection. */
    async connection(userId: string, connectionId: string) {
      await ready;
      const stored = store.find(safeId.parse(userId), connectionId);
      return stored ? view(userId, stored) : null;
    },

    syncConnection: async (userId: string, connectionId: string) => {
      await ready;
      return syncConnection(userId, connectionId);
    },

    /**
     * Pull every connection of a user now (or one of them). A failing connection is reported in its
     * own entry with a sanitized message and does not stop the others.
     */
    async sync(userId: string, connectionId?: string) {
      await ready;
      await readLedger(userId);
      const connections = store.read(userId);
      if (connectionId && !connections.some(item => item.id === connectionId))
        throw new ApiError(404, 'Bank connection not found');
      const results = [];
      for (const connection of connections) {
        if (connectionId && connection.id !== connectionId) continue;
        try {
          results.push({ status: 'synced' as const, ...(await syncConnection(userId, connection.id)) });
        } catch (error) {
          results.push({
            status: 'failed' as const,
            connectionId: connection.id,
            providerId: connection.providerId,
            error: sanitizedError(error),
          });
        }
      }
      return { userId, results };
    },

    acceptWebhook,

    /**
     * A verified webhook said something changed for a connection reference: sync it in the
     * background. Returns false when no connection uses that reference. Prefer `acceptWebhook`,
     * which also ignores repeated notification IDs.
     */
    async notify(providerId: string, connectionRef: string) {
      if (closed) return false;
      return (await acceptWebhook(providerId, { connectionRef })).known;
    },

    runDue: async () => {
      await ready;
      return runDue();
    },

    /** Resolves when no sync is running or queued behind one. Used by tests and orderly shutdowns. */
    async idle() {
      await ready;
      for (;;) {
        const running = [...activities.values()].map(state => state.running).filter(Boolean);
        if (!running.length) return;
        await Promise.allSettled(running);
      }
    },

    /** Counters of this process and the notifications still waiting for a successful sync. */
    webhookStatus() {
      return { ...webhookCounts, pending: queue.pendingCount() };
    },

    /** Listen for every persisted ledger revision of every user. Returns the function that unsubscribes. */
    onEvent(listener: BankEventListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Stop all timers, wait for syncs in flight and drop listeners. */
    async close() {
      closed = true;
      clearInterval(housekeeping);
      for (const state of activities.values()) {
        if (state.timer) clearInterval(state.timer);
        state.timer = undefined;
        state.queued = false;
        state.nextRetryAt = undefined;
      }
      await Promise.allSettled([...activities.values()].map(state => state.running));
      // Notifications that were not processed stay in the queue table for the next start.
      unsubscribe();
      listeners.clear();
    },
  };
}

export type BankSync = ReturnType<typeof createBankSync>;
