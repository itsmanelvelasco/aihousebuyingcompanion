/**
 * Banc Demo: the worked example of "add a bank = one file".
 *
 * Banc Demo is the fictional neobank in `apps/demo-bank`, a separate process this file only reaches
 * over HTTP. It behaves like the business API of a modern bank: bearer-authenticated REST to pull
 * accounts and transactions, and signed webhooks to be told that something changed. Everything it
 * returns is fabricated, so the provider is `synthetic: true`.
 *
 *   - `connection.ref` is the bank's customer ID (`cust-001`); it is not a secret.
 *   - Amounts arrive as decimal strings and become integer cents with `decimalToCents`.
 *   - `pending` stays `pending`, `completed` becomes `booked`, and `declined` or `reverted`
 *     transactions are reported in `removedIds`, because they never moved money.
 *   - The bank lists transactions in change order behind an opaque cursor. The cursor is stored on
 *     the connection, so each sync only reads what changed since the previous one; a pending payment
 *     that completes comes back with the same ID and updates its ledger row.
 *   - A webhook is `X-Demo-Bank-Signature` = hex HMAC-SHA256 of `<timestamp>.<raw body>`, with the
 *     timestamp in `X-Demo-Bank-Timestamp`. Calls older or newer than five minutes are rejected.
 *   - A person connects it by consenting at the bank (`consent` below): ReloCat creates a consent
 *     request, the person approves on the bank's own page, and the one-time code the bank sends
 *     back is exchanged for the customer reference. The engine seals that reference at rest.
 *   - The bank's API is reached at `BANK_DEMO_BANK_BASE_URL` (server to server). The person's
 *     browser may not be able to reach that address (a loopback port behind a tunnel), so with
 *     `BANK_DEMO_BANK_PUBLIC_PATH` the consent page is opened on ReloCat's own origin, where
 *     `apps/server` mounts it: `<origin>/banc-demo/consent/<id>`.
 */
import { z } from 'zod';
import { ApiError } from '../../http/server.ts';
import type { BankCategory, ProviderAccount, ProviderTransaction } from '../provider.ts';
import { decimalToCents, defineBankProvider, hmacSha256Matches, safeCategory, stableId } from '../provider.ts';

const id = 'demo-bank';
const requestTimeoutMs = 10_000;
const pageSize = 200;
/** A single sync reads at most this many pages; the rest follows on the next sync from the cursor. */
const maxPages = 25;
/** Accepted distance between the signed timestamp and our clock, in both directions. */
const signatureToleranceMs = 5 * 60_000;

// --- What the bank's API returns. Unknown extra fields are ignored; missing ones fail the sync. ---

const accountSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string(),
  currency: z.string(),
  opening_balance: z.string(),
  opened_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const accountsSchema = z.object({ accounts: z.array(accountSchema).max(50) });

const transactionSchema = z.object({
  id: z.string().min(1).max(64),
  account_id: z.string().min(1).max(64),
  type: z.string(),
  state: z.enum(['pending', 'completed', 'declined', 'reverted']),
  amount: z.string(),
  currency: z.string(),
  description: z.string(),
  counterparty: z.object({ name: z.string(), own_account: z.boolean() }),
  merchant_category: z.string(),
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T/),
  completed_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T/)
    .nullable(),
});
type BankTransaction = z.infer<typeof transactionSchema>;
const pageSchema = z.object({
  transactions: z.array(transactionSchema).max(pageSize),
  next_cursor: z.string().min(1).max(400),
  has_more: z.boolean(),
});

const eventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(60),
  data: z.object({ customer_id: z.string().min(1).max(200) }),
});

/** A single path segment, such as `/banc-demo`. */
const publicPathPattern = /^\/[a-z0-9-]{1,40}$/;

const consentRequestSchema = z.object({ consent_path: z.string().regex(/^\/consent\/consent-[0-9a-f]{32}$/) });
const consentGrantSchema = z.object({
  customer_id: z.string().min(1).max(200),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T/),
});

/** Thrown for an HTTP status the caller wants to react to (a cursor the bank no longer accepts). */
class BankStatusError extends ApiError {}

/**
 * One authenticated GET to the bank, validated against a schema. Failures become short messages
 * that are safe to store on the connection: they never contain the URL, the key or the bank's text.
 */
