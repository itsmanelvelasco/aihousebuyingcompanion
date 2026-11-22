import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { stateSchema } from '../contracts/habits.ts';
import { safeId } from '../contracts/ids.ts';
import { inputSchema } from '../contracts/inputs.ts';
import { transactionSchema } from '../finance/cashflow.ts';
import type { ConnectionRecord, QueuedWebhook } from './bank-sync.ts';
import { insertConnection, restoreWebhookQueue, seenRetention } from './bank-sync.ts';
import type { Database } from './database.ts';
import { readMeta, writeMeta } from './database.ts';
import type { HabitCheckin, HabitGoal } from './habits.ts';
import { habitsUsageScope, insertCheckin, insertGoal, writeUsage } from './habits.ts';
import type { InputRecord } from './inputs.ts';
import { insertInput } from './inputs.ts';
import type { LedgerAccount, LedgerEventRecord, LedgerTransaction } from './ledger.ts';
import { eventRetention, insertAccount, insertEvent, insertTransaction, writeLedgerHead } from './ledger.ts';
import { countUsers, insertUser, writeSection } from './profiles.ts';

/**
 * One-time import of the JSON files that ReloCat wrote before it had a database.
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
 * The import runs only into an empty database, in one transaction, and checks the row counts
 * before it commits. The JSON files are only read: they stay where they are as the user's copy.
 * A file that cannot be parsed or is inconsistent is skipped and reported, never half-imported.
 */

/** Key of the `app_meta` row that records the import. */
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

export type LegacyImportResult =
  | { status: 'already_imported' | 'database_not_empty' | 'nothing_to_import' }
  | { status: 'imported'; counts: LegacyCounts; skipped: { path: string; reason: string }[] };

const sectionNames = ['details', 'preferences', 'bank-account'] as const;
const documentSchema = z.object({ schemaVersion: z.literal(1), synthetic: z.literal(true) }).catchall(z.json());
const inputsFileSchema = z.object({ inputs: z.array(inputSchema) });
const accountSchema = z.object({
  id: safeId,
  name: z.string(),
  currency: z.string(),
  openingBalanceCents: z.number().int().safe(),
  openingDate: z.string(),
  synthetic: z.boolean(),
});
const eventSchema = z.object({
  sequence: z.number().int().positive(),
  occurredAt: z.string(),
  type: z.string(),
  accountCount: z.number().int().nonnegative(),
  transactionCount: z.number().int().nonnegative(),
  synthetic: z.boolean(),
});
const ledgerFileSchema = z.object({
  updatedAt: z.string().default(''),
  accounts: z.array(accountSchema),
  transactions: z.array(transactionSchema),
  revision: z.number().int().nonnegative().default(0),
  events: z.array(eventSchema).default([]),
});
const connectionSchema = z.object({
  id: safeId,
  providerId: safeId,
  ref: z.string().min(1),
  createdAt: z.string(),
  cursor: z.string().nullable(),
  pollIntervalMs: z.number().int().positive().nullable(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: z.string().nullable().default(null),
  consecutiveFailures: z.number().int().nonnegative().default(0),
});
const connectionsFileSchema = z.object({ connections: z.array(connectionSchema) });
const queueFileSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
  pending: z.array(
    z.object({ seq: z.number().int().positive(), providerId: safeId, ref: z.string().min(1), receivedAt: z.string() }),
  ),
  seen: z.array(z.string()),
});
const usageFileSchema = z.object({ date: z.string(), attempts: z.number().int().nonnegative() });

type UserPlan = {
  id: string;
  sections: Record<(typeof sectionNames)[number], { synthetic: boolean }>;
  inputs: InputRecord[];
  ledger?: {
    revision: number;
    updatedAt: string;
    accounts: LedgerAccount[];
    transactions: LedgerTransaction[];
    events: LedgerEventRecord[];
  };
  connections: ConnectionRecord[];
  habits?: { goals: HabitGoal[]; checkins: HabitCheckin[] };
};
type Plan = {
  users: UserPlan[];
  queue?: { lastSeq: number; pending: QueuedWebhook[]; seen: { providerId: string; eventId: string }[] };
  usage?: { date: string; attempts: number };
  skipped: { path: string; reason: string }[];
};

const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const unique = (values: string[]) => new Set(values).size === values.length;

/** Parse one JSON file. Undefined when it does not exist; a broken file is recorded as skipped. */
async function load<Schema extends z.ZodType>(path: string, schema: Schema, skipped: Plan['skipped']) {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (!isMissing(error)) skipped.push({ path, reason: 'unreadable' });
    return undefined;
  }
  try {
    return schema.parse(JSON.parse(text)) as z.infer<Schema>;
  } catch {
    skipped.push({ path, reason: 'not valid JSON of the expected shape' });
    return undefined;
  }
}

