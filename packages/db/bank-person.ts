import type { Database } from './database.ts';

/**
 * Queries for a person's own banking: sealed credentials of consented connections, consents in
 * progress, statement uploads and imports, and the categories a person chose. Values arrive here
 * already sealed or hashed; this file never sees a bank credential or a consent state in clear.
 */

// ------------------------------------------------------------- credentials

export type CredentialRecord = {
  connectionId: string;
  providerId: string;
  cipher: string;
  createdAt: string;
  expiresAt: string | null;
};

const credentialColumns =
  'connection_id AS connectionId, provider_id AS providerId, cipher, created_at AS createdAt, expires_at AS expiresAt';

export function getCredential(db: Database, userId: string, connectionId: string) {
  return db.get<CredentialRecord>(
    `SELECT ${credentialColumns} FROM bank_credentials WHERE user_id = ? AND connection_id = ?`,
    userId,
    connectionId,
  );
}

/** Store the sealed credential of a connection, replacing the one it had (a renewed consent). */
export function putCredential(db: Database, userId: string, credential: CredentialRecord) {
  db.run(
    `
      INSERT INTO bank_credentials (user_id, connection_id, provider_id, cipher, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, connection_id) DO UPDATE SET
        cipher = excluded.cipher, created_at = excluded.created_at, expires_at = excluded.expires_at
    `,
    userId,
    credential.connectionId,
    credential.providerId,
    credential.cipher,
    credential.createdAt,
    credential.expiresAt,
  );
}

export function deleteCredential(db: Database, userId: string, connectionId: string) {
  db.run('DELETE FROM bank_credentials WHERE user_id = ? AND connection_id = ?', userId, connectionId);
}

export function deleteCredentialsOfUser(db: Database, userId: string) {
  return db.run('DELETE FROM bank_credentials WHERE user_id = ?', userId).changes;
}

/** When each sealed connection's consent ends, by connection id. */
export function credentialExpiries(db: Database, userId: string) {
  return new Map(
    db
      .all<{ connectionId: string; expiresAt: string | null }>(
        'SELECT connection_id AS connectionId, expires_at AS expiresAt FROM bank_credentials WHERE user_id = ?',
        userId,
      )
      .map(row => [row.connectionId, row.expiresAt]),
  );
}

// ----------------------------------------------------------------- consents

export type ConsentRecord = {
  userId: string;
  providerId: string;
  sessionHash: string;
  createdAt: string;
  expiresAt: string;
};

