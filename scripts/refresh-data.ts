import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'csv-parse/sync';
import { strFromU8, unzipSync } from 'fflate';
import { readSheet } from 'read-excel-file/node';
import { z } from 'zod';
import type { Metric, Municipality, School, Snapshot } from '../packages/contracts/places.ts';
import { isoDate } from '../packages/contracts/places.ts';
import { validateSnapshot } from '../packages/places/data.ts';
import { distanceKm, madridDate } from '../packages/places/geography.ts';
import { lleidaCode, railMunicipalities, recommendableCodes, socrata, urls } from './sources.ts';

type Row = Record<string, string | undefined>;
type EmexField = { id: string; v?: string; r?: string };
type EmexTable = { l?: string; r?: string; ff: { f: EmexField[] | EmexField } };
type EmexProfile = { fitxes: { gg: { g: { tt: { t: EmexTable[] | EmexTable } }[] } } };
type EmexNodes = { fitxes: { v: { v: { content: string; v: { id: string; content: string }[] }[] } } };
const asOf = madridDate();
const salesYear = z.coerce
  .number()
  .int()
  .min(2020)
  .max(Number(asOf.slice(0, 4)))
  .parse(process.env.SALES_YEAR ?? 2025);
const codes = [...recommendableCodes, lleidaCode].sort();
const quoted = (items: string[]) => items.map(item => `'${item.replaceAll("'", "''")}'`).join(',');
const oneOrMany = <T>(value: T | T[]) => (Array.isArray(value) ? value : [value]);

async function fetchSource(url: string) {
  const request = () => fetch(url, { signal: AbortSignal.timeout(20_000) });
  const response = await request().then(
    async response => {
      if (response.status !== 429 && response.status < 500) return response;
      await response.body?.cancel();
      await delay(1000);
      return request();
    },
    async () => {
      await delay(1000);
      return request();
    },
  );
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response;
}

async function json<T>(url: string): Promise<T> {
  return (await fetchSource(url)).json() as Promise<T>;
}

function query<T = Row[]>(dataset: string, params: Record<string, string>) {
  return json<T>(`${socrata}/resource/${dataset}.json?${new URLSearchParams(params)}`);
}

async function latestYear(dataset: string) {
  const rows = await query(dataset, { $select: 'max(any) as latest' });
  return z
    .string()
    .regex(/^20\d{2}$/)
    .parse(rows[0]?.latest);
}

async function updatedOn(dataset: string) {
  const meta = await json<{ rowsUpdatedAt: number }>(`${socrata}/api/views/${dataset}.json`);
  return madridDate(new Date(meta.rowsUpdatedAt * 1000));
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

const [profiles, marketMunicipal, marketComarca, schoolRows, retailRows, rail] = await Promise.all([
  Promise.all(codes.map(code => json<EmexProfile>(urls.emexProfile(code)))),
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
const townMetrics = Object.fromEntries(
  municipalities.map((town, index) => {
    const tables = profiles[index].fitxes.gg.g.flatMap(group => oneOrMany(group.tt.t));
    const municipal = {
      geography: 'municipality' as const,
      geographyName: town.name,
    };
    function emex(fieldId: string, kind: Metric['kind'], unit: string) {
      for (const table of tables) {
        const field = oneOrMany(table.ff.f).find(field => field.id === fieldId);
        if (!field) continue;
        const value = number(field.v?.split(',')[0]);
        const observedAt = field.r ?? table.r;
        if (value !== undefined && observedAt && (kind !== 'rent_eur_per_month' || value > 0)) {
          return { ...municipal, kind, unit, value, observedAt, sourceUrl: table.l ?? urls.emexProfile(town.code) };
        }
      }
    }
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
        emex('f321', 'population', 'residents'),
        emex('f407', 'rent_eur_per_month', 'EUR/month'),
        emex('f406', 'rent_contracts', 'contracts'),
        emex('f308', 'registered_unemployment', 'people (annual average)'),
        emex('f377', 'resident_social_security_affiliates', 'people'),
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
      ].filter(defined),
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

const output = validateSnapshot({
  schemaVersion: 1,
  generatedOn: asOf,
  version: `catalonia-pilot-${asOf}-${randomUUID().slice(0, 8)}`,
  municipalities,
  townMetrics,
  comarcaMetrics,
  schools,
  schoolDirectory: { observedAt: schoolObserved, sourceUrl: urls.school },
  rail,
});
const target = new URL('../data/towns.json', import.meta.url);
const temporary = new URL(`../data/${output.version}.tmp`, import.meta.url);
try {
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, target);
} finally {
  await rm(temporary, { force: true });
}
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
