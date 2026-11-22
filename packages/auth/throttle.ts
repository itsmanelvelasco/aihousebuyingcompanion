import {
  clearThrottle,
  countThrottles,
  deleteOldestThrottles,
  deleteStaleThrottles,
  readThrottle,
  writeThrottle,
} from '../db/auth.ts';
import type { Database } from '../db/database.ts';

/**
 * Counters behind the sign-in, sign-up and registration limits, kept in the `auth_throttle` table
 * so a restart does not reset them. Two kinds share the table:
 *
 * - a **budget**: so many events per fixed window (`spend`, `spent`);
 * - a **delay**: after a number of free failures, each further failure makes the key wait longer
 *   before its next try, doubling up to a maximum (`fail`, `waitSeconds`). The count is forgotten
 *   once the key has been quiet for a while.
 *
 * Nothing here decides what a key means; `accounts.ts` and `oauth.ts` choose the keys.
 */

export type DelayRule = {
  /** Failures that cost nothing. */
  free: number;
  /** The wait after the first failure past the free ones; it doubles with each further failure. */
  delayMs: number;
  maxDelayMs: number;
  /** The count starts again after this long without a failure. */
  quietMs: number;
};

/** Rows kept at most; past it the oldest go first. A row is about a hundred bytes. */
const defaultMaxRows = 50_000;

export function createThrottle(db: Database, now: () => Date, maxRows = defaultMaxRows) {
  let writes = 0;

  /** Every so many writes, check the size of the table and drop the oldest rows when it is over. */
  function bound() {
    if (++writes % 200 !== 0) return;
    prune();
  }

  function prune() {
    const total = countThrottles(db);
    if (total > maxRows) deleteOldestThrottles(db, total - Math.floor(maxRows * 0.9));
  }

  return {
    /** Events counted for `key` in its current window. */
    spent(key: string, windowMs: number) {
      const record = readThrottle(db, key);
      return record && Date.parse(record.windowStart) + windowMs > now().getTime() ? record.failures : 0;
    },

    /** Seconds until the window of `key` ends. */
    windowEndsIn(key: string, windowMs: number) {
      const record = readThrottle(db, key);
      if (!record) return 0;
      return Math.max(0, Math.ceil((Date.parse(record.windowStart) + windowMs - now().getTime()) / 1000));
    },

    /** Count one event for `key` and return the count of its window. */
    spend(key: string, windowMs: number) {
      return db.transaction(() => {
        const time = now();
        const previous = readThrottle(db, key);
        const fresh = !previous || Date.parse(previous.windowStart) + windowMs <= time.getTime();
        const failures = fresh ? 1 : previous.failures + 1;
        writeThrottle(db, key, {
          failures,
          windowStart: fresh ? time.toISOString() : previous.windowStart,
          lockedUntil: null,
        });
        bound();
        return failures;
      });
    },

    /** Seconds `key` must still wait before its next try; zero when it may try now. */
    waitSeconds(key: string) {
      const until = readThrottle(db, key)?.lockedUntil;
      if (!until) return 0;
      return Math.max(0, Math.ceil((Date.parse(until) - now().getTime()) / 1000));
    },

    /**
     * Count one failure for `key` under a delay rule. `windowStart` holds the time of the latest
     * failure for these keys. `straightToMax` skips the doubling: the key waits the maximum at once.
     */
    fail(key: string, rule: DelayRule, straightToMax = false) {
      db.transaction(() => {
        const time = now();
        const previous = readThrottle(db, key);
        const fresh = !previous || Date.parse(previous.windowStart) + rule.quietMs <= time.getTime();
        const failures = fresh ? 1 : previous.failures + 1;
        const past = failures - rule.free;
        const delay = straightToMax
          ? rule.maxDelayMs
          : past <= 0
            ? 0
            : Math.min(rule.maxDelayMs, rule.delayMs * 2 ** Math.min(past - 1, 30));
        writeThrottle(db, key, {
          failures,
          windowStart: time.toISOString(),
          lockedUntil: delay > 0 ? new Date(time.getTime() + delay).toISOString() : null,
        });
        bound();
      });
    },

    clear(key: string) {
      clearThrottle(db, key);
    },

    /** Housekeeping: drop rows that no longer matter, then bound the table. */
    sweep(olderThanMs: number) {
      deleteStaleThrottles(db, new Date(now().getTime() - olderThanMs).toISOString(), now().toISOString());
      prune();
    },
  };
}

export type Throttle = ReturnType<typeof createThrottle>;
