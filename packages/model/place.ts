import type { Metric, Snapshot } from '../contracts/places.ts';
import type { Place } from '../contracts/planner.ts';
import { place } from '../contracts/planner.ts';
import { getTown } from '../places/data.ts';

/**
 * The place entity: one municipality node with its indicators and service counts.
 *
 * Every figure keeps its own source, date and geography. An absent figure is `null` and named in
 * `dataMissing`; it is never replaced by zero.
 */
type Indicator = NonNullable<Place['indicators']['population']>;

function metricOf(metrics: Metric[] | undefined, kind: string): Metric | undefined {
  // Compared as a string so kinds added to the snapshot later are read without a code change.
  return metrics?.find(metric => (metric.kind as string) === kind);
}

function indicator(metric: Metric | undefined): Indicator | null {
  if (!metric) return null;
  const { value, unit, geography, observedAt, sourceUrl } = metric;
  return { value, unit, geography, observedAt, sourceUrl };
}

/** Residents per km²: the published figure, else population ÷ area when both are published. */
function density(metrics: Metric[] | undefined): Indicator | null {
  const published = indicator(metricOf(metrics, 'population_density_per_km2'));
  if (published) return published;
  const population = metricOf(metrics, 'population');
  const area = metricOf(metrics, 'area_km2');
  if (!population || !area || !(area.value > 0)) return null;
  return {
    value: Math.round((population.value / area.value) * 10) / 10,
    unit: 'inhabitants per km2 (population divided by area)',
    geography: 'municipality',
    observedAt: population.observedAt,
    sourceUrl: population.sourceUrl,
  };
}

/**
 * Build the `Place` node for one municipality of the snapshot.
 *
 * Resale price and rent fall back to the comarca figure when the municipal one is not published;
 * the indicator is then marked `geography: 'comarca'` and the municipal gap stays in `dataMissing`.
 * Throws when the municipality is outside the snapshot.
 */
export function buildPlace(snapshot: Snapshot, municipalityCode: string): Place {
  const town = getTown(snapshot, municipalityCode);
  const municipal = snapshot.townMetrics[town.code];
  const comarca = snapshot.comarcaMetrics[town.comarca];
  const dataMissing: string[] = [];

  const withFallback = (kind: string, name: string) => {
    const own = indicator(metricOf(municipal, kind));
    if (own) return own;
    const proxy = indicator(metricOf(comarca, kind));
    dataMissing.push(proxy ? `${name} (municipal figure not published; comarca figure shown)` : name);
    return proxy;
  };
  const required = (value: Indicator | null, name: string) => {
    if (!value) dataMissing.push(name);
    return value;
  };

  const indicators = {
    population: required(indicator(metricOf(municipal, 'population')), 'population'),
    densityPerKm2: required(density(municipal), 'densityPerKm2'),
    foreignPopulationPercent: required(
      indicator(metricOf(municipal, 'foreign_population_percent')),
      'foreignPopulationPercent',
    ),
    resaleEurPerM2: withFallback('resale_eur_per_m2', 'resaleEurPerM2'),
    rentEurPerMonth: withFallback('rent_eur_per_month', 'rentEurPerMonth'),
  };

  // `services` is an optional snapshot section; a missing section or kind is unknown, not zero.
  const rawServices = (snapshot as { services?: Record<string, unknown> }).services?.[town.code];
  const services = place.shape.services.safeParse(
    Array.isArray(rawServices)
      ? rawServices.map(({ kind, count, observedAt, sourceUrl }) => ({ kind, count, observedAt, sourceUrl }))
      : undefined,
  );
  if (!services.success) dataMissing.push('services');

  return place.parse({
    municipalityCode: town.code,
    name: town.name,
    comarca: town.comarca,
    rural: town.rural.category,
    ruralEffectiveFrom: town.rural.effectiveFrom ?? null,
    centre: { latitude: town.centre.latitude, longitude: town.centre.longitude },
    indicators,
    services: services.success ? services.data : [],
    dataMissing,
  });
}
