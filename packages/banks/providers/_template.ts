/**
 * TEMPLATE: copy this file to add a bank.
 *
 *   1. Copy it to `packages/banks/providers/<your-bank>.ts`. Files starting with `_` are ignored by
 *      the registry; any other `*.ts` in this folder is loaded automatically. Nothing else to register.
 *   2. Change `id`, `displayName` and the `env` list. Variables are named `BANK_<ID>_<NAME>`
 *      (`my-bank` reads `BANK_MY_BANK_*`). Add them, empty, to `.env.example`.
 *   3. Implement the two required functions, `listAccounts` and `fetchTransactions`, by replacing
 *      the `callBank` placeholder below with real calls to the bank's documented API.
 *   4. If the bank can call us when something changes, implement `verifyWebhook` and `parseWebhook`
 *      and register `https://<origin>/api/webhooks/bank/<id>` at the bank. Otherwise delete both and
 *      the engine polls every `pollIntervalMs`.
 *   5. Check it: `GET /bank/providers` lists the provider (as `unconfigured` until its variables are
 *      set), `POST /users/:id/bank/connections` links a user and `POST /users/:id/bank/sync` pulls.
 *
 * A complete, working example is `demo-bank.ts` next to this file: cursor pagination, pending
 * movements that complete, declined ones (`removedIds`), a signature with a timestamp window and
 * event IDs (`eventId`) so a redelivered webhook is ignored.
 *
 * Nothing in this file describes a real bank. `BankApiAccount`, `BankApiMovement` and `callBank` are
 * placeholders for whatever the bank's API returns: replace them, do not ship them.
 *
 * Rules a provider must keep (the engine validates the result and rejects the whole sync otherwise):
 *   - Money is integer EUR cents. Use `decimalToCents`, never `Math.round(amount * 100)` on a float.
 *   - IDs are stable: the same bank movement must get the same `id` on every fetch (`stableId`).
 *   - Secrets come from `context.env` only. Never read `process.env`, never log or return a secret.
 *   - The connection `ref` is a non-secret identifier issued by the bank's consent flow.
 *   - A webhook is a signal to sync. Never build movements from a webhook body.
 */
import type { BankCategory, ProviderAccount, ProviderTransaction } from '../provider.ts';
import { decimalToCents, defineBankProvider, hmacSha256Matches, safeCategory, stableId } from '../provider.ts';

const id = 'my-bank';

// --- Placeholders: replace with the shapes of the bank's real API responses. ---------------------

type BankApiAccount = { accountId: string; label: string; currency: string; balance: string; balanceDate: string };
type BankApiMovement = {
  movementId: string;
  accountId: string;
  bookingDate: string;
  text: string;
  amount: string;
  currency: string;
  kind: string;
  booked: boolean;
};

/**
 * Placeholder for the HTTP call to the bank. A real implementation uses `fetch` with the credentials
 * from `env`, checks `response.ok`, and throws on failure (the engine stores a sanitized error, so
 * the thrown message is never shown to users).
 */
async function callBank<T>(_env: Readonly<Record<string, string>>, _path: string): Promise<T> {
  throw new Error('Template provider: replace callBank with the bank API client');
}

// --- Mapping the bank's vocabulary onto the ledger. ----------------------------------------------

/** The bank's own movement kinds mapped to ledger categories. Unknown kinds become `other`. */
const categories: Record<string, BankCategory> = {
  // 'SALARY': 'income',
  // 'RENT': 'housing',
  // 'SUPERMARKET': 'food',
};

/** One bank movement in ledger shape. */
function toTransaction(movement: BankApiMovement): ProviderTransaction {
  const amountCents = decimalToCents(movement.amount);
  return {
    id: stableId(id, movement.movementId),
    accountId: stableId(id, movement.accountId),
    date: movement.bookingDate,
    description: movement.text.trim().slice(0, 200) || 'Bank movement',
    amountCents,
    // `safeCategory` falls back to `other` when the sign disagrees with the category (a refund).
    category: safeCategory(categories[movement.kind] ?? 'other', amountCents),
    status: movement.booked ? 'booked' : 'pending',
  };
}

