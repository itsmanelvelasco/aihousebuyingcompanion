import { z } from 'zod';
import type { Metric } from '../../contracts/places.ts';
import { metric, municipalityCode } from '../../contracts/places.ts';
import { socrata, socrataQuery } from '../http.ts';
import { matchTownsByName } from '../names.ts';
import { withDerivedServices, withMetrics } from '../overlay.ts';
import type { SourceTown } from '../source.ts';
import { defineSource } from '../source.ts';
import { latestYear, numeric } from '../values.ts';

const dataset = '2dhj-q3r8';
const pageLimit = 5000;
export const retailUrl = `${socrata}/d/${dataset}`;

export type RetailRow = {
  municipi?: string;
  comarca?: string;
  establiments?: string;
  densitat_comercial_est_1?: string;
};

/**
 * Retail census figures per municipality. The census names municipalities without a code, so towns
 * are joined by name and comarca; a town without exactly one clean row gets no figure.
 */
export function retailMetrics(rows: RetailRow[], towns: SourceTown[], year: string) {
  const matched = matchTownsByName(towns, rows);
  return Object.fromEntries(
    towns.map(town => {
      const found = matched.get(town.code) ?? [];
      const row = found.length === 1 ? found[0] : undefined;
      const scope = {
        geography: 'municipality' as const,
        geographyName: town.name,
        observedAt: year,
        sourceUrl: retailUrl,
      };
      const count = numeric(row?.establiments);
      const density = numeric(row?.densitat_comercial_est_1);
      const metrics: Metric[] = [];
      if (count !== undefined && count >= 0) {
        metrics.push({ ...scope, kind: 'retail_establishments', unit: 'establishments', value: count });
      }
      if (density !== undefined && density >= 0) {
        metrics.push({ ...scope, kind: 'retail_per_1000', unit: 'establishments/1,000 residents', value: density });
      }
      return [town.code, metrics] as const;
    }),
  );
}

export default defineSource({
  id: 'gencat-cens-comercial',
  title: "Cens d'establiments comercials de Catalunya (CECC)",
  authority: "Generalitat de Catalunya, Departament d'Empresa i Treball",
  homepage: retailUrl,
  ttlMs: 24 * 60 * 60 * 1000,
  schema: z.record(municipalityCode, z.array(metric)),
  async fetch(context) {
    const year = await latestYear(context, dataset);
    const rows = await socrataQuery<RetailRow[]>(context, dataset, {
      $select: 'municipi,comarca,establiments,densitat_comercial_est_1',
      $where: `any=${year}`,
      $order: 'municipi',
      $limit: String(pageLimit),
    });
    if (!Array.isArray(rows) || rows.length < 500 || rows.length === pageLimit) {
      throw new Error('Incomplete retail census download');
    }
    return retailMetrics(rows, context.municipalities, year);
  },
  // The shop count in `services` follows from the census metric.
  overlay: (data, value) => withDerivedServices(withMetrics(data, value)),
});
