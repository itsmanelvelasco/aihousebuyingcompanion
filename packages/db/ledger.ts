import type { Database } from './database.ts';

/**
 * Queries for the bank ledger: accounts, movements, the per-user revision counter and its event log.
 * Callers combine them inside `db.transaction`, so a change, its revision and its event are one unit.
 */

export type LedgerAccount = {
  id: string;
  name: string;
  currency: string;
  openingBalanceCents: number;
  openingDate: string;
  synthetic: boolean;
};

export type LedgerTransaction = {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amountCents: number;
  currency: string;
  category: string;
  status: string;
  synthetic: boolean;
};

export type LedgerEventRecord = {
  sequence: number;
  occurredAt: string;
  type: string;
  accountCount: number;
  transactionCount: number;
  synthetic: boolean;
};

/** How many events are kept per user. */
export const eventRetention = 500;

type Flagged<Row> = Omit<Row, 'synthetic'> & { synthetic: number };
const flag = <Row extends { synthetic: number }>(row: Row) => ({ ...row, synthetic: row.synthetic === 1 });

const accountColumns = `
  id, name, currency, opening_balance_cents AS openingBalanceCents, opening_date AS openingDate, synthetic
`;
const transactionColumns = `
  id, account_id AS accountId, date, description, amount_cents AS amountCents, currency, category, status, synthetic
`;
const eventColumns = `
  sequence, occurred_at AS occurredAt, type, account_count AS accountCount,
  transaction_count AS transactionCount, synthetic
`;

/** Revision and last change of a user's ledger; revision 0 and an empty date before the first change. */
export function ledgerHead(db: Database, userId: string) {
  return (
    db.get<{ revision: number; updatedAt: string }>(
      'SELECT revision, updated_at AS updatedAt FROM bank_ledgers WHERE user_id = ?',
      userId,
    ) ?? { revision: 0, updatedAt: '' }
  );
}

/** A user's accounts in the order they were created. */
export function listAccounts(db: Database, userId: string) {
  return db
    .all<Flagged<LedgerAccount>>(
      `SELECT ${accountColumns} FROM bank_accounts WHERE user_id = ? ORDER BY row_id`,
      userId,
    )
    .map(flag) as LedgerAccount[];
}

export function getAccount(db: Database, userId: string, accountId: string) {
  const row = db.get<Flagged<LedgerAccount>>(
    `SELECT ${accountColumns} FROM bank_accounts WHERE user_id = ? AND id = ?`,
    userId,
    accountId,
  );
  return row && (flag(row) as LedgerAccount);
}

export function countAccounts(db: Database, userId: string) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM bank_accounts WHERE user_id = ?', userId)!.total;
}

export function insertAccount(db: Database, userId: string, account: LedgerAccount) {
  db.run(
    `
      INSERT INTO bank_accounts (user_id, id, name, currency, opening_balance_cents, opening_date, synthetic)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    userId,
    account.id,
    account.name,
    account.currency,
    account.openingBalanceCents,
    account.openingDate,
    account.synthetic ? 1 : 0,
  );
}

export function updateAccount(db: Database, userId: string, account: LedgerAccount) {
  db.run(
    `
      UPDATE bank_accounts
      SET name = ?, currency = ?, opening_balance_cents = ?, opening_date = ?, synthetic = ?
      WHERE user_id = ? AND id = ?
    `,
    account.name,
    account.currency,
    account.openingBalanceCents,
    account.openingDate,
    account.synthetic ? 1 : 0,
    userId,
    account.id,
  );
}

/** Date of the earliest movement of an account, or undefined when it has none. */
export function earliestMovementDate(db: Database, userId: string, accountId: string) {
  return (
    db.get<{ date: string | null }>(
      'SELECT MIN(date) AS date FROM bank_transactions WHERE user_id = ? AND account_id = ?',
      userId,
      accountId,
    )?.date ?? undefined
  );
}

export function getTransaction(db: Database, userId: string, transactionId: string) {
  const row = db.get<Flagged<LedgerTransaction>>(
    `SELECT ${transactionColumns} FROM bank_transactions WHERE user_id = ? AND id = ?`,
    userId,
    transactionId,
  );
  return row && (flag(row) as LedgerTransaction);
}

export function countTransactions(db: Database, userId: string) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM bank_transactions WHERE user_id = ?', userId)!.total;
}

export function insertTransaction(db: Database, userId: string, movement: LedgerTransaction) {
  db.run(
    `
      INSERT INTO bank_transactions
        (user_id, id, account_id, date, description, amount_cents, currency, category, status, synthetic)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    userId,
    movement.id,
    movement.accountId,
    movement.date,
    movement.description,
    movement.amountCents,
    movement.currency,
    movement.category,
    movement.status,
    movement.synthetic ? 1 : 0,
  );
}

/** Rewrite one movement in place (for example pending to booked); its position does not change. */
export function updateTransaction(db: Database, userId: string, movement: LedgerTransaction) {
  db.run(
    `
      UPDATE bank_transactions
      SET account_id = ?, date = ?, description = ?, amount_cents = ?, currency = ?, category = ?,
          status = ?, synthetic = ?
      WHERE user_id = ? AND id = ?
    `,
    movement.accountId,
    movement.date,
    movement.description,
    movement.amountCents,
    movement.currency,
    movement.category,
    movement.status,
    movement.synthetic ? 1 : 0,
    userId,
    movement.id,
  );
}

/** Returns false when there was nothing to delete. */
export function deleteTransaction(db: Database, userId: string, transactionId: string) {
  return db.run('DELETE FROM bank_transactions WHERE user_id = ? AND id = ?', userId, transactionId).changes === 1;
}