export default defineBankProvider({
  id,
  displayName: 'My Bank (template)',
  // True only for fabricated data. A real bank is `false`: its records are stored and reported as real.
  synthetic: false,
  env: [
    { name: 'BANK_MY_BANK_CLIENT_ID', description: 'API client ID issued by My Bank.' },
    { name: 'BANK_MY_BANK_CLIENT_SECRET', description: 'API client secret issued by My Bank.' },
    {
      name: 'BANK_MY_BANK_WEBHOOK_SECRET',
      description: 'Secret My Bank signs webhook calls with.',
      // Optional variables do not make the provider `unconfigured` when they are missing.
      required: false,
    },
  ],
  // Used when the provider has no webhooks, or as the default cadence a connection may override.
  pollIntervalMs: 15 * 60_000,

  /**
   * Required. The accounts behind `connection.ref`.
   *
   * The ledger computes balances as opening balance plus booked movements, so report the balance
   * immediately before `openingDate` and never return a movement dated earlier than that date.
   * When the bank only gives today's balance, derive it: balance today minus the booked movements
   * since `openingDate`.
   */
  async listAccounts(connection, { env }): Promise<ProviderAccount[]> {
    const accounts = await callBank<BankApiAccount[]>(env, `/links/${encodeURIComponent(connection.ref)}/accounts`);
    return accounts
      .filter(account => account.currency === 'EUR') // The ledger is EUR-only.
      .map(account => ({
        id: stableId(id, account.accountId),
        name: account.label.trim().slice(0, 100) || 'Bank account',
        currency: 'EUR' as const,
        openingBalanceCents: decimalToCents(account.balance),
        openingDate: account.balanceDate,
      }));
  },

  /**
   * Required. Movements dated `since` or later (`since` is null on the first sync: return the
   * history the bank offers). Returning a movement again is safe: identical rows are skipped and
   * changed rows (pending to booked) are updated. `connection.cursor` holds the `nextCursor` this
   * function returned last time, for banks with cursor-based pagination.
   */
  async fetchTransactions(connection, { env, since }) {
    const query = since ? `?from=${since}` : '';
    const movements = await callBank<BankApiMovement[]>(
      env,
      `/links/${encodeURIComponent(connection.ref)}/movements${query}`,
    );
    return {
      transactions: movements.filter(movement => movement.currency === 'EUR').map(toTransaction),
      // nextCursor: '...'  // Return it when the bank paginates by cursor; omit to keep the old one.
    };
  },

  /**
   * Optional (delete together with `parseWebhook` for a polling-only bank). The webhook route has
   * no bearer token, so this check is its only authentication: follow the bank's documented
   * signature scheme exactly and return false when anything is missing. The context also carries
   * `now`, the engine's clock, for schemes that sign a timestamp and reject old calls.
   */
  verifyWebhook({ headers, rawBody }, { env }) {
    const signature = headers['x-my-bank-signature'];
    const secret = env.BANK_MY_BANK_WEBHOOK_SECRET;
    if (typeof signature !== 'string' || !secret) return false;
    return hmacSha256Matches(secret, rawBody, signature, 'hex');
  },

  /**
   * Optional. Which connection the verified webhook is about. Only the reference is used; the
   * engine then calls `fetchTransactions`. Return null for notifications that need no sync. Add
   * `eventId` when the bank numbers its notifications: banks retry, and repeats are then ignored.
   */
  parseWebhook(rawBody) {
    try {
      const body = JSON.parse(rawBody) as { linkId?: unknown; type?: unknown };
      if (typeof body.linkId !== 'string') return null;
      return { connectionRef: body.linkId, hint: typeof body.type === 'string' ? body.type.slice(0, 60) : undefined };
    } catch {
      return null;
    }
  },
});
