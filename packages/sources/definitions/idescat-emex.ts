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

export default defineSource({
  id: 'idescat-emex',
  title: 'El municipi en xifres (EMEX)',
  authority: "Institut d'Estadística de Catalunya (Idescat)",
  homepage: 'https://www.idescat.cat/emex/',
  ttlMs: 24 * 60 * 60 * 1000,
  schema: z.record(municipalityCode, z.array(metric).nonempty()),
  async fetch(context) {
    const profiles = await Promise.all(
      context.municipalities.map(town => context.json<EmexProfile>(emexProfileUrl(town.code))),
    );
    return Object.fromEntries(
      context.municipalities.map((town, index) => [town.code, emexMetrics(town, profiles[index])]),
    );
  },
  overlay: withMetrics,
});