async function callBank<T>(
  env: Readonly<Record<string, string>>,
  path: string,
  schema: z.ZodType<T>,
  post?: unknown,
): Promise<T> {
  const base = env.BANK_DEMO_BANK_BASE_URL.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: post === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${env.BANK_DEMO_BANK_API_KEY}`,
        Accept: 'application/json',
        ...(post === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(post === undefined ? {} : { body: JSON.stringify(post) }),
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const timedOut = (error as Error)?.name === 'TimeoutError';
    throw new ApiError(502, timedOut ? 'Banc Demo did not answer in time' : 'Banc Demo could not be reached');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new BankStatusError(502, 'Banc Demo rejected the API key');
    if (response.status === 404) throw new BankStatusError(502, 'Banc Demo does not know this customer');
    if (response.status === 410) throw new BankStatusError(410, 'Banc Demo no longer accepts the saved cursor');
    if (response.status === 400 && post !== undefined)
      throw new BankStatusError(502, 'Banc Demo refused the authorisation; start again');
    throw new ApiError(502, `Banc Demo answered with status ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(502, 'Banc Demo returned an unreadable answer');
  }
  return schema.parse(body);
}

// --- Mapping the bank's vocabulary onto the ledger. ----------------------------------------------

/** The bank's merchant categories mapped to ledger categories. Unknown ones become `other`. */
const categories: Record<string, BankCategory> = {
  salary: 'income',
  rent: 'housing',
  utilities: 'utilities',
  groceries: 'food',
  restaurants: 'food',
  transport: 'transport',
  subscriptions: 'subscriptions',
  health: 'healthcare',
  education: 'education',
  loan: 'debt',
};

/** A pending or completed bank transaction in ledger shape. */
function toTransaction(transaction: BankTransaction): ProviderTransaction {
  const amountCents = decimalToCents(transaction.amount);
  // A transfer between the customer's own accounts is not income or spending: the ledger excludes it.
  const category = transaction.counterparty.own_account
    ? 'internal_transfer'
    : safeCategory(categories[transaction.merchant_category] ?? 'other', amountCents);
  return {
    id: stableId(id, transaction.id),
    accountId: stableId(id, transaction.account_id),
    // The day the money moved once it has, else the day the payment was made.
    date: (transaction.completed_at ?? transaction.created_at).slice(0, 10),
    description: transaction.description.trim().slice(0, 200) || 'Banc Demo movement',
    amountCents,
    category,
    status: transaction.state === 'completed' ? 'booked' : 'pending',
  };
}

const customerPath = (ref: string) => `/customers/${encodeURIComponent(ref)}`;

