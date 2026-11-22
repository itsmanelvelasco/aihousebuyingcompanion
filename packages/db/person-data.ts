import type { Database } from './database.ts';

/**
 * The one list of where a person's data lives. Export ("give me everything"), deletion ("remove
 * everything") and the proof that a deletion was complete all read it, so a table cannot be added to
 * one and forgotten in the other.
 *
 * Every table of the schema must be named here: in `personTables` when a row can be about one
 * person, in `sharedTables` (with the reason) when it cannot. `tests/db.test.ts` fails when a table
 * is in neither list, and when a table with a `user_id`, `account_id` or `grant_id` column is not in
 * `personTables`.
 */
export type PersonTable = {
  table: string;
  /** Which id selects the person's rows: their `users.id` or their `accounts.id`. */
  key: 'userId' | 'accountId';
  /** SQL condition with exactly one `?`, bound to that id. */
  where: string;
  /**
   * Columns left out of an export: hashes of secrets and sealed credentials. The export names them,
   * so the person sees that something is stored without receiving a value that would act as a key.
   */
  redact?: string[];
  /** Columns that hold JSON text, parsed in an export so it reads as data. */
  json?: string[];
  /** What the rows are, in words a person can read. */
  holds: string;
};

const ofGrants = 'grant_id IN (SELECT id FROM oauth_grants WHERE account_id = ?)';

/**
 * Listed in deletion order: rows that reference others come first, so each `DELETE` finds its
 * parents still there and no foreign key is left dangling.
 */
export const personTables: readonly PersonTable[] = [
  {
    table: 'bank_webhook_queue',
    key: 'userId',
    where: `EXISTS (
      SELECT 1 FROM bank_connections c
      WHERE c.user_id = ? AND c.provider_id = bank_webhook_queue.provider_id AND c.ref = bank_webhook_queue.ref
    )`,
    holds: 'Bank notifications waiting to be synced for your connections',
  },
  { table: 'bank_import_rows', key: 'userId', where: 'user_id = ?', holds: 'Which movements each statement brought' },
  {
    table: 'bank_import_previews',
    key: 'userId',
    where: 'user_id = ?',
    holds: 'Statements you uploaded and have not confirmed yet (they expire)',
  },
  { table: 'bank_imports', key: 'userId', where: 'user_id = ?', holds: 'Statements you imported' },
  {
    table: 'bank_credentials',
    key: 'userId',
    where: 'user_id = ?',
    redact: ['cipher'],
    holds: 'The sealed bank reference of each connection made with your consent at the bank',
  },
  {
    table: 'bank_consents',
    key: 'userId',
    where: 'user_id = ?',
    redact: ['state_hash', 'session_hash'],
    holds: 'Bank authorisations you started and have not finished',
  },
  {
    table: 'bank_connections',
    key: 'userId',
    where: 'user_id = ?',
    holds: 'Your bank connections and their sync state',
  },
  { table: 'bank_events', key: 'userId', where: 'user_id = ?', holds: 'The log of changes to your ledger' },
  { table: 'bank_transactions', key: 'userId', where: 'user_id = ?', holds: 'Your bank movements' },
  { table: 'bank_accounts', key: 'userId', where: 'user_id = ?', holds: 'Your bank accounts' },
  { table: 'bank_ledgers', key: 'userId', where: 'user_id = ?', holds: 'The revision counter of your ledger' },
  { table: 'habit_checkins', key: 'userId', where: 'user_id = ?', holds: 'Your habit check-ins' },
  { table: 'habit_goals', key: 'userId', where: 'user_id = ?', holds: 'Your habit goals' },
  { table: 'input_records', key: 'userId', where: 'user_id = ?', json: ['data'], holds: 'Answers you saved' },
  {
    table: 'profile_sections',
    key: 'userId',
    where: 'user_id = ?',
    json: ['document'],
    holds: 'Your three profile documents',
  },
  {
    table: 'oauth_tokens',
    key: 'accountId',
    where: ofGrants,
    redact: ['token_hash'],
    holds: 'Access and refresh tokens of applications you connected (only their hashes are stored)',
  },
  {
    table: 'oauth_codes',
    key: 'accountId',
    where: ofGrants,
    redact: ['code_hash', 'code_challenge'],
    holds: 'One-time codes of connections in progress',
  },
  { table: 'oauth_grants', key: 'accountId', where: 'account_id = ?', holds: 'Applications you allowed, and what for' },
  {
    table: 'auth_sessions',
    key: 'accountId',
    where: 'account_id = ?',
    redact: ['id_hash'],
    holds: 'Browsers where you are signed in',
  },
  {
    table: 'accounts',
    key: 'accountId',
    where: 'id = ?',
    redact: ['password_hash'],
    holds: 'Your account: email and sign-in times (the password is stored only as a salted hash)',
  },
  { table: 'users', key: 'userId', where: 'id = ?', holds: 'Your record id' },
];

