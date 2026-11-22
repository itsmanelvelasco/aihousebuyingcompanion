import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Policy, Snapshot } from '../contracts/places.ts';
import {
  metricKind,
  policy,
  relocationDataset,
  serviceKind,
  snapshotSchema,
  travelEstimateData,
} from '../contracts/places.ts';

const snapshotPath = new URL('../../data/towns.json', import.meta.url);
const policyPath = new URL('../../data/incentives.json', import.meta.url);
const travelEstimatePath = new URL('../../data/travel-estimates.json', import.meta.url);

function unique(ids: string[], context: string) {
  if (ids.length !== new Set(ids).size) throw new Error(`Duplicate ${context}`);
}

export function validateSnapshot(raw: unknown) {
  const snapshot = snapshotSchema.parse(raw);
  const townCodes = new Set(snapshot.municipalities.map(({ code }) => code));
  unique(
    snapshot.municipalities.map(({ code }) => code),
    'municipality',
  );
  unique(
    snapshot.schools.map(({ id }) => id),
    'school',
  );
  unique(
    snapshot.rail.stops.map(({ id }) => id),
    'rail stop',
  );

  for (const town of snapshot.municipalities) {
    const metrics = snapshot.townMetrics[town.code];
    if (!metrics?.some(({ kind }) => kind === 'population')) throw new Error(`Missing population for ${town.code}`);
    unique(
      metrics.map(({ kind }) => kind),
      `metric for ${town.code}`,
    );
    if (metrics.some(metric => metric.geography !== 'municipality' || metric.geographyName !== town.name)) {
      throw new Error(`Incorrect municipal metric scope for ${town.code}`);
    }
  }
  for (const code of Object.keys(snapshot.townMetrics)) {
    if (!townCodes.has(code)) throw new Error(`Orphan municipal metrics for ${code}`);
  }
  for (const [code, services] of Object.entries(snapshot.services ?? {})) {
    if (!townCodes.has(code)) throw new Error(`Orphan service counts for ${code}`);
    unique(
      services.map(({ kind }) => kind),
      `service kind for ${code}`,
    );
  }
  for (const [area, metrics] of Object.entries(snapshot.comarcaMetrics)) {
    unique(
      metrics.map(({ kind }) => kind),
      `metric for ${area}`,
    );
    if (metrics.some(metric => metric.geography !== 'comarca' || metric.geographyName !== area)) {
      throw new Error(`Incorrect comarca metric scope for ${area}`);
    }
  }

  const stops = new Set(snapshot.rail.stops.map(({ id }) => id));
  const services = new Set(snapshot.rail.trips.map(({ service }) => service));
  if (snapshot.rail.validFrom > snapshot.rail.validThrough) throw new Error('Invalid GTFS coverage dates');
  for (const [date, active] of Object.entries(snapshot.rail.dates)) {
    if (date < snapshot.rail.validFrom || date > snapshot.rail.validThrough || active.some(id => !services.has(id))) {
      throw new Error(`Invalid GTFS service calendar at ${date}`);
    }
  }
  for (const stop of snapshot.rail.stops) {
    if (!townCodes.has(stop.municipalityCode)) throw new Error(`Orphan station ${stop.id}`);
  }
  for (const trip of snapshot.rail.trips) {
    let previousDeparture = 0;
    for (const [stop, arrival, departure] of trip.calls) {
      if (!stops.has(stop) || arrival < previousDeparture || departure < arrival) {
        throw new Error(`Invalid GTFS call at ${stop}`);
      }
      previousDeparture = departure;
    }
  }
  return snapshot;
}

export function readPolicies(): Policy[] {
  const policies = z
    .array(policy)
    .nonempty()
    .parse(JSON.parse(readFileSync(policyPath, 'utf8')));
  unique(
    policies.map(({ id }) => id),
    'incentive ID',
  );
  for (const entry of policies) {
    if (
      entry.effectiveFrom > entry.effectiveThrough ||
      (entry.mechanism === 'grant' && !entry.municipalityCodes?.length)
    ) {
      throw new Error(`Invalid dates or geographic scope for ${entry.id}`);
    }
    unique(entry.municipalityCodes ?? [], `incentive geography for ${entry.id}`);
  }
  return policies;
}