export function insertConsent(db: Database, stateHash: string, consent: ConsentRecord) {
  db.run(
    `
      INSERT INTO bank_consents (state_hash, user_id, provider_id, session_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    stateHash,
    consent.userId,
    consent.providerId,
    consent.sessionHash,
    consent.createdAt,
    consent.expiresAt,
  );
}

/**
 * Take a pending consent out of the table and return it: a state can be presented once, whoever
 * presents it and whatever happens next. Returns undefined when the state is unknown.
 */
export function takeConsent(db: Database, stateHash: string) {
  return db.get<ConsentRecord>(
    `
      DELETE FROM bank_consents WHERE state_hash = ?
      RETURNING user_id AS userId, provider_id AS providerId, session_hash AS sessionHash,
        created_at AS createdAt, expires_at AS expiresAt
    `,
    stateHash,
  );
}

/** A person's consents in progress, newest first. Never the state: only its hash is stored. */
export function listConsents(db: Database, userId: string, now: string) {
  return db.all<{ providerId: string; createdAt: string; expiresAt: string }>(
    `
      SELECT provider_id AS providerId, created_at AS createdAt, expires_at AS expiresAt
      FROM bank_consents WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC
    `,
    userId,
    now,
  );
}

/** Keep the newest `keep` consents of a person and drop the older ones. */
export function trimConsents(db: Database, userId: string, keep: number) {
  db.run(
    `
      DELETE FROM bank_consents WHERE user_id = ? AND state_hash NOT IN (
        SELECT state_hash FROM bank_consents WHERE user_id = ? ORDER BY created_at DESC, state_hash LIMIT ?
      )
    `,
    userId,
    userId,
    keep,
  );
}

export function deleteConsentsOfUser(db: Database, userId: string) {
  return db.run('DELETE FROM bank_consents WHERE user_id = ?', userId).changes;
}

/** Housekeeping: consents nobody finished in time. */
export function deleteExpiredConsents(db: Database, now: string) {
  return db.run('DELETE FROM bank_consents WHERE expires_at <= ?', now).changes;
}

// ----------------------------------------------------------- statement imports

export type PreviewRecord = { previewHash: string; csv: string; createdAt: string; expiresAt: string };

export function putPreview(db: Database, userId: string, preview: PreviewRecord) {
  db.run(
    `
      INSERT INTO bank_import_previews (user_id, preview_hash, csv, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, preview_hash) DO UPDATE SET
        csv = excluded.csv, created_at = excluded.created_at, expires_at = excluded.expires_at
    `,
    userId,
    preview.previewHash,
    preview.csv,
    preview.createdAt,
    preview.expiresAt,
  );
}

export function getPreview(db: Database, userId: string, previewHash: string) {
  return db.get<PreviewRecord>(
    `
      SELECT preview_hash AS previewHash, csv, created_at AS createdAt, expires_at AS expiresAt
      FROM bank_import_previews WHERE user_id = ? AND preview_hash = ?
    `,
    userId,
    previewHash,
  );
}

export function deletePreview(db: Database, userId: string, previewHash: string) {
  return (
    db.run('DELETE FROM bank_import_previews WHERE user_id = ? AND preview_hash = ?', userId, previewHash).changes === 1
  );
}

/** Keep the newest `keep` unconfirmed uploads of a person. */
export function trimPreviews(db: Database, userId: string, keep: number) {
  db.run(
    `
      DELETE FROM bank_import_previews WHERE user_id = ? AND preview_hash NOT IN (
        SELECT preview_hash FROM bank_import_previews WHERE user_id = ? ORDER BY created_at DESC, preview_hash LIMIT ?
      )
    `,
    userId,
    userId,
    keep,
  );
}

export function deleteExpiredPreviews(db: Database, now: string) {
  return db.run('DELETE FROM bank_import_previews WHERE expires_at <= ?', now).changes;
}

export type ImportRecord = {
  id: string;
  accountId: string;
  createdAt: string;
  rowCount: number;
  coveredFrom: string;
  coveredTo: string;
};

const importColumns =
  'id, account_id AS accountId, created_at AS createdAt, row_count AS rowCount, covered_from AS coveredFrom, covered_to AS coveredTo';

export function listImports(db: Database, userId: string) {
  return db.all<ImportRecord>(
    `SELECT ${importColumns} FROM bank_imports WHERE user_id = ? ORDER BY created_at DESC, id`,
    userId,
  );
}

export function getImport(db: Database, userId: string, importId: string) {
  return db.get<ImportRecord>(
    `SELECT ${importColumns} FROM bank_imports WHERE user_id = ? AND id = ?`,
    userId,
    importId,
  );
}

export function countImports(db: Database, userId: string) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM bank_imports WHERE user_id = ?', userId)!.total;
}

export function insertImport(db: Database, userId: string, record: ImportRecord) {
  db.run(
    `
      INSERT INTO bank_imports (user_id, id, account_id, created_at, row_count, covered_from, covered_to)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    userId,
    record.id,
    record.accountId,
    record.createdAt,
    record.rowCount,
    record.coveredFrom,
    record.coveredTo,
  );
}

export function linkImportRow(db: Database, userId: string, importId: string, transactionId: string) {
  db.run(
    `
      INSERT INTO bank_import_rows (user_id, import_id, transaction_id) VALUES (?, ?, ?)
      ON CONFLICT DO NOTHING
    `,
    userId,
    importId,
    transactionId,
  );
}

