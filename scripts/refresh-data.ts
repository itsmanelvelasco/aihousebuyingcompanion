import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Metric, Policy, Snapshot } from '../packages/contracts/places.ts';
import { serviceKind } from '../packages/contracts/places.ts';
import { validateSnapshot } from '../packages/places/data.ts';
import { madridDate } from '../packages/places/geography.ts';
import rail from '../packages/sources/definitions/fgc-gtfs.ts';
import schools from '../packages/sources/definitions/gencat-centres-docents.ts';
import rural from '../packages/sources/definitions/gencat-municipis-rurals.ts';
import { createSourceContext, socrataQuery, socrataUpdatedOn, soqlList } from '../packages/sources/http.ts';
import { sources } from '../packages/sources/registry.ts';
import type { LiveData, SourceContext } from '../packages/sources/source.ts';
import { runSource } from '../packages/sources/source.ts';
import { coordinates } from '../packages/sources/values.ts';
import { lleidaCode, recommendableCodes, urls } from './sources.ts';

type EmexNodes = { fitxes: { v: { v: { content: string; v: { id: string; content: string }[] }[] } } };
const asOf = madridDate();
const committed = fileURLToPath(new URL('../data/towns.json', import.meta.url));
const outFlag = process.argv.indexOf('--out');
/** `--out <file>` writes the result somewhere else, to inspect it before replacing the snapshot. */
const target = outFlag > 0 && process.argv[outFlag + 1] ? resolve(process.argv[outFlag + 1]) : committed;

/** Metric kinds in the order the snapshot has always listed them, so reruns do not reorder the file. */
const metricOrder: Metric['kind'][] = [
  'population',
  'rent_eur_per_month',
  'rent_contracts',
  'registered_unemployment',
  'resident_social_security_affiliates',
  'resale_transactions',
  'resale_eur_per_m2',
  'retail_establishments',
  'retail_per_1000',
  'area_km2',
  'population_density_per_km2',
  'foreign_population_percent',
];

function inOrder<T extends { kind: string }>(record: Record<string, T[]>, order: readonly string[]) {
  const position = (kind: string) => (order.includes(kind) ? order.indexOf(kind) : order.length);
  return Object.fromEntries(
    Object.entries(record).map(([key, items]) => [key, [...items].sort((a, b) => position(a.kind) - position(b.kind))]),
  );
}

/** Replaces the snapshot file in one step after validating it. */
async function writeSnapshot(raw: unknown) {
  const valid = validateSnapshot(raw);
  const output = {
    ...valid,
    townMetrics: inOrder(valid.townMetrics, metricOrder),
    services: inOrder(valid.services ?? {}, serviceKind.options),
  };
  const temporary = join(dirname(target), `${output.version}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return output;
}

/**
 * Fetches every source definition once, with the same code the live layer runs, and lays the
 * results over `snapshot` in registry order. Any failing source aborts the refresh.
 */
async function withSources(snapshot: Snapshot, context: SourceContext, fetched = new Map<string, unknown>()) {
  const values = await Promise.all(sources.map(source => fetched.get(source.id) ?? runSource(source, context)));
  // Sources overlay the shape `loadData()` returns; policies and travel estimates are not involved here.
  let data: LiveData = { snapshot, policies: [] as Policy[], travelEstimates: {} };
  sources.forEach((source, index) => {
    if (source.overlay) data = source.overlay(data, values[index]);
  });
  return data.snapshot;
}

const context = (municipalities: SourceContext['municipalities']) =>
  createSourceContext({ municipalities, env: process.env });
const version = () => `catalonia-pilot-${asOf}-${randomUUID().slice(0, 8)}`;

/**
 * `--sources-only`: keeps the committed municipalities (codes, names, centres) and refetches
 * everything the source definitions cover, which is all the rest of the snapshot.
 */
async function refreshSourcesOnly() {
  const snapshot = validateSnapshot(JSON.parse(await readFile(committed, 'utf8')));
  const refreshed = await withSources(snapshot, context(snapshot.municipalities));
  const output = await writeSnapshot({ ...refreshed, generatedOn: asOf, version: version() });
  console.log(`Wrote ${output.version}: refreshed ${sources.map(source => source.id).join(', ')}.`);
}

/** Rebuilds the snapshot from nothing: the official identity and centre of each town, then every source. */
async function refreshAll() {
  const codes = [...recommendableCodes, lleidaCode].sort();
  const base = createSourceContext({ municipalities: [] });
  const [ids, centres, geoObserved] = await Promise.all([
    base.json<EmexNodes>(urls.emexNodes),
    socrataQuery(base, 'wpyq-we8x', { $where: `codi_municipi in (${soqlList(codes)})`, $limit: '100' }),
    socrataUpdatedOn(base, 'wpyq-we8x'),
  ]);
  const byCode = new Map(
    ids.fitxes.v.v.flatMap(comarca =>
      comarca.v.map(town => [town.id, { name: town.content, comarca: comarca.content }] as const),
    ),
  );
  const identities = codes.map(code => {
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
    };
  });

  // The three parts a snapshot cannot be built without come first; the rest is laid over them.
  const sourceContext = context(identities);
  const [ruralByCode, timetable, directory] = await Promise.all([
    runSource(rural, sourceContext),
    runSource(rail, sourceContext),
    runSource(schools, sourceContext),
  ]);
  const [first, ...rest] = identities.map(town => ({ ...town, rural: ruralByCode[town.code] }));
  const skeleton: Snapshot = {
    schemaVersion: 1,
    generatedOn: asOf,
    version: version(),
    municipalities: [first, ...rest],
    townMetrics: Object.fromEntries(codes.map(code => [code, []])),
    comarcaMetrics: Object.fromEntries(
      [...new Set(identities.map(town => town.comarca))].sort().map(name => [name, []]),
    ),
    schools: directory.schools,
    schoolDirectory: directory.directory,
    rail: timetable,
    services: Object.fromEntries(codes.map(code => [code, []])),
  };
  const fetched = new Map<string, unknown>([
    [rural.id, ruralByCode],
    [rail.id, timetable],
    [schools.id, directory],
  ]);
  const output = await writeSnapshot(await withSources(skeleton, sourceContext, fetched));
  console.log(
    `Wrote ${output.version} with ${output.municipalities.length} municipalities and ${output.schools.length} schools.`,
  );
}

await (process.argv.includes('--sources-only') ? refreshSourcesOnly() : refreshAll());
if (target !== committed) console.log(`Output: ${target}`);