export default defineBankProvider({
  id,
  displayName: 'Banc Demo (fictional bank)',
  synthetic: true,
  env: [
    {
      name: 'BANK_DEMO_BANK_BASE_URL',
      description: 'Origin of the demo bank service, for example http://127.0.0.1:3003.',
    },
    { name: 'BANK_DEMO_BANK_API_KEY', description: 'API key the demo bank accepts as a bearer token.' },
    {
      name: 'BANK_DEMO_BANK_WEBHOOK_SECRET',
      description: 'Signing secret the demo bank returned when the webhook was registered.',
    },
    {
      name: 'BANK_DEMO_BANK_PUBLIC_PATH',
      description:
        'Path on the origin of ReloCat where the consent page of the demo bank is mounted, for example /banc-demo. Unset: the person is sent to BANK_DEMO_BANK_BASE_URL.',
      required: false,
    },
  ],

  /**
   * The person authorises access at Banc Demo. `beginConsent` registers the return address and
   * the state with the bank and gets the page to open; `completeConsent` exchanges the one-time
   * code of the callback for the customer reference and the day the consent ends.
   */
  consent: {
    async beginConsent({ returnUrl, state }, { env }) {
      const created = await callBank(env, '/consents', consentRequestSchema, { redirect_uri: returnUrl, state });
      // Mounted on ReloCat's origin: the page is on the origin the person is already on (the one
      // the callback returns to), so it is reachable wherever ReloCat is. Otherwise the bank's own.
      const mount = env.BANK_DEMO_BANK_PUBLIC_PATH;
      if (mount !== undefined && !publicPathPattern.test(mount))
        throw new ApiError(502, 'BANK_DEMO_BANK_PUBLIC_PATH must be one path segment, such as /banc-demo');
      const base = mount ? `${new URL(returnUrl).origin}${mount}` : env.BANK_DEMO_BANK_BASE_URL.replace(/\/+$/, '');
      return { redirectUrl: `${base}${created.consent_path}` };
    },
    async completeConsent(params, { env }) {
      if (typeof params.code !== 'string' || !params.code)
        throw new ApiError(502, 'Banc Demo sent no authorisation code');
      const granted = await callBank(env, '/consents/token', consentGrantSchema, { code: params.code });
      return { ref: granted.customer_id, expiresAt: granted.expires_at };
    },
  },

  /** The customer's EUR accounts, with the balance they had before their first listed movement. */
  async listAccounts(connection, { env }): Promise<ProviderAccount[]> {
    const { accounts } = await callBank(env, `${customerPath(connection.ref)}/accounts`, accountsSchema);
    return accounts
      .filter(account => account.currency === 'EUR')
      .map(account => ({
        id: stableId(id, account.id),
        name: account.name.trim().slice(0, 100) || 'Banc Demo account',
        currency: 'EUR' as const,
        openingBalanceCents: decimalToCents(account.opening_balance),
        openingDate: account.opened_on,
      }));
  },

  /**
   * Everything that changed since the saved cursor (the whole history on the first sync). When the
   * bank refuses the cursor, because it was restarted without its snapshot, the sync starts again
   * without one from `since`; stable IDs make that re-import harmless.
   */
  async fetchTransactions(connection, { env, since }) {
    const transactions: ProviderTransaction[] = [];
    const removedIds: string[] = [];
    let cursor = connection.cursor;
    let from = cursor ? null : since;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({ limit: String(pageSize) });
      if (cursor) query.set('cursor', cursor);
      else if (from) query.set('from', from);
      let result: z.infer<typeof pageSchema>;
      try {
        result = await callBank(env, `${customerPath(connection.ref)}/transactions?${query}`, pageSchema);
      } catch (error) {
        if (!(error instanceof BankStatusError && error.status === 410) || !cursor) throw error;
        cursor = null;
        from = since;
        continue;
      }
      for (const transaction of result.transactions) {
        if (transaction.currency !== 'EUR') continue;
        if (transaction.state === 'declined' || transaction.state === 'reverted')
          removedIds.push(stableId(id, transaction.id));
        else transactions.push(toTransaction(transaction));
      }
      cursor = result.next_cursor;
      if (!result.has_more) break;
    }
    // A transaction can appear twice in one read when it changed between two pages: the last wins.
    const latest = new Map(transactions.map(transaction => [transaction.id, transaction]));
    const removed = new Set(removedIds);
    return {
      transactions: [...latest.values()].filter(transaction => !removed.has(transaction.id)),
      removedIds: [...removed],
      nextCursor: cursor,
    };
  },

  /**
   * The webhook route has no bearer token: this signature check is its only authentication. The
   * signed text includes the timestamp, so an old call cannot be replayed with a new timestamp.
   */
  verifyWebhook({ headers, rawBody }, { env, now }) {
    const signature = headers['x-demo-bank-signature'];
    const timestamp = headers['x-demo-bank-timestamp'];
    const secret = env.BANK_DEMO_BANK_WEBHOOK_SECRET;
    if (typeof signature !== 'string' || typeof timestamp !== 'string' || !secret) return false;
    if (!/^\d{1,16}$/.test(timestamp)) return false;
    if (Math.abs(now.getTime() - Number(timestamp)) > signatureToleranceMs) return false;
    return hmacSha256Matches(secret, `${timestamp}.${rawBody}`, signature, 'hex');
  },

  /** Which customer the event is about, and the event ID that lets the engine ignore a redelivery. */
  parseWebhook(rawBody) {
    try {
      const event = eventSchema.parse(JSON.parse(rawBody));
      return { connectionRef: event.data.customer_id, hint: event.type, eventId: event.id };
    } catch {
      return null;
    }
  },
});
