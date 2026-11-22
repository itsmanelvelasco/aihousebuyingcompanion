import { loadData, validateSnapshot } from '../places/data.ts';
import { madridDate } from '../places/geography.ts';
import type { CacheStatus } from './cache.ts';
import { createSourceCache } from './cache.ts';
import { createSourceContext } from './http.ts';
import { sources as registeredSources } from './registry.ts';
import type { AnySource, LiveData } from './source.ts';
import { runSource } from './source.ts';

export type LiveDataOptions = {
  /** Directory of the per-source cache files, normally `data/cache`. */
  cacheDir: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Sources to keep live. Defaults to every definition discovered by the registry. */
  sources?: AnySource[];
  /** Loads the committed snapshot the live values are laid over. Defaults to `loadData`. */
  baseline?: () => LiveData;
  env?: Record<string, string | undefined>;
  /** Per-request timeout for source downloads. */
  requestTimeoutMs?: number;
  /** Retries per request after a network failure, a 429 or a 5xx answer. */
  retries?: number;
  retryDelayMs?: number;
  /** Upper bound for one whole source refresh. */
  refreshTimeoutMs?: number;
  /** Minimum wait before retrying a source whose refresh failed. */
  retryAfterMs?: number;
  /** How often `start()` looks for sources that are due. */
  checkIntervalMs?: number;
};

/** One line of the health page. */
export type SourceStatus = {
  id: string;
  title: string;
  authority: string;
  homepage: string;
  ttlMs: number;
  status: CacheStatus;
  fetchedAt: string | null;
  lastAttemptAt: string | null;
  /** Why the last refresh failed. The last good value, if any, is still served. */
  error: string | null;
  refreshing: boolean;
  /** Whether the cached value is part of `current()`, and if not, why. */
  applied: boolean;
  notAppliedReason: string | null;
  env: { name: string; description: string; required: boolean; set: boolean }[];
};

/**
 * Live data with a committed fallback. `current()` is synchronous and never throws because of a
 * source: it returns the committed snapshot with every usable cached value laid over it.
 */
export function createLiveData(options: LiveDataOptions) {
  const { now = () => new Date(), sources = registeredSources, env = process.env } = options;
  const base = (options.baseline ?? loadData)();
  const byId = new Map(sources.map(source => [source.id, source]));
  const context = createSourceContext({
    municipalities: base.snapshot.municipalities.map(({ code, name, comarca, centre }) => ({
      code,
      name,
      comarca,
      centre: { latitude: centre.latitude, longitude: centre.longitude },
    })),
    fetch: options.fetch,
    now,
    env,
    timeoutMs: options.requestTimeoutMs,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
  });
  const cache = createSourceCache({
    cacheDir: options.cacheDir,
    now,
    timeoutMs: options.refreshTimeoutMs,
    retryAfterMs: options.retryAfterMs,
    // Recompute the overlay as soon as a refresh lands, so no request pays for validating it.
    onSettled: () => void overlay(),
    load: async ({ id }) => {
      const source = byId.get(id);
      if (!source) throw new Error(`Unknown source ${id}`);
      return runSource(source, context);
    },
  });
  let timer: NodeJS.Timeout | undefined;
  let memo: { revision: number; data: LiveData; skipped: Map<string, string> } | undefined;

  /** Lays one cached value over `data`, or explains why it cannot be used. */
  function apply(data: LiveData, source: AnySource): { data: LiveData; skipped?: string } {
    const entry = cache.peek(source);
    if (entry.value === undefined || !entry.fetchedAt) return { data, skipped: 'Nothing cached yet' };
    if (!source.overlay) return { data, skipped: 'The source defines no overlay' };
    if (madridDate(new Date(entry.fetchedAt)) < base.snapshot.generatedOn) {
      return { data, skipped: 'The committed snapshot is newer than the cached value' };
    }
    try {
      const overlaid = source.overlay(data, entry.value);
      const codes = overlaid.snapshot.municipalities.map(town => town.code).join();
      if (codes !== data.snapshot.municipalities.map(town => town.code).join()) {
        throw new Error('A source may not change the list of municipalities');
      }
      return { data: { ...overlaid, snapshot: validateSnapshot(overlaid.snapshot) } };
    } catch (error) {
      return { data, skipped: `Overlay rejected: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Recomputes the overlay only when a cached value has changed. */
  function overlay() {
    if (memo?.revision === cache.revision()) return memo;
    const revision = cache.revision();
    const skipped = new Map<string, string>();
    let data = base;
    for (const source of sources) {
      const result = apply(data, source);
      data = result.data;
      if (result.skipped) skipped.set(source.id, result.skipped);
    }
    memo = { revision, data, skipped };
    return memo;
  }

  /** Starts a background refresh for every source that is due. */
  function revalidate() {
    for (const source of sources) cache.get(source);
  }

  function status(): SourceStatus[] {
    const { skipped } = overlay();
    return sources.map(source => {
      const entry = cache.peek(source);
      return {
        id: source.id,
        title: source.title,
        authority: source.authority,
        homepage: source.homepage,
        ttlMs: source.ttlMs,
        status: entry.status,
        fetchedAt: entry.fetchedAt,
        lastAttemptAt: entry.lastAttemptAt,
        error: entry.error,
        refreshing: entry.refreshing,
        applied: !skipped.has(source.id),
        notAppliedReason: skipped.get(source.id) ?? null,
        env: (source.env ?? []).map(variable => ({
          name: variable.name,
          description: variable.description,
          required: variable.required ?? false,
          set: Boolean(env[variable.name]),
        })),
      };
    });
  }

  return {
    /**
     * The data to serve right now, in the shape `loadData()` returns. Once `start()` has been
     * called, reading also triggers a background refresh of any source older than its `ttlMs`.
     */
    current(): LiveData {
      if (timer) revalidate();
      return overlay().data;
    },
    /**
     * Fetches every source that is not fresh and resolves when all have finished, successfully
     * or not. Call it once at server start. `force` refetches fresh sources too.
     */
    async warm({ force = false } = {}): Promise<SourceStatus[]> {
      // Read and apply what is already on disk before any download starts.
      overlay();
      // Each source refreshes on its own: a slow or failing one never holds back or undoes another.
      await Promise.all(
        sources.filter(source => force || cache.peek(source).status !== 'fresh').map(source => cache.refresh(source)),
      );
      return status();
    },
    /** Keeps sources fresh in the background until `stop()`. Does not keep the process alive. */
    start() {
      if (timer) return;
      const shortestTtl = Math.min(...sources.map(source => source.ttlMs), 60_000);
      timer = setInterval(revalidate, options.checkIntervalMs ?? shortestTtl);
      timer.unref();
      revalidate();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    /** Every source with its freshness, last fetch time and last error, for a health page. */
    status,
    /** Resolves when no refresh is running. Meant for tests and orderly shutdown. */
    idle: cache.idle,
  };
}

export type LiveDataService = ReturnType<typeof createLiveData>;
