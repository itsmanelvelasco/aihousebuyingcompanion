import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { strFromU8, unzipSync } from 'fflate';
import { readSheet } from 'read-excel-file/node';
import { z } from 'zod';
import type { Metric, Municipality, Policy, School, Snapshot } from '../packages/contracts/places.ts';
import { isoDate, serviceKind } from '../packages/contracts/places.ts';
import { derivedServices, validateSnapshot } from '../packages/places/data.ts';
import { distanceKm, madridDate } from '../packages/places/geography.ts';
import equipaments from '../packages/sources/definitions/gencat-equipaments.ts';
import emex from '../packages/sources/definitions/idescat-emex.ts';
import {
  createRequester,
  createSourceContext,
  socrataQuery,
  socrataUpdatedOn,
  soqlList,
} from '../packages/sources/http.ts';
import { withServices } from '../packages/sources/overlay.ts';
import { sources } from '../packages/sources/registry.ts';
import { runSource } from '../packages/sources/source.ts';
import { lleidaCode, railMunicipalities, recommendableCodes, urls } from './sources.ts';

type Row = Record<string, string | undefined>;
type EmexNodes = { fitxes: { v: { v: { content: string; v: { id: string; content: string }[] }[] } } };
const asOf = madridDate();
const salesYear = z.coerce
  .number()
  .int()
  .min(2020)
  .max(Number(asOf.slice(0, 4)))
  .parse(process.env.SALES_YEAR ?? 2025);
const codes = [...recommendableCodes, lleidaCode].sort();
const quoted = soqlList;
// HTTP goes through the same bounded, retrying requester the live sources use.
const fetchSource = createRequester();
const http = { json: async <T>(url: string) => (await fetchSource(url)).json() as Promise<T> };
const json = http.json;
const query = <T = Row[]>(dataset: string, params: Record<string, string>) => socrataQuery<T>(http, dataset, params);
const updatedOn = (dataset: string) => socrataUpdatedOn(http, dataset);
const target = new URL('../data/towns.json', import.meta.url);

/** Service counts in the order of the serviceKind enum, so reruns do not reorder the file. */
function inKindOrder(services: NonNullable<Snapshot['services']>) {
  const position = (kind: (typeof serviceKind.options)[number]) => serviceKind.options.indexOf(kind);
  return Object.fromEntries(
    Object.entries(services).map(([code, counts]) => [
      code,
      [...counts].sort((a, b) => position(a.kind) - position(b.kind)),
    ]),
  );
}

/** Replaces the committed snapshot in one step after validating it. */
async function writeSnapshot(raw: unknown) {
  const valid = validateSnapshot(raw);
  const output = { ...valid, services: inKindOrder(valid.services ?? {}) };
  const temporary = new URL(`../data/${output.version}.tmp`, import.meta.url);
  try {
    await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return output;
}

/**
 * `--sources-only`: refetches only what the live source definitions cover (Idescat municipal
 * metrics and service counts) and lays it over the committed snapshot. Schools, rail timetables,
 * housing and retail figures stay exactly as committed.
 */
async function refreshSourcesOnly() {
  const snapshot = validateSnapshot(JSON.parse(await readFile(target, 'utf8')));
  const context = createSourceContext({ municipalities: snapshot.municipalities });
  // Sources overlay the shape `loadData()` returns; policies and travel estimates are not involved here.
  let data = { snapshot, policies: [] as Policy[], travelEstimates: {} };
  for (const source of sources) {
    if (source.overlay) data = source.overlay(data, await runSource(source, context));
  }
  data = withServices(data, derivedServices(data.snapshot));
  const output = await writeSnapshot({
    ...data.snapshot,
    generatedOn: asOf,
    version: `catalonia-pilot-${asOf}-${randomUUID().slice(0, 8)}`,
  });
  console.log(`Wrote ${output.version}: refreshed ${sources.map(source => source.id).join(', ')} only.`);
}

if (process.argv.includes('--sources-only')) {
  await refreshSourcesOnly();
  process.exit(0);
}

async function latestYear(dataset: string) {
  const rows = await query(dataset, { $select: 'max(any) as latest' });
  return z
    .string()
    .regex(/^20\d{2}$/)
    .parse(rows[0]?.latest);
}

function number(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) return undefined;
  return Number(value);
}

