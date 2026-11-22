import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { stateSchema } from '../contracts/habits.ts';
import { safeId } from '../contracts/ids.ts';
import { inputSchema, maxInputs } from '../contracts/inputs.ts';
import {
  accountSchema,
  dateSchema,
  defaultMaxTransactions,
  maxAccounts,
  transactionSchema,
} from '../finance/cashflow.ts';
import { documentSchema } from '../profiles/store.ts';
import type { ConnectionRecord, QueuedWebhook } from './bank-sync.ts';
import {
  connectionByRef,
  countPendingWebhooks,
  countSeenWebhooks,
  getConnection,
  insertConnection,
  restoreWebhookQueue,
  seenRetention,
} from './bank-sync.ts';
import type { Database } from './database.ts';
import { readMeta, writeMeta } from './database.ts';
import type { HabitCheckin, HabitGoal } from './habits.ts';
import {
  getCheckin,
  getGoal,
  habitsUsageScope,
  insertCheckin,
  insertGoal,
  listCheckins,
  listGoals,
  usageAttempts,
  writeUsage,
} from './habits.ts';
import type { InputRecord } from './inputs.ts';
import { countInputs, getInput, insertInput } from './inputs.ts';
import type { LedgerAccount, LedgerEventRecord, LedgerTransaction } from './ledger.ts';
import {
  appendRevision,
  countAccounts,
  countEvents,
  countTransactions,
  eventRetention,
  getAccount,
  getTransaction,
  insertAccount,
  insertEvent,
  insertTransaction,
  ledgerExists,
  writeLedgerHead,
} from './ledger.ts';
import { countUsers, insertUser, userExists, writeSection } from './profiles.ts';

/**
 * Import of the JSON files that ReloCat wrote before it had a database.
 *
 * Old layout, all of it optional:
 *   <profileDir>/<userId>/details.json, preferences.json, bank-account.json   profile documents
 *   <profileDir>/<userId>/app-inputs.json                                     input records
 *   <profileDir>/<userId>/bank-ledger.json                                    accounts, movements, events
 *   <profileDir>/<userId>/bank-connections.json                               bank connections
 *   <profileDir>/bank-webhook-queue.json                                      pending webhooks, seen IDs
 *   <habitsDir>/users/<userId>.json                                           habit goals and check-ins
 *   <habitsDir>/openai-usage.json                                             daily AI attempt counter
 *
 * Each file is one unit. It is validated with the schemas and limits the running stores apply, so
 * nothing gets in that the stores would refuse or could not read back (500 input records, 20
 * accounts, 100,000 movements, a revision counter that can still be incremented). A file that
 * cannot be read, is not valid or does not fit is skipped as a whole and reported with its reason;
 * the other files are imported. The JSON files are only read: they stay as the user's copy.
 *
 * Completion is recorded per file in `legacy_import_files`, under the file's logical name:
 *   - `importLegacyJson` runs by itself on the first start: only into an empty database, once
 *     (the `legacy_json_import` marker), importing every valid file.
 *   - `importLegacyFiles` is the explicit command (`npm run db:import-legacy -- <dir>`). It may run
 *     at any time and as often as needed: it imports the files that are not recorded yet, for example
 *     one that was repaired after being skipped, and it never touches a file that is recorded.
 *
 * Nothing already in the database is overwritten or imported twice. A later import adds only the
 * records whose IDs are missing, and a ledger that has moved on gets a new revision of its own
 * instead of the old event log. One run is one transaction, checked row by row before it commits.
 */

/** Key of the `app_meta` row that records the first import. */
export const legacyImportMarker = 'legacy_json_import';

export type LegacySources = { profileDir?: string; habitsDir?: string };

