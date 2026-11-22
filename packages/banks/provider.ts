import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { safeId } from '../contracts/ids.ts';
import type { Transaction } from '../finance/cashflow.ts';

/**
 * The bank provider contract.
 *
 * A provider is one file in `packages/banks/providers/` whose default export is the result of
 * `defineBankProvider({ ... })`. The registry discovers it, the sync engine calls it, and the ledger
 * store remains the only writer. A provider never touches files, never reads `process.env` and never
 * writes to the ledger: it only answers "which accounts?" and "which movements since X?".
 *
 * To add a bank, copy `providers/_template.ts`, implement `listAccounts` and `fetchTransactions`
 * (plus `verifyWebhook` and `parseWebhook` when the bank can call us) and declare its variables in `env`.
 */

/** Ledger categories a provider must map the bank's own categories onto. */
export type BankCategory = Transaction['category'];

/** One environment variable a provider needs. Names must start with `BANK_<PROVIDER_ID>_`. */
export type BankProviderEnvVar = {
  /** For provider `my-bank`: `BANK_MY_BANK_CLIENT_ID`, `BANK_MY_BANK_WEBHOOK_SECRET`, ... */
  name: string;
  /** One line for `.env.example` and the `GET /bank/providers` listing. Never put a value here. */
  description: string;
  /** Defaults to true. A provider missing a required variable is listed as `unconfigured`. */
  required?: boolean;
};

/** A user's link to one bank, as the provider sees it. */
export type BankConnection = {
  /** Connection ID within the user, for example `my-bank-1a2b3c4d`. */
  id: string;
  userId: string;
  /**
   * Opaque identifier the bank (or its consent flow) issued for this link, such as a requisition or
   * item ID. It is stored as plain JSON: it must not be a password, access token or other secret.
   */
  ref: string;
  /** The `nextCursor` returned by the previous successful `fetchTransactions`, or null. */
  cursor: string | null;
  /** Polling cadence configured for this connection, or null when it is not polled. */
  pollIntervalMs: number | null;
};

/** What every provider function receives besides the connection. */
export type ProviderContext = {
  /** Values of the variables declared in `env`, by name. Unset optional variables are absent. */
  env: Readonly<Record<string, string>>;
  /** The engine's clock. Use it instead of `new Date()` so syncs are reproducible in tests. */
  now: Date;
  /** Accounts already in the user's ledger. Most banks ignore this; the synthetic feed attaches to them. */
  ledgerAccounts: readonly { id: string; openingDate: string }[];
};

/** Options of one `fetchTransactions` call: the context plus the lower date bound. */
export type FetchOptions = ProviderContext & {
  /**
   * `YYYY-MM-DD` from which movements are wanted (inclusive), or null on the first sync. The engine
   * re-requests a few days before the last sync so pending movements that were booked get updated.
   */
  since: string | null;
};

/** An account as it will be stored in the ledger. */
export type ProviderAccount = {
  /** Stable ledger account ID (lowercase slug). Build it with `stableId(providerId, bankAccountId)`. */
  id: string;
  name: string;
  /** The ledger is EUR-only: skip accounts in other currencies. */
  currency: 'EUR';
  /** Balance in integer cents immediately before the movements of `openingDate`. */
  openingBalanceCents: number;
  /** `YYYY-MM-DD`; no movement of this account may be dated earlier. */
  openingDate: string;
};

/** A movement as it will be stored in the ledger. The engine adds `currency` and `synthetic`. */
export type ProviderTransaction = {
  /**
   * Stable ledger movement ID (lowercase slug), unique within the user and identical on every fetch
   * of the same bank movement: build it with `stableId(providerId, bankTransactionId)`. This is what
   * keeps imports idempotent.
   */
  id: string;
  /** `ProviderAccount.id` of the account that holds the movement. */
  accountId: string;
  /** Booking (or expected booking) date, `YYYY-MM-DD`. */
  date: string;
  /** 1-200 characters. */
  description: string;
  /** Integer EUR cents, never zero: money in is positive, money out is negative. */
  amountCents: number;
  /** See `safeCategory` for the sign rules. */
  category: BankCategory;
  /** `pending` movements do not count in balances or summaries until a later sync reports them `booked`. */
  status: 'booked' | 'pending';
};

/** Result of one `fetchTransactions` call. */
export type FetchResult = {
  transactions: ProviderTransaction[];
  /** Saved on the connection and passed back as `connection.cursor`. Omit to keep the previous cursor. */
  nextCursor?: string | null;
  /**
   * Optional. Ledger IDs (built with `stableId`) of movements the bank says never happened: a card
   * payment that was declined, or a pending one that was reverted. The engine deletes the ones that
   * are in the ledger and ignores the rest, so listing an ID again is safe.
   */
  removedIds?: string[];
};

/** The raw HTTP call a bank made to `POST /webhooks/bank/:providerId`. */
export type WebhookRequest = {
  /** Node's lowercased request headers. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The body exactly as received (at most 64 KiB), before any JSON parsing. Sign-check this string. */
  rawBody: string;
};

/** What a verified webhook tells the engine: which connection to sync. Its content is never stored. */
export type WebhookSignal = {
  /** The `BankConnection.ref` the notification is about. */
  connectionRef: string;
  /** Optional short label for logs, such as `transactions.created`. It is not trusted as data. */
  hint?: string;
  /**
   * Optional. The bank's unique ID of this notification (1-200 characters). Banks retry deliveries,
   * so the same notification can arrive twice: the engine remembers recent IDs and ignores repeats.
   */
  eventId?: string;
};

/** What the webhook functions receive besides the request. */
export type WebhookContext = Pick<ProviderContext, 'env'> & {
  /** The engine's clock, for signature schemes that reject old timestamps (replay protection). */
  now: Date;
};