export function combineRelocationData(snapshot: Snapshot, raw: unknown): Snapshot {
  // Parse only research fields: the bundled publicDataSnapshot must never overwrite official data.
  const relocation = relocationDataset.parse(raw);
  unique(
    relocation.municipalities.map(town => town.municipalityCode),
    'relocation municipality',
  );
  unique(
    relocation.municipalities.flatMap(town => town.opportunities.map(offer => offer.id)),
    'opportunity ID',
  );
  for (const research of relocation.municipalities) {
    const town = getTown(snapshot, research.municipalityCode);
    if (town.name !== research.name) throw new Error(`Relocation municipality name mismatch for ${town.code}`);
    if (research.opportunities.some(offer => offer.checkedOn > relocation.checkedOn)) {
      throw new Error(`Opportunity check date exceeds dataset date for ${town.code}`);
    }
  }
  return { ...snapshot, relocation };
}

export function loadData() {
  const snapshot = validateSnapshot(JSON.parse(readFileSync(snapshotPath, 'utf8')));
  const travelEstimates = travelEstimateData.parse(JSON.parse(readFileSync(travelEstimatePath, 'utf8')));
  for (const [code, estimates] of Object.entries(travelEstimates)) {
    getTown(snapshot, code);
    unique(
      estimates.map(({ destinationId }) => destinationId),
      `travel destination for ${code}`,
    );
  }
  const research = JSON.parse(readFileSync(new URL('../../data/relocat-pilot-data.json', import.meta.url), 'utf8'));
  return { snapshot: combineRelocationData(snapshot, research), policies: readPolicies(), travelEstimates };
}

export function snapshotInfo(snapshot: Snapshot) {
  return { version: snapshot.version, generatedOn: snapshot.generatedOn };
}

export function getTown(snapshot: Snapshot, code: string) {
  const town = snapshot.municipalities.find(town => town.code === code);
  if (!town)
    throw new Error(
      `Municipality ${code} is outside this snapshot. Use list_catalonia_municipalities for pilot coverage.`,
    );
  return town;
}

export function missingMetrics(snapshot: Snapshot, code: string) {
  const metrics = snapshot.townMetrics[code];
  return metricKind.options.filter(kind => !metrics.some(metric => metric.kind === kind));
}

/** Service kinds with no count for a municipality. Missing means unknown, never zero. */
export function missingServices(snapshot: Snapshot, code: string) {
  const services = snapshot.services?.[code] ?? [];
  return serviceKind.options.filter(kind => !services.some(service => service.kind === kind));
}

type ServiceCounts = NonNullable<Snapshot['services']>;

/**
 * Service counts that follow from data already in the snapshot: schools from the official school
 * directory, FGC rail stops from the timetable feed and shops from the retail census metric.
 * A kind is only reported when its source lists at least one facility or states a figure: the
 * directory keeps schools near pilot towns only, and the feed covers FGC lines, not all rail.
 */
export function derivedServices(snapshot: Pick<Snapshot, 'municipalities' | 'townMetrics' | 'schools' | 'rail'>) {
  const counts: ServiceCounts = {};
  for (const { code } of snapshot.municipalities) {
    const schools = snapshot.schools.filter(school => school.municipalityCode === code);
    const stops = snapshot.rail.stops.filter(stop => stop.municipalityCode === code);
    const retail = snapshot.townMetrics[code]?.find(metric => metric.kind === 'retail_establishments');
    counts[code] = [
      ...(schools.length
        ? [
            {
              kind: 'school' as const,
              count: schools.length,
              observedAt: schools[0].observedAt,
              sourceUrl: schools[0].sourceUrl,
            },
          ]
        : []),
      ...(stops.length
        ? [
            {
              kind: 'rail_station' as const,
              count: stops.length,
              observedAt: snapshot.rail.observedAt,
              sourceUrl: snapshot.rail.sourceUrl,
            },
          ]
        : []),
      ...(retail && Number.isInteger(retail.value)
        ? [{ kind: 'retail' as const, count: retail.value, observedAt: retail.observedAt, sourceUrl: retail.sourceUrl }]
        : []),
    ];
  }
  return counts;
}