const tables = [
  'users',
  'profile_sections',
  'input_records',
  'bank_accounts',
  'bank_transactions',
  'bank_events',
  'bank_ledgers',
  'bank_connections',
  'bank_webhook_queue',
  'bank_webhook_seen',
  'habit_goals',
  'habit_checkins',
  'ai_usage',
] as const;
type Table = (typeof tables)[number];
export type LegacyCounts = Record<Table, number>;
/** A file that was not imported: where it is, its logical name and why. */
export type LegacySkip = { path: string; file: string; reason: string };

export type LegacyImportResult =
  | { status: 'already_imported' | 'database_not_empty' | 'nothing_to_import' }
  | {
      status: 'imported';
      /** Rows added by this run, per table. */
      counts: LegacyCounts;
      skipped: LegacySkip[];
      /** Logical names of the files imported by this run. */
      imported: string[];
      /** Logical names of the files that an earlier run had already imported; they were not read again. */
      alreadyImported: string[];
    };

/** The largest revision a ledger file may carry: far above any real ledger, far below unsafe integers. */
export const maxLegacyRevision = 1_000_000_000;

const sectionNames = ['details', 'preferences', 'bank-account'] as const;
const timestamp = z.iso.datetime({ offset: true });
const storedInput = inputSchema.refine(
  input => input.source !== 'profile' && input.id !== 'profile-snapshot',
  'profile source and profile-snapshot ID are reserved',
);
const inputsFileSchema = z.object({ inputs: z.array(storedInput).max(maxInputs) });
const eventSchema = z.object({
  sequence: z.number().int().positive().max(maxLegacyRevision),
  occurredAt: timestamp,
  type: z.literal('bank.updated'),
  accountCount: z.number().int().nonnegative().max(maxAccounts),
  transactionCount: z.number().int().nonnegative().max(defaultMaxTransactions),
  synthetic: z.boolean(),
});
const ledgerFileSchema = z.object({
  updatedAt: z.union([timestamp, z.literal('')]).default(''),
  accounts: z.array(accountSchema).max(maxAccounts),
  transactions: z.array(transactionSchema).max(defaultMaxTransactions),
  revision: z.number().int().nonnegative().max(maxLegacyRevision).default(0),
  events: z.array(eventSchema).default([]),
});
const connectionSchema = z.object({
  id: safeId,
  providerId: safeId,
  ref: z.string().min(1).max(200),
  createdAt: timestamp,
  cursor: z.string().max(2000).nullable(),
  pollIntervalMs: z.number().int().positive().max(86_400_000).nullable(),
  lastSyncAt: timestamp.nullable(),
  lastError: z.string().max(2000).nullable(),
  lastAttemptAt: timestamp.nullable().default(null),
  consecutiveFailures: z.number().int().nonnegative().max(1_000_000).default(0),
});
const connectionsFileSchema = z.object({ connections: z.array(connectionSchema).max(100) });
const queueFileSchema = z.object({
  lastSeq: z.number().int().nonnegative().max(maxLegacyRevision),
  pending: z
    .array(
      z.object({
        seq: z.number().int().positive().max(maxLegacyRevision),
        providerId: safeId,
        ref: z.string().min(1).max(200),
        receivedAt: timestamp,
      }),
    )
    .max(10_000),
  seen: z.array(z.string().max(300)).max(100_000),
});
const usageFileSchema = z.object({ date: dateSchema, attempts: z.number().int().nonnegative().max(1_000_000) });

/** One file of the old layout, validated, or the reason it cannot be imported. */
type Unit<Content> = { file: string; path: string; content: Content };
type LedgerContent = {
  revision: number;
  updatedAt: string;
  accounts: LedgerAccount[];
  transactions: LedgerTransaction[];
  events: LedgerEventRecord[];
};
type UserPlan = {
  id: string;
  profile?: Unit<Record<(typeof sectionNames)[number], { synthetic: boolean }>>;
  inputs?: Unit<InputRecord[]>;
  ledger?: Unit<LedgerContent>;
  connections?: Unit<ConnectionRecord[]>;
  habits?: Unit<{ goals: HabitGoal[]; checkins: HabitCheckin[] }>;
};
type Plan = {
  users: UserPlan[];
  queue?: Unit<{ lastSeq: number; pending: QueuedWebhook[]; seen: { providerId: string; eventId: string }[] }>;
  usage?: Unit<{ date: string; attempts: number }>;
  skipped: LegacySkip[];
  alreadyImported: string[];
};

