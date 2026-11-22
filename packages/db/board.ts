import type { Database } from './database.ts';

/** Queries for the scripted board runs of `apps/board`, so a restart keeps the shared board. */

export type BoardRunRecord = {
  id: string;
  pairCode: string;
  persona: string;
  /** The scene state as parsed JSON; `apps/board` owns its shape. */
  state: unknown;
  revision: number;
  /** True for the one shared board everybody follows. */
  shared: boolean;
};

type RunRow = Omit<BoardRunRecord, 'state' | 'shared'> & { state: string; shared: number };

const runColumns = 'id, pair_code AS pairCode, persona, state, revision, shared';
const fromRow = (row: RunRow): BoardRunRecord => ({ ...row, state: JSON.parse(row.state), shared: row.shared === 1 });

/** A run that has not expired. The shared board never expires. */
export function getBoardRun(db: Database, runId: string, now: string) {
  const row = db.get<RunRow>(
    `SELECT ${runColumns} FROM board_runs WHERE id = ? AND (shared = 1 OR expires_at > ?)`,
    runId,
    now,
  );
  return row && fromRow(row);
}

export function boardRunIdByPairCode(db: Database, pairCode: string, now: string) {
  return db.get<{ id: string }>(
    'SELECT id FROM board_runs WHERE pair_code = ? AND (shared = 1 OR expires_at > ?)',
    pairCode,
    now,
  )?.id;
}

export function sharedBoardRunId(db: Database) {
  return db.get<{ id: string }>('SELECT id FROM board_runs WHERE shared = 1')?.id;
}

/**
 * Add a run. Expired rehearsals are removed first, then the oldest ones until fewer than `limit`
 * runs remain, so the table stays bounded; the shared board is never removed. A new shared run
 * takes over from the previous one.
 */
export function insertBoardRun(
  db: Database,
  run: BoardRunRecord,
  times: { now: string; expiresAt: string },
  limit: number,
) {
  db.transaction(() => {
    db.run('DELETE FROM board_runs WHERE shared = 0 AND expires_at <= ?', times.now);
    const excess = countBoardRuns(db) - (limit - 1);
    if (excess > 0)
      db.run(
        `
          DELETE FROM board_runs
          WHERE id IN (SELECT id FROM board_runs WHERE shared = 0 ORDER BY created_at, rowid LIMIT ?)
        `,
        excess,
      );
    if (run.shared) db.run('UPDATE board_runs SET shared = 0 WHERE shared = 1');
    db.run(
      `
        INSERT INTO board_runs (id, pair_code, persona, state, revision, shared, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      run.id,
      run.pairCode,
      run.persona,
      JSON.stringify(run.state),
      run.revision,
      run.shared ? 1 : 0,
      times.now,
      times.now,
      times.expiresAt,
    );
  });
}

/** Save a run after an action and push its expiry forward. */
export function updateBoardRun(
  db: Database,
  run: Pick<BoardRunRecord, 'id' | 'persona' | 'state' | 'revision'>,
  times: { now: string; expiresAt: string },
) {
  db.run(
    'UPDATE board_runs SET persona = ?, state = ?, revision = ?, updated_at = ?, expires_at = ? WHERE id = ?',
    run.persona,
    JSON.stringify(run.state),
    run.revision,
    times.now,
    times.expiresAt,
    run.id,
  );
}

export function pairCodeTaken(db: Database, pairCode: string) {
  return db.get('SELECT 1 FROM board_runs WHERE pair_code = ?', pairCode) !== undefined;
}

export function countBoardRuns(db: Database) {
  return db.get<{ total: number }>('SELECT COUNT(*) AS total FROM board_runs')!.total;
}
