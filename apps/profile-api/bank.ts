import { z } from 'zod';
import { safeId } from '../../packages/contracts/ids.ts';
import type { Database } from '../../packages/db/database.ts';
import type { TransactionFilter } from '../../packages/db/ledger.ts';
import {
  appendRevision,
  bookedTotals,
  cashflowCells,
  countAccounts,
  countTransactions,
  deleteTransaction,
  earliestMovementDate,
  expenseGroups,
  getAccount,
  getTransaction,
  insertAccount,
  insertTransaction,
  ledgerHasRecords,
  ledgerHead,
  ledgerIsSynthetic,
  listAccounts,
  listEvents,
  listTransactions,
  oldestEventSequence,
  pageTransactions,
  transactionsAreSynthetic,
  updateAccount,
  updateTransaction,
} from '../../packages/db/ledger.ts';
import { personIsSynthetic } from '../../packages/db/profiles.ts';
import type { Account, Transaction } from '../../packages/finance/cashflow.ts';
import {
  accountSchema,
  dateSchema,
  defaultMaxTransactions,
  maxAccounts,
  periodSchema,
  recurringSince,
  summarizeCashflow,
  transactionSchema,
} from '../../packages/finance/cashflow.ts';
import { ApiError } from '../../packages/http/server.ts';
import { createStore, requireUser } from '../../packages/profiles/store.ts';

export type { Account } from '../../packages/finance/cashflow.ts';
export { accountSchema, dateSchema, defaultMaxTransactions } from '../../packages/finance/cashflow.ts';

const money = z.number().int().min(-100_000_000_000).max(100_000_000_000);

/**
 * Thrown when a write would take a ledger past its cap. Nothing of the batch is stored. Trying the
 * same batch again cannot succeed until movements are deleted, so `retryable` is false: the sync
 * engine records the message on the connection and stops retrying on its own.
 */
export class LedgerFullError extends ApiError {
  readonly retryable = false;
  constructor(limit: number) {
    super(
      400,
      `Movement limit reached: the ledger holds its maximum of ${limit} movements, so new ones are not imported. Delete older movements, then sync again.`,
    );
  }
}

/** One ledger revision. The newest 500 per user are kept. */
export type LedgerEvent = {
  sequence: number;
  occurredAt: string;
  type: 'bank.updated';
  accountCount: number;
  transactionCount: number;
  /** Whether the whole ledger was synthetic at this revision. */
  synthetic: boolean;
};
/** Revision, freshness and provenance of a ledger, without its records. */
export type LedgerHead = {
  schemaVersion: 1;
  /** Derived on every read: true only when every account and movement is synthetic. */
  synthetic: boolean;
  /** ISO time of the last change; empty before the first one. */
  updatedAt: string;
  revision: number;
};
/** A whole ledger. Reading it loads every movement; the routes use the narrower store methods. */
export type Ledger = LedgerHead & { accounts: Account[]; transactions: Transaction[]; events: LedgerEvent[] };
/** Fired after a ledger revision has been committed. */
export type LedgerListener = (change: { userId: string; event: LedgerEvent }) => void;
const importSchema = z.object({ transactions: z.array(transactionSchema).min(1).max(500) }).strict();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The bank ledger of each user in the runtime database. Every change runs in one transaction with
 * its revision bump and its event, so a failed or interrupted change leaves the previous ledger,
 * and an import of N movements writes N rows instead of rewriting the whole ledger.
 */
