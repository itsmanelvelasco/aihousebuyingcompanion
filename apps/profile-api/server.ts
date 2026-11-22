import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { z } from 'zod';
import { supportsWebhooks } from '../../packages/banks/provider.ts';
import type { BankRegistry } from '../../packages/banks/registry.ts';
import { loadBankRegistry } from '../../packages/banks/registry.ts';
import type { BankSyncOptions, LedgerEvent } from '../../packages/banks/sync.ts';
import { createBankSync } from '../../packages/banks/sync.ts';
import { safeId } from '../../packages/contracts/ids.ts';
import type { Database } from '../../packages/db/database.ts';
import { analyzeTransactions, periodSchema, scenarioSchema, simulateSavings } from '../../packages/finance/cashflow.ts';
import type { ApiAuthorizer } from '../../packages/http/server.ts';
import {
  ApiError,
  apiAccess,
  pathParts,
  readJson,
  readText,
  sendJson as reply,
  requireOwnRoute,
} from '../../packages/http/server.ts';
import type { Section } from '../../packages/profiles/store.ts';
import { createStore, profileSchema, sections } from '../../packages/profiles/store.ts';
import { createBankStore, dateSchema } from './bank.ts';
import { createInputStore } from './inputs.ts';
import { createBankRuntime, seedEmptyLedger } from './runtime.ts';

const body = (req: Parameters<typeof readJson>[0]) => readJson(req, 262_144, 'Body exceeds 256 KiB');

const bankRoutes = [
  'accounts',
  'transactions',
  'summary',
  'simulate',
  'demo',
  'runtime',
  'events',
  'connections',
  'sync',
];
const emptyBody = z.object({}).strict();
const syncBody = z.object({ connectionId: safeId.optional() }).strict();
const cursorSchema = z.coerce.number().int().nonnegative().safe();
const maxEventStreams = 100;

export type ProfileApiOptions = {
  /** Bank providers to serve. Defaults to every file in `packages/banks/providers/`. */
  bankRegistry?: BankRegistry | Promise<BankRegistry>;
  /** Interval between heartbeat comments on event streams. */
  heartbeatMs?: number;
  clock?: () => Date;
  /** Retry, fallback-pull and housekeeping settings of the sync engine; see `BankSyncOptions`. */
  bankSync?: Pick<BankSyncOptions, 'retryBaseMs' | 'retryMaxMs' | 'fallbackPollMs' | 'housekeepingMs'>;
  /**
   * Recognises a person's own credential (OAuth access token or browser session). Such a caller
   * reaches only `/users/<its own id>/…`: every read, and writes to `inputs`. Without it only the
   * admin token is accepted.
   */
  authorize?: ApiAuthorizer;
  /** True when a person record belongs to an account, so its context is not labelled fictional. */
  ownedByAccount?: (userId: string) => boolean;
};

/** Routes a person may write with their own credential. Ledger, feed and profile documents stay admin-only. */
const personWritable = (parts: string[]) => parts[2] === 'inputs';

/**
 * The profile, inputs and bank routes as a request handler, so one server can mount them under a
 * prefix. All state lives in `db`; the caller opens it and closes it after `close()` has resolved.
 */
