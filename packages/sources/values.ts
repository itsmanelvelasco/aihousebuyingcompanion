import { socrataQuery } from './http.ts';
import type { SourceContext } from './source.ts';

/** A finite number from a published cell, or undefined when the cell holds anything else. */
export function numeric(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) return undefined;
  return Number(value);
}

/** Decimal-degree coordinates inside Catalonia's bounding box, or null. */
export function coordinates(latitude: unknown, longitude: unknown) {
  const lat = numeric(latitude);
  const lon = numeric(longitude);
  if (lat === undefined || lon === undefined || lat < 40 || lat > 43 || lon < 0 || lon > 4) return null;
  return { latitude: lat, longitude: lon };
}

/** The most recent year a Socrata dataset with an `any` column has rows for. */
export async function latestYear(context: Pick<SourceContext, 'json'>, dataset: string) {
  const rows = await socrataQuery(context, dataset, { $select: 'max(any) as latest' });
  const latest = Array.isArray(rows) ? rows[0]?.latest : undefined;
  if (!latest || !/^20\d{2}$/.test(latest)) throw new Error(`Missing latest year for dataset ${dataset}`);
  return latest;
}
