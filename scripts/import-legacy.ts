import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { storageConfig } from '../packages/config/env.ts';
import { DatabaseBusyError, open } from '../packages/db/database.ts';
import { importedLegacyFiles, importLegacyFiles } from '../packages/db/legacy.ts';

/**
 * `npm run db:import-legacy -- <profileDir> [habitsDir]`
 *
 * Imports the JSON files an earlier version of ReloCat wrote (see `packages/db/legacy.ts` for the
 * layout) into the runtime database (`DATABASE_FILE`). The server does this by itself on its first
 * start with an empty database; this command is for what that start could not import, for example a
 * `bank-ledger.json` that was truncated and has been repaired since.
 *
 * It imports only the files that are not recorded as imported, adds only records whose IDs are not
 * in the database yet, and overwrites nothing, so it is safe to run again and while the server
 * runs. Without arguments it reads `PROFILE_DATA_DIR` and `HABITS_DATA_DIR`. The JSON files are
 * only read. Exit status: 0 when every file found is in the database, 2 when some were skipped.
 */
const [profileArgument, habitsArgument] = process.argv.slice(2);
if (profileArgument === '--help' || profileArgument === '-h') {
  console.log('Usage: npm run db:import-legacy -- <profileDir> [habitsDir]');
  process.exit(0);
}
const storage = storageConfig();
const sources = {
  profileDir: resolve(profileArgument ?? storage.legacyProfileDir),
  habitsDir: resolve(habitsArgument ?? storage.legacyHabitsDir),
};
if (!existsSync(sources.profileDir) && !existsSync(sources.habitsDir)) {
  console.error(`Neither ${sources.profileDir} nor ${sources.habitsDir} exists. Nothing to import.`);
  process.exit(1);
}

const db = open(storage.databaseFile);
try {
  const outcome = await importLegacyFiles(db, sources);
  if (outcome.status !== 'imported') {
    console.log('No legacy JSON files were found in %s or %s.', sources.profileDir, sources.habitsDir);
  } else {
    const rows = Object.entries(outcome.counts).filter(([, count]) => count > 0);
    console.log(
      'Imported %d file(s) into %s%s',
      outcome.imported.length,
      storage.databaseFile,
      rows.length ? `: ${rows.map(([table, count]) => `${count} ${table}`).join(', ')}.` : '.',
    );
    for (const file of outcome.imported) console.log('  imported: %s', file);
    if (outcome.alreadyImported.length)
      console.log('%d file(s) were imported earlier and were not read again.', outcome.alreadyImported.length);
    for (const { path, reason } of outcome.skipped) console.warn('  not imported: %s (%s)', path, reason);
    if (outcome.skipped.length) {
      console.warn('%d file(s) were not imported. Repair them and run this command again.', outcome.skipped.length);
      process.exitCode = 2;
    }
  }
  console.log('%d legacy file(s) are recorded as imported in total.', importedLegacyFiles(db).length);
} catch (error) {
  if (error instanceof DatabaseBusyError) console.error('The database is busy. Nothing was imported; try again.');
  else console.error('The import failed and nothing was imported: %s', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