function coordinates(latitude: unknown, longitude: unknown) {
  const lat = number(latitude);
  const lon = number(longitude);
  if (lat === undefined || lon === undefined || lat < 40 || lat > 43 || lon < 0 || lon > 4) return null;
  return { latitude: lat, longitude: lon };
}

function ruralStatus(raw: string | undefined): Municipality['rural'] {
  const provenance = { observedAt: ruralObserved, sourceUrl: urls.rural };
  switch (raw) {
    case "Municipi rural d'atenció especial":
      return {
        ...provenance,
        category: 'special_attention',
        effectiveFrom: '2026-02-24',
        legalUrl: urls.ruralResolution,
      };
    case 'Municipi rural':
      return { ...provenance, category: 'rural', effectiveFrom: '2026-02-24', legalUrl: urls.ruralResolution };
    case 'Municipi amb aplicació de les mesures del règim especial':
      return { ...provenance, category: 'rural', effectiveFrom: '2026-09-29', legalUrl: urls.additionsResolution };
    case 'Municipi amb aplicació parcial de les mesures del règim especial':
      return { ...provenance, category: 'partial', effectiveFrom: '2026-02-24', legalUrl: urls.ruralResolution };
    case undefined:
      return { ...provenance, category: 'not_listed', effectiveFrom: null };
    default:
      throw new Error(`Unrecognized rural classification: ${raw}`);
  }
}

const [ids, centres, ruralRows, ruralObserved, geoObserved, schoolObserved, schoolYear, retailYear] = await Promise.all(
  [
    json<EmexNodes>(urls.emexNodes),
    query('wpyq-we8x', { $where: `codi_municipi in (${quoted(codes)})`, $limit: '100' }),
    query('7gqm-722r', { $limit: '2000' }),
    updatedOn('7gqm-722r'),
    updatedOn('wpyq-we8x'),
    updatedOn('kvmv-ahh4'),
    latestYear('kvmv-ahh4'),
    latestYear('2dhj-q3r8'),
  ],
);
if (ruralRows.length < 500 || ruralRows.length === 2000) throw new Error('Incomplete rural classification download');
const byCode = new Map(
  ids.fitxes.v.v.flatMap(comarca =>
    comarca.v.map(town => [town.id, { name: town.content, comarca: comarca.content }] as const),
  ),
);
const municipalities = codes.map(code => {
  const town = byCode.get(code);
  const centre = centres.find(row => row.codi_municipi === code);
  const location = coordinates(centre?.latitud, centre?.longitud);
  if (!town || !centre?.municipi || !centre.cap_de_municipi || !location)
    throw new Error(`Missing official identity or centre for ${code}`);
  if (town.comarca !== centre.comarca) throw new Error(`Conflicting comarques for ${code}`);
  return {
    code,
    name: centre.municipi,
    comarca: town.comarca,
    recommendable: code !== lleidaCode,
    identity: { observedAt: asOf, sourceUrl: urls.emexNodes },
    centre: { ...location, name: centre.cap_de_municipi, observedAt: geoObserved, sourceUrl: urls.geography },
    rural: ruralStatus(ruralRows.find(row => row.codi === code)?.classificacio),
  };
});
const comarques = [...new Set(municipalities.map(town => town.comarca))].sort();

async function workbook(scope: 'municipis' | 'ambits') {
  const response = await fetchSource(urls.sales(scope, salesYear));
  const rows = await readSheet(Buffer.from(await response.arrayBuffer()), String(salesYear));
  const usedIndex = scope === 'municipis' ? 17 : 16;
  if (
    !String(rows[1]?.[0]).toLowerCase().includes(`desembre ${salesYear}`) ||
    !String(rows[3]?.[usedIndex - 1]).includes('Preu / m2') ||
    rows[4]?.[usedIndex] !== 'Habitatge usat'
  ) {
    throw new Error(`Unexpected annual ${scope} sales workbook layout`);
  }
  return rows.slice(5);
}

