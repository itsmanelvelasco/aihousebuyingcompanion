import { z } from 'zod';
import type { Metric } from '../../contracts/places.ts';
import { metric, municipalityCode } from '../../contracts/places.ts';
import { withMetrics } from '../overlay.ts';
import type { SourceTown } from '../source.ts';
import { defineSource } from '../source.ts';

type EmexField = { id: string; v?: string; r?: string };
type EmexTable = { l?: string; r?: string; ff: { f: EmexField[] | EmexField } };
export type EmexProfile = { fitxes: { gg: { g: { tt: { t: EmexTable[] | EmexTable } }[] } } };

/** The municipal profile ("El municipi en xifres") of one municipality. */
export const emexProfileUrl = (code: string) => `https://api.idescat.cat/emex/v1/geo/${code}.json?lang=ca`;

/** EMEX indicator ids, checked against the live response on 2026-11-22. */
const indicators: { field: string; kind: Metric['kind']; unit: string }[] = [
  { field: 'f321', kind: 'population', unit: 'residents' },
  { field: 'f407', kind: 'rent_eur_per_month', unit: 'EUR/month' },
  { field: 'f406', kind: 'rent_contracts', unit: 'contracts' },
  { field: 'f308', kind: 'registered_unemployment', unit: 'people (annual average)' },
  { field: 'f377', kind: 'resident_social_security_affiliates', unit: 'people' },
  { field: 'f261', kind: 'area_km2', unit: 'km²' },
  { field: 'f262', kind: 'population_density_per_km2', unit: 'residents/km²' },
];
/** Population by nationality: foreign residents and the total they are a share of. */
const nationality = { foreign: 'f184', total: 'f263' };
/** A rent, surface or density of zero stands for "not published", not for a measurement. */
const positiveOnly = new Set<Metric['kind']>(['rent_eur_per_month', 'area_km2', 'population_density_per_km2']);

const oneOrMany = <T>(value: T | T[]) => (Array.isArray(value) ? value : [value]);

/** The municipal figure of an EMEX field: values come as "municipality,comarca,Catalonia". */
function municipalValue(field: EmexField | undefined) {
  const text = field?.v?.split(',')[0].trim();
  return text && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : undefined;
}

/** Turns one EMEX profile into dated municipal metrics. Unpublished figures are left out, never zeroed. */
export function emexMetrics(town: SourceTown, profile: EmexProfile): Metric[] {
  const tables = profile.fitxes.gg.g.flatMap(group => oneOrMany(group.tt.t));
  const scope = { geography: 'municipality' as const, geographyName: town.name };
  const fallbackUrl = emexProfileUrl(town.code);
  const metrics: Metric[] = [];
  for (const { field: fieldId, kind, unit } of indicators) {
    for (const table of tables) {
      const field = oneOrMany(table.ff.f).find(field => field.id === fieldId);
      const value = municipalValue(field);
      const observedAt = field?.r ?? table.r;
      if (value === undefined || value < 0 || !observedAt || (positiveOnly.has(kind) && value === 0)) continue;
      metrics.push({ ...scope, kind, unit, value, observedAt, sourceUrl: table.l ?? fallbackUrl });
      break;
    }
  }
  for (const table of tables) {
    const fields = oneOrMany(table.ff.f);
    const foreign = municipalValue(fields.find(field => field.id === nationality.foreign));
    const total = municipalValue(fields.find(field => field.id === nationality.total));
    if (foreign === undefined || !total || foreign < 0 || foreign > total || !table.r) continue;
    metrics.push({
      ...scope,
      kind: 'foreign_population_percent',
      unit: '% of residents',
      value: Math.round((foreign / total) * 1000) / 10,
      observedAt: table.r,
      sourceUrl: table.l ?? fallbackUrl,
    });
    break;
  }
  return metrics;
}

/** The public page of a municipality's figures, cited as the source of what the table states. */
export const emexPageUrl = (code: string) => `https://www.idescat.cat/emex/?id=${code}`;

type EmexIndicator = { id: string; r?: string; v?: string };
export type EmexAllTowns = {
  fitxes: { indicadors: { i: EmexIndicator[] | EmexIndicator }; cols: { col: { id: string }[] | { id: string } } };
};

const fields = [...new Set([...indicators.map(indicator => indicator.field), nationality.foreign, nationality.total])];
/** The same indicators for every municipality of Catalonia in one answer, one column per municipality. */
export const emexTableUrl = `https://api.idescat.cat/emex/v1/dades.json?i=${fields.join(',')}&tipus=mun&lang=ca`;

const published = (text: string | undefined) =>
  text !== undefined && /^-?\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : undefined;

/**
 * Turns the all-municipalities table into dated municipal metrics for the given towns. A town the
 * table has no column for gets nothing, and an unpublished figure is left out, never zeroed.
 */
export function emexTableMetrics(towns: SourceTown[], table: EmexAllTowns): Record<string, Metric[]> {
  const columns = new Map(oneOrMany(table.fitxes.cols.col).map((column, index) => [column.id, index]));
  const byField = new Map(
    oneOrMany(table.fitxes.indicadors.i).map(indicator => [
      indicator.id,
      { observedAt: indicator.r, values: (indicator.v ?? '').split(',') },
    ]),
  );
  const result: Record<string, Metric[]> = {};
  for (const town of towns) {
    const column = columns.get(town.code);
    if (column === undefined) continue;
    const scope = {
      geography: 'municipality' as const,
      geographyName: town.name,
      sourceUrl: emexPageUrl(town.code),
    };
    const read = (field: string) => {
      const entry = byField.get(field);
      return { value: published(entry?.values[column]), observedAt: entry?.observedAt };
    };
    const metrics: Metric[] = [];
    for (const { field, kind, unit } of indicators) {
      const { value, observedAt } = read(field);
      if (value === undefined || value < 0 || !observedAt || (positiveOnly.has(kind) && value === 0)) continue;
      metrics.push({ ...scope, kind, unit, value, observedAt });
    }
    const foreign = read(nationality.foreign);
    const total = read(nationality.total);
    if (
      foreign.value !== undefined &&
      total.value &&
      foreign.value >= 0 &&
      foreign.value <= total.value &&
      foreign.observedAt
    ) {
      metrics.push({
        ...scope,
        kind: 'foreign_population_percent',
        unit: '% of residents',
        value: Math.round((foreign.value / total.value) * 1000) / 10,
        observedAt: foreign.observedAt,
      });
    }
    if (metrics.length) result[town.code] = metrics;
  }
  return result;
}

export default defineSource({
  id: 'idescat-emex',
  title: 'El municipi en xifres (EMEX)',
  authority: "Institut d'Estadística de Catalunya (Idescat)",
  homepage: 'https://www.idescat.cat/emex/',
  ttlMs: 24 * 60 * 60 * 1000,
  schema: z.record(municipalityCode, z.array(metric).nonempty()),
  async fetch(context) {
    // One request covers every municipality; a profile per town would be hundreds of requests.
    const table = await context.json<EmexAllTowns>(emexTableUrl);
    const metrics = emexTableMetrics(context.municipalities, table);
    if (Object.keys(metrics).length < context.municipalities.length) {
      throw new Error('The municipal figures table does not cover every municipality');
    }
    return metrics;
  },
  overlay: withMetrics,
});
