import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { storageConfig } from '../packages/config/env.ts';
import { integrityCheck, open } from '../packages/db/database.ts';
import { countUsers } from '../packages/db/profiles.ts';

/**
 * `npm run db:backup -- <file>`
 *
 * Copies the runtime database (`DATABASE_FILE`) into `<file>` with SQLite's online backup. It is
 * safe while the server runs: the source is opened read-only and the copy is a consistent
 * snapshot, including changes still in the write-ahead log.
 *
 * The copy is written under a temporary name (`<file>.partial`), checked, and only then renamed to
 * `<file>`, so `<file>` either does not exist or is a complete, verified backup: one file, with no
 * `-wal` or `-shm` beside it. A run that fails removes what it wrote and exits with status 1; a
 * `.partial` left by a run that was killed is replaced by the next one. An existing `<file>` is
 * never overwritten.
 */
const [target] = process.argv.slice(2);
if (!target) {
  console.error('Usage: npm run db:backup -- <file>   (for example backups/relocat-2026-11-22.db)');
  process.exit(1);
}
const source = storageConfig().databaseFile;
const destination = resolve(target);
const partial = `${destination}.partial`;
if (!existsSync(resolve(source))) {
  console.error(`There is no database at ${source}. Set DATABASE_FILE or start the server once.`);
  process.exit(1);
}
if (existsSync(destination)) {
  console.error(`${destination} already exists. Choose another name; backups are never overwritten.`);
  process.exit(1);
}

/** Files SQLite may leave beside a database it opened. */
const sidecars = ['-wal', '-shm', '-journal'];
const remove = (file: string) => rmSync(file, { force: true });
const removePartial = () => {
  for (const suffix of ['', ...sidecars]) remove(`${partial}${suffix}`);
};

try {
  mkdirSync(dirname(destination), { recursive: true });
  // Whatever an interrupted run left under the temporary name is not a backup.
  removePartial();
  const live = open(source, { readOnly: true });
  try {
    await live.backupTo(partial);
  } finally {
    live.close();
  }
  const copy = open(partial, { readOnly: true });
  let summary: string;
  try {
    const check = integrityCheck(copy);
    if (check !== 'ok') throw new Error(`The copy failed its integrity check: ${check}`);
    const users = copy.schemaVersion ? countUsers(copy) : 0;
    summary = `schema version ${copy.schemaVersion}, ${users} users`;
  } finally {
    copy.close();
  }
  // Reading the copy made SQLite create an (empty) write-ahead log beside it. Nothing was written
  // through it, so the main file alone is the whole backup.
  for (const suffix of sidecars) remove(`${partial}${suffix}`);
  if (existsSync(destination)) throw new Error(`${destination} appeared while the backup ran`);
  renameSync(partial, destination);
  // Sidecar files of an older database that once had this name would be read as part of the new one.
  for (const suffix of sidecars) remove(`${destination}${suffix}`);
  console.log(`Backed up ${source} to ${destination} (${summary}).`);
} catch (error) {
  try {
    removePartial();
  } catch {
    // The failure below is what the operator needs to see.
  }
  console.error(`Backup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