const sourceContext = createSourceContext({ municipalities });
const [emexMetrics, facilities, marketMunicipal, marketComarca, schoolRows, retailRows, rail] = await Promise.all([
  runSource(emex, sourceContext),
  runSource(equipaments, sourceContext),
  workbook('municipis'),
  workbook('ambits'),
  query('kvmv-ahh4', {
    $where: `any=${schoolYear} and nom_comarca in (${quoted(comarques)})`,
    $order: 'codi_centre',
    $limit: '4000',
  }),
  query('2dhj-q3r8', {
    $where: `any=${retailYear} and comarca in (${quoted(comarques)})`,
    $limit: '4000',
  }),
  readRail(),
]);
if (!schoolRows.length || schoolRows.length === 4000 || !retailRows.length || retailRows.length === 4000) {
  throw new Error('Incomplete school or retail download');
}

const defined = <T>(value: T | undefined): value is T => value !== undefined;
// Kinds added after the first snapshots go last, so existing metrics keep their position in the file.
const newIndicators = new Set<Metric['kind']>(['area_km2', 'population_density_per_km2', 'foreign_population_percent']);
const townMetrics = Object.fromEntries(
  municipalities.map(town => {
    const municipal = {
      geography: 'municipality' as const,
      geographyName: town.name,
    };
    // Idescat metrics come from the shared source definition, in the order it declares them.
    const idescat = emexMetrics[town.code] ?? [];
    const established = (metric: Metric) => !newIndicators.has(metric.kind);
    const sale = marketMunicipal.find(row => String(row[0]).padStart(5, '0') === town.code.slice(0, 5));
    const sold = number(sale?.[4]);
    const price = number(sale?.[17]);
    const censusName = byCode.get(town.code)?.name;
    const retail = retailRows.find(row => row.municipi === censusName && row.comarca === town.comarca);
    const saleSource = { observedAt: String(salesYear), sourceUrl: urls.sales('municipis', salesYear) };
    const retailSource = { observedAt: retailYear, sourceUrl: urls.retail };
    const retailCount = number(retail?.establiments);
    const retailDensity = number(retail?.densitat_comercial_est_1);
    return [
      town.code,
      [
        ...idescat.filter(established),
        sold !== undefined
          ? { ...municipal, ...saleSource, kind: 'resale_transactions', unit: 'transactions', value: sold }
          : undefined,
        price !== undefined && price > 0
          ? { ...municipal, ...saleSource, kind: 'resale_eur_per_m2', unit: 'EUR/m²', value: price }
          : undefined,
        retailCount !== undefined
          ? { ...municipal, ...retailSource, kind: 'retail_establishments', unit: 'establishments', value: retailCount }
          : undefined,
        retailDensity !== undefined
          ? {
              ...municipal,
              ...retailSource,
              kind: 'retail_per_1000',
              unit: 'establishments/1,000 residents',
              value: retailDensity,
            }
          : undefined,
        ...idescat.filter(metric => !established(metric)),
      ].filter(defined) as Metric[],
    ] as const;
  }),
);

const comarcaMetrics = Object.fromEntries(
  comarques.map(comarca => {
    const row = marketComarca.find(row => row[0] === comarca);
    const value = number(row?.[16]);
    if (value === undefined || value <= 0) throw new Error(`Missing resale reference price for ${comarca}`);
    return [
      comarca,
      [
        {
          kind: 'resale_eur_per_m2',
          value,
          unit: 'EUR/m²',
          geography: 'comarca',
          geographyName: comarca,
          observedAt: String(salesYear),
          sourceUrl: urls.sales('ambits', salesYear),
        },
      ],
    ];
  }),
);

const schools: School[] = [];
for (const row of schoolRows) {
  if (!row.codi_centre || !row.denominaci_completa || !row.codi_municipi_6 || !row.curs || !row.codi_naturalesa)
    continue;
  const location = coordinates(row.coordenades_geo_y, row.coordenades_geo_x);
  // The published geographic columns are decimal degrees. The separate UTM columns are EPSG:25831.
  if (
    location
      ? !municipalities.some(town => distanceKm(town.centre, location) <= 15)
      : !codes.includes(row.codi_municipi_6)
  )
    continue;
  const stages: School['stages'] = [];
  if (row.einf1c) stages.push('nursery');
  if (row.einf2c) stages.push('infantil');
  if (row.epri) stages.push('primary');
  if (row.eso) stages.push('eso');
  if (row.batx) stages.push('batxillerat');
  if (row.cfpm || row.cfps || row.cfam || row.cfas || row.tegm || row.tegs) stages.push('fp');
  if (!stages.length) continue;
  schools.push({
    id: row.codi_centre,
    name: row.denominaci_completa,
    municipalityCode: row.codi_municipi_6,
    locality: row.nom_localitat?.trim() || null,
    coordinates: location,
    public: row.codi_naturalesa === '1',
    stages,
    observedAt: row.curs,
    sourceUrl: urls.school,
  });
}

