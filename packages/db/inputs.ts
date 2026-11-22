import type { Database } from './database.ts';

/** Queries for a user's input records (`GET /users/:id/inputs`). */

/** An input record as stored: provenance in columns, the partial answers as one object. */
export type InputRecord = {
  id: string;
  source: string;
  observedAt: string;
  confirmed: boolean;
  synthetic: boolean;
  data: unknown;
};

type InputRow = {
  id: string;
  source: string;
  observedAt: string;
  confirmed: number;
  synthetic: number;
  data: string;
};

const columns = 'id, source, observed_at AS observedAt, confirmed, synthetic, data';

function fromRow(row: InputRow): InputRecord {
  return {
    id: row.id,
    source: row.source,
    observedAt: row.observedAt,
    confirmed: row.confirmed === 1,
    synthetic: row.synthetic === 1,
    data: JSON.parse(row.data),
  };
}

/** A user's inputs in the order they were first added. */
export function listInputs(db: Database, userId: string) {
  return db
    .all<InputRow>(`SELECT ${columns} FROM input_records WHERE user_id = ? ORDER BY row_id`, userId)
    .map(fromRow);
}

export function getInput(db: Database, userId: string, inputId: string) {
  const row = db.get<InputRow>(`SELECT ${columns} FROM input_records WHERE user_id = ? AND id = ?`, userId, inputId);
  return row && fromRow(row);
}

export function countInputs(db: Database, userId: string) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM input_records WHERE user_id = ?', userId)!.total;
}

export function insertInput(db: Database, userId: string, input: InputRecord) {
  db.run(
    `
      INSERT INTO input_records (user_id, id, source, observed_at, confirmed, synthetic, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    userId,
    input.id,
    input.source,
    input.observedAt,
    input.confirmed ? 1 : 0,
    input.synthetic ? 1 : 0,
    JSON.stringify(input.data),
  );
}

/** Replace an input in place, keeping its position. Returns false when it does not exist. */
export function updateInput(db: Database, userId: string, input: InputRecord) {
  const outcome = db.run(
    `
      UPDATE input_records
      SET source = ?, observed_at = ?, confirmed = ?, synthetic = ?, data = ?
      WHERE user_id = ? AND id = ?
    `,
    input.source,
    input.observedAt,
    input.confirmed ? 1 : 0,
    input.synthetic ? 1 : 0,
    JSON.stringify(input.data),
    userId,
    input.id,
  );
  return outcome.changes === 1;
}

/** Returns false when there was nothing to delete. */
export function deleteInput(db: Database, userId: string, inputId: string) {
  return db.run('DELETE FROM input_records WHERE user_id = ? AND id = ?', userId, inputId).changes === 1;
}
