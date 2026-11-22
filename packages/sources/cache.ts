import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';

/** What the cache needs to know about a source. */
export type Cacheable<T> = { id: string; ttlMs: number; schema: z.ZodType<T> };

/**
 * `fresh`: a value younger than `ttlMs`. `stale`: a value older than that, still served.
 * `error`: the last refresh failed; the last good value, if any, is still served.
 * `never`: nothing has been fetched yet.
 */
export type CacheStatus = 'fresh' | 'stale' | 'error' | 'never';

export type CacheEntry<T> = {
  status: CacheStatus;
  /** The last value that passed the source's schema, or undefined. */
  value: T | undefined;
  /** ISO time of the last successful fetch. */
  fetchedAt: string | null;
  /** ISO time of the last attempt, successful or not. */
  lastAttemptAt: string | null;
  /** Why the last attempt failed, or null when it succeeded. */
  error: string | null;
  refreshing: boolean;
};

type Stored = { value?: unknown; fetchedAt: string | null; lastAttemptAt: string | null; error: string | null };

export type CacheOptions = {
  cacheDir: string;
  /** Downloads a source's raw value. May reject; the cache never passes that on to readers. */
  load: (source: Cacheable<unknown>) => Promise<unknown>;
  now?: () => Date;
  /** Upper bound for one whole refresh, including the source's own retries. */
  timeoutMs?: number;
  /** Minimum wait before retrying after a failed refresh. Capped by the source's `ttlMs`. */
  retryAfterMs?: number;
};

const empty: Stored = { fetchedAt: null, lastAttemptAt: null, error: null };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * A disk-backed, stale-while-revalidate cache with one JSON file per source.
 * Readers always get an answer at once and never see an exception from a refresh.
 */
export function createSourceCache(options: CacheOptions) {
  const { cacheDir, load, now = () => new Date(), timeoutMs = 60_000, retryAfterMs = 60_000 } = options;
  const entries = new Map<string, Stored>();
  const running = new Map<string, Promise<void>>();
  let revision = 0;
  const file = (id: string) => join(cacheDir, `${id}.json`);

  /** The in-memory record, read from disk on first use. Unreadable or invalid files count as absent. */
  function stored(source: Cacheable<unknown>): Stored {
    const known = entries.get(source.id);
    if (known) return known;
    let entry = empty;
    try {
      const raw = JSON.parse(readFileSync(file(source.id), 'utf8')) as Stored;
      const value = source.schema.safeParse(raw.value);
      const time = (text: unknown) => (typeof text === 'string' && !Number.isNaN(Date.parse(text)) ? text : null);
      if (value.success && time(raw.fetchedAt)) {
        entry = {
          value: value.data,
          fetchedAt: time(raw.fetchedAt),
          lastAttemptAt: time(raw.lastAttemptAt),
          error: typeof raw.error === 'string' ? raw.error : null,
        };
      }
    } catch {
      // No cache file yet, or one that cannot be trusted: start from nothing.
    }
    entries.set(source.id, entry);
    return entry;
  }

  /** Replaces the cache file in one step, so a crash never leaves a half-written value behind. */
  async function persist(id: string, entry: Stored) {
    const temporary = join(cacheDir, `${id}.${randomUUID()}.tmp`);
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ id, ...entry })}\n`, { flag: 'wx' });
      await rename(temporary, file(id));
    } catch {
      // The in-memory value still serves this process; the next refresh writes again.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  function age(entry: Stored, field: 'fetchedAt' | 'lastAttemptAt') {
    const at = entry[field];
    return at ? now().getTime() - Date.parse(at) : Number.POSITIVE_INFINITY;
  }

  function status(source: Cacheable<unknown>, entry: Stored): CacheStatus {
    if (entry.error) return 'error';
    if (!entry.fetchedAt) return 'never';
    return age(entry, 'fetchedAt') < source.ttlMs ? 'fresh' : 'stale';
  }

  /** Whether a background refresh should start now. Failed refreshes wait `retryAfterMs`. */
  function due(source: Cacheable<unknown>, entry: Stored) {
    if (entry.error) return age(entry, 'lastAttemptAt') >= Math.min(retryAfterMs, source.ttlMs);
    return age(entry, 'fetchedAt') >= source.ttlMs;
  }

  async function attempt(source: Cacheable<unknown>) {
    const previous = stored(source);
    let timer: NodeJS.Timeout | undefined;
    let next: Stored;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      const value = source.schema.parse(await Promise.race([Promise.resolve().then(() => load(source)), timeout]));
      const at = now().toISOString();
      next = { value, fetchedAt: at, lastAttemptAt: at, error: null };
      revision++;
    } catch (error) {
      // Keep the last good value and its fetch time; only the failure is recorded.
      next = { ...previous, lastAttemptAt: now().toISOString(), error: message(error) };
    } finally {
      clearTimeout(timer);
    }
    entries.set(source.id, next);
    await persist(source.id, next);
  }

  /** Refreshes now and resolves when done. Concurrent calls share one download. Never rejects. */
  function refresh<T>(source: Cacheable<T>): Promise<CacheEntry<T>> {
    let job = running.get(source.id);
    if (!job) {
      job = attempt(source)
        .catch(() => {})
        .finally(() => running.delete(source.id));
      running.set(source.id, job);
    }
    return job.then(() => peek(source));
  }

  /** The cached entry as it is, without starting anything. */
  function peek<T>(source: Cacheable<T>): CacheEntry<T> {
    const entry = stored(source);
    return {
      status: status(source, entry),
      value: entry.value as T | undefined,
      fetchedAt: entry.fetchedAt,
      lastAttemptAt: entry.lastAttemptAt,
      error: entry.error,
      refreshing: running.has(source.id),
    };
  }

  /** Stale-while-revalidate read: answers from the cache at once and refreshes in the background when due. */
  function get<T>(source: Cacheable<T>): CacheEntry<T> {
    if (!running.has(source.id) && due(source, stored(source))) void refresh(source);
    return peek(source);
  }

  return {
    get,
    peek,
    refresh,
    /** Increases whenever any cached value changes; lets readers memoise derived data. */
    revision: () => revision,
    /** Resolves when no refresh is running. */
    idle: async () => {
      while (running.size) await Promise.all(running.values());
    },
  };
}

export type SourceCache = ReturnType<typeof createSourceCache>;