const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const unique = (values: string[]) => new Set(values).size === values.length;

/** The first problem of a file that does not fit its schema, in words a person can act on. */
function describeIssue(error: z.ZodError) {
  const [issue] = error.issues;
  const where = issue.path.length ? ` at ${issue.path.join('.')}` : '';
  const more = error.issues.length > 1 ? ` (and ${error.issues.length - 1} more)` : '';
  return `not the expected shape${where}: ${issue.message}${more}`;
}

/** Parse one JSON file. Undefined when it does not exist; a broken file is recorded as skipped. */
async function load<Schema extends z.ZodType>(
  path: string,
  file: string,
  schema: Schema,
  skipped: LegacySkip[],
): Promise<z.infer<Schema> | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (!isMissing(error)) skipped.push({ path, file, reason: 'the file could not be read' });
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    skipped.push({ path, file, reason: 'not valid JSON (the file may be truncated)' });
    return undefined;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    skipped.push({ path, file, reason: describeIssue(parsed.error) });
    return undefined;
  }
  return parsed.data;
}

/** Names in a directory; an absent directory has none. */
async function entries(directory: string, kind: 'directories' | 'files') {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => (kind === 'directories' ? entry.isDirectory() : entry.isFile()))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** A ledger file as rows, or the reason it cannot be imported as a whole. */
function ledgerContent(file: z.infer<typeof ledgerFileSchema>): LedgerContent | string {
  const accounts = new Map(file.accounts.map(account => [account.id, account]));
  if (accounts.size !== file.accounts.length) return 'duplicate account IDs';
  if (!unique(file.transactions.map(movement => movement.id))) return 'duplicate movement IDs';
  for (const movement of file.transactions) {
    const account = accounts.get(movement.accountId);
    if (!account) return `movement ${movement.id} refers to an unknown account`;
    if (movement.date < account.openingDate) return `movement ${movement.id} precedes the opening date of its account`;
  }
  if (!unique(file.events.map(event => String(event.sequence)))) return 'duplicate event sequences';
  const events = [...file.events].sort((a, b) => a.sequence - b.sequence).slice(-eventRetention);
  // The revision counter never falls behind the events it produced.
  const revision = Math.max(file.revision, events.at(-1)?.sequence ?? 0);
  return { revision, updatedAt: file.updatedAt, accounts: file.accounts, transactions: file.transactions, events };
}