/** Folder names that are safe IDs; an absent directory has none. */
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

/** A ledger file as rows, or a reason why it cannot be imported as a whole. */
function ledgerPlan(file: z.infer<typeof ledgerFileSchema>): UserPlan['ledger'] | string {
  const accountIds = new Set(file.accounts.map(account => account.id));
  if (accountIds.size !== file.accounts.length) return 'duplicate account IDs';
  if (!unique(file.transactions.map(movement => movement.id))) return 'duplicate movement IDs';
  if (file.transactions.some(movement => !accountIds.has(movement.accountId)))
    return 'a movement refers to an unknown account';
  if (!unique(file.events.map(event => String(event.sequence)))) return 'duplicate event sequences';
  const events = [...file.events].sort((a, b) => a.sequence - b.sequence).slice(-eventRetention);
  // The revision counter never falls behind the events it produced.
  const revision = Math.max(file.revision, events.at(-1)?.sequence ?? 0);
  return { revision, updatedAt: file.updatedAt, accounts: file.accounts, transactions: file.transactions, events };
}

/** Read everything the old layout holds into memory, validating file by file. */
async function readLegacy(sources: LegacySources): Promise<Plan> {
  const plan: Plan = { users: [], skipped: [] };
  const { skipped } = plan;
  const takenRefs = new Set<string>();
  if (sources.profileDir) {
    for (const id of await entries(sources.profileDir, 'directories')) {
      if (!safeId.safeParse(id).success) continue;
      const folder = join(sources.profileDir, id);
      const documents = await Promise.all(
        sectionNames.map(section => load(join(folder, `${section}.json`), documentSchema, skipped)),
      );
      if (documents.some(document => document === undefined)) {
        skipped.push({ path: folder, reason: 'not a complete profile (three section files are required)' });
        continue;
      }
      const [details, preferences, bankAccount] = documents as z.infer<typeof documentSchema>[];
      const user: UserPlan = {
        id,
        sections: { details, preferences, 'bank-account': bankAccount },
        inputs: [],
        connections: [],
      };
      const inputs = await load(join(folder, 'app-inputs.json'), inputsFileSchema, skipped);
      if (inputs && unique(inputs.inputs.map(input => input.id))) user.inputs = inputs.inputs;
      else if (inputs) skipped.push({ path: join(folder, 'app-inputs.json'), reason: 'duplicate input IDs' });
      const ledger = await load(join(folder, 'bank-ledger.json'), ledgerFileSchema, skipped);
      const rows = ledger && ledgerPlan(ledger);
      if (typeof rows === 'string') skipped.push({ path: join(folder, 'bank-ledger.json'), reason: rows });
      else user.ledger = rows;
      const connections = await load(join(folder, 'bank-connections.json'), connectionsFileSchema, skipped);
      for (const connection of connections?.connections ?? []) {
        const ref = `${connection.providerId}\n${connection.ref}`;
        if (takenRefs.has(ref) || user.connections.some(item => item.id === connection.id)) {
          skipped.push({
            path: join(folder, 'bank-connections.json'),
            reason: `duplicate connection ${connection.id}`,
          });
          continue;
        }
        takenRefs.add(ref);
        user.connections.push(connection);
      }
      plan.users.push(user);
    }
    const queue = await load(join(sources.profileDir, 'bank-webhook-queue.json'), queueFileSchema, skipped);
    if (queue) {
      // Old keys are `<providerId>:<eventId>`; a provider ID never contains a colon.
      const seen = [...new Set(queue.seen)]
        .filter(key => key.includes(':'))
        .slice(-seenRetention)
        .map(key => ({ providerId: key.slice(0, key.indexOf(':')), eventId: key.slice(key.indexOf(':') + 1) }));
      const refs = new Set<string>();
      const pending = [...queue.pending]
        .sort((a, b) => b.seq - a.seq)
        .filter(item => {
          // One pending notification per connection reference: the newest one.
          const ref = `${item.providerId}\n${item.ref}`;
          return !refs.has(ref) && Boolean(refs.add(ref));
        })
        .filter((item, index, all) => all.findIndex(other => other.seq === item.seq) === index)
        .reverse();
      plan.queue = { lastSeq: queue.lastSeq, pending, seen };
    }
  }
  if (sources.habitsDir) {
    const folder = join(sources.habitsDir, 'users');
    for (const name of await entries(folder, 'files')) {
      if (!name.endsWith('.json')) continue;
      const path = join(folder, name);
      const user = plan.users.find(item => item.id === name.slice(0, -'.json'.length));
      if (!user) {
        skipped.push({ path, reason: 'habits of a user without a profile' });
        continue;
      }
      const state = await load(path, stateSchema, skipped);
      if (!state) continue;
      const goalIds = new Set(state.goals.map(goal => goal.id));
      const consistent =
        goalIds.size === state.goals.length &&
        unique(state.checkins.map(checkin => checkin.id)) &&
        state.checkins.every(checkin => goalIds.has(checkin.goalId));
      if (consistent) user.habits = { goals: state.goals, checkins: state.checkins };
      else skipped.push({ path, reason: 'duplicate IDs or a check-in for an unknown habit' });
    }
    plan.usage = await load(join(sources.habitsDir, 'openai-usage.json'), usageFileSchema, skipped);
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

/** Rows the plan must add to each table, used to verify the import before it commits. */
function expectedCounts(plan: Plan) {
  const sum = (count: (user: UserPlan) => number) => plan.users.reduce((total, user) => total + count(user), 0);
  return {
    users: plan.users.length,
    profile_sections: plan.users.length * sectionNames.length,
    input_records: sum(user => user.inputs.length),
    bank_accounts: sum(user => user.ledger?.accounts.length ?? 0),
    bank_transactions: sum(user => user.ledger?.transactions.length ?? 0),
    bank_events: sum(user => user.ledger?.events.length ?? 0),
    bank_ledgers: sum(user => (user.ledger ? 1 : 0)),
    bank_connections: sum(user => user.connections.length),
    bank_webhook_queue: plan.queue?.pending.length ?? 0,
    bank_webhook_seen: plan.queue?.seen.length ?? 0,
    habit_goals: sum(user => user.habits?.goals.length ?? 0),
    habit_checkins: sum(user => user.habits?.checkins.length ?? 0),
    ai_usage: plan.usage ? 1 : 0,
  } satisfies LegacyCounts;
}

/** Insert one user's rows. Runs inside the import transaction. */
function writeUser(db: Database, user: UserPlan, now: string) {
  insertUser(db, user.id, now);
  for (const section of sectionNames) writeSection(db, user.id, section, user.sections[section], now);
  for (const input of user.inputs) insertInput(db, user.id, input);
  if (user.ledger) {
    for (const account of user.ledger.accounts) insertAccount(db, user.id, account);
    for (const movement of user.ledger.transactions) insertTransaction(db, user.id, movement);
    for (const event of user.ledger.events) insertEvent(db, user.id, event);
    writeLedgerHead(db, user.id, user.ledger.revision, user.ledger.updatedAt);
  }
  for (const connection of user.connections) insertConnection(db, user.id, connection);
  for (const goal of user.habits?.goals ?? []) insertGoal(db, user.id, goal);
  for (const checkin of user.habits?.checkins ?? []) insertCheckin(db, user.id, checkin);
}

/**
 * Import the old JSON runtime files when the database is empty and has never imported them.
 * All or nothing: a count that does not match what was read rolls the whole import back.
 */
export async function importLegacyJson(
  db: Database,
  sources: LegacySources,
  now = new Date(),
): Promise<LegacyImportResult> {
  const empty = () => countUsers(db) === 0;
  if (readMeta(db, legacyImportMarker) !== undefined) return { status: 'already_imported' };
  if (!empty()) return { status: 'database_not_empty' };
  const plan = await readLegacy(sources);
  if (!plan.users.length && !plan.queue && !plan.usage) return { status: 'nothing_to_import' };
  const expected = expectedCounts(plan);
  return db.transaction((): LegacyImportResult => {
    // Checked again under the write lock: another process may have imported or seeded meanwhile.
    if (readMeta(db, legacyImportMarker) !== undefined) return { status: 'already_imported' };
    if (!empty()) return { status: 'database_not_empty' };
    const before = tableCounts(db);
    const timestamp = now.toISOString();
    for (const user of plan.users) writeUser(db, user, timestamp);
    if (plan.queue) restoreWebhookQueue(db, plan.queue);
    if (plan.usage) writeUsage(db, habitsUsageScope, plan.usage.date, plan.usage.attempts);
    const after = tableCounts(db);
    for (const table of tables) {
      const added = after[table] - before[table];
      if (added !== expected[table])
        throw new Error(`Legacy import check failed for ${table}: read ${expected[table]}, stored ${added}`);
    }
    writeMeta(
      db,
      legacyImportMarker,
      JSON.stringify({ importedAt: timestamp, sources, counts: expected, skipped: plan.skipped.length }),
      now,
    );
    return { status: 'imported', counts: expected, skipped: plan.skipped };
  });
}
