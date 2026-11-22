import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { backup, DatabaseSync } from 'node:sqlite';
import type { Migration } from './schema.ts';
import { migrations as appMigrations } from './schema.ts';

/**
 * ReloCat's runtime database: one SQLite file opened through Node's built-in `node:sqlite`.
 *
 * `packages/db` is the only place that imports `node:sqlite` or contains SQL. This file opens the
 * database, applies migrations and offers a few small helpers; the files next to it hold the
 * queries of one area each (profiles, inputs, ledger, bank sync, habits, board runs).
 *
 * Every call is synchronous, so a `transaction` callback runs without another query of this
 * process interleaving, and `BEGIN IMMEDIATE` plus the busy timeout serializes writers of other
 * processes. That replaces the per-user promise queues the JSON stores needed.
 *
 * Reads and writes take different transactions. `read` opens a deferred transaction: in WAL mode it
 * sees one consistent snapshot and never waits for a writer of another process. `transaction` takes
 * the write lock at once. Waiting for a lock is synchronous and stops the event loop, so the wait
 * is short (`busyTimeoutMs`) and a database that stays busy is reported as `DatabaseBusyError`,
 * which the HTTP layers answer with a retryable 503 instead of freezing.
 */

type Parameters = SQLInputValue[] | [Record<string, SQLInputValue>];

export type Database = {
  /** The file path as given to `open`, or `:memory:`. */
  readonly path: string;
  /** Version of the newest applied migration. */
  readonly schemaVersion: number;
  /** Run a statement that returns no rows. */
  run(sql: string, ...parameters: Parameters): { changes: number; lastInsertRowid: number };
  /** First row of a query, or undefined. */
  get<Row>(sql: string, ...parameters: Parameters): Row | undefined;
  /** Every row of a query. */
  all<Row>(sql: string, ...parameters: Parameters): Row[];
  /**
   * Run `work` in one write transaction: all of it is committed, or none of it when it throws.
   * `work` must be synchronous. A call inside another transaction joins the outer one. Throws
   * `DatabaseBusyError` when another process keeps the write lock longer than the busy timeout.
   */
  transaction<Result>(work: () => Result): Result;
  /**
   * Run `work` in one read transaction: every query sees the same snapshot, and a writer of
   * another process is never waited for. `work` must be synchronous and must not write; a write
   * inside it is refused by SQLite. Inside a write transaction it simply joins it.
   */
  read<Result>(work: () => Result): Result;
  /** Copy the live database into `file` with SQLite's online backup; safe while others write. */
  backupTo(file: string): Promise<void>;
  close(): void;
};

export type OpenOptions = {
  /** Migrations to apply instead of the application's own; used by tests of the runner. */
  migrations?: readonly Migration[];
  /**
   * Milliseconds a write waits for another process's lock before it fails with `DatabaseBusyError`.
   * The wait blocks the event loop, so the default is short: 250. Opening and migrating the file
   * always waits at least 5000, because nothing is being served yet.
   */
  busyTimeoutMs?: number;
  /**
   * Open an existing file for reading only: nothing is created, migrated or written, and any
   * schema version is accepted. Used by the backup command, which must not change a live database.
   */
  readOnly?: boolean;
};

/** Thrown when the file was written by a newer version of the code than the one opening it. */
export class SchemaTooNewError extends Error {}

/**
 * Thrown when another process held a lock for longer than the busy timeout. Nothing was written;
 * the same call can be tried again shortly. HTTP layers answer it with 503 and `Retry-After`.
 */
export class DatabaseBusyError extends Error {
  /** Seconds a client should wait before it tries again. */
  readonly retryAfterSeconds = 1;
  constructor(cause?: unknown) {
    super('The database is busy; try again shortly.', { cause });
    this.name = 'DatabaseBusyError';
  }
}

/** Default wait for a lock while serving requests, in milliseconds. */
export const defaultBusyTimeoutMs = 250;
/** Shortest wait while opening and migrating, in milliseconds. */
const openBusyTimeoutMs = 5000;

/** SQLITE_BUSY and its extended codes (snapshot, recovery, timeout) share the low byte 5. */
function isBusy(error: unknown) {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && (code & 0xff) === 5;
}

/** Run a statement and turn "database is locked" into `DatabaseBusyError`. */
function guardBusy<Result>(work: () => Result): Result {
  try {
    return work();
  } catch (error) {
    throw isBusy(error) ? new DatabaseBusyError(error) : error;
  }
}

/**
 * Open (and create when missing) the database at `path`, or a private in-memory one for
 * `:memory:`. The schema is brought up to date before the handle is returned.
 */
