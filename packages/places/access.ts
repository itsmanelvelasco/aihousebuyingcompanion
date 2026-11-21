import type { Municipality, RailRoute, RecommendationInput, SchoolJourney, SchoolQuery, Snapshot, TransportQuery } from "../contracts/places.ts";
import { getTown, snapshotInfo } from "./data.ts";
import { distanceKm } from "./geography.ts";

const MAX_STATION_DISTANCE_KM = 1.8;
const MAX_SCHOOL_WALK_KM = 2;
const SCHOOL_SEARCH_RADIUS_KM = 15;

export function timeSeconds(clock: string) {
  const [hours, minutes, seconds = 0] = clock.split(":").map(Number);
  return (hours * 60 + minutes) * 60 + seconds;
}

function clock(seconds: number) {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2, "0")).join(":");
}

function walkMinutes(km: number) {
  // Screening estimate: stretch the straight-line distance by 25%, then assume 4 km/h.
  return Math.ceil(km * 1.25 / 4 * 60);
}

export function railwayCoverage(snapshot: Snapshot, date: string) {
  return date >= snapshot.rail.validFrom && date <= snapshot.rail.validThrough;
}

function findRailRoutes(snapshot: Snapshot, date: string, originIds: Set<string>, destinationIds: Set<string>) {
  const feed = snapshot.rail;
  const stops = new Map(feed.stops.map(stop => [stop.id, stop]));
  const active = new Set(feed.dates[date] ?? []);
  const routes: RailRoute[] = [];
  for (const trip of feed.trips) {
    if (!active.has(trip.service)) continue;
    let fromDeparture: number | undefined;
    let origin: string | undefined;
    for (const [stop, arrival, departure] of trip.calls) {
      if (destinationIds.has(stop) && origin && fromDeparture !== undefined && origin !== stop) {
        routes.push({
          line: trip.line,
          from: stops.get(origin)!,
          to: stops.get(stop)!,
          departure: clock(fromDeparture),
          arrival: clock(arrival),
          durationMinutes: Math.ceil((arrival - fromDeparture) / 60),
          observedAt: feed.observedAt,
          sourceUrl: feed.sourceUrl,
        });
      }
      if (originIds.has(stop)) {
        fromDeparture = departure;
        origin = stop;
      }
    }
  }
  return routes.sort((a, b) => timeSeconds(a.departure) - timeSeconds(b.departure) || a.durationMinutes - b.durationMinutes);
}

function stationIds(snapshot: Snapshot, town: Municipality, maximumKm = Infinity) {
  return new Set(snapshot.rail.stops
    .filter(stop => stop.municipalityCode === town.code && distanceKm(stop, town.centre) <= maximumKm)
    .map(stop => stop.id));
}

function departureWindow(routes: RailRoute[], query: Pick<TransportQuery, "departFrom" | "departBy">) {
  const from = query.departFrom ? timeSeconds(query.departFrom) : 0;
  const through = query.departBy ? timeSeconds(query.departBy) : Infinity;
  if (from > through) throw new Error("departFrom must be at or before departBy within the service day.");
  return routes.filter(route => timeSeconds(route.departure) >= from && timeSeconds(route.departure) <= through);
}

export function getTransportOptions(snapshot: Snapshot, query: TransportQuery) {
  const from = getTown(snapshot, query.municipalityCode);
  const to = getTown(snapshot, query.destinationCode);
  if (from.code === to.code) throw new Error("Choose a different destination municipality for an inter-town rail journey.");
  const covered = railwayCoverage(snapshot, query.travelDate);
  const routes = departureWindow(findRailRoutes(snapshot, query.travelDate, stationIds(snapshot, from), stationIds(snapshot, to)), query);
  const limitations = ["Direct FGC RL1/RL2 timetabled services only. Check the operator for disruption, walking access and request stops."];
  if (!covered) limitations.push(`Cached schedules cover ${snapshot.rail.validFrom} through ${snapshot.rail.validThrough}.`);
  return {
    snapshot: snapshotInfo(snapshot),
    municipalityCode: from.code,
    destinationCode: to.code,
    travelDate: query.travelDate,
    scheduleCoverage: covered ? "covered" as const : "outside_snapshot" as const,
    totalDepartures: routes.length,
    routes: routes.slice(0, query.limit ?? 6),
    limitations,
  };
}

export function bestCommute(
  snapshot: Snapshot, from: Municipality, to: Municipality, date: string,
  query: NonNullable<RecommendationInput["commute"]>,
) {
  if (from.code === to.code) return undefined;
  const routes = departureWindow(findRailRoutes(snapshot, date, stationIds(snapshot, from, MAX_STATION_DISTANCE_KM),
    stationIds(snapshot, to, MAX_STATION_DISTANCE_KM)), query);
  return routes.map(rail => ({
    rail,
    estimatedMinutes: rail.durationMinutes + walkMinutes(distanceKm(from.centre, rail.from)) + walkMinutes(distanceKm(to.centre, rail.to)),
  })).sort((a, b) => a.estimatedMinutes - b.estimatedMinutes)[0];
}

