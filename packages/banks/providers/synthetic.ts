import { ApiError } from '../../http/server.ts';
import { defineBankProvider } from '../provider.ts';

/** Slot length used for movement IDs when a connection is ticked by hand instead of polled. */
export const syntheticIntervalMs = 5000;

/** Today's date in Catalonia, `YYYY-MM-DD`: the day a movement made "now" would be booked. */
function madridDate(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The fictional demo feed. It talks to no bank: each fetch fabricates one small grocery purchase on
 * the first ledger account that is open today. The movement ID depends only on the time slot, so
 * asking twice within one slot returns the same movement and the import stays idempotent.
 */
export default defineBankProvider({
  id: 'synthetic',
  displayName: 'Synthetic demo feed',
  synthetic: true,
  env: [],
  pollIntervalMs: syntheticIntervalMs,

  /** The feed attaches to accounts already in the ledger (the demo seed), so it adds none. */
  async listAccounts() {
    return [];
  },

  async fetchTransactions(connection, { now, ledgerAccounts }) {
    const date = madridDate(now);
    const account = ledgerAccounts.find(candidate => candidate.openingDate <= date);
    if (!account) throw new ApiError(400, 'No account is open for the simulated movement date');
    const intervalMs = connection.pollIntervalMs ?? syntheticIntervalMs;
    const slot = Math.floor(now.getTime() / intervalMs);
    return {
      transactions: [
        {
          id: `runtime-${intervalMs}-${slot}`,
          accountId: account.id,
          date,
          description: 'Synthetic runtime grocery purchase',
          amountCents: -(300 + (slot % 900)),
          category: 'food',
          status: 'booked',
        },
      ],
    };
  },
});
