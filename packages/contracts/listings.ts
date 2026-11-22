import { z } from 'zod';
import { municipalityCode } from './places.ts';

export const homeSearchInput = z
  .object({
    municipalityCodes: z.array(municipalityCode).min(1).max(3),
    operation: z.enum(['buy', 'rent']),
    maxPriceEur: z.number().positive().max(50_000_000).optional(),
    minBedrooms: z.number().int().min(0).max(20).optional(),
    limitPerTown: z.number().int().min(1).max(5).default(3),
  })
  .strict();
export type HomeSearchInput = z.infer<typeof homeSearchInput>;
export const homeSearchResult = z.object({
  provider: z.literal('treg_google_search'),
  evidenceType: z.literal('search_index_examples'),
  searchedAt: z.iso.datetime(),
  requestedFilters: homeSearchInput,
  searches: z.array(
    z.object({
      municipalityCode,
      municipalityName: z.string(),
      query: z.string(),
      searchUrl: z.url(),
      /** `budget_exhausted`: the server's own spending cap refused the paid search; `searchUrl` still works. */
      status: z.enum(['ok', 'no_indexed_examples', 'provider_unavailable', 'provider_error', 'budget_exhausted']),
      errorCode: z
        .enum([
          'not_configured',
          'authentication',
          'quota_or_cost_limit',
          'rate_limited',
          'upstream_error',
          'daily_limit',
          'minute_limit',
        ])
        .nullable(),
      costUsd: z.number().nonnegative().nullable(),
      /** True when the result was reused from a recent identical search, at no cost. */
      cached: z.boolean().optional(),
      examples: z.array(
        z.object({
          provider: z.literal('idealista'),
          listingId: z.string(),
          url: z.url(),
          title: z.string(),
          snippet: z.string(),
          foundAt: z.iso.datetime(),
          municipalityCode: municipalityCode.nullable(),
          locationConfidence: z.literal('unknown'),
          availability: z.literal('unknown'),
          filtersVerified: z.literal(false),
        }),
      ),
    }),
  ),
  limitations: z.array(z.string()),
});
export type HomeSearchResult = z.infer<typeof homeSearchResult>;
