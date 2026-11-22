import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { safeId } from '../contracts/ids.ts';
import { transactionSchema } from '../finance/cashflow.ts';
import { ApiError } from '../http/server.ts';
import type { BankConnection, BankProvider, ProviderContext, WebhookSignal } from './provider.ts';
import { pollIntervalSchema, supportsWebhooks } from './provider.ts';
import type { BankRegistry, RegisteredProvider } from './registry.ts';

/**
 * The bank sync engine: which user is connected to which provider, pulling movements from providers
 * into the ledger, polling providers that cannot call us, and telling listeners about new revisions.
 *
 * It is built to survive a real peer. A verified webhook is written to a small persistent queue
 * before it is acknowledged, so a notification that arrives during a sync or just before a restart
 * is still processed; repeated notification IDs are ignored. A sync that fails is retried with
 * exponential backoff and its state is kept on the connection. A provider with webhooks is still
 * pulled when it has been silent for a while, so a lost notification only delays a movement.
 *
 * The engine never writes ledger files itself. It goes through the `SyncLedger` it is given, so the
 * profile API's ledger store stays the single writer and imports stay idempotent.
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
  createAccount(userId: string, account: unknown): Promise<Revision>;
  /** Insert new movements, update changed ones, skip identical ones; one revision per changed batch. */
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
const connectionFileSchema = z
  .object({ schemaVersion: z.literal(1), connections: z.array(connectionSchema).max(10) })
  .strict();
type StoredConnection = z.infer<typeof connectionSchema>;

/** One verified webhook waiting for its sync. There is at most one per connection reference. */
const queueItemSchema = z
  .object({
    /** Position in the order of arrival; a sync clears the notifications that arrived before it started. */
    seq: z.number().int().positive(),
    providerId: safeId,
    ref: refSchema,
    receivedAt: z.string(),
  })
  .strict();
const queueFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    lastSeq: z.number().int().nonnegative(),
    pending: z.array(queueItemSchema).max(5000),
    /** `<providerId>:<eventId>` of recently accepted notifications, oldest first. */
    seen: z.array(z.string().max(300)).max(2000),
  })
  .strict();
type WebhookQueueFile = z.infer<typeof queueFileSchema>;
const eventIdSchema = z.string().min(1).max(200);
const maxSeenEvents = 2000;

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
  /** Directory with one folder per user. Connections persist there; without it they live in memory. */
  root?: string;
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
};

const connectionFile = 'bank-connections.json';
const queueFile = 'bank-webhook-queue.json';
const key = (userId: string, connectionId: string) => `${userId}/${connectionId}`;
const refKey = (providerId: string, ref: string) => `${providerId}\n${ref}`;