/** Every movement of a user in the order it was first imported. Prefer the narrower queries below. */
export function listTransactions(db: Database, userId: string) {
  return db
    .all<Flagged<LedgerTransaction>>(
      `SELECT ${transactionColumns} FROM bank_transactions WHERE user_id = ? ORDER BY row_id`,
      userId,
    )
    .map(flag) as LedgerTransaction[];
}

export type TransactionFilter = { from?: string; to?: string; accountId?: string };

/** One page of movements by date then ID, with the total that matches the filter. */
export function pageTransactions(
  db: Database,
  userId: string,
  filter: TransactionFilter,
  page: { limit: number; offset: number },
) {
  const where = `
    user_id = :userId
    AND (:from IS NULL OR date >= :from)
    AND (:to IS NULL OR date <= :to)
    AND (:accountId IS NULL OR account_id = :accountId)
  `;
  const bound = {
    userId,
    from: filter.from ?? null,
    to: filter.to ?? null,
    accountId: filter.accountId ?? null,
  };
  const total = db.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM bank_transactions WHERE ${where}`,
    bound,
  )!.total;
  const rows = db.all<Flagged<LedgerTransaction>>(
    `
      SELECT ${transactionColumns}
      FROM bank_transactions
      WHERE ${where}
      ORDER BY date, id
      LIMIT :limit OFFSET :offset
    `,
    { ...bound, limit: page.limit, offset: page.offset },
  );
  return { total, transactions: rows.map(flag) as LedgerTransaction[] };
}

/** Movements dated on or before `to`, oldest first: the history a period analysis needs. */
export function transactionsThrough(db: Database, userId: string, to: string) {
  return db
    .all<Flagged<LedgerTransaction>>(
      `
        SELECT ${transactionColumns}
        FROM bank_transactions
        WHERE user_id = ? AND date <= ?
        ORDER BY row_id
      `,
      userId,
      to,
    )
    .map(flag) as LedgerTransaction[];
}

/** Sum of booked movements per account up to and including `asOf`. Accounts without any are absent. */
export function bookedTotals(db: Database, userId: string, asOf: string) {
  const rows = db.all<{ accountId: string; totalCents: number }>(
    `
      SELECT account_id AS accountId, SUM(amount_cents) AS totalCents
      FROM bank_transactions
      WHERE user_id = ? AND status = 'booked' AND date <= ?
      GROUP BY account_id
    `,
    userId,
    asOf,
  );
  return new Map(rows.map(row => [row.accountId, row.totalCents]));
}

/** True when no movement of the user is real bank data. */
export function transactionsAreSynthetic(db: Database, userId: string) {
  return db.get('SELECT 1 FROM bank_transactions WHERE user_id = ? AND synthetic = 0 LIMIT 1', userId) === undefined;
}

/** True only when every account and movement of the user is labelled synthetic. */
export function ledgerIsSynthetic(db: Database, userId: string) {
  const realAccount = db.get('SELECT 1 FROM bank_accounts WHERE user_id = ? AND synthetic = 0 LIMIT 1', userId);
  return realAccount === undefined && transactionsAreSynthetic(db, userId);
}

/**
 * Record that the ledger changed: bump the revision, append its event and drop events beyond the
 * retention. Call it in the transaction that made the change.
 */
export function appendRevision(db: Database, userId: string, occurredAt: string): LedgerEventRecord {
  const { revision } = db.get<{ revision: number }>(
    `
      INSERT INTO bank_ledgers (user_id, revision, updated_at) VALUES (?, 1, ?)
      ON CONFLICT (user_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at
      RETURNING revision
    `,
    userId,
    occurredAt,
  )!;
  const event: LedgerEventRecord = {
    sequence: revision,
    occurredAt,
    type: 'bank.updated',
    accountCount: countAccounts(db, userId),
    transactionCount: countTransactions(db, userId),
    synthetic: ledgerIsSynthetic(db, userId),
  };
  insertEvent(db, userId, event);
  db.run('DELETE FROM bank_events WHERE user_id = ? AND sequence <= ?', userId, revision - eventRetention);
  return event;
}

/** Store an event as it is; `appendRevision` and the legacy import use it. */
export function insertEvent(db: Database, userId: string, event: LedgerEventRecord) {
  db.run(
    `
      INSERT INTO bank_events (user_id, sequence, occurred_at, type, account_count, transaction_count, synthetic)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    userId,
    event.sequence,
    event.occurredAt,
    event.type,
    event.accountCount,
    event.transactionCount,
    event.synthetic ? 1 : 0,
  );
}

/** Set the ledger head directly; only the legacy import needs it. */
export function writeLedgerHead(db: Database, userId: string, revision: number, updatedAt: string) {
  db.run(
    `
      INSERT INTO bank_ledgers (user_id, revision, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
    `,
    userId,
    revision,
    updatedAt,
  );
}

/** Events with a sequence above `after`, oldest first, at most `limit` (all when omitted). */
export function listEvents(db: Database, userId: string, after = 0, limit = eventRetention) {
  return db
    .all<Flagged<LedgerEventRecord>>(
      `
        SELECT ${eventColumns}
        FROM bank_events
        WHERE user_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?
      `,
      userId,
      after,
      limit,
    )
    .map(flag) as LedgerEventRecord[];
}

/** Sequence of the oldest event still kept, or undefined when there is none. */
export function oldestEventSequence(db: Database, userId: string) {
  return (
    db.get<{ sequence: number | null }>('SELECT MIN(sequence) AS sequence FROM bank_events WHERE user_id = ?', userId)
      ?.sequence ?? undefined
  );
}
