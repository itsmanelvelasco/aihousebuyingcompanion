import { readdir } from 'node:fs/promises';
import type { AnySource } from './source.ts';

const definitions = new URL('./definitions/', import.meta.url);

function isSource(value: unknown): value is AnySource {
  const candidate = value as Partial<AnySource> | undefined;
  return (
    typeof candidate?.id === 'string' &&
    typeof candidate.fetch === 'function' &&
    typeof candidate.schema?.parse === 'function'
  );
}

/**
 * Loads every source definition in a directory: one `.ts` file per source, default-exporting
 * `defineSource(...)`. Files whose name starts with `_` (templates, helpers) are skipped.
 */
export async function discoverSources(directory: URL = definitions): Promise<AnySource[]> {
  const files = (await readdir(directory)).filter(name => /^[^_].*\.ts$/.test(name)).sort();
  const found: AnySource[] = [];
  for (const name of files) {
    const source = ((await import(new URL(name, directory).href)) as { default?: unknown }).default;
    if (!isSource(source)) throw new Error(`${name} must default-export defineSource(...)`);
    if (found.some(known => known.id === source.id)) throw new Error(`Duplicate source id in ${name}`);
    found.push(source);
  }
  return found;
}

/** Every source shipped in `definitions/`, in file-name order. */
export const sources = await discoverSources();