export function createBankStore(db: Database, options: { maxTransactions?: number } = {}) {
  const maxTransactions = options.maxTransactions ?? defaultMaxTransactions;
  const profiles = createStore(db);
  const listeners = new Set<LedgerListener>();
  /** Tell in-process listeners about a committed revision. A failing listener never breaks a write. */
  function announce(userId: string, event: LedgerEvent) {
    for (const listener of listeners) {
      try {
        listener({ userId, event });
      } catch {
        // Listeners are observers; the ledger write already succeeded.
      }
    }
  }
  /**
   * The flag of an aggregate: true only when every record it draws on is fabricated. A ledger
   * without records has nothing to say, so the person decides: fictional for a fixture persona, and
   * never "synthetic" for a real person who simply has no bank data yet.
   */
  function provenance(id: string, recordsAreSynthetic: boolean) {
    return recordsAreSynthetic && (ledgerHasRecords(db, id) || personIsSynthetic(db, id));
  }
  function headOf(id: string): LedgerHead {
    // The provenance flag is not stored; the records decide.
    return { schemaVersion: 1, synthetic: provenance(id, ledgerIsSynthetic(db, id)), ...ledgerHead(db, id) };
  }
  /** Revision, freshness and accounts of a ledger: what most callers need, without its movements. */
  async function head(id: string) {
    requireUser(db, id);
    return db.read(() => ({ ...headOf(id), accounts: listAccounts(db, id) as Account[] }));
  }
  async function read(id: string): Promise<Ledger> {
    requireUser(db, id);
    return db.read(() => ({
      ...headOf(id),
      accounts: listAccounts(db, id) as Account[],
      transactions: listTransactions(db, id) as Transaction[],
      events: listEvents(db, id) as LedgerEvent[],
    }));
  }
  /** Reject a movement whose account is unknown or that precedes the account's opening date. */
  function checkMovement(id: string, tx: Transaction, accounts: Map<string, Account | undefined>) {
    if (!accounts.has(tx.accountId))
      accounts.set(tx.accountId, getAccount(db, id, tx.accountId) as Account | undefined);
    const account = accounts.get(tx.accountId);
    if (!account) throw new ApiError(400, `Unknown account: ${tx.accountId}`);
    if (tx.date < account.openingDate) throw new ApiError(400, 'Movement precedes account opening balance date');
  }
  /**
   * Run one change of a user's ledger in a transaction. `change` reports whether records changed;
   * only then is the revision bumped and its event appended, in that same transaction.
   */
  async function mutate<T>(id: string, change: () => { result: T; changed: boolean }) {
    const outcome = db.transaction(() => {
      requireUser(db, id);
      const { result, changed } = change();
      const event = changed ? (appendRevision(db, id, new Date().toISOString()) as LedgerEvent) : undefined;
      return { result, event, ledger: headOf(id) };
    });
    if (outcome.event) announce(id, outcome.event);
    return { result: outcome.result, ledger: outcome.ledger };
  }
  return {
    read,
    head,
    /** Subscribe to committed revisions of this store instance. Returns the function that unsubscribes. */
    onEvent(listener: LedgerListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async events(id: string, after: number, limit: number) {
      requireUser(db, id);
      return db.read(() => {
        const ledger = headOf(id);
        const oldest = oldestEventSequence(db, id) ?? ledger.revision + 1;
        const requiresRefresh = after > ledger.revision || after < oldest - 1;
        const selected = listEvents(db, id, after, limit) as LedgerEvent[];
        const nextCursor =
          requiresRefresh && after > ledger.revision ? ledger.revision : (selected.at(-1)?.sequence ?? after);
        return {
          synthetic: ledger.synthetic,
          events: selected,
          latestRevision: ledger.revision,
          nextCursor,
          requiresRefresh,
          hasMore: nextCursor < ledger.revision,
        };
      });
    },
    /** The ledger head and every event still kept, read together for the replay of an event stream. */
    async eventLog(id: string) {
      requireUser(db, id);
      return db.read(() => ({ ...headOf(id), events: listEvents(db, id) as LedgerEvent[] }));
    },
    /** Accounts with their booked balance on `asOf`, summed by the database. */
    async balances(id: string, asOf: string) {
      requireUser(db, id);
      return db.read(() => ({
        ...headOf(id),
        accounts: accountBalances(listAccounts(db, id) as Account[], bookedTotals(db, id, asOf), asOf),
      }));
    },
    /** One page of movements by date then ID. Filtering by an unknown account is a 404. */
    async transactions(id: string, filter: TransactionFilter, page: { limit: number; offset: number }) {
      requireUser(db, id);
      return db.read(() => {
        if (filter.accountId && !getAccount(db, id, filter.accountId)) throw new ApiError(404, 'Account not found');
        const selected = pageTransactions(db, id, filter, page);
        return { ...headOf(id), total: selected.total, transactions: selected.transactions as Transaction[] };
      });
    },
    /**
     * Cash flow of the complete calendar months `from`–`to`. The database sums the movements per
     * month and category and groups the candidates for recurring expenses, so no movement is loaded
     * however large the ledger is. `synthetic` covers the whole ledger: one real movement anywhere
     * makes the summary real.
     */
    async summary(id: string, period: { from: unknown; to: unknown }) {
      requireUser(db, id);
      const { from, to } = periodSchema.parse(period);
      return db.read(() => {
        const aggregates = {
          cells: cashflowCells(db, id, from, to),
          expenseGroups: expenseGroups(db, id, recurringSince(from), to),
        };
        return {
          ...summarizeCashflow(aggregates, from, to, provenance(id, transactionsAreSynthetic(db, id))),
          ledgerUpdatedAt: ledgerHead(db, id).updatedAt || null,
        };
      });
    },
    async createAccount(id: string, input: unknown) {
      const account = accountSchema.parse(input);
      return mutate(id, () => {
        if (getAccount(db, id, account.id)) throw new ApiError(409, 'Account already exists');
        if (countAccounts(db, id) >= maxAccounts) throw new ApiError(400, 'Account limit reached');
        insertAccount(db, id, account);
        return { result: account, changed: true };
      });
    },
    async updateAccount(id: string, accountId: string, input: unknown) {
      const account = accountSchema.parse(input);
      if (account.id !== accountId) throw new ApiError(400, 'Account ID must match route');
      return mutate(id, () => {
        const existing = getAccount(db, id, accountId);
        if (!existing) throw new ApiError(404, 'Account not found');
        if (same(existing, account)) return { result: account, changed: false };
        const earliest = earliestMovementDate(db, id, accountId);
        if (earliest !== undefined && earliest < account.openingDate)
          throw new ApiError(400, 'Movement precedes account opening balance date');
        updateAccount(db, id, account);
        return { result: account, changed: true };
      });
    },
    /** Add movements. A repeated identical movement is counted as a duplicate; a different one with a known ID is a conflict. */
    async importTransactions(id: string, input: unknown) {
      const { transactions } = importSchema.parse(input);
      return mutate(id, () => {
        const accounts = new Map<string, Account | undefined>();
        let inserted = 0,
          duplicates = 0;
        for (const tx of transactions) {
          const existing = getTransaction(db, id, tx.id);
          if (existing) {
            if (!same(existing, tx)) throw new ApiError(409, `Movement ID conflict: ${tx.id}`);
            duplicates++;
            continue;
          }
          checkMovement(id, tx, accounts);
          insertTransaction(db, id, tx);
          inserted++;
        }
        if (inserted && countTransactions(db, id) > maxTransactions) throw new LedgerFullError(maxTransactions);
        return { result: { inserted, duplicates }, changed: inserted > 0 };
      });
    },
    /**
     * Provider sync: insert new movements and update the ones whose content changed at the bank
     * (for example pending to booked). Identical rows are skipped, so repeating a sync changes nothing.
     */
    async upsertTransactions(id: string, input: unknown) {
      const { transactions } = importSchema.parse(input);
      return mutate(id, () => {
        const accounts = new Map<string, Account | undefined>();
        const counts = { inserted: 0, updated: 0, duplicates: 0 };
        for (const tx of transactions) {
          const existing = getTransaction(db, id, tx.id);
          if (existing && same(existing, tx)) {
            counts.duplicates++;
            continue;
          }
          checkMovement(id, tx, accounts);
          if (existing) {
            updateTransaction(db, id, tx);
            counts.updated++;
          } else {
            insertTransaction(db, id, tx);
            counts.inserted++;
          }
        }
        if (counts.inserted && countTransactions(db, id) > maxTransactions) throw new LedgerFullError(maxTransactions);
        return { result: counts, changed: counts.inserted + counts.updated > 0 };
      });
    },
    /**
     * Provider sync: delete the listed movements that exist (a pending payment the bank reverted or
     * declined). Unknown IDs are ignored, so repeating the call changes nothing and writes no revision.
     */
    async removeTransactions(id: string, transactionIds: string[]) {
      const ids = new Set(z.array(safeId).max(500).parse(transactionIds));
      return mutate(id, () => {
        let removed = 0;
        for (const transactionId of ids) if (deleteTransaction(db, id, transactionId)) removed++;
        return { result: { removed }, changed: removed > 0 };
      });
    },
    async updateTransaction(id: string, transactionId: string, input: unknown) {
      const tx = transactionSchema.parse(input);
      if (tx.id !== transactionId) throw new ApiError(400, 'Movement ID must match route');
      return mutate(id, () => {
        const existing = getTransaction(db, id, transactionId);
        if (!existing) throw new ApiError(404, 'Movement not found');
        if (same(existing, tx)) return { result: tx, changed: false };
        checkMovement(id, tx, new Map());
        updateTransaction(db, id, tx);
        return { result: tx, changed: true };
      });
    },
    async deleteTransaction(id: string, transactionId: string) {
      return mutate(id, () => {
        if (!deleteTransaction(db, id, transactionId)) throw new ApiError(404, 'Movement not found');
        return { result: { deleted: transactionId }, changed: true };
      });
    },
    async seedDemo(id: string) {
      const snapshot = await profiles.read(id, 'bank-account');
      const data = z
        .object({
          snapshotDate: dateSchema,
          balanceCents: money.nonnegative(),
          monthlyIncomeCents: money.nonnegative(),
          monthlyExpensesCents: money.nonnegative(),
          debtPaymentsCents: money.nonnegative(),
        })
        .parse(snapshot);
      const snapshotDate = new Date(`${data.snapshotDate}T00:00:00Z`);
      return mutate(id, () => {
        if (countAccounts(db, id) || countTransactions(db, id))
          throw new ApiError(409, 'Demo seeding requires an empty ledger');
        const first = new Date(Date.UTC(snapshotDate.getUTCFullYear(), snapshotDate.getUTCMonth() - 3, 1));
        const cashflow = data.monthlyIncomeCents - data.monthlyExpensesCents - data.debtPaymentsCents;
        const account = accountSchema.parse({
          id: 'demo-current',
          name: 'Fictional current account',
          currency: 'EUR',
          synthetic: true,
          openingDate: first.toISOString().slice(0, 10),
          openingBalanceCents: data.balanceCents - cashflow * 3,
        });
        insertAccount(db, id, account);
        for (let index = 0; index < 3; index++) {
          const month = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index, 1))
            .toISOString()
            .slice(0, 7);
          const expenses = data.monthlyExpensesCents;
          const subscription = Math.min(expenses, 2500);
          const rent = Math.floor((expenses - subscription) * 0.55);
          const rows = [
            ['salary', 'income', data.monthlyIncomeCents, 'Fictional household income', '02'],
            ['rent', 'housing', -rent, 'Fictional rent', '05'],
            ['subscription', 'subscriptions', -subscription, 'Fictional subscription', '10'],
            ['living', 'other', -(expenses - subscription - rent), 'Fictional living expenses', '15'],
            ['debt', 'debt', -data.debtPaymentsCents, 'Fictional debt payment', '20'],
          ] as const;
          for (const [key, category, amount, description, day] of rows) {
            if (!amount) continue;
            insertTransaction(
              db,
              id,
              transactionSchema.parse({
                id: `${key}-${month}`,
                accountId: 'demo-current',
                date: `${month}-${day}`,
                amountCents: amount,
                description,
                category,
                currency: 'EUR',
                status: 'booked',
                synthetic: true,
              }),
            );
          }
        }
        const result = {
          seeded: true,
          from: first.toISOString().slice(0, 10),
          to: new Date(Date.UTC(snapshotDate.getUTCFullYear(), snapshotDate.getUTCMonth(), 0))
            .toISOString()
            .slice(0, 10),
          note: 'Three scripted months, derived from the profile snapshot; not actual transaction history.',
        };
        return { result, changed: true };
      });
    },
  };
}

/** Each account with its balance on `asOf`: opening balance plus the booked movements up to that day. */
export function accountBalances(accounts: Account[], bookedTotalsByAccount: Map<string, number>, asOf: string) {
  return accounts.map(account => {
    if (asOf < account.openingDate) return { ...account, balanceCents: null, asOf, status: 'before_opening_date' };
    const balance = account.openingBalanceCents + (bookedTotalsByAccount.get(account.id) ?? 0);
    if (!Number.isSafeInteger(balance)) throw new ApiError(400, 'Balance exceeds safe integer range');
    return { ...account, balanceCents: balance, asOf, status: 'calculated' };
  });
}
