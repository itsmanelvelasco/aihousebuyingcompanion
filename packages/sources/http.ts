import { setTimeout as delay } from 'node:timers/promises';
import { madridDate } from '../places/geography.ts';
import type { SourceContext, SourceTown } from './source.ts';

/** The Generalitat open data portal (Socrata). */
export const socrata = 'https://analisi.transparenciacatalunya.cat';

type Fetch = typeof globalThis.fetch;
type RequestOptions = { fetch?: Fetch; timeoutMs?: number; retries?: number; retryDelayMs?: number };

/**
 * Builds the GET helper sources use: each attempt is cut off after `timeoutMs`, and a network
 * failure, a 429 or a 5xx answer is retried `retries` times. Anything else non-2xx rejects.
 */
export function createRequester(options: RequestOptions = {}) {
  const { fetch = globalThis.fetch, timeoutMs = 20_000, retries = 1, retryDelayMs = 1000 } = options;
  return async function request(url: string) {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retries;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (response.ok) return response;
        await response.body?.cancel();
        if (last || (response.status !== 429 && response.status < 500)) {
          throw Object.assign(new Error(`${response.status} from ${url}`), { final: true });
        }
      } catch (error) {
        if (last || (error as { final?: boolean }).final) throw error;
      }
      await delay(retryDelayMs);
    }
  };
}

type ContextOptions = RequestOptions & {
  municipalities: SourceTown[];
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

/** The context handed to every source's `fetch`. */
export function createSourceContext(options: ContextOptions): SourceContext {
  const request = createRequester(options);
  return {
    municipalities: options.municipalities,
    now: options.now ?? (() => new Date()),
    env: options.env ?? {},
    request,
    json: async <T>(url: string) => (await request(url)).json() as Promise<T>,
  };
}

/** A quoted SoQL list, for `column in (...)` filters. */
export function soqlList(items: string[]) {
  return items.map(item => `'${item.replaceAll("'", "''")}'`).join(',');
}

/** Rows of a Socrata dataset as string records. */
export function socrataQuery<T = Record<string, string | undefined>[]>(
  context: Pick<SourceContext, 'json'>,
  dataset: string,
  params: Record<string, string>,
) {
  return context.json<T>(`${socrata}/resource/${dataset}.json?${new URLSearchParams(params)}`);
}

/** The Madrid calendar date on which a Socrata dataset's rows last changed. */
export async function socrataUpdatedOn(context: Pick<SourceContext, 'json'>, dataset: string) {
  const meta = await context.json<{ rowsUpdatedAt?: number }>(`${socrata}/api/views/${dataset}.json`);
  if (typeof meta.rowsUpdatedAt !== 'number') throw new Error(`Missing update time for dataset ${dataset}`);
  return madridDate(new Date(meta.rowsUpdatedAt * 1000));
}