export interface BankProvider {
  /** Lowercase slug, unique in the registry. It is the `:providerId` of the webhook route. */
  id: string;
  /** Name people read, for example in a "connect your bank" list. */
  displayName: string;
  /**
   * True when every record is fabricated, false for a real bank. The engine stamps this flag on
   * each stored account and movement; ledgers, events and summaries report `synthetic: true` only
   * when every record they are built from is synthetic.
   */
  synthetic: boolean;
  /** Every environment variable the provider reads. This is the only way a provider gets secrets. */
  env: readonly BankProviderEnvVar[];
  /** Default polling cadence in milliseconds for connections of a provider without webhooks. */
  pollIntervalMs?: number;

  /**
   * List the accounts behind a connection. Called at the start of every sync; accounts missing from
   * the ledger are created, existing ones are left untouched. Return `[]` to add no accounts.
   */
  listAccounts(connection: BankConnection, context: ProviderContext): Promise<ProviderAccount[]>;

  /**
   * Return the movements of a connection dated `since` or later, normalized to the ledger shape.
   * Returning a movement again is safe: identical rows are skipped and changed rows are updated.
   * Throw to fail the sync; the engine records a sanitized error and keeps the previous cursor.
   */
  fetchTransactions(connection: BankConnection, options: FetchOptions): Promise<FetchResult>;

  /**
   * Optional, together with `parseWebhook`. Authenticate a webhook call, typically by checking a
   * signature header against `rawBody` with a secret from `context.env` (see `hmacSha256Matches`).
   * The webhook route has no bearer token: this function is its only protection. Return false when
   * in doubt. When the bank signs a timestamp, compare it with `context.now` and reject stale calls.
   */
  verifyWebhook?(request: WebhookRequest, context: WebhookContext): boolean | Promise<boolean>;

  /**
   * Optional, together with `verifyWebhook`. Extract which connection a verified webhook refers to.
   * A webhook is only a signal to sync: the engine then calls `fetchTransactions` and stores what
   * the bank's API returns, never what the webhook body claims. Return null to ignore the call.
   */
  parseWebhook?(rawBody: string, context: WebhookContext): WebhookSignal | null;
}

/** Prefix every variable of a provider must carry: `my-bank` reads `BANK_MY_BANK_*`. */
export function envPrefix(providerId: string) {
  return `BANK_${providerId.toUpperCase().replaceAll('-', '_')}_`;
}

/**
 * Declare a provider. Checks at load time what TypeScript cannot: the ID is a slug, variable names
 * follow the `BANK_<PROVIDER_ID>_` convention and webhook support is either complete or absent.
 */
export function defineBankProvider<const P extends BankProvider>(provider: P): P {
  safeId.parse(provider.id);
  const prefix = envPrefix(provider.id);
  const names = new Set<string>();
  for (const variable of provider.env) {
    if (!new RegExp(`^${prefix}[A-Z0-9_]+$`).test(variable.name))
      throw new Error(`Bank provider ${provider.id}: variable ${variable.name} must be named ${prefix}<NAME>`);
    if (names.has(variable.name)) throw new Error(`Bank provider ${provider.id}: duplicate variable ${variable.name}`);
    names.add(variable.name);
  }
  if (Boolean(provider.verifyWebhook) !== Boolean(provider.parseWebhook))
    throw new Error(`Bank provider ${provider.id}: implement both verifyWebhook and parseWebhook, or neither`);
  if (provider.pollIntervalMs !== undefined) pollIntervalSchema.parse(provider.pollIntervalMs);
  return provider;
}

/** Polling cadence accepted for a connection: one second to one day. */
export const pollIntervalSchema = z.number().int().min(1000).max(86_400_000);

/** True when the provider implements the webhook pair. */
export function supportsWebhooks(provider: BankProvider) {
  return Boolean(provider.verifyWebhook && provider.parseWebhook);
}

/**
 * Turn a bank's own identifier into a stable ledger ID: `stableId('my-bank', 'TX_9/001')`.
 * Identifiers that are already short slugs stay readable (`my-bank-abc123`); anything else becomes
 * a hash, so the same input always gives the same ID and retried imports stay idempotent.
 */
export function stableId(providerId: string, externalId: string) {
  const readable = `${providerId}-${externalId}`;
  if (safeId.safeParse(readable).success) return readable;
  const digest = createHash('sha256').update(externalId).digest('hex').slice(0, 32);
  return safeId.parse(`${providerId.slice(0, 30)}-${digest}`);
}

/**
 * Convert a decimal amount such as `"-12.3"` or `"1050.00"` to integer cents without floating-point
 * arithmetic. Throws on anything that is not a plain decimal with at most two fraction digits.
 */
export function decimalToCents(amount: string) {
  const match = /^([+-]?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new Error('Amount is not a decimal with at most two fraction digits');
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] === '-' ? -cents : cents;
}

/**
 * Keep a mapped category only when it agrees with the sign of the amount, otherwise fall back to
 * `other`. The ledger requires `income` to be positive and expense categories to be negative;
 * `other` and `internal_transfer` accept both signs (use `other` for refunds).
 */
export function safeCategory(category: BankCategory, amountCents: number): BankCategory {
  if (category === 'other' || category === 'internal_transfer') return category;
  if (category === 'income') return amountCents > 0 ? 'income' : 'other';
  return amountCents < 0 ? category : 'other';
}

/**
 * Constant-time check of a hex or base64 HMAC-SHA256 signature over the raw webhook body.
 * A convenience for `verifyWebhook`; use the bank's documented scheme when it differs.
 */
export function hmacSha256Matches(secret: string, rawBody: string, signature: string, encoding: 'hex' | 'base64') {
  if (!secret || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest(encoding));
  const actual = Buffer.from(signature.trim());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