export function createProfileApiHandler(db: Database, token: string, options: ProfileApiOptions = {}) {
  if (!token) throw new Error('PROFILE_API_TOKEN is required');
  const store = createStore(db);
  const bank = createBankStore(db);
  const inputs = createInputStore(db);
  const registry = Promise.resolve(options.bankRegistry ?? loadBankRegistry());
  registry.catch(() => {});
  const sync = createBankSync({
    ledger: bank,
    registry,
    db,
    clock: options.clock,
    beforeSync: seedEmptyLedger(bank),
    ...options.bankSync,
  });
  const clock = options.clock ?? (() => new Date());
  const runtime = createBankRuntime(bank, options.clock, sync);
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  /** One function per open event stream; calling it ends the stream and releases its listener. */
  const streams = new Set<() => void>();
  let closing: Promise<void> | undefined;

  /** Stop feeds and polling, end event streams and wait for syncs in flight. Safe to call twice. */
  function close() {
    closing ??= (async () => {
      for (const end of [...streams]) end();
      await runtime.close();
      await sync.close();
    })();
    return closing;
  }

  /**
   * `POST /webhooks/bank/:providerId`, called by a bank. There is no bearer token: the provider's
   * `verifyWebhook` authenticates the call, and a verified call only schedules a sync. The
   * notification is written to the engine's persistent queue before the 202, so the bank is answered
   * quickly and a restart right after the reply does not lose it; a repeated event ID is acknowledged
   * and ignored.
   */
  async function webhook(req: IncomingMessage, res: ServerResponse, parts: string[]) {
    if (parts[1] !== 'bank' || parts.length !== 3) throw new ApiError(404, 'Route not found');
    if (req.method !== 'POST') throw new ApiError(405, 'Method not allowed');
    const providerId = safeId.parse(parts[2]);
    const entry = (await registry).get(providerId);
    if (!entry || !supportsWebhooks(entry.provider))
      throw new ApiError(404, 'This bank provider does not accept webhooks');
    if (entry.status !== 'configured') throw new ApiError(503, 'This bank provider is not configured');
    const rawBody = await readText(req, 65_536, 'Webhook body exceeds 64 KiB');
    const context = { env: entry.env, now: clock() };
    let verified = false;
    try {
      verified = (await entry.provider.verifyWebhook!({ headers: req.headers, rawBody }, context)) === true;
    } catch {
      // A verifier that throws has not verified anything.
    }
    if (!verified) throw new ApiError(401, 'Webhook verification failed');
    let signal: ReturnType<NonNullable<typeof entry.provider.parseWebhook>> = null;
    try {
      signal = entry.provider.parseWebhook!(rawBody, context);
    } catch {
      // An unreadable notification is acknowledged and ignored.
    }
    // The reply does not reveal whether the reference is known; the sync runs in the background.
    if (signal && typeof signal.connectionRef === 'string') {
      const eventId = typeof signal.eventId === 'string' && signal.eventId.length <= 200 ? signal.eventId : undefined;
      await sync.acceptWebhook(providerId, { connectionRef: signal.connectionRef, eventId });
    }
    return reply(res, 202, { accepted: true });
  }

  /**
   * `GET /users/:id/bank/events/stream`: Server-Sent Events. Persisted events after the cursor are
   * replayed first, then every new ledger revision is pushed as it is written.
   */
  async function streamEvents(req: IncomingMessage, res: ServerResponse, id: string, after: number) {
    if (streams.size >= maxEventStreams) throw new ApiError(503, 'Too many open event streams');
    let cursor = after;
    let live = false;
    const waiting: LedgerEvent[] = [];
    const send = (event: LedgerEvent) => {
      if (event.sequence <= cursor) return;
      cursor = event.sequence;
      res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Subscribe before reading so a revision written during the replay is not lost.
    const unsubscribe = sync.onEvent(change => {
      if (change.userId !== id) return;
      if (live) send(change.event);
      else waiting.push(change.event);
    });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const end = () => {
      if (!streams.delete(end)) return;
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    };
    streams.add(end);
    try {
      const ledger = await bank.eventLog(id);
      const oldest = ledger.events[0]?.sequence ?? ledger.revision + 1;
      const requiresRefresh = after > ledger.revision || after < oldest - 1;
      cursor = Math.min(after, ledger.revision);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no',
      });
      const ready = { latestRevision: ledger.revision, requiresRefresh, synthetic: ledger.synthetic };
      res.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify(ready)}\n\n`);
      for (const event of ledger.events) send(event);
      for (const event of waiting) send(event);
      live = true;
    } catch (error) {
      streams.delete(end);
      unsubscribe();
      throw error;
    }
    heartbeat = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs);
    heartbeat.unref();
    req.on('close', end);
    res.on('close', end);
  }

  /**
   * In-process reads and the one write the rest of the server needs for a person. Each takes the
   * user id explicitly; `apps/server/people.ts` binds them to one id before any tool sees them.
   */
  const people = {
    /** The resolved context. A person who belongs to an account is not labelled fictional. */
    async context(id: string) {
      const context = await inputs.context(id);
      return options.ownedByAccount?.(id) ? { ...context, synthetic: false } : context;
    },
    inputs: (id: string) => inputs.read(id),
    addInputs: (id: string, value: unknown) => inputs.add(id, value),
    /** Cash-flow aggregates of complete calendar months; never movements. */
    async bankSummary(id: string, period: { from: unknown; to: unknown }) {
      const { from, to } = periodSchema.parse(period);
      // Only the movements up to the end of the period are loaded; later ones cannot affect it.
      const ledger = await bank.history(id, to);
      return {
        ...analyzeTransactions(ledger.transactions, from, to),
        // Provenance covers the whole ledger: one real movement anywhere makes it real.
        synthetic: ledger.transactionsSynthetic,
        ledgerUpdatedAt: ledger.updatedAt || null,
      };
    },
    bankEvents: (id: string, after: number, limit: number) => bank.events(id, after, limit),
    bankRuntime: (id: string) => runtime.status(id),
    /** Sum of today's booked balances in cents, or null when there are no accounts. */
    async bankBalanceCents(id: string) {
      const { accounts } = await bank.balances(id, new Date().toISOString().slice(0, 10));
      if (!accounts.length || !accounts.every(account => typeof account.balanceCents === 'number')) return null;
      return accounts.reduce((sum, account) => sum + (account.balanceCents as number), 0);
    },
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const parts = pathParts(req);
      if (parts[0] === 'webhooks') return await webhook(req, res, parts);
      const access = apiAccess(req, token, options.authorize);
      requireOwnRoute(access, req, parts, personWritable);
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      if (parts[0] === 'bank' && parts[1] === 'providers' && parts.length === 2) {
        if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed');
        const loaded = await registry;
        return reply(res, 200, { providers: loaded.list(), loadErrors: loaded.loadErrors });
      }
      if (parts[0] !== 'users' || parts.length > 5) throw new ApiError(404, 'Route not found');
      if (parts.length === 1) {
        if (req.method === 'GET') return reply(res, 200, { users: await store.list() });
        if (req.method === 'POST') {
          const data = profileSchema.parse(await body(req));
          const id = safeId.parse(data.details.id);
          return reply(res, 201, await store.create(id, data));
        }
      } else {
        const id = safeId.parse(parts[1]);
        if (parts[2] === 'context' && parts.length === 3) {
          if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed');
          return reply(res, 200, await people.context(id));
        }
        if (parts[2] === 'inputs') {
          if (parts.length === 3 && req.method === 'GET') return reply(res, 200, await inputs.read(id));
          if (parts.length === 3 && req.method === 'POST')
            return reply(res, 200, await inputs.add(id, await body(req)));
          if (parts.length === 4) {
            const inputId = safeId.parse(parts[3]);
            if (req.method === 'PUT') return reply(res, 200, await inputs.replace(id, inputId, await body(req)));
            if (req.method === 'DELETE') return reply(res, 200, await inputs.delete(id, inputId));
          }
          throw new ApiError(405, 'Method not allowed');
        }
        if (parts[2] === 'bank') {
          const route = parts[3];
          const itemId = parts[4] === undefined ? undefined : safeId.parse(parts[4]);
          if (route === 'events' && itemId === 'stream' && parts.length === 5 && req.method === 'GET') {
            // A reconnecting EventSource sends the last event ID it saw.
            const after = cursorSchema.parse(query.get('after') ?? req.headers['last-event-id'] ?? 0);
            return await streamEvents(req, res, id, after);
          }
          if (route === 'connections') {
            if (parts.length === 4 && req.method === 'GET')
              return reply(res, 200, { connections: await sync.listConnections(id) });
            if (parts.length === 4 && req.method === 'POST')
              return reply(res, 201, await sync.connect(id, await body(req)));
            if (parts.length === 5 && req.method === 'DELETE')
              return reply(res, 200, await sync.disconnect(id, itemId!));
          }
          if (route === 'sync' && parts.length === 4 && req.method === 'POST') {
            const { connectionId } = syncBody.parse(await body(req));
            return reply(res, 200, await sync.sync(id, connectionId));
          }
          if (route === 'events' && parts.length === 4 && req.method === 'GET') {
            const after = cursorSchema.parse(query.get('after') ?? 0);
            const limit = z.coerce
              .number()
              .int()
              .min(1)
              .max(100)
              .parse(query.get('limit') ?? 50);
            return reply(res, 200, await bank.events(id, after, limit));
          }
          if (route === 'runtime') {
            if (parts.length === 4 && req.method === 'GET') return reply(res, 200, await runtime.status(id));
            if (parts.length === 4 && req.method === 'POST')
              return reply(res, 200, await runtime.configure(id, await body(req)));
            if (parts.length === 5 && itemId === 'tick' && req.method === 'POST') {
              emptyBody.parse(await body(req));
              return reply(res, 200, await runtime.tick(id));
            }
          }
          if (route === 'demo' && parts.length === 4 && req.method === 'POST') {
            emptyBody.parse(await body(req));
            const outcome = await bank.seedDemo(id);
            return reply(res, 201, {
              ...outcome.result,
              updatedAt: outcome.ledger.updatedAt,
              synthetic: outcome.ledger.synthetic,
            });
          }
          if (route === 'accounts') {
            if (parts.length === 4 && req.method === 'GET') {
              await bank.head(id);
              const asOf = dateSchema.parse(query.get('asOf') ?? new Date().toISOString().slice(0, 10));
              const ledger = await bank.balances(id, asOf);
              return reply(res, 200, {
                synthetic: ledger.synthetic,
                updatedAt: ledger.updatedAt || null,
                accounts: ledger.accounts,
              });
            }
            if (parts.length === 4 && req.method === 'POST')
              return reply(res, 201, (await bank.createAccount(id, await body(req))).result);
            if (parts.length === 5 && req.method === 'PUT')
              return reply(res, 200, (await bank.updateAccount(id, itemId!, await body(req))).result);
          } else if (route === 'transactions') {
            if (parts.length === 4 && req.method === 'POST')
              return reply(res, 200, (await bank.importTransactions(id, await body(req))).result);
            if (parts.length === 5 && req.method === 'PUT')
              return reply(res, 200, (await bank.updateTransaction(id, itemId!, await body(req))).result);
            if (parts.length === 5 && req.method === 'DELETE')
              return reply(res, 200, (await bank.deleteTransaction(id, itemId!)).result);
            if (parts.length === 4 && req.method === 'GET') {
              const { accounts } = await bank.head(id);
              const from = query.has('from') ? dateSchema.parse(query.get('from')) : undefined;
              const to = query.has('to') ? dateSchema.parse(query.get('to')) : undefined;
              if (from && to && from > to) throw new ApiError(400, 'from must not follow to');
              const accountId = query.has('accountId') ? safeId.parse(query.get('accountId')) : undefined;
              if (accountId && !accounts.some(account => account.id === accountId))
                throw new ApiError(404, 'Account not found');
              const limit = z.coerce
                .number()
                .int()
                .min(1)
                .max(500)
                .parse(query.get('limit') ?? 100);
              const offset = z.coerce
                .number()
                .int()
                .min(0)
                .max(10000)
                .parse(query.get('offset') ?? 0);
              // The database filters, orders and pages; only the requested page is loaded.
              const ledger = await bank.transactions(id, { from, to, accountId }, { limit, offset });
              return reply(res, 200, {
                synthetic: ledger.synthetic,
                updatedAt: ledger.updatedAt || null,
                total: ledger.total,
                offset,
                limit,
                transactions: ledger.transactions,
              });
            }
          } else if ((route === 'summary' && req.method === 'GET') || (route === 'simulate' && req.method === 'POST')) {
            if (parts.length !== 4) throw new ApiError(404, 'Route not found');
            const { ledgerUpdatedAt, ...summary } = await people.bankSummary(id, {
              from: query.get('from'),
              to: query.get('to'),
            });
            const result =
              route === 'simulate' ? simulateSavings(summary, scenarioSchema.parse(await body(req))) : summary;
            return reply(res, 200, { ...result, ledgerUpdatedAt });
          }
          if (!bankRoutes.includes(route ?? '')) throw new ApiError(404, 'Bank route not found');
          throw new ApiError(405, 'Method not allowed');
        }
        if (parts.length > 3) throw new ApiError(404, 'Route not found');
        if (parts.length === 2 && req.method === 'GET') {
          const values = await Promise.all(sections.map(async s => [s, await store.read(id, s)]));
          return reply(res, 200, Object.fromEntries(values));
        }
        if (parts.length === 3) {
          if (!sections.includes(parts[2] as Section)) throw new ApiError(404, 'Section not found');
          const section = parts[2] as Section;
          if (req.method === 'GET') return reply(res, 200, await store.read(id, section));
          if (req.method === 'PUT') return reply(res, 200, await store.write(id, section, await body(req)));
        }
      }
      throw new ApiError(405, 'Method not allowed');
    } catch (error) {
      // An event stream that already started cannot switch to a JSON error.
      if (res.headersSent) return void res.destroy();
      if (error instanceof ApiError) return reply(res, error.status, { error: error.message });
      if (error instanceof z.ZodError) return reply(res, 400, { error: 'Invalid request data', issues: error.issues });
      reply(res, 500, { error: 'Profile storage failure' });
    }
  };
  return {
    handle,
    /** Closing the runtime closes everything, so callers that only know `bankRuntime` still shut down cleanly. */
    bankRuntime: { ...runtime, close },
    bank,
    people,
    bankSync: sync,
    /** In-process subscription to every persisted ledger revision: `bankEvents.onEvent(listener)`. */
    bankEvents: { onEvent: sync.onEvent },
    close,
  };
}

/** The same API as a standalone HTTP server; used by tests and tools that want an isolated instance. */
export function createProfileApi(db: Database, token: string, options: ProfileApiOptions = {}) {
  const api = createProfileApiHandler(db, token, options);
  const server = createServer(api.handle);
  // Open event streams would keep `server.close()` waiting, so they are ended first.
  const closeServer = server.close.bind(server);
  server.close = callback => {
    // The callback waits for syncs in flight, so the caller may close the database right after it.
    const stopped = api.close().catch(() => {});
    return closeServer(error => void stopped.then(() => callback?.(error)));
  };
  return Object.assign(server, { bankRuntime: api.bankRuntime, bankSync: api.bankSync, bankEvents: api.bankEvents });
}