const derived = derivedServices({ municipalities, townMetrics, schools, rail });
const output = await writeSnapshot({
  schemaVersion: 1,
  generatedOn: asOf,
  version: `catalonia-pilot-${asOf}-${randomUUID().slice(0, 8)}`,
  municipalities,
  townMetrics,
  comarcaMetrics,
  schools,
  schoolDirectory: { observedAt: schoolObserved, sourceUrl: urls.school },
  rail,
  // Directory counts first, then the kinds that follow from schools, rail stops and the retail census.
  services: Object.fromEntries(codes.map(code => [code, [...(facilities[code] ?? []), ...(derived[code] ?? [])]])),
});
console.log(`Wrote ${output.version} with ${municipalities.length} municipalities and ${schools.length} schools.`);

async function readRail(): Promise<Snapshot['rail']> {
  const response = await fetchSource(urls.gtfs);
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  function table(name: string) {
    const contents = archive[`${name}.txt`];
    if (!contents) throw new Error(`Missing ${name}.txt in FGC feed`);
    return parse(strFromU8(contents), { columns: true, bom: true, skip_empty_lines: true }) as Record<string, string>[];
  }
  function date(value: string) {
    return isoDate.parse(value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
  }
  function seconds(time: string) {
    const [h, m, s] = time.split(':').map(Number);
    return h * 3600 + m * 60 + s;
  }
  const [info] = table('feed_info');
  const feedEnd = date(info.feed_end_date);
  const validFrom = date(info.feed_start_date);
  if (asOf < validFrom || asOf > feedEnd) throw new Error('The official FGC feed does not cover today');
  const dated = table('calendar_dates');
  const routes = table('trips').filter(row => row.route_id === 'RL1' || row.route_id === 'RL2');

  // This feed publishes date-specific additions without calendar.txt. Fail if the format switches.
  if (archive['calendar.txt']) throw new Error('FGC service calendar format changed');
  const serviceIds = new Set(routes.map(row => row.service_id));
  const dates: Record<string, string[]> = {};
  const corridorDates = dated.filter(row => serviceIds.has(row.service_id));
  if (!corridorDates.length) throw new Error('Missing RL1/RL2 service dates in FGC feed');
  const serviceDates = corridorDates.map(row => date(row.date)).sort();
  const windowStart = serviceDates[0];
  const windowEnd = serviceDates[serviceDates.length - 1];
  if (asOf < windowStart || asOf > windowEnd || windowEnd > feedEnd)
    throw new Error('Invalid RL1/RL2 schedule coverage');
  for (const row of corridorDates) {
    if (row.exception_type === '1') (dates[date(row.date)] ??= []).push(row.service_id);
  }

  const byTrip = new Map(
    routes.map(row => [
      row.trip_id,
      {
        service: row.service_id,
        line: row.route_id as 'RL1' | 'RL2',
        calls: [] as { sequence: number; call: [string, number, number] }[],
      },
    ]),
  );
  for (const row of table('stop_times')) {
    byTrip.get(row.trip_id)?.calls.push({
      sequence: Number(row.stop_sequence),
      call: [row.stop_id, seconds(row.arrival_time), seconds(row.departure_time)],
    });
  }
  const trips = [...byTrip.values()].map(trip => ({
    ...trip,
    calls: trip.calls.sort((a, b) => a.sequence - b.sequence).map(({ call }) => call),
  }));
  const used = new Set(trips.flatMap(trip => trip.calls.map(([stop]) => stop)));
  const stops = table('stops')
    .filter(row => used.has(row.stop_id))
    .map(row => {
      const location = coordinates(row.stop_lat, row.stop_lon);
      if (!location || !railMunicipalities[row.stop_id]) throw new Error(`Unmapped corridor stop: ${row.stop_id}`);
      return { ...location, id: row.stop_id, name: row.stop_name, municipalityCode: railMunicipalities[row.stop_id] };
    });
  return {
    observedAt: info.feed_version,
    sourceUrl: urls.gtfs,
    validFrom: windowStart,
    validThrough: windowEnd,
    dates,
    stops,
    trips,
  };
}
