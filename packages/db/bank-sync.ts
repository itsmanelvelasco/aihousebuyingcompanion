import type { Database } from './database.ts';

/** Queries for bank connections and the persistent webhook queue of the sync engine. */

export type ConnectionRecord = {
  id: string;
  providerId: string;
  ref: string;
  createdAt: string;
  cursor: string | null;
  pollIntervalMs: number | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  consecutiveFailures: number;
};

export type QueuedWebhook = { seq: number; providerId: string; ref: string; receivedAt: string };

/** How many accepted notification IDs are remembered. */
export const seenRetention = 2000;

const connectionColumns = `
  id, provider_id AS providerId, ref, created_at AS createdAt, cursor, poll_interval_ms AS pollIntervalMs,
  last_sync_at AS lastSyncAt, last_error AS lastError, last_attempt_at AS lastAttemptAt,
  consecutive_failures AS consecutiveFailures
`;

/** A user's connections in the order they were linked. */
export function listConnections(db: Database, userId: string) {
  return db.all<ConnectionRecord>(
    `SELECT ${connectionColumns} FROM bank_connections WHERE user_id = ? ORDER BY row_id`,
    userId,
  );
}

export function getConnection(db: Database, userId: string, connectionId: string) {
  return db.get<ConnectionRecord>(
    `SELECT ${connectionColumns} FROM bank_connections WHERE user_id = ? AND id = ?`,
    userId,
    connectionId,
  );
}

/** Every connection of every user, for the engine's start-up index. */
export function allConnections(db: Database) {
  return db.all<ConnectionRecord & { userId: string }>(
    `SELECT user_id AS userId, ${connectionColumns} FROM bank_connections ORDER BY user_id, row_id`,
  );
}

export function countConnections(db: Database, userId: string) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM bank_connections WHERE user_id = ?', userId)!.total;
}

/** Who holds a bank reference, if anyone. */
export function connectionByRef(db: Database, providerId: string, ref: string) {
  return db.get<{ userId: string; connectionId: string }>(
    'SELECT user_id AS userId, id AS connectionId FROM bank_connections WHERE provider_id = ? AND ref = ?',
    providerId,
    ref,
  );
}

export function insertConnection(db: Database, userId: string, connection: ConnectionRecord) {
  db.run(
    `
      INSERT INTO bank_connections
        (user_id, id, provider_id, ref, created_at, cursor, poll_interval_ms, last_sync_at, last_error,
         last_attempt_at, consecutive_failures)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    userId,
    connection.id,
    connection.providerId,
    connection.ref,
    connection.createdAt,
    connection.cursor,
    connection.pollIntervalMs,
    connection.lastSyncAt,
    connection.lastError,
    connection.lastAttemptAt,
    connection.consecutiveFailures,
  );
}

/** Write the mutable fields of a connection (cursor, cadence and sync state). */
export function updateConnection(db: Database, userId: string, connection: ConnectionRecord) {
  db.run(
    `
      UPDATE bank_connections
      SET cursor = ?, poll_interval_ms = ?, last_sync_at = ?, last_error = ?, last_attempt_at = ?,
          consecutive_failures = ?
      WHERE user_id = ? AND id = ?
    `,
    connection.cursor,
    connection.pollIntervalMs,
    connection.lastSyncAt,
    connection.lastError,
    connection.lastAttemptAt,
    connection.consecutiveFailures,
    userId,
    connection.id,
  );
}

export function deleteConnection(db: Database, userId: string, connectionId: string) {
  return db.run('DELETE FROM bank_connections WHERE user_id = ? AND id = ?', userId, connectionId).changes === 1;
}

/** Notifications still waiting for a successful sync, in order of arrival. */
export function pendingWebhooks(db: Database) {
  return db.all<QueuedWebhook>(`
    SELECT seq, provider_id AS providerId, ref, received_at AS receivedAt
    FROM bank_webhook_queue
    ORDER BY seq
  `);
}

export function countPendingWebhooks(db: Database) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM bank_webhook_queue')!.total;
}

/** The highest sequence ever given to a notification, including ones already cleared; 0 at first. */
export function lastWebhookSeq(db: Database) {
  return db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'bank_webhook_queue'")?.seq ?? 0;
}

/**
 * Record a verified notification in one transaction. Returns false, and stores nothing, when its
 * event ID was already accepted. Notifications for one connection collapse into a single pending
 * row that takes a new, higher sequence.
 */
export function enqueueWebhook(
  db: Database,
  notification: { providerId: string; ref: string; eventId?: string; receivedAt: string },
) {
  const { providerId, ref, eventId, receivedAt } = notification;
  return db.transaction(() => {
    if (eventId !== undefined) {
      const fresh = db.run(
        `
          INSERT INTO bank_webhook_seen (provider_id, event_id) VALUES (?, ?)
          ON CONFLICT (provider_id, event_id) DO NOTHING
        `,
        providerId,
        eventId,
      );
      if (fresh.changes === 0) return false;
      trimSeenWebhooks(db);
    }
    db.run('DELETE FROM bank_webhook_queue WHERE provider_id = ? AND ref = ?', providerId, ref);
    db.run(
      'INSERT INTO bank_webhook_queue (provider_id, ref, received_at) VALUES (?, ?, ?)',
      providerId,
      ref,
      receivedAt,
    );
    return true;
  });
}

/** Keep only the newest `seenRetention` notification IDs. */
export function trimSeenWebhooks(db: Database) {
  db.run(
    `
      DELETE FROM bank_webhook_seen
      WHERE position <= (SELECT position FROM bank_webhook_seen ORDER BY position DESC LIMIT 1 OFFSET ?)
    `,
    seenRetention,
  );
}

/** Drop the notifications of a connection up to `throughSeq`: a sync that started after them covered them. */
export function clearWebhooks(db: Database, providerId: string, ref: string, throughSeq: number) {
  db.run('DELETE FROM bank_webhook_queue WHERE provider_id = ? AND ref = ? AND seq <= ?', providerId, ref, throughSeq);
}

export function countSeenWebhooks(db: Database) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM bank_webhook_seen')!.total;
}

/** Restore a queue written elsewhere, keeping its sequence numbers; only the legacy import needs it. */
export function restoreWebhookQueue(
  db: Database,
  queue: { lastSeq: number; pending: QueuedWebhook[]; seen: { providerId: string; eventId: string }[] },
) {
  for (const { providerId, eventId } of queue.seen)
    db.run(
      `
        INSERT INTO bank_webhook_seen (provider_id, event_id) VALUES (?, ?)
        ON CONFLICT (provider_id, event_id) DO NOTHING
      `,
      providerId,
      eventId,
    );
  for (const item of queue.pending)
    db.run(
      `
        INSERT INTO bank_webhook_queue (seq, provider_id, ref, received_at) VALUES (?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `,
      item.seq,
      item.providerId,
      item.ref,
      item.receivedAt,
    );
  // The counter must not fall behind sequences the previous process already handed out.
  const lastSeq = Math.max(queue.lastSeq, lastWebhookSeq(db));
  const updated = db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = 'bank_webhook_queue'", lastSeq);
  if (updated.changes === 0)
    db.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('bank_webhook_queue', ?)", lastSeq);
}
