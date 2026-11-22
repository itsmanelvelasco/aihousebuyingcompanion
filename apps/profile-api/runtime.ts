import { z } from 'zod';
import type { BankProvider } from '../../packages/banks/provider.ts';
import synthetic, { syntheticIntervalMs } from '../../packages/banks/providers/synthetic.ts';
import { createBankRegistry } from '../../packages/banks/registry.ts';
import type { BankSync } from '../../packages/banks/sync.ts';
import { createBankSync } from '../../packages/banks/sync.ts';
import { safeId } from '../../packages/contracts/ids.ts';
import { ApiError } from '../../packages/http/server.ts';
import type { createBankStore } from './bank.ts';

export const runtimeSettings = z
  .object({ enabled: z.boolean(), intervalMs: z.number().int().min(1000).max(60000).optional() })
  .strict();
type BankStore = ReturnType<typeof createBankStore>;

/** The one connection per user that `/runtime` drives. It is an ordinary synthetic-provider connection. */
export const runtimeConnectionId = 'synthetic-feed';
const maxFeeds = 20;
const failureNote = 'Synthetic feed failed; inspect account dates, profile seed data and ledger capacity.';

/**
 * Sync-engine hook for the synthetic provider: an empty ledger gets the three scripted months
 * derived from the profile snapshot before the first fabricated movement is added.
 */
export function seedEmptyLedger(bank: BankStore) {
  return async (userId: string, provider: BankProvider) => {
    if (provider.id !== synthetic.id) return;
    const ledger = await bank.read(userId);
    if (!ledger.accounts.length) await bank.seedDemo(userId);
  };
}

/**
 * The simulated background feed behind `/users/:id/bank/runtime`. It keeps the route's original
 * shape, but owns no timer and fabricates nothing: it connects the user to the synthetic provider
 * and lets the sync engine poll it.
 */
export function createBankRuntime(bank: BankStore, clock = () => new Date(), sharedEngine?: BankSync) {
  const engine =
    sharedEngine ??
    createBankSync({
      ledger: bank,
      registry: createBankRegistry([synthetic], {}),
      clock,
      beforeSync: seedEmptyLedger(bank),
    });
  /** Users this runtime has touched, so `close` and the feed limit know where to look. */
  const users = new Set<string>();

  async function view(id: string) {
    const connection = await engine.connection(id, runtimeConnectionId);
    return {
      userId: id,
      synthetic: true,
      enabled: connection?.polling ?? false,
      intervalMs: connection?.pollIntervalMs ?? syntheticIntervalMs,
      lastTickAt: connection?.lastSyncAt ?? null,
      lastError: connection?.lastError ? failureNote : null,
      tickCount: connection?.syncCount ?? 0,
    };
  }

  /** Make sure the user has the runtime connection, without starting its timer. */
  async function ensureConnection(id: string) {
    users.add(id);
    if (await engine.connection(id, runtimeConnectionId)) return;
    try {
      await engine.connect(id, {
        providerId: synthetic.id,
        ref: `runtime-${id}`,
        id: runtimeConnectionId,
        pollIntervalMs: null,
      });
    } catch (error) {
      // A concurrent request created it first.
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
  }

  async function enabledFeeds() {
    let count = 0;
    for (const user of users) if ((await engine.connection(user, runtimeConnectionId))?.polling) count++;
    return count;
  }

  /** Produce one synthetic movement now. A failure pauses the feed until it is enabled again. */
  async function tick(id: string) {
    safeId.parse(id);
    await ensureConnection(id);
    try {
      const result = await engine.syncConnection(id, runtimeConnectionId);
      return { ...(await view(id)), inserted: result.inserted, revision: result.revision };
    } catch (error) {
      await engine.pausePolling(id, runtimeConnectionId);
      throw error;
    }
  }

  return {
    async status(id: string) {
      await bank.read(id);
      return view(id);
    },
    tick,
    async configure(id: string, input: unknown) {
      const settings = runtimeSettings.parse(input);
      await bank.read(id);
      const existing = await engine.connection(id, runtimeConnectionId);
      if (!settings.enabled && !existing) return view(id);
      if (settings.enabled && !existing?.polling && (await enabledFeeds()) >= maxFeeds)
        throw new ApiError(400, `Maximum ${maxFeeds} enabled demo feeds`);
      await ensureConnection(id);
      const intervalMs = settings.intervalMs ?? existing?.pollIntervalMs ?? syntheticIntervalMs;
      // The demo feed stops at its first failure instead of retrying, and reports it in `lastError`.
      if (settings.enabled || settings.intervalMs !== undefined)
        await engine.setPolling(id, runtimeConnectionId, intervalMs, { stopAfterFailures: 1 });
      if (!settings.enabled) await engine.pausePolling(id, runtimeConnectionId);
      return view(id);
    },
    async close() {
      await Promise.all([...users].map(user => engine.pausePolling(user, runtimeConnectionId)));
      if (!sharedEngine) await engine.close();
    },
  };
}
