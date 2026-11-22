import { readSheet } from 'read-excel-file/node';
import { z } from 'zod';
import type { Metric } from '../../contracts/places.ts';
import { metric, municipalityCode } from '../../contracts/places.ts';
import { madridDate } from '../../places/geography.ts';
import { withComarcaMetrics, withMetrics } from '../overlay.ts';
import type { LiveData, SourceContext, SourceTown } from '../source.ts';
import { defineSource } from '../source.ts';
import { numeric } from '../values.ts';

type Scope = 'municipis' | 'ambits';
type Sheet = unknown[][];

/** The workbook of registered home sales for one year, by municipality or by territorial area. */
export const salesUrl = (scope: Scope, year: number) =>
  `https://habitatge.gencat.cat/web/.content/home/dades/estadistiques/01_Estadistiques_de_construccio_i_mercat_immobiliari/02_Compravenda_i_preu_de_venda/02_Compravendes_d_habitatges_registrades_i_el_preu_de_venda/${year}/Trimestrals_per_${scope}_${year}.xlsx`;

/** Column of the second-hand price per m²; the second-hand sales count sits in a fixed column too. */
const usedPriceColumn = { municipis: 17, ambits: 16 };

/**
 * The data rows of the annual sheet. Only the sheet named after the year, covering January to
 * December, is read: the quarterly sheets of a year in progress use other periods and layouts.
 */
export function annualRows(rows: Sheet, scope: Scope, year: number) {
  const column = usedPriceColumn[scope];
  if (
    !String(rows[1]?.[0]).toLowerCase().includes(`desembre ${year}`) ||
    !String(rows[3]?.[column - 1]).includes('Preu / m2') ||
    rows[4]?.[column] !== 'Habitatge usat'
  ) {
    throw new Error(`Unexpected annual ${scope} sales workbook layout`);
  }
  return rows.slice(5);
}

/**
 * Second-hand sales and prices from the two annual sheets. Municipal rows exist only for towns the
 * statistic covers (more than 2,000 residents); the others get no figure. Every comarca of the given
 * towns must have a reference price, or the whole value is rejected.
 */
export function salesMetrics(sheets: Record<Scope, Sheet>, towns: SourceTown[], year: number) {
  const municipal = annualRows(sheets.municipis, 'municipis', year);
  const areas = annualRows(sheets.ambits, 'ambits', year);
  const observedAt = String(year);
  const townMetrics = Object.fromEntries(
    towns.map(town => {
      // The workbook uses the five-digit INE code, without the Idescat control digit.
      const row = municipal.find(row => String(row[0]).padStart(5, '0') === town.code.slice(0, 5));
      const scope = {
        geography: 'municipality' as const,
        geographyName: town.name,
        observedAt,
        sourceUrl: salesUrl('municipis', year),
      };
      const sold = numeric(row?.[4]);
      const price = numeric(row?.[usedPriceColumn.municipis]);
      const metrics: Metric[] = [];
      if (sold !== undefined && sold >= 0) {
        metrics.push({ ...scope, kind: 'resale_transactions', unit: 'transactions', value: sold });
      }
      // A price of zero stands for "no sales to average", not for a measurement.
      if (price !== undefined && price > 0) {
        metrics.push({ ...scope, kind: 'resale_eur_per_m2', unit: 'EUR/m²', value: price });
      }
      return [town.code, metrics] as const;
    }),
  );
  const comarcaMetrics = Object.fromEntries(
    [...new Set(towns.map(town => town.comarca))].sort().map(comarca => {
      const value = numeric(areas.find(row => row[0] === comarca)?.[usedPriceColumn.ambits]);
      if (value === undefined || value <= 0) throw new Error(`Missing resale reference price for ${comarca}`);
      const entry: Metric = {
        kind: 'resale_eur_per_m2',
        value,
        unit: 'EUR/m²',
        geography: 'comarca',
        geographyName: comarca,
        observedAt,
        sourceUrl: salesUrl('ambits', year),
      };
      return [comarca, [entry]] as const;
    }),
  );
  return { year, townMetrics, comarcaMetrics };
}

async function annualSheet(context: SourceContext, scope: Scope, year: number): Promise<Sheet> {
  const response = await context.request(salesUrl(scope, year));
  return readSheet(Buffer.from(await response.arrayBuffer()), String(year));
}

const value = z.object({
  year: z.number().int().min(2020),
  townMetrics: z.record(municipalityCode, z.array(metric)),
  comarcaMetrics: z.record(z.string(), z.array(metric).nonempty()),
});

function withSales(data: LiveData, fresh: z.infer<typeof value>): LiveData {
  return withComarcaMetrics(withMetrics(data, fresh.townMetrics), fresh.comarcaMetrics);
}

export default defineSource({
  id: 'gencat-compravendes-habitatge',
  title: "Compravendes d'habitatges registrades i preu de venda",
  authority: "Generalitat de Catalunya, Agència de l'Habitatge de Catalunya",
  homepage: 'https://habitatge.gencat.cat/ca/dades/',
  // The annual sheet appears once a year; a weekly look is enough to pick it up.
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  env: [{ name: 'SALES_YEAR', description: 'Pins the annual sales workbook to one year (default: latest complete)' }],
  schema: value,
  async fetch(context) {
    const pinned = context.env.SALES_YEAR;
    const thisYear = Number(madridDate(context.now()).slice(0, 4));
    // Last year's annual sheet is published some months into the year; until then use the one before.
    const candidates = pinned
      ? [z.coerce.number().int().min(2020).max(thisYear).parse(pinned)]
      : [thisYear - 1, thisYear - 2];
    let failure: unknown;
    for (const year of candidates) {
      try {
        const [municipis, ambits] = await Promise.all([
          annualSheet(context, 'municipis', year),
          annualSheet(context, 'ambits', year),
        ]);
        return salesMetrics({ municipis, ambits }, context.municipalities, year);
      } catch (error) {
        // Only "not published yet" moves on to the year before; a network failure must not downgrade.
        if (!/^404 from|Sheet not found|Unexpected annual/.test(error instanceof Error ? error.message : ''))
          throw error;
        failure = error;
      }
    }
    throw failure;
  },
  overlay: withSales,
});
