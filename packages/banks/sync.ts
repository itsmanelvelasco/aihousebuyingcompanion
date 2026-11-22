import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { safeId } from '../contracts/ids.ts';
import { transactionSchema } from '../finance/cashflow.ts';
import { ApiError } from '../http/server.ts';
import type { BankConnection, BankProvider, ProviderContext } from './provider.ts';
import { pollIntervalSchema, supportsWebhooks } from './provider.ts';
import type { BankRegistry, RegisteredProvider } from './registry.ts';

/**
 * The bank sync engine: which user is connected to which provider, pulling movements from providers
 * into the ledger, polling providers that cannot call us, and telling listeners about new revisions.
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
  })
  .strict();
const connectionFileSchema = z
  .object({ schemaVersion: z.literal(1), connections: z.array(connectionSchema).max(10) })
  .strict();
type StoredConnection = z.infer<typeof connectionSchema>;

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
};

type Activity = {
  timer?: ReturnType<typeof setInterval>;
  running?: Promise<SyncResult>;
  /** A webhook arrived during a sync: run once more when it finishes. */
  queued: boolean;
  failures: number;
  stopAfterFailures: number;
  syncCount: number;
};

const connectionFile = 'bank-connections.json';
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
  const store = createConnectionStore(options.root);
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
    if (!state) activities.set(id, (state = { queued: false, failures: 0, stopAfterFailures: 5, syncCount: 0 }));
    return state;
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
    const counts = { inserted: 0, updated: 0, duplicates: 0 };
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
      target.lastError = null;
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
      try {
        const result = await pull(userId, stored);
        state.failures = 0;
        state.syncCount++;
        return result;
      } catch (error) {
        state.failures++;
        const message = sanitizedError(error);
        await mutate(userId, connections => {
          const target = connections.find(item => item.id === connectionId);
          if (target) target.lastError = message;
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

  /** Rebuild the webhook index and resume polling of real providers after a restart. */
  async function resume() {
    const registry = await options.registry;
    for (const [userId, connections] of await store.scan()) {
      for (const connection of connections) {
        refs.set(refKey(connection.providerId, connection.ref), { userId, connectionId: connection.id });
        const entry = registry.get(connection.providerId);
        // Real connections keep polling across restarts. Synthetic feeds are opt-in per process.
        const resumable = entry?.status === 'configured' && !entry.provider.synthetic && connection.pollIntervalMs;
        if (resumable && !closed) startTimer(userId, connection.id, connection.pollIntervalMs!);
      }
    }
  }
  const ready = resume().catch(() => {});

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

    /**
     * A verified webhook said something changed for a connection reference: sync it in the
     * background. Returns false when no connection uses that reference.
     */
    async notify(providerId: string, connectionRef: string) {
      await ready;
      const target = refs.get(refKey(providerId, connectionRef));
      if (!target || closed) return false;
      const state = activity(target.userId, target.connectionId);
      if (state.running) state.queued = true;
      else void syncConnection(target.userId, target.connectionId).catch(() => {});
      return true;
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
      for (const state of activities.values()) {
        if (state.timer) clearInterval(state.timer);
        state.timer = undefined;
        state.queued = false;
      }
      await Promise.allSettled([...activities.values()].map(state => state.running));
      unsubscribe();
      listeners.clear();
    },
  };
}

export type BankSync = ReturnType<typeof createBankSync>;