export function schoolJourneys(snapshot: Snapshot, town: Municipality, date: string, arriveBy?: string): SchoolJourney[] {
  const deadline = timeSeconds(arriveBy ?? "09:00");
  const originIds = stationIds(snapshot, town, MAX_STATION_DISTANCE_KM);
  const earliest = 6.5 * 3600;
  const nearby = new Map<string, SchoolJourney>();
  const railJourneys: SchoolJourney[] = [];

  for (const school of snapshot.schools) {
    const sameTown = school.municipalityCode === town.code;
    const km = school.coordinates ? distanceKm(town.centre, school.coordinates) : null;
    if (!sameTown && (km === null || km > SCHOOL_SEARCH_RADIUS_KM)) continue;

    const straightLineKm = km === null ? null : Math.round(km * 100) / 100;
    const walkable = km !== null && km <= MAX_SCHOOL_WALK_KM;
    nearby.set(school.id, {
      school, straightLineKm,
      mode: walkable ? "estimated_walk" : "unknown",
      estimatedMinutes: walkable ? walkMinutes(km) : null,
    });

    if (!school.coordinates || !originIds.size) continue;
    const schoolPoint = school.coordinates;
    const destinationIds = new Set(snapshot.rail.stops
      .filter(stop => stop.municipalityCode !== town.code && stop.municipalityCode === school.municipalityCode
        && distanceKm(stop, schoolPoint) <= MAX_STATION_DISTANCE_KM).map(stop => stop.id));
    const routes = findRailRoutes(snapshot, date, originIds, destinationIds);
    const viable = routes.flatMap(rail => {
      const walkToSchool = walkMinutes(distanceKm(rail.to, schoolPoint));
      if (timeSeconds(rail.departure) < earliest || timeSeconds(rail.arrival) + walkToSchool * 60 > deadline) return [];
      return [{ rail, minutes: walkMinutes(distanceKm(town.centre, rail.from)) + rail.durationMinutes + walkToSchool }];
    }).sort((a, b) => a.minutes - b.minutes || timeSeconds(b.rail.departure) - timeSeconds(a.rail.departure));
    if (viable[0]) {
      railJourneys.push({
        school, straightLineKm, mode: "scheduled_rail_with_estimated_walk",
        estimatedMinutes: viable[0].minutes, rail: viable[0].rail,
      });
    }
  }

  return [...[...nearby.values()].filter(journey => !railJourneys.some(rail =>
    rail.school.id === journey.school.id && journey.mode === "unknown")), ...railJourneys]
    .sort((a, b) => (a.estimatedMinutes ?? Infinity) - (b.estimatedMinutes ?? Infinity)
      || (a.straightLineKm ?? Infinity) - (b.straightLineKm ?? Infinity)
      || a.school.id.localeCompare(b.school.id));
}

function meetsSchoolQuery(journey: SchoolJourney, query: SchoolQuery) {
  return (!query.stage || journey.school.stages.includes(query.stage))
    && (query.mode !== "rail" || journey.mode === "scheduled_rail_with_estimated_walk")
    && (query.mode !== "car_free" || journey.estimatedMinutes !== null)
    && (query.maxJourneyMinutes === undefined || (journey.estimatedMinutes !== null && journey.estimatedMinutes <= query.maxJourneyMinutes));
}

export function getNearbySchools(snapshot: Snapshot, query: SchoolQuery, travelDate: string) {
  const town = getTown(snapshot, query.municipalityCode);
  const journeys = schoolJourneys(snapshot, town, travelDate, query.arriveBy);
  const bySchool = new Map<string, SchoolJourney>();
  for (const journey of journeys.filter(journey => meetsSchoolQuery(journey, query))) {
    if (!bySchool.has(journey.school.id)) bySchool.set(journey.school.id, journey);
  }
  const limitations = [
    "The directory records authorized stages. Check admissions, catchment, school start times and school-bus eligibility separately.",
    `Rail options depart from 06:30 and reach the school by ${query.arriveBy ?? "09:00"} local time. Walking legs are estimates from town centres; verify paths and return journeys.`,
    "The pilot includes local schools and neighbouring schools within 15 km where covered by the snapshot.",
  ];
  if (!railwayCoverage(snapshot, travelDate)) limitations.push("This date is outside the cached FGC timetable.");
  return { snapshot: snapshotInfo(snapshot), travelDate, directory: snapshot.schoolDirectory, schools: [...bySchool.values()].slice(0, query.limit ?? 8), limitations };
}
