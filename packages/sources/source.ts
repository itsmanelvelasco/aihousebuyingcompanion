import type { z } from 'zod';
import type { Municipality } from '../contracts/places.ts';
import type { loadData } from '../places/data.ts';

/** The data every tool reads: the same shape `loadData()` returns. */
export type LiveData = ReturnType<typeof loadData>;

/** The municipalities a source is asked about. Sources never invent or change official codes. */
export type SourceTown = Pick<Municipality, 'code' | 'name' | 'comarca'> & {
  /** The town centre, for sources that select facilities by distance. */
  centre?: Pick<Municipality['centre'], 'latitude' | 'longitude'>;
};

/** Everything a source may use to reach the outside world. Injected, so tests need no network. */
export type SourceContext = {
  municipalities: SourceTown[];
  now: () => Date;
  env: Record<string, string | undefined>;
  /** GET with a bounded timeout and retry. Rejects on network failure or a non-2xx answer. */
  request: (url: string) => Promise<Response>;
  /** `request` followed by JSON parsing. */
  json: <T>(url: string) => Promise<T>;
};

/** An environment variable a source reads, such as an API key. Most Catalan open data needs none. */
export type SourceEnv = { name: string; description: string; required?: boolean };

export type Source<T> = {
  /** Stable identifier, also the cache file name: lower-case letters, digits and hyphens. */
  id: string;
  title: string;
  /** The public body that publishes the data. */
  authority: string;
  homepage: string;
  /** How long a fetched value counts as fresh. Older values are served while a refresh runs. */
  ttlMs: number;
  env?: SourceEnv[];
  /** Validates a fetched value before it is cached, and a cached value before it is used. */
  schema: z.ZodType<T>;
  /** Downloads the raw value. May throw: the cache keeps the last good value. */
  fetch(context: SourceContext): Promise<unknown>;
  /** Returns `data` with this source's values laid over it. Must not mutate `data`. */
  overlay?(data: LiveData, value: T): LiveData;
};

/** A source whose value type is not known statically, as held by the registry. */
export type AnySource = Source<unknown>;

/** Declares one data source. Each file in `definitions/` default-exports the result. */
export function defineSource<T>(source: Source<T>): Source<T> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(source.id)) throw new Error(`Invalid source id: ${source.id}`);
  if (!Number.isFinite(source.ttlMs) || source.ttlMs <= 0) throw new Error(`Invalid ttlMs for ${source.id}`);
  if (!URL.canParse(source.homepage)) throw new Error(`Invalid homepage for ${source.id}`);
  return source;
}

/** Fetches a source once and validates the answer. Shared by the live cache and `data:refresh`. */
export async function runSource<T>(source: Source<T>, context: SourceContext): Promise<T> {
  const missing = (source.env ?? []).filter(variable => variable.required && !context.env[variable.name]);
  if (missing.length) {
    throw new Error(`Missing environment variable ${missing.map(variable => variable.name).join(', ')}`);
  }
  return source.schema.parse(await source.fetch(context));
}