/** Read what the old layout holds into memory, file by file, leaving out the files already imported. */
async function readLegacy(sources: LegacySources, done: Set<string>): Promise<Plan> {
  const plan: Plan = { users: [], skipped: [], alreadyImported: [] };
  const { skipped } = plan;
  /** True when the file still has to be looked at; a recorded file is never read again. */
  const pending = (file: string) => {
    if (!done.has(file)) return true;
    plan.alreadyImported.push(file);
    return false;
  };
  const users = new Map<string, UserPlan>();
  const userPlan = (id: string) => {
    let user = users.get(id);
    if (!user) {
      user = { id };
      users.set(id, user);
      plan.users.push(user);
    }
    return user;
  };
  if (sources.profileDir) {
    for (const id of await entries(sources.profileDir, 'directories')) {
      if (!safeId.safeParse(id).success) continue;
      const folder = join(sources.profileDir, id);
      const user = userPlan(id);
      const unit = (name: string) => ({ file: `profiles/${id}/${name}`, path: join(folder, name) });

      const profile = { file: `profiles/${id}/profile`, path: folder };
      if (pending(profile.file)) {
        const problems: LegacySkip[] = [];
        const documents = await Promise.all(
          sectionNames.map(section => load(join(folder, `${section}.json`), profile.file, documentSchema, problems)),
        );
        if (documents.some(document => document === undefined))
          skipped.push({
            ...profile,
            reason: problems.length
              ? problems.map(problem => `${problem.path.slice(folder.length + 1)}: ${problem.reason}`).join('; ')
              : 'not a complete profile (three section files are required)',
          });
        else {
          const [details, preferences, bankAccount] = documents as z.infer<typeof documentSchema>[];
          if (details.id !== id) skipped.push({ ...profile, reason: 'details.id does not match the folder name' });
          else user.profile = { ...profile, content: { details, preferences, 'bank-account': bankAccount } };
        }
      }

      const inputs = unit('app-inputs.json');
      if (pending(inputs.file)) {
        const file = await load(inputs.path, inputs.file, inputsFileSchema, skipped);
        if (file && !unique(file.inputs.map(input => input.id)))
          skipped.push({ ...inputs, reason: 'duplicate input IDs' });
        else if (file) user.inputs = { ...inputs, content: file.inputs };
      }

      const ledger = unit('bank-ledger.json');
      if (pending(ledger.file)) {
        const file = await load(ledger.path, ledger.file, ledgerFileSchema, skipped);
        const rows = file && ledgerContent(file);
        if (typeof rows === 'string') skipped.push({ ...ledger, reason: rows });
        else if (rows) user.ledger = { ...ledger, content: rows };
      }

      const connections = unit('bank-connections.json');
      if (pending(connections.file)) {
        const file = await load(connections.path, connections.file, connectionsFileSchema, skipped);
        if (file && !unique(file.connections.map(connection => connection.id)))
          skipped.push({ ...connections, reason: 'duplicate connection IDs' });
        else if (file) user.connections = { ...connections, content: file.connections };
      }
    }
    const queue = {
      file: 'profiles/bank-webhook-queue.json',
      path: join(sources.profileDir, 'bank-webhook-queue.json'),
    };
    if (pending(queue.file)) {
      const file = await load(queue.path, queue.file, queueFileSchema, skipped);
      if (file) {
        // Old keys are `<providerId>:<eventId>`; a provider ID never contains a colon.
        const seen = [...new Set(file.seen)]
          .filter(key => key.includes(':'))
          .slice(-seenRetention)
          .map(key => ({ providerId: key.slice(0, key.indexOf(':')), eventId: key.slice(key.indexOf(':') + 1) }));
        const refs = new Set<string>();
        const waiting = [...file.pending]
          .sort((a, b) => b.seq - a.seq)
          .filter(item => {
            // One pending notification per connection reference: the newest one.
            const ref = `${item.providerId}\n${item.ref}`;
            return !refs.has(ref) && Boolean(refs.add(ref));
          })
          .filter((item, index, all) => all.findIndex(other => other.seq === item.seq) === index)
          .reverse();
        plan.queue = { ...queue, content: { lastSeq: file.lastSeq, pending: waiting, seen } };
      }
    }
  }
  if (sources.habitsDir) {
    const folder = join(sources.habitsDir, 'users');
    for (const name of await entries(folder, 'files')) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!safeId.safeParse(id).success) continue;
      const habits = { file: `habits/users/${name}`, path: join(folder, name) };
      if (!pending(habits.file)) continue;
      // Older files carry `synthetic: true` whoever they belong to; the flag is derived, not imported.
      const state = await load(habits.path, habits.file, stateSchema, skipped);
      if (!state) continue;
      const goalIds = new Set(state.goals.map(goal => goal.id));
      if (state.userId !== id) skipped.push({ ...habits, reason: 'userId does not match the file name' });
      else if (goalIds.size !== state.goals.length || !unique(state.checkins.map(checkin => checkin.id)))
        skipped.push({ ...habits, reason: 'duplicate habit or check-in IDs' });
      else if (!state.checkins.every(checkin => goalIds.has(checkin.goalId)))
        skipped.push({ ...habits, reason: 'a check-in refers to an unknown habit' });
      else userPlan(id).habits = { ...habits, content: { goals: state.goals, checkins: state.checkins } };
    }
    const usage = { file: 'habits/openai-usage.json', path: join(sources.habitsDir, 'openai-usage.json') };
    if (pending(usage.file)) {
      const file = await load(usage.path, usage.file, usageFileSchema, skipped);
      if (file) plan.usage = { ...usage, content: file };
    }
  }
  return plan;
}

