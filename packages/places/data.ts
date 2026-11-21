import { readFileSync } from "node:fs";
import { z } from "zod";
import { metricKind, policy, snapshotSchema, travelEstimateData } from "../contracts/places.ts";
import type { Policy, Snapshot } from "../contracts/places.ts";

const snapshotPath = new URL("../../data/towns.json", import.meta.url);
const policyPath = new URL("../../data/incentives.json", import.meta.url);
const travelEstimatePath = new URL("../../data/travel-estimates.json", import.meta.url);

function unique(ids: string[], context: string) {
  if (ids.length !== new Set(ids).size) throw new Error(`Duplicate ${context}`);
}

export function validateSnapshot(raw: unknown) {
  const snapshot = snapshotSchema.parse(raw);
  const townCodes = new Set(snapshot.municipalities.map(({ code }) => code));
  unique(snapshot.municipalities.map(({ code }) => code), "municipality");
  unique(snapshot.schools.map(({ id }) => id), "school");
  unique(snapshot.rail.stops.map(({ id }) => id), "rail stop");

  for (const town of snapshot.municipalities) {
    const metrics = snapshot.townMetrics[town.code];
    if (!metrics?.some(({ kind }) => kind === "population")) throw new Error(`Missing population for ${town.code}`);
    unique(metrics.map(({ kind }) => kind), `metric for ${town.code}`);
    if (metrics.some(metric => metric.geography !== "municipality" || metric.geographyName !== town.name)) {
      throw new Error(`Incorrect municipal metric scope for ${town.code}`);
    }
  }
  for (const code of Object.keys(snapshot.townMetrics)) {
    if (!townCodes.has(code)) throw new Error(`Orphan municipal metrics for ${code}`);
  }
  for (const [area, metrics] of Object.entries(snapshot.comarcaMetrics)) {
    unique(metrics.map(({ kind }) => kind), `metric for ${area}`);
    if (metrics.some(metric => metric.geography !== "comarca" || metric.geographyName !== area)) {
      throw new Error(`Incorrect comarca metric scope for ${area}`);
    }
  }

  const stops = new Set(snapshot.rail.stops.map(({ id }) => id));
  const services = new Set(snapshot.rail.trips.map(({ service }) => service));
  if (snapshot.rail.validFrom > snapshot.rail.validThrough) throw new Error("Invalid GTFS coverage dates");
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
  const policies = z.array(policy).nonempty().parse(JSON.parse(readFileSync(policyPath, "utf8")));
  unique(policies.map(({ id }) => id), "incentive ID");
  for (const entry of policies) {
    if (entry.effectiveFrom > entry.effectiveThrough || (entry.mechanism === "grant" && !entry.municipalityCodes?.length)) {
      throw new Error(`Invalid dates or geographic scope for ${entry.id}`);
    }
    unique(entry.municipalityCodes ?? [], `incentive geography for ${entry.id}`);
  }
  return policies;
}

export function loadData() {
  const snapshot = validateSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const travelEstimates = travelEstimateData.parse(JSON.parse(readFileSync(travelEstimatePath, "utf8")));
  for (const [code, estimates] of Object.entries(travelEstimates)) {
    getTown(snapshot, code);
    unique(estimates.map(({ destinationId }) => destinationId), `travel destination for ${code}`);
  }
  return { snapshot, policies: readPolicies(), travelEstimates };
}

export function snapshotInfo(snapshot: Snapshot) {
  return { version: snapshot.version, generatedOn: snapshot.generatedOn };
}

export function getTown(snapshot: Snapshot, code: string) {
  const town = snapshot.municipalities.find(town => town.code === code);
  if (!town) throw new Error(`Municipality ${code} is outside this snapshot. Use list_catalonia_municipalities for pilot coverage.`);
  return town;
}

export function missingMetrics(snapshot: Snapshot, code: string) {
  const metrics = snapshot.townMetrics[code];
  return metricKind.options.filter(kind => !metrics.some(metric => metric.kind === kind));
}
