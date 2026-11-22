import { z } from 'zod';
import { safeId } from '../../packages/contracts/ids.ts';
import { ApiError } from '../../packages/http/server.ts';
import type { createBankStore } from './bank.ts';

export const runtimeSettings = z
  .object({ enabled: z.boolean(), intervalMs: z.number().int().min(1000).max(60000).optional() })
  .strict();
type BankStore = ReturnType<typeof createBankStore>;
type RuntimeView = {
  userId: string;
  synthetic: boolean;
  enabled: boolean;
  intervalMs: number;
  lastTickAt: string | null;
  lastError: string | null;
  tickCount: number;
};
type State = {
  enabled: boolean;
  intervalMs: number;
  lastTickAt: string | null;
  lastError: string | null;
  tickCount: number;
  timer?: ReturnType<typeof setInterval>;
  running?: Promise<RuntimeView & { inserted: number; revision: number }>;
};

export function createBankRuntime(bank: BankStore, clock = () => new Date()) {
  const states = new Map<string, State>();
  const fresh = (): State => ({ enabled: false, intervalMs: 5000, lastTickAt: null, lastError: null, tickCount: 0 });
  function view(id: string, state = states.get(id) ?? fresh()) {
    return {
      userId: id,
      synthetic: true,
      enabled: state.enabled,
      intervalMs: state.intervalMs,
      lastTickAt: state.lastTickAt,
      lastError: state.lastError,
      tickCount: state.tickCount,
    };
  }
  async function tick(id: string) {
    safeId.parse(id);
    const state = states.get(id) ?? fresh();
    states.set(id, state);
    if (state.running) return state.running;
    const operation = (async () => {
      try {
        let ledger = await bank.read(id);
        if (!ledger.accounts.length) {
          await bank.seedDemo(id);
          ledger = await bank.read(id);
        }
        const now = clock();
        const date = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Madrid',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(now);
        const account = ledger.accounts.find(account => account.openingDate <= date);
        if (!account) throw new ApiError(400, 'No account is open for the simulated movement date');
        const slot = Math.floor(now.getTime() / state.intervalMs);
        const outcome = await bank.importTransactions(id, {
          transactions: [
            {
              id: `runtime-${state.intervalMs}-${slot}`,
              accountId: account.id,
              date,
              description: 'Synthetic runtime grocery purchase',
              amountCents: -(300 + (slot % 900)),
              currency: 'EUR',
              category: 'food',
              status: 'booked',
              synthetic: true,
            },
          ],
        });
        state.lastTickAt = now.toISOString();
        state.lastError = null;
        state.tickCount++;
        return { ...view(id, state), inserted: outcome.result.inserted, revision: outcome.ledger.revision };
      } catch (error) {
        state.lastError = 'Synthetic feed failed; inspect account dates, profile seed data and ledger capacity.';
        state.enabled = false;
        if (state.timer) clearInterval(state.timer);
        throw error;
      }
    })();
    state.running = operation;
    try {
      return await operation;
    } finally {
      state.running = undefined;
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
      const state = states.get(id) ?? fresh();
      if (settings.enabled && !state.enabled && [...states.values()].filter(s => s.enabled).length >= 20)
        throw new ApiError(400, 'Maximum 20 enabled demo feeds');
      if (state.timer) clearInterval(state.timer);
      state.enabled = settings.enabled;
      state.intervalMs = settings.intervalMs ?? state.intervalMs;
      states.set(id, state);
      if (state.enabled) {
        state.timer = setInterval(() => {
          void tick(id).catch(() => {});
        }, state.intervalMs);
        state.timer.unref();
      } else if (state.running) await state.running.catch(() => {});
      return view(id, state);
    },
    async close() {
      for (const state of states.values()) {
        state.enabled = false;
        if (state.timer) clearInterval(state.timer);
      }
      await Promise.allSettled([...states.values()].map(state => state.running));
    },
  };
}