export function open(path: string, options: OpenOptions = {}): Database {
  const inMemory = path === ':memory:';
  const readOnly = options.readOnly === true;
  if (!inMemory && !readOnly) mkdirSync(dirname(resolve(path)), { recursive: true });
  const connection = new DatabaseSync(inMemory ? path : resolve(path), { readOnly });
  const busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? defaultBusyTimeoutMs));
  try {
    connection.exec(`PRAGMA busy_timeout = ${Math.max(busyTimeoutMs, openBusyTimeoutMs)}; PRAGMA foreign_keys = ON;`);
    // WAL lets readers and the backup run while a writer works; NORMAL is durable enough with WAL.
    if (!readOnly) connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  } catch (error) {
    connection.close();
    throw error;
  }

  const statements = new Map<string, StatementSync>();
  /** Statements are prepared once per SQL text and reused. */
  function prepare(sql: string) {
    let statement = statements.get(sql);
    if (!statement) {
      statement = connection.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  let depth = 0;
  /** `begin` opens the transaction; everything after it is committed together or rolled back. */
  function within<Result>(begin: string, work: () => Result): Result {
    guardBusy(() => connection.exec(begin));
    depth++;
    try {
      const result = guardBusy(work);
      if (result instanceof Promise) throw new Error('A database transaction must be synchronous');
      guardBusy(() => connection.exec('COMMIT'));
      return result;
    } catch (error) {
      if (connection.isTransaction) connection.exec('ROLLBACK');
      throw error;
    } finally {
      depth--;
    }
  }
  function transaction<Result>(work: () => Result): Result {
    return depth > 0 ? work() : within('BEGIN IMMEDIATE', work);
  }
  function read<Result>(work: () => Result): Result {
    if (depth > 0) return work();
    // `query_only` makes SQLite refuse a write, so a read transaction can never ask for the write lock.
    connection.exec('PRAGMA query_only = ON');
    try {
      return within('BEGIN DEFERRED', work);
    } finally {
      connection.exec('PRAGMA query_only = OFF');
    }
  }

  const database = {
    path,
    schemaVersion: 0,
    run(sql: string, ...parameters: Parameters) {
      // A single statement outside a transaction takes the write lock by itself.
      const { changes, lastInsertRowid } = guardBusy(() => prepare(sql).run(...(parameters as SQLInputValue[])));
      return { changes: Number(changes), lastInsertRowid: Number(lastInsertRowid) };
    },
    // Rows are copied into ordinary objects: `node:sqlite` returns them without a prototype.
    get<Row>(sql: string, ...parameters: Parameters) {
      const row = guardBusy(() => prepare(sql).get(...(parameters as SQLInputValue[])));
      return row === undefined ? undefined : ({ ...row } as Row);
    },
    all<Row>(sql: string, ...parameters: Parameters) {
      return guardBusy(() => prepare(sql).all(...(parameters as SQLInputValue[]))).map(row => ({ ...row }) as Row);
    },
    transaction,
    read,
    backupTo(file: string) {
      return backup(connection, file).then(() => {});
    },
    close() {
      if (!connection.isOpen) return;
      statements.clear();
      // Lets SQLite refresh its query-planner statistics cheaply before the file is left alone.
      try {
        if (!readOnly) connection.exec('PRAGMA optimize');
      } catch {
        // Closing must not fail because an optional optimisation could not run.
      }
      connection.close();
    },
  };

  try {
    database.schemaVersion = readOnly
      ? storedVersion(database)
      : migrate(database, connection, options.migrations ?? appMigrations);
    // From here on a lock is waited for only briefly: the wait stops the event loop.
    connection.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  } catch (error) {
    connection.close();
    throw error;
  }
  return database;
}

/**
 * Forward-only migrations. Each one runs in its own transaction together with its row in
 * `schema_migrations`, so a failed migration leaves the previous version intact. A database whose
 * version is newer than the newest known migration is refused instead of being written to.
 */
function migrate(database: Database, connection: DatabaseSync, migrations: readonly Migration[]) {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  ordered.forEach((migration, index) => {
    if (!Number.isInteger(migration.version) || migration.version !== index + 1)
      throw new Error('Migration versions must be 1, 2, 3, … without gaps');
  });
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const currentVersion = () =>
    database.get<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')!.version;
  const known = ordered.length;
  let version = currentVersion();
  if (version > known)
    throw new SchemaTooNewError(
      `Database ${database.path} has schema version ${version}, but this code knows only up to ${known}. ` +
        'Start a newer build or restore a backup; it was not modified.',
    );
  for (const migration of ordered) {
    if (migration.version <= version) continue;
    database.transaction(() => {
      // Another process may have applied it while this one waited for the write lock.
      if (currentVersion() >= migration.version) return;
      connection.exec(migration.sql);
      database.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
    version = currentVersion();
  }
  return version;
}

/** Schema version of a database that is only read; 0 when it has never been migrated. */
function storedVersion(database: Database) {
  const tracked = database.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  if (!tracked) return 0;
  return database.get<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')!
    .version;
}

/** The rows of `schema_migrations`, oldest first. */
export function appliedMigrations(database: Database) {
  return database.all<{ version: number; name: string; appliedAt: string }>(`
    SELECT version, name, applied_at AS appliedAt
    FROM schema_migrations
    ORDER BY version
  `);
}

/** SQLite's own consistency check of the whole file: `ok` when it is sound. */
export function integrityCheck(database: Database) {
  return database.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check ?? 'no result';
}

/** Read a value of the small key/value table used for one-off markers. */
export function readMeta(database: Database, key: string) {
  return database.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', key)?.value;
}

export function writeMeta(database: Database, key: string, value: string, now = new Date()) {
  database.run(
    `
      INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    key,
    value,
    now.toISOString(),
  );
}
