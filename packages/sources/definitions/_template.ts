/**
 * Template for a new data source. Copy this file to `definitions/<authority>-<dataset>.ts`
 * (no leading underscore) and it is discovered automatically: there is no registration step.
 *
 * Rules every source follows:
 * - Official publishers only, and every value carries its own `observedAt` and `sourceUrl`.
 * - Missing or unpublished figures are left out, never written as zero.
 * - Municipality codes stay six-digit strings; a source reports on the towns it is given and
 *   never adds or renames municipalities.
 * - `fetch` may throw. The cache then keeps serving the last good value and records the error.
 */
import { z } from 'zod';
import { metric, municipalityCode } from '../../contracts/places.ts';
import { withMetrics } from '../overlay.ts';
import { defineSource } from '../source.ts';

export default defineSource({
  // Lower-case, hyphenated, unique. Also the cache file name: data/cache/<id>.json.
  id: 'example-authority-dataset',
  title: 'Human-readable dataset title',
  authority: 'Publishing body',
  homepage: 'https://example.org/dataset',
  // How long a fetched value is fresh. After that it is still served while a refresh runs.
  ttlMs: 24 * 60 * 60 * 1000,
  // Only when the publisher needs a key. Document the variable in `.env.example` too.
  env: [{ name: 'EXAMPLE_API_KEY', description: 'Key for the example API', required: true }],
  // The value is validated with this schema before it is cached and again when read from disk.
  schema: z.record(municipalityCode, z.array(metric)),
  // `context.json` and `context.request` add a timeout and one retry; use them for all HTTP.
  async fetch(context) {
    const codes = context.municipalities.map(town => town.code).join(',');
    const response = await context.request(`https://example.org/api?codes=${codes}`);
    const rows = (await response.json()) as { code: string; value: number; year: string }[];
    return Object.fromEntries(
      context.municipalities.map(town => [
        town.code,
        rows
          .filter(row => row.code === town.code)
          .map(row => ({
            kind: 'population' as const,
            value: row.value,
            unit: 'residents',
            geography: 'municipality' as const,
            geographyName: town.name,
            observedAt: row.year,
            sourceUrl: 'https://example.org/dataset',
          })),
      ]),
    );
  },
  // How the cached value is laid over the committed snapshot. Use the helpers in `../overlay.ts`.
  overlay: withMetrics,
});