/** Rows per table. Table names are the constants above, never request data. */
function tableCounts(db: Database) {
  const counts = {} as LegacyCounts;
  for (const table of tables)
    counts[table] = db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`)!.total;
  return counts;
}

const noRows = () => Object.fromEntries(tables.map(table => [table, 0])) as LegacyCounts;

/** Logical names of the files recorded as imported. */
export function importedLegacyFiles(db: Database) {
  return db
    .all<{ file: string; importedAt: string; rowCount: number }>(
      'SELECT file, imported_at AS importedAt, row_count AS rowCount FROM legacy_import_files ORDER BY file',
    )
    .map(row => ({ ...row }));
}

/**
 * Apply the plan inside the caller's transaction. Each unit either goes in completely or is
 * reported in `skipped`; `added` counts the rows it wrote, per table.
 */
function apply(db: Database, plan: Plan, now: string) {
  const added = noRows();
  const imported: string[] = [];
  const skipped: LegacySkip[] = [];
  const record = (unit: { file: string }, rowCount: number) => {
    db.run('INSERT INTO legacy_import_files (file, imported_at, row_count) VALUES (?, ?, ?)', unit.file, now, rowCount);
    imported.push(unit.file);
  };
  const skip = (unit: { file: string; path: string }, reason: string) =>
    skipped.push({ path: unit.path, file: unit.file, reason });
  const orphan = 'the user has no profile in the database, so there is nothing to attach it to';

  for (const user of plan.users) {
    const { id } = user;
    if (user.profile) {
      // A user created since (by a fixture, an account or an earlier import) is never overwritten.
      if (userExists(db, id)) skip(user.profile, 'the user already exists in the database; its profile was kept');
      else {
        insertUser(db, id, now);
        for (const section of sectionNames) writeSection(db, id, section, user.profile.content[section], now);
        added.users++;
        added.profile_sections += sectionNames.length;
        record(user.profile, 1 + sectionNames.length);
      }
    }
    const known = userExists(db, id);

    if (user.inputs) {
      const missing = user.inputs.content.filter(input => !getInput(db, id, input.id));
      if (!known) skip(user.inputs, orphan);
      else if (countInputs(db, id) + missing.length > maxInputs)
        skip(user.inputs, `importing it would exceed the limit of ${maxInputs} input records per user`);
      else {
        for (const input of missing) insertInput(db, id, input);
        added.input_records += missing.length;
        record(user.inputs, missing.length);
      }
    }

    if (user.ledger) {
      const ledger = user.ledger.content;
      const fresh = countAccounts(db, id) === 0 && countTransactions(db, id) === 0 && !ledgerExists(db, id);
      const newAccounts = ledger.accounts.filter(account => !getAccount(db, id, account.id));
      const newMovements = ledger.transactions.filter(movement => !getTransaction(db, id, movement.id));
      // An account that is already in the database keeps its own opening date.
      const early = newMovements.find(movement => {
        const stored = getAccount(db, id, movement.accountId);
        return stored !== undefined && movement.date < stored.openingDate;
      });
      if (!known) skip(user.ledger, orphan);
      else if (countAccounts(db, id) + newAccounts.length > maxAccounts)
        skip(user.ledger, `importing it would exceed the limit of ${maxAccounts} accounts per user`);
      else if (countTransactions(db, id) + newMovements.length > defaultMaxTransactions)
        skip(user.ledger, `importing it would exceed the limit of ${defaultMaxTransactions} movements per user`);
      else if (early)
        skip(user.ledger, `movement ${early.id} precedes the opening date of the account already in the database`);
      else {
        for (const account of newAccounts) insertAccount(db, id, account);
        for (const movement of newMovements) insertTransaction(db, id, movement);
        added.bank_accounts += newAccounts.length;
        added.bank_transactions += newMovements.length;
        let rows = newAccounts.length + newMovements.length;
        if (fresh) {
          // Nothing was there: the ledger comes back exactly as it was, with its revisions and events.
          for (const event of ledger.events) insertEvent(db, id, event);
          writeLedgerHead(db, id, ledger.revision, ledger.updatedAt);
          added.bank_events += ledger.events.length;
          added.bank_ledgers++;
          rows += ledger.events.length + 1;
        } else if (rows > 0) {
          // The ledger has moved on since: the old event log is history. The change is one new revision.
          const eventsBefore = countEvents(db, id);
          const hadHead = ledgerExists(db, id);
          appendRevision(db, id, now);
          // The new event may push the oldest one out of the retained log.
          added.bank_events += countEvents(db, id) - eventsBefore;
          if (!hadHead) added.bank_ledgers++;
        }
        record(user.ledger, rows);
      }
    }

    if (user.connections) {
      if (!known) skip(user.connections, orphan);
      else {
        let rows = 0;
        for (const connection of user.connections.content) {
          // A connection that is already there, or whose bank reference is taken, is left alone.
          if (getConnection(db, id, connection.id)) continue;
          if (connectionByRef(db, connection.providerId, connection.ref)) {
            skip(
              user.connections,
              `connection ${connection.id} was left out: its bank reference already belongs to another connection`,
            );
            continue;
          }
          insertConnection(db, id, connection);
          rows++;
        }
        added.bank_connections += rows;
        record(user.connections, rows);
      }
    }

    if (user.habits) {
      const { goals, checkins } = user.habits.content;
      const newGoals = goals.filter(goal => !getGoal(db, id, goal.id));
      const newCheckins = checkins.filter(checkin => !getCheckin(db, id, checkin.id));
      // The limits of the habit contract apply to what the user would hold afterwards.
      const fits = known
        ? stateSchema.safeParse({
            schemaVersion: 1,
            synthetic: false,
            userId: id,
            goals: [...listGoals(db, id), ...newGoals],
            checkins: [...listCheckins(db, id), ...newCheckins],
          })
        : undefined;
      if (!fits) skip(user.habits, orphan);
      else if (!fits.success) skip(user.habits, 'importing it would exceed the limit of 20 habits or 1000 check-ins');
      else {
        for (const goal of newGoals) insertGoal(db, id, goal);
        for (const checkin of newCheckins) insertCheckin(db, id, checkin);
        added.habit_goals += newGoals.length;
        added.habit_checkins += newCheckins.length;
        record(user.habits, newGoals.length + newCheckins.length);
      }
    }
  }

  if (plan.queue) {
    // Old notifications are only restored into a queue that has no state of its own.
    if (countPendingWebhooks(db) > 0 || countSeenWebhooks(db) > 0)
      skip(plan.queue, 'the database already has webhook state of its own; old notifications were not added');
    else {
      restoreWebhookQueue(db, plan.queue.content);
      added.bank_webhook_queue += plan.queue.content.pending.length;
      added.bank_webhook_seen += plan.queue.content.seen.length;
      record(plan.queue, plan.queue.content.pending.length + plan.queue.content.seen.length);
    }
  }
  if (plan.usage) {
    const exists = db.get('SELECT 1 FROM ai_usage WHERE scope = ?', habitsUsageScope) !== undefined;
    if (exists || usageAttempts(db, habitsUsageScope, plan.usage.content.date) > 0)
      skip(plan.usage, 'the database already has a daily counter of its own');
    else {
      writeUsage(db, habitsUsageScope, plan.usage.content.date, plan.usage.content.attempts);
      added.ai_usage++;
      record(plan.usage, 1);
    }
  }
  return { added, imported, skipped };
}

/** True when the plan holds at least one file that could be imported. */
function hasWork(plan: Plan) {
  return (
    plan.queue !== undefined ||
    plan.usage !== undefined ||
    plan.users.some(user => user.profile || user.inputs || user.ledger || user.connections || user.habits)
  );
}

type Marker = { importedAt: string; sources: LegacySources; counts: LegacyCounts; skipped: number };

/** One run: read, apply in a transaction, verify the row counts, record the files and the marker. */
async function run(
  db: Database,
  sources: LegacySources,
  now: Date,
  guard: () => 'already_imported' | 'database_not_empty' | undefined,
): Promise<LegacyImportResult> {
  const refused = guard();
  if (refused) return { status: refused };
  const plan = await readLegacy(sources, new Set(importedLegacyFiles(db).map(row => row.file)));
  if (!hasWork(plan) && !plan.skipped.length && !plan.alreadyImported.length) return { status: 'nothing_to_import' };
  return db.transaction((): LegacyImportResult => {
    // Checked again under the write lock: another process may have imported or seeded meanwhile.
    const refusedNow = guard();
    if (refusedNow) return { status: refusedNow };
    const before = tableCounts(db);
    const stamp = now.toISOString();
    const outcome = apply(db, plan, stamp);
    const after = tableCounts(db);
    for (const table of tables) {
      const stored = after[table] - before[table];
      if (stored !== outcome.added[table])
        throw new Error(`Legacy import check failed for ${table}: wrote ${outcome.added[table]}, stored ${stored}`);
    }
    const skipped = [...plan.skipped, ...outcome.skipped];
    // The marker keeps the totals of every run, and how many files the latest run could not import.
    const previous = readMeta(db, legacyImportMarker);
    const earlier = previous === undefined ? undefined : (JSON.parse(previous) as Partial<Marker>);
    const counts = noRows();
    for (const table of tables) counts[table] = (earlier?.counts?.[table] ?? 0) + outcome.added[table];
    writeMeta(
      db,
      legacyImportMarker,
      JSON.stringify({
        importedAt: earlier?.importedAt ?? stamp,
        lastRunAt: stamp,
        sources,
        counts,
        skipped: skipped.length,
        skippedFiles: skipped.map(({ file, reason }) => ({ file, reason })),
      }),
      now,
    );
    return {
      status: 'imported',
      counts: outcome.added,
      skipped,
      imported: outcome.imported,
      alreadyImported: plan.alreadyImported,
    };
  });
}

/**
 * The automatic import of the first start: into an empty database that has never imported, once.
 * Files that are skipped are reported and can be imported later with `importLegacyFiles`.
 */
export async function importLegacyJson(
  db: Database,
  sources: LegacySources,
  now = new Date(),
): Promise<LegacyImportResult> {
  // An empty layout leaves no marker, so a layout that appears later is still imported automatically.
  return run(db, sources, now, () =>
    readMeta(db, legacyImportMarker) !== undefined
      ? 'already_imported'
      : countUsers(db) > 0
        ? 'database_not_empty'
        : undefined,
  );
}

/**
 * The explicit import (`npm run db:import-legacy -- <dir>`): import every file of the old layout
 * that is not recorded as imported yet, whatever the database already holds. Running it again
 * imports nothing: each file is recorded when it goes in.
 */
export function importLegacyFiles(db: Database, sources: LegacySources, now = new Date()) {
  return run(db, sources, now, () => undefined);
}
