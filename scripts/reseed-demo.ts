import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { accessConfig, storageConfig } from '../packages/config/env.ts';
import { safeId } from '../packages/contracts/ids.ts';
import { accountIdOfUser } from '../packages/db/auth.ts';
import type { Database } from '../packages/db/database.ts';
import { open } from '../packages/db/database.ts';
import { insertUser, readSection, userExists, writeSection } from '../packages/db/profiles.ts';
import { profileSchema, sections } from '../packages/profiles/store.ts';

/**
 * `npm run db:reseed-demo [-- --dry-run]`
 *
 * Brings the demo personas of the runtime database (`DATABASE_FILE`) up to date with the committed
 * fixtures in `data/users/`. The server copies a fixture only when the persona does not exist yet,
 * so a database that already has `user-001` to `user-004` keeps their old profile documents when
 * the fixtures change; this command replaces them.
 *
 * What it touches, and nothing else:
 *   - only the ids of the demo allowlist (`DEMO_USER_IDS`, default `user-001` to `user-004`);
 *   - only the three profile documents (`details`, `preferences`, `bank-account`) of each.
 * Saved answers, ledgers, bank connections and habits of a persona stay as they are. An id that
 * belongs to an account is a person, not a persona: it is skipped and reported, whatever the
 * allowlist says. It is safe while the server runs: all documents are written in one short
 * transaction, and the server reads them on the next request.
 */
export type ReseedOutcome = {
  updated: string[];
  created: string[];
  unchanged: string[];
  skipped: { id: string; reason: string }[];
};

export async function reseedDemo(
  db: Database,
  options: { fixtures: string; ids: string[]; dryRun?: boolean },
): Promise<ReseedOutcome> {
  const outcome: ReseedOutcome = { updated: [], created: [], unchanged: [], skipped: [] };
  const ready: { id: string; profile: ReturnType<typeof profileSchema.parse> }[] = [];
  for (const id of options.ids) {
    if (!safeId.safeParse(id).success) {
      outcome.skipped.push({ id, reason: 'not a valid id' });
      continue;
    }
    try {
      const documents = await Promise.all(
        sections.map(async section => [
          section,
          JSON.parse(await readFile(join(options.fixtures, id, `${section}.json`), 'utf8')),
        ]),
      );
      const profile = profileSchema.parse(Object.fromEntries(documents));
      if (profile.details.id !== id) throw new Error('details.id does not match the folder name');
      if (!sections.every(section => profile[section].synthetic === true))
        throw new Error('a fixture document is not marked synthetic');
      ready.push({ id, profile });
    } catch (error) {
      outcome.skipped.push({ id, reason: error instanceof Error ? error.message : 'unreadable fixture' });
    }
  }
  db.transaction(() => {
    const now = new Date().toISOString();
    for (const { id, profile } of ready) {
      // Checked inside the transaction: an account may have been created for this id a moment ago.
      if (accountIdOfUser(db, id) !== undefined) {
        outcome.skipped.push({ id, reason: 'belongs to an account; a person is never overwritten' });
        continue;
      }
      const exists = userExists(db, id);
      const same =
        exists &&
        sections.every(section => JSON.stringify(readSection(db, id, section)) === JSON.stringify(profile[section]));
      if (same) {
        outcome.unchanged.push(id);
        continue;
      }
      (exists ? outcome.updated : outcome.created).push(id);
      if (options.dryRun) continue;
      if (!exists) insertUser(db, id, now);
      for (const section of sections) writeSection(db, id, section, profile[section], now);
    }
  });
  return outcome;
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  const file = storageConfig().databaseFile;
  const fixtures = resolve('data/users');
  if (!existsSync(resolve(file))) {
    console.error(`There is no database at ${file}. Set DATABASE_FILE or start the server once.`);
    process.exit(1);
  }
  if (!existsSync(fixtures)) {
    console.error(`There are no fixtures at ${fixtures}. Run this from the repository root.`);
    process.exit(1);
  }
  // A running server holds the write lock only for moments; wait for it instead of failing.
  const db = open(file, { busyTimeoutMs: 5000 });
  try {
    const outcome = await reseedDemo(db, { fixtures, ids: accessConfig().demoUserIds, dryRun });
    const list = (ids: string[]) => (ids.length ? ids.join(', ') : 'none');
    console.log('%s in %s', dryRun ? 'Dry run: nothing was written' : 'Demo personas reseeded', file);
    console.log('  %s: %s', dryRun ? 'would update' : 'updated', list(outcome.updated));
    console.log('  %s: %s', dryRun ? 'would create' : 'created', list(outcome.created));
    console.log('  already up to date: %s', list(outcome.unchanged));
    for (const { id, reason } of outcome.skipped) console.warn('  skipped %s: %s', id, reason);
    if (outcome.skipped.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The demo personas could not be reseeded');
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
