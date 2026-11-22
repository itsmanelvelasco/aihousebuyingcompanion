import type { HomeSearchResult } from '../contracts/listings.ts';
import type { Database } from '../db/database.ts';
import type { UsageCap } from '../db/usage.ts';
import { takeUsage } from '../db/usage.ts';

/**
 * The spending guard of the paid listing search. `search_homes` needs no sign-in, so the server
 * itself bounds what it can cost: a cap on paid searches per day, a cap per minute, and a short
 * cache so that repeating a search is not a second charge.
 */
export type ListingBudgetLimits = {
  /** Paid provider searches per UTC day. Zero disables paid search. */
  dailyLimit: number;
  /** Paid provider searches per clock minute. */
  perMinuteLimit: number;
  /** How long a successful search is reused, in milliseconds. Zero disables the cache. */
  cacheTtlMs: number;
};

export const defaultListingLimits: ListingBudgetLimits = { dailyLimit: 200, perMinuteLimit: 12, cacheTtlMs: 600_000 };

type Search = HomeSearchResult['searches'][number];
export type BudgetRefusal = 'daily_limit' | 'minute_limit';

export interface ListingBudget {
  /** Reserve one paid search, or say which cap is full. A refused search costs nothing. */
  take(now: Date): BudgetRefusal | null;
  /** A recent successful result of the same search, if any. */
  cached(key: string, now: Date): Search | undefined;
  remember(key: string, search: Search, now: Date): void;
}

/** Counts one call against every cap or against none; returns the scope of the cap that is full. */
type Counter = (caps: readonly UsageCap[]) => string | null;

const dailyScope = 'listings-day';
const minuteScope = 'listings-minute';
const maxCached = 500;

function memoryCounter(): Counter {
  const rows = new Map<string, { period: string; attempts: number }>();
  return caps => {
    for (const cap of caps) {
      const row = rows.get(cap.scope);
      if ((row?.period === cap.period ? row.attempts : 0) >= cap.limit) return cap.scope;
    }
    for (const cap of caps) {
      const row = rows.get(cap.scope);
      rows.set(cap.scope, { period: cap.period, attempts: row?.period === cap.period ? row.attempts + 1 : 1 });
    }
    return null;
  };
}

/**
 * A budget whose counters live in the database when `db` is given (so a restart does not reset
 * them and every process sharing the file shares the caps), or in memory otherwise. The cache is
 * always in memory: losing it on a restart costs at most one repeated search per query.
 */
export function createListingBudget(limits: Partial<ListingBudgetLimits> = {}, db?: Database): ListingBudget {
  const { dailyLimit, perMinuteLimit, cacheTtlMs } = { ...defaultListingLimits, ...limits };
  const count: Counter = db ? caps => takeUsage(db, caps) : memoryCounter();
  const cache = new Map<string, { at: number; search: Search }>();
  return {
    take(now) {
      const iso = now.toISOString();
      const full = count([
        { scope: minuteScope, period: iso.slice(0, 16), limit: perMinuteLimit },
        { scope: dailyScope, period: iso.slice(0, 10), limit: dailyLimit },
      ]);
      return full === null ? null : full === dailyScope ? 'daily_limit' : 'minute_limit';
    },
    cached(key, now) {
      const entry = cache.get(key);
      if (!entry) return undefined;
      const age = now.getTime() - entry.at;
      if (age >= 0 && age < cacheTtlMs) return structuredClone(entry.search);
      cache.delete(key);
      return undefined;
    },
    remember(key, search, now) {
      if (cacheTtlMs <= 0) return;
      cache.delete(key);
      cache.set(key, { at: now.getTime(), search: structuredClone(search) });
      // Oldest first out, so the cache cannot grow without bound.
      for (const oldest of cache.keys()) {
        if (cache.size <= maxCached) break;
        cache.delete(oldest);
      }
    },
  };
}
