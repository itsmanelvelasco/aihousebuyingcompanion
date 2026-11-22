import { createHash } from 'node:crypto';
import { z } from 'zod';
import { safeId } from '../contracts/ids.ts';
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
import { pollIntervalSchema, supportsWebhooks } from './provider.ts';
import type { BankRegistry, RegisteredProvider } from './registry.ts';

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
const maxConnections = 10;

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
    add(userId: string, connection: StoredConnection) {
      const record = connectionSchema.parse(connection);
      db.transaction(() => {
        // A private engine database has no profile store in front of it to create the user row.
        if (registerUsers) insertUser(db, safeId.parse(userId), record.createdAt);
        if (connectionByRef(db, record.providerId, record.ref))
          throw new ApiError(409, 'This bank connection reference is already linked');
        if (getConnection(db, userId, record.id)) throw new ApiError(409, 'Bank connection already exists');
        if (countConnections(db, userId) >= maxConnections) throw new ApiError(400, 'Connection limit reached');
        insertConnection(db, userId, record);
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
        if (target) deleteConnection(db, userId, connectionId);
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

  function view(userId: string, connection: StoredConnection) {
    const state = activities.get(key(userId, connection.id));
    return {
      id: connection.id,
      providerId: connection.providerId,
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

  /** Pull one connection from its provider into the ledger. */
  async function pull(userId: string, stored: StoredConnection): Promise<SyncResult> {
    const { provider: bank, env } = await provider(stored.providerId);
    await options.beforeSync?.(userId, bank);
    const now = clock();
    const connection: BankConnection = {
      id: stored.id,
      userId,
      ref: stored.ref,
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
      const stored = await find(userId, connectionId);
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
      if (state.queued && !closed) {
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
    const target = refs.get(refKey(providerId, signal.connectionRef));
    if (!target) return { known: false, duplicate: false };
    const eventId = eventIdSchema.optional().parse(signal.eventId);
    const fresh = await queue.add(providerId, signal.connectionRef, eventId, clock().toISOString());
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
      return store.read(userId).map(connection => view(userId, connection));
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
      if (refs.has(index)) throw new ApiError(409, 'This bank connection reference is already linked');
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
