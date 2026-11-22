import type { Database } from './database.ts';

/** Queries for users and their three profile documents. */

export function userExists(db: Database, userId: string) {
  return db.get('SELECT 1 FROM users WHERE id = ?', userId) !== undefined;
}

/** Every user ID, sorted. */
export function listUserIds(db: Database) {
  return db.all<{ id: string }>('SELECT id FROM users ORDER BY id').map(row => row.id);
}

export function countUsers(db: Database) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM users')!.total;
}

/** Add a user row. Returns false, and changes nothing, when the user already exists. */
export function insertUser(db: Database, userId: string, createdAt: string) {
  const outcome = db.run(
    'INSERT INTO users (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
    userId,
    createdAt,
  );
  return outcome.changes === 1;
}

/**
 * Whether a person is fictional: true only when every profile document they have says so. A person
 * without documents is not called fictional, because nothing states it.
 */
export function personIsSynthetic(db: Database, userId: string) {
  const row = db.get<{ total: number; fictional: number | null }>(
    'SELECT COUNT(*) AS total, SUM(synthetic) AS fictional FROM profile_sections WHERE user_id = ?',
    userId,
  )!;
  return row.total > 0 && row.fictional === row.total;
}

/** The stored flag of one profile document, or undefined when the user has no such section. */
export function sectionIsSynthetic(db: Database, userId: string, section: string) {
  const row = db.get<{ synthetic: number }>(
    'SELECT synthetic FROM profile_sections WHERE user_id = ? AND section = ?',
    userId,
    section,
  );
  return row === undefined ? undefined : row.synthetic === 1;
}

/** One profile document as parsed JSON, or undefined when the user has no such section. */
export function readSection(db: Database, userId: string, section: string): unknown {
  const row = db.get<{ document: string }>(
    'SELECT document FROM profile_sections WHERE user_id = ? AND section = ?',
    userId,
    section,
  );
  return row === undefined ? undefined : JSON.parse(row.document);
}

/** Insert or replace one profile document. */
export function writeSection(
  db: Database,
  userId: string,
  section: string,
  document: { synthetic: boolean },
  updatedAt: string,
) {
  db.run(
    `
      INSERT INTO profile_sections (user_id, section, synthetic, document, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, section) DO UPDATE SET
        synthetic = excluded.synthetic,
        document = excluded.document,
        updated_at = excluded.updated_at
    `,
    userId,
    section,
    document.synthetic ? 1 : 0,
    JSON.stringify(document),
    updatedAt,
  );
}