/** Tables that hold nothing about one person, with the reason. */
export const sharedTables: Readonly<Record<string, string>> = {
  schema_migrations: 'which schema versions were applied',
  app_meta: 'one-off markers and server-wide keys',
  ai_usage: 'daily counters of paid AI calls for the whole server',
  board_runs: 'scripted journey-board rehearsals; nothing typed there is saved to a stored person',
  legacy_import_files: 'which legacy JSON files were imported',
  oauth_clients: 'applications that registered; a person appears only in oauth_grants',
  bank_webhook_seen: 'notification ids of banks, kept to ignore redeliveries; they name no person',
  auth_throttle:
    'attempt counters keyed by hashes of emails, sessions and visitor addresses; they expire on their own and hold nothing a person entered',
  sqlite_sequence: 'SQLite bookkeeping',
};

type Ids = { userId: string; accountId: string };

const count = (db: Database, entry: PersonTable, ids: Ids) =>
  db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM ${entry.table} WHERE ${entry.where}`, ids[entry.key])!.total;

/** Rows stored about a person, per table. */
export function personRowCounts(db: Database, ids: Ids) {
  return Object.fromEntries(personTables.map(entry => [entry.table, count(db, entry, ids)])) as Record<string, number>;
}

/**
 * Delete every row of every person-owned table. Returns the rows found per table before the
 * deletion. Call it inside a transaction.
 */
export function deletePersonRows(db: Database, ids: Ids) {
  const removed = personRowCounts(db, ids);
  for (const entry of personTables) db.run(`DELETE FROM ${entry.table} WHERE ${entry.where}`, ids[entry.key]);
  return removed;
}

/**
 * Everything stored about a person, table by table, as one JSON-ready object. Secrets that are
 * stored only as hashes, and sealed bank credentials, are left out and named in `redacted`.
 */
export function exportPersonRows(db: Database, ids: Ids, now = new Date()) {
  return db.read(() => {
    const tables: Record<string, Record<string, unknown>[]> = {};
    const redacted: Record<string, string[]> = {};
    const describes: Record<string, string> = {};
    // Parents first reads better than the deletion order.
    for (const entry of [...personTables].reverse()) {
      const rows = db.all<Record<string, unknown>>(
        `SELECT * FROM ${entry.table} WHERE ${entry.where} ORDER BY 1, 2`,
        ids[entry.key],
      );
      tables[entry.table] = rows.map(row => {
        const copy: Record<string, unknown> = { ...row };
        for (const column of entry.redact ?? []) delete copy[column];
        for (const column of entry.json ?? []) {
          try {
            if (typeof copy[column] === 'string') copy[column] = JSON.parse(copy[column] as string);
          } catch {
            // Left as the text that is stored.
          }
        }
        return copy;
      });
      describes[entry.table] = entry.holds;
      if (entry.redact?.length) redacted[entry.table] = entry.redact;
    }
    return {
      format: 'relocat-export/1',
      exportedAt: now.toISOString(),
      userId: ids.userId,
      about:
        'Every row ReloCat stores about you, by table. Money is in integer cents, dates are YYYY-MM-DD and times are ISO 8601 in UTC.',
      redacted: {
        note: 'These columns are not exported: they are hashes of secrets or sealed credentials, which would act as keys and tell you nothing.',
        columns: redacted,
      },
      notStoredPerPerson: sharedTables,
      describes,
      tables,
    };
  });
}

export type PersonExport = ReturnType<typeof exportPersonRows>;