/** Movements that only this import brought: the ones to delete with it. */
export function movementsOnlyOf(db: Database, userId: string, importId: string) {
  return db
    .all<{ transactionId: string }>(
      `
        SELECT r.transaction_id AS transactionId FROM bank_import_rows r
        WHERE r.user_id = ? AND r.import_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM bank_import_rows o
            WHERE o.user_id = r.user_id AND o.transaction_id = r.transaction_id AND o.import_id <> r.import_id
          )
      `,
      userId,
      importId,
    )
    .map(row => row.transactionId);
}

/** Remove an import and its row links (the movements are deleted by the caller through the ledger). */
export function deleteImport(db: Database, userId: string, importId: string) {
  db.run('DELETE FROM bank_import_rows WHERE user_id = ? AND import_id = ?', userId, importId);
  return db.run('DELETE FROM bank_imports WHERE user_id = ? AND id = ?', userId, importId).changes === 1;
}

/** Forget that any import brought this movement (it was deleted by hand). */
export function unlinkMovement(db: Database, userId: string, transactionId: string) {
  db.run('DELETE FROM bank_import_rows WHERE user_id = ? AND transaction_id = ?', userId, transactionId);
}

// -------------------------------------------------------- chosen categories

/** True when the person chose the category of this movement, so a sync must keep it. */
export function categoryIsLocked(db: Database, userId: string, transactionId: string) {
  return (
    db.get<{ locked: number }>(
      'SELECT category_locked AS locked FROM bank_transactions WHERE user_id = ? AND id = ?',
      userId,
      transactionId,
    )?.locked === 1
  );
}

/** Set the category a person chose and lock it against later syncs. Returns false for an unknown movement. */
export function setChosenCategory(db: Database, userId: string, transactionId: string, category: string) {
  return (
    db.run(
      'UPDATE bank_transactions SET category = ?, category_locked = 1 WHERE user_id = ? AND id = ?',
      category,
      userId,
      transactionId,
    ).changes === 1
  );
}

/** A movement as the person's own pages list it: newest first, with whether they chose its category. */
export type ListedMovement = {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amountCents: number;
  currency: string;
  category: string;
  status: string;
  synthetic: boolean;
  categoryChosen: boolean;
};

/** One page of a person's movements, newest first, optionally within a date range. */
export function recentMovements(
  db: Database,
  userId: string,
  filter: { from?: string; to?: string },
  page: { limit: number; offset: number },
) {
  const conditions = ['user_id = ?'];
  const bound: string[] = [userId];
  if (filter.from !== undefined) {
    conditions.push('date >= ?');
    bound.push(filter.from);
  }
  if (filter.to !== undefined) {
    conditions.push('date <= ?');
    bound.push(filter.to);
  }
  const where = conditions.join(' AND ');
  const total = db.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM bank_transactions WHERE ${where}`,
    ...bound,
  )!.total;
  const rows = db.all<Omit<ListedMovement, 'synthetic' | 'categoryChosen'> & { synthetic: number; locked: number }>(
    `
      SELECT id, account_id AS accountId, date, description, amount_cents AS amountCents, currency, category,
        status, synthetic, category_locked AS locked
      FROM bank_transactions WHERE ${where} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?
    `,
    ...bound,
    page.limit,
    page.offset,
  );
  return {
    total,
    movements: rows.map(({ locked, synthetic, ...row }) => ({
      ...row,
      synthetic: synthetic === 1,
      categoryChosen: locked === 1,
    })) as ListedMovement[],
  };
}

// ------------------------------------------------- sessions and grants of an account

/** End every session of an account except one (the browser that just changed the password). */
export function deleteOtherSessions(db: Database, accountId: string, keepIdHash: string) {
  return db.run('DELETE FROM auth_sessions WHERE account_id = ? AND id_hash <> ?', accountId, keepIdHash).changes;
}

/** Ids of an account's grants that are not revoked yet. */
export function liveGrantIds(db: Database, accountId: string) {
  return db
    .all<{ id: string }>('SELECT id FROM oauth_grants WHERE account_id = ? AND revoked_at IS NULL', accountId)
    .map(row => row.id);
}
