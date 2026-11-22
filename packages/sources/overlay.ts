import type { z } from 'zod';
import type { Metric, serviceCount } from '../contracts/places.ts';
import { derivedServices } from '../places/data.ts';
import type { LiveData } from './source.ts';

type ServiceCount = z.infer<typeof serviceCount>;

/**
 * Lays `fresh` items over `current` ones: an item of a kind already present replaces it in place,
 * a new kind is appended, and kinds missing from `fresh` keep their current value.
 */
function mergeByKind<T extends { kind: string }>(current: T[], fresh: T[]) {
  const replaced = current.map(item => fresh.find(candidate => candidate.kind === item.kind) ?? item);
  return [...replaced, ...fresh.filter(item => !current.some(candidate => candidate.kind === item.kind))];
}

/** Merges by kind for every municipality in `codes` that `fresh` covers. Other codes are ignored. */
function mergeRecord<T extends { kind: string }>(
  codes: string[],
  current: Record<string, T[]>,
  fresh: Record<string, T[]>,
) {
  const merged: Record<string, T[]> = { ...current };
  for (const code of codes) {
    if (fresh[code]?.length) merged[code] = mergeByKind(current[code] ?? [], fresh[code]);
  }
  return merged;
}

/** Overlays municipal metrics by kind. Each metric keeps its own `observedAt` and `sourceUrl`. */
export function withMetrics(data: LiveData, fresh: Record<string, Metric[]>): LiveData {
  const { snapshot } = data;
  const codes = snapshot.municipalities.map(town => town.code);
  return { ...data, snapshot: { ...snapshot, townMetrics: mergeRecord(codes, snapshot.townMetrics, fresh) } };
}

/** Overlays service counts by kind. A kind the fresh value lacks keeps the baseline count. */
export function withServices(data: LiveData, fresh: Record<string, ServiceCount[]>): LiveData {
  const { snapshot } = data;
  const codes = snapshot.municipalities.map(town => town.code);
  return { ...data, snapshot: { ...snapshot, services: mergeRecord(codes, snapshot.services ?? {}, fresh) } };
}

/** Overlays comarca metrics by kind, only for comarques the snapshot already has. */
export function withComarcaMetrics(data: LiveData, fresh: Record<string, Metric[]>): LiveData {
  const { snapshot } = data;
  const comarques = [...new Set(snapshot.municipalities.map(town => town.comarca))];
  return { ...data, snapshot: { ...snapshot, comarcaMetrics: mergeRecord(comarques, snapshot.comarcaMetrics, fresh) } };
}

const derivedKinds = new Set<ServiceCount['kind']>(['school', 'rail_station', 'retail']);

/**
 * Recomputes the service counts that follow from other parts of the snapshot (schools, rail stops,
 * retail census) after one of those parts changed. Unlike directory counts these are exact: a kind
 * the snapshot no longer supports is removed instead of keeping its previous count.
 */
export function withDerivedServices(data: LiveData): LiveData {
  const { snapshot } = data;
  const derived = derivedServices(snapshot);
  const services = Object.fromEntries(
    snapshot.municipalities.map(({ code }) => {
      const fresh = derived[code] ?? [];
      const kept = (snapshot.services?.[code] ?? []).filter(
        entry => !derivedKinds.has(entry.kind) || fresh.some(candidate => candidate.kind === entry.kind),
      );
      return [code, mergeByKind(kept, fresh)] as const;
    }),
  );
  return { ...data, snapshot: { ...snapshot, services: { ...snapshot.services, ...services } } };
}
