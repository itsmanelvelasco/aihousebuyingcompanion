import type { Database } from './database.ts';

/**
 * Persistent counters of paid calls, kept in `ai_usage`: one row per scope, holding the current
 * period and how many calls it has had. The `day` column holds the period key: a day
 * (`2026-11-22`) for a daily cap or a minute (`2026-11-22T10:05`) for a per-minute cap.
 */
export type UsageCap = { scope: string; period: string; limit: number };

/**
 * Count one call against every cap, or against none. Returns the scope of the first cap that is
 * already full, or null when the call was counted. One transaction, so two processes sharing the
 * database cannot both take the last call, and a restart does not reset the count.
 */
export function takeUsage(db: Database, caps: readonly UsageCap[]): string | null {
  return db.transaction(() => {
    for (const cap of caps) {
      const row = db.get<{ attempts: number }>(
        'SELECT attempts FROM ai_usage WHERE scope = ? AND day = ?',
        cap.scope,
        cap.period,
      );
      if ((row?.attempts ?? 0) >= cap.limit) return cap.scope;
    }
    for (const cap of caps) {
      // Earlier periods are forgotten, so the table stays one row per scope.
      db.run('DELETE FROM ai_usage WHERE scope = ? AND day <> ?', cap.scope, cap.period);
      db.run(
        `
          INSERT INTO ai_usage (scope, day, attempts) VALUES (?, ?, 1)
          ON CONFLICT (scope, day) DO UPDATE SET attempts = attempts + 1
        `,
        cap.scope,
        cap.period,
      );
    }
    return null;
  });
}