/** Persistence of connection records: JSON files under `root`, or a map when there is no root. */
function createConnectionStore(root?: string) {
  const memory = new Map<string, StoredConnection[]>();
  async function read(userId: string): Promise<StoredConnection[]> {
    if (!root) return memory.get(userId) ?? [];
    try {
      const text = await readFile(join(root, safeId.parse(userId), connectionFile), 'utf8');
      return connectionFileSchema.parse(JSON.parse(text)).connections;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async function write(userId: string, connections: StoredConnection[]) {
    const file = connectionFileSchema.parse({ schemaVersion: 1, connections });
    if (!root) return void memory.set(userId, file.connections);
    const target = join(root, safeId.parse(userId), connectionFile);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  /** Every user that has a readable connection file. Unreadable files are skipped, not fatal. */
  async function scan() {
    const found = new Map<string, StoredConnection[]>();
    if (!root) return found;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeId.safeParse(entry.name).success) continue;
      const connections = await read(entry.name).catch(() => []);
      if (connections.length) found.set(entry.name, connections);
    }
    return found;
  }
  return { read, write, scan };
}

/**
 * The persistent webhook queue: one small JSON file under `root` (memory without a root), replaced
 * atomically on every change. Changes are serialized, so a write never overlaps another.
 */
function createWebhookQueue(root?: string) {
  let state: WebhookQueueFile = { schemaVersion: 1, lastSeq: 0, pending: [], seen: [] };
  let seen = new Set<string>();
  let lock: Promise<unknown> = Promise.resolve();

  async function persist() {
    if (!root) return;
    const target = join(root, queueFile);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  /** Run one change after the previous one has been written. */
  function serialized<T>(change: () => Promise<T>): Promise<T> {
    const operation = lock.catch(() => {}).then(change);
    lock = operation;
    return operation;
  }

  return {
    /** Read the file left by a previous process. A missing or unreadable file starts an empty queue. */
    async load() {
      if (!root) return;
      try {
        state = queueFileSchema.parse(JSON.parse(await readFile(join(root, queueFile), 'utf8')));
        seen = new Set(state.seen);
      } catch {
        // Losing the queue only delays movements until the next pull; it must not stop the engine.
      }
    },
    pending: () => state.pending,
    lastSeq: () => state.lastSeq,
    /**
     * Record a notification durably. Returns false, and stores nothing, when its event ID was
     * already accepted. Notifications for one connection collapse into a single pending item.
     */
    add(providerId: string, ref: string, eventId: string | undefined, receivedAt: string) {
      return serialized(async () => {
        const dedupeKey = eventId === undefined ? undefined : `${providerId}:${eventId}`;
        if (dedupeKey !== undefined && seen.has(dedupeKey)) return false;
        const previous = structuredClone(state);
        if (dedupeKey !== undefined) {
          state.seen.push(dedupeKey);
          seen.add(dedupeKey);
          for (const dropped of state.seen.splice(0, Math.max(0, state.seen.length - maxSeenEvents)))
            seen.delete(dropped);
        }
        state.pending = state.pending.filter(item => item.providerId !== providerId || item.ref !== ref);
        state.pending.push({ seq: ++state.lastSeq, providerId, ref, receivedAt });
        try {
          await persist();
        } catch (error) {
          // Not durable means not accepted: the bank gets an error and delivers again.
          state = previous;
          seen = new Set(state.seen);
          throw error;
        }
        return true;
      });
    },
    /** Drop the notifications of a connection that a sync started after `throughSeq` has covered. */
    clear(providerId: string, ref: string, throughSeq: number) {
      return serialized(async () => {
        const kept = state.pending.filter(
          item => item.providerId !== providerId || item.ref !== ref || item.seq > throughSeq,
        );
        if (kept.length === state.pending.length) return;
        state.pending = kept;
        await persist();
      });
    },
    /** Wait for writes in flight. */
    idle: () => lock.catch(() => {}),
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
  const clock = options.clock ?? (() => new Date());
  const defaultPollIntervalMs = pollIntervalSchema.parse(options.defaultPollIntervalMs ?? 300_000);
  const overlapDays = options.overlapDays ?? 7;
  const maxPolling = options.maxPolling ?? 50;
  const retryBaseMs = options.retryBaseMs ?? 2000;
  const retryMaxMs = options.retryMaxMs ?? 300_000;
  const fallbackPollMs = options.fallbackPollMs === undefined ? 300_000 : options.fallbackPollMs;
  const housekeepingMs = options.housekeepingMs === undefined ? 1000 : options.housekeepingMs;
  const store = createConnectionStore(options.root);
  const queue = createWebhookQueue(options.root);
  const webhookCounts = { accepted: 0, duplicates: 0 };
  const activities = new Map<string, Activity>();
  const refs = new Map<string, { userId: string; connectionId: string }>();
  const locks = new Map<string, Promise<unknown>>();
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
      };
      activities.set(id, state);
    }
    return state;
  }

  /** Delay before the retry that follows the given number of consecutive failures. */
  function retryDelay(failures: number) {
    return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(failures - 1, 30));
  }

  /** Serialize changes to one user's connection file. */
  async function mutate<T>(userId: string, change: (connections: StoredConnection[]) => T): Promise<T> {
    const previous = locks.get(userId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const connections = await store.read(userId);
        const result = change(connections);
        await store.write(userId, connections);
        return result;
      });
    locks.set(userId, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(userId) === operation) locks.delete(userId);
    }
  }

  async function provider(providerId: string): Promise<RegisteredProvider> {
    const entry = (await options.registry).get(providerId);
    if (!entry) throw new ApiError(404, `Unknown bank provider: ${providerId}`);
    if (entry.status === 'unconfigured')
      throw new ApiError(409, `Bank provider ${providerId} is not configured; set ${entry.missingEnv.join(', ')}`);
    return entry;
  }

  async function find(userId: string, connectionId: string) {
    const connection = (await store.read(userId)).find(item => item.id === connectionId);
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
      /** When the engine will retry on its own after a failure, or null when no retry is scheduled. */
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
    let current = await ledger.read(userId);
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
    if (accountsCreated) current = await ledger.read(userId);

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
    await mutate(userId, connections => {
      const target = connections.find(item => item.id === stored.id);
      if (!target) return;
      if (fetched.nextCursor !== undefined) target.cursor = fetched.nextCursor;
      target.lastSyncAt = syncedAt;
      target.lastAttemptAt = syncedAt;
      target.lastError = null;
      target.consecutiveFailures = 0;
    });
    return { connectionId: stored.id, providerId: stored.providerId, accountsCreated, ...counts, revision, syncedAt };
  }

  /** Sync one connection. Concurrent calls for the same connection share one run. */
  async function syncConnection(userId: string, connectionId: string): Promise<SyncResult> {
    safeId.parse(userId);
    if (closed) throw new ApiError(503, 'Bank sync is shutting down');
    const state = activity(userId, connectionId);
    if (state.running) return state.running;
    const operation = (async () => {
      const stored = await find(userId, connectionId);
      // Notifications accepted up to here are covered by this pull; later ones need another.
      const coveredSeq = queue.lastSeq();
      state.lastActivityAt = clock().getTime();
      state.nextRetryAt = undefined;
      try {
        const result = await pull(userId, stored);
        state.failures = 0;
        state.syncCount++;
        await queue.clear(stored.providerId, stored.ref, coveredSeq).catch(() => {});
        return result;
      } catch (error) {
        state.failures++;
        const attemptedAt = clock();
        // Connections that are fed automatically retry with backoff; manual ones wait for the caller.
        const automatic = state.fallback || Boolean(state.timer);
        if (automatic && state.failures < state.stopAfterFailures && !closed)
          state.nextRetryAt = attemptedAt.getTime() + retryDelay(state.failures);
        const message = sanitizedError(error);
        await mutate(userId, connections => {
          const target = connections.find(item => item.id === connectionId);
          if (!target) return;
          target.lastError = message;
          target.lastAttemptAt = attemptedAt.toISOString();
          target.consecutiveFailures = state.failures;
        }).catch(() => {});
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
        void syncConnection(userId, connectionId).catch(() => {});
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
      void syncConnection(userId, connectionId).catch(() => {
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
      if (!state || state.running) continue;
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
        started.push(syncConnection(target.userId, target.connectionId).catch(() => {}));
    }
    await Promise.all(started);
  }

  /** Rebuild the webhook index and resume polling of real providers after a restart. */
  async function resume() {
    const registry = await options.registry;
    await queue.load();
    for (const [userId, connections] of await store.scan()) {
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
   * soon as the notification is on disk, so the route can acknowledge it without waiting for the bank.
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
    else void syncConnection(target.userId, target.connectionId).catch(() => {});
    return { known: true, duplicate: false };
  }

  return {
    /** Resolves when persisted connections have been indexed. Every method waits for it. */
    ready,

    async listConnections(userId: string) {
      await ready;
      await ledger.read(userId);
      return (await store.read(userId)).map(connection => view(userId, connection));
    },

    /**
     * Link a user to a provider. Providers without webhooks are polled, at `pollIntervalMs` when
     * given, else the provider's own cadence; pass `pollIntervalMs: null` for manual syncs only.
     */
    async connect(userId: string, input: unknown, polling: { stopAfterFailures?: number } = {}) {
      await ready;
      await ledger.read(userId);
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
        await mutate(userId, connections => {
          if (connections.some(item => item.id === id)) throw new ApiError(409, 'Bank connection already exists');
          if (connections.length >= 10) throw new ApiError(400, 'Connection limit reached');
          connections.push(connection);
        });
        written = true;
        const state = activity(userId, id);
        state.fallback = supportsWebhooks(bank);
        state.lastActivityAt = clock().getTime();
        if (pollIntervalMs) startTimer(userId, id, pollIntervalMs, polling.stopAfterFailures);
      } catch (error) {
        refs.delete(index);
        // Only undo a record this call wrote (the polling limit was hit after the write).
        if (written)
          await mutate(userId, connections => {
            const position = connections.findIndex(item => item.id === id);
            if (position >= 0) connections.splice(position, 1);
          }).catch(() => {});
        throw error;
      }
      return view(userId, connection);
    },

    /** Remove a link and stop its polling. Movements already imported stay in the ledger. */
    async disconnect(userId: string, connectionId: string) {
      await ready;
      await ledger.read(userId);
      const state = stopTimer(userId, connectionId);
      await state?.running?.catch(() => {});
      const removed = await mutate(userId, connections => {
        const position = connections.findIndex(item => item.id === connectionId);
        if (position < 0) throw new ApiError(404, 'Bank connection not found');
        return connections.splice(position, 1)[0];
      });
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
      const connection = await mutate(userId, connections => {
        const target = connections.find(item => item.id === connectionId);
        if (!target) throw new ApiError(404, 'Bank connection not found');
        target.pollIntervalMs = pollIntervalMs;
        return target;
      });
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
      const stored = (await store.read(userId)).find(item => item.id === connectionId);
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
      await ledger.read(userId);
      const connections = await store.read(userId);
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
      return { ...webhookCounts, pending: queue.pending().length };
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
      // Notifications that were not processed stay in the queue file for the next start.
      await queue.idle();
      unsubscribe();
      listeners.clear();
    },
  };
}

export type BankSync = ReturnType<typeof createBankSync>;
