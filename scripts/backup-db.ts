import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { storageConfig } from '../packages/config/env.ts';
import { integrityCheck, open } from '../packages/db/database.ts';
import { countUsers } from '../packages/db/profiles.ts';

/**
 * `npm run db:backup -- <file>`
 *
 * Copies the runtime database (`DATABASE_FILE`) into `<file>` with SQLite's online backup. It is
 * safe while the server runs: the source is opened read-only and the copy is a consistent
 * snapshot, including changes still in the write-ahead log. The copy is checked before the
 * command reports success, and an existing file is never overwritten.
 */
const [target] = process.argv.slice(2);
if (!target) {
  console.error('Usage: npm run db:backup -- <file>   (for example backups/relocat-2026-11-22.db)');
  process.exit(1);
}
const source = storageConfig().databaseFile;
const destination = resolve(target);
if (!existsSync(resolve(source))) {
  console.error(`There is no database at ${source}. Set DATABASE_FILE or start the server once.`);
  process.exit(1);
}
if (existsSync(destination)) {
  console.error(`${destination} already exists. Choose another name; backups are never overwritten.`);
  process.exit(1);
}

try {
  mkdirSync(dirname(destination), { recursive: true });
  const live = open(source, { readOnly: true });
  try {
    await live.backupTo(destination);
  } finally {
    live.close();
  }
  const copy = open(destination, { readOnly: true });
  try {
    const check = integrityCheck(copy);
    if (check !== 'ok') throw new Error(`The copy failed its integrity check: ${check}`);
    const users = copy.schemaVersion ? countUsers(copy) : 0;
    console.log(`Backed up ${source} to ${destination} (schema version ${copy.schemaVersion}, ${users} users).`);
  } finally {
    copy.close();
  }
} catch (error) {
  console.error(`Backup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
