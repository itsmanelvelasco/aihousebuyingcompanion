import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import type { Metric } from '../packages/contracts/places.ts';
import { metric, municipalityCode } from '../packages/contracts/places.ts';
import { loadData, validateSnapshot } from '../packages/places/data.ts';
import { createSourceCache } from '../packages/sources/cache.ts';
import rail, { readRail } from '../packages/sources/definitions/fgc-gtfs.ts';
import { retailMetrics } from '../packages/sources/definitions/gencat-cens-comercial.ts';
import { schoolsNear } from '../packages/sources/definitions/gencat-centres-docents.ts';
import sales, { salesMetrics, salesUrl } from '../packages/sources/definitions/gencat-compravendes-habitatge.ts';
import equipaments, { countFacilities } from '../packages/sources/definitions/gencat-equipaments.ts';
import { ruralStatuses } from '../packages/sources/definitions/gencat-municipis-rurals.ts';
import { countSocialServices } from '../packages/sources/definitions/gencat-serveis-socials.ts';
import emex, { emexMetrics, emexPageUrl, emexTableMetrics } from '../packages/sources/definitions/idescat-emex.ts';
import { createRequester, createSourceContext } from '../packages/sources/http.ts';
import { createLiveData } from '../packages/sources/live.ts';
import { matchTownsByName, normaliseName } from '../packages/sources/names.ts';
import { withMetrics } from '../packages/sources/overlay.ts';
import { discoverSources, sources } from '../packages/sources/registry.ts';
import { defineSource, runSource } from '../packages/sources/source.ts';

const hour = 60 * 60 * 1000;
const baseline = loadData();
const alcoletge = '250122';

async function temporaryDirectory(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'relocat-sources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A clock tests move by hand. It starts at noon on the day the committed snapshot was generated. */
function clock() {
  let time = Date.parse(`${baseline.snapshot.generatedOn}T12:00:00Z`);
  return { now: () => new Date(time), advance: (ms: number) => void (time += ms) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const allSourceIds = [
  'fgc-gtfs',
  'gencat-cens-comercial',
  'gencat-centres-docents',
  'gencat-compravendes-habitatge',
  'gencat-equipaments',
  'gencat-municipis-rurals',
  'gencat-serveis-socials',
  'idescat-emex',
];
const numbers = { id: 'numbers', ttlMs: hour, schema: z.object({ n: z.number() }) };

test('cache serves fresh values, persists them atomically and revalidates stale ones in the background', async t => {
  const cacheDir = await temporaryDirectory(t);
  const time = clock();
  let n = 0;
  const load = async () => ({ n: ++n });
  const cache = createSourceCache({ cacheDir, load, now: time.now });

  assert.deepEqual(cache.peek(numbers), {
    status: 'never',
    value: undefined,
    fetchedAt: null,
    lastAttemptAt: null,
    error: null,
    refreshing: false,
  });
  const [first, shared] = await Promise.all([cache.refresh(numbers), cache.refresh(numbers)]);
  assert.equal(first.status, 'fresh');
  assert.deepEqual(first.value, { n: 1 });
  assert.deepEqual(shared.value, { n: 1 }, 'concurrent refreshes share one download');
  assert.equal(first.fetchedAt, time.now().toISOString());
  assert.deepEqual(await readdir(cacheDir), ['numbers.json'], 'no temporary file is left behind');
  assert.deepEqual(JSON.parse(await readFile(join(cacheDir, 'numbers.json'), 'utf8')).value, { n: 1 });

  time.advance(hour - 1);
  assert.equal(cache.get(numbers).status, 'fresh');
  await cache.idle();
  assert.equal(n, 1, 'a fresh value is not fetched again');

  // A new process reads the same file, and an expired value is still served while it refreshes.
  time.advance(1);
  const restarted = createSourceCache({ cacheDir, load, now: time.now });
  const stale = restarted.get(numbers);
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.value, { n: 1 });
  assert.equal(stale.refreshing, true);
  await restarted.idle();
  assert.deepEqual(restarted.peek(numbers).value, { n: 2 });
  assert.equal(restarted.peek(numbers).status, 'fresh');
  assert.equal(restarted.revision(), 1);
});

test('cache keeps the last good value when a refresh fails, times out or returns invalid data', async t => {
  const cacheDir = await temporaryDirectory(t);
  const time = clock();
  let answer: () => Promise<unknown> = async () => ({ n: 7 });
  let calls = 0;
  const cache = createSourceCache({
    cacheDir,
    now: time.now,
    timeoutMs: 20,
    retryAfterMs: 1000,
    load: () => {
      calls++;
      return answer();
    },
  });
  const good = await cache.refresh(numbers);

  time.advance(2 * hour);
  answer = async () => {
    throw new Error('upstream is down');
  };
  const failed = await cache.refresh(numbers);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'upstream is down');
  assert.deepEqual(failed.value, { n: 7 });
  assert.equal(failed.fetchedAt, good.fetchedAt);
  assert.equal(failed.lastAttemptAt, time.now().toISOString());
  const onDisk = JSON.parse(await readFile(join(cacheDir, 'numbers.json'), 'utf8'));
  assert.deepEqual([onDisk.value, onDisk.error], [{ n: 7 }, 'upstream is down']);

  // A failed source is not hammered: the next background attempt waits for `retryAfterMs`.
  calls = 0;
  cache.get(numbers);
  await cache.idle();
  assert.equal(calls, 0);
  time.advance(1000);
  answer = async () => ({ n: 'not a number' });
  assert.deepEqual(cache.get(numbers).value, { n: 7 });
  await cache.idle();
  assert.equal(calls, 1);
  assert.equal(cache.peek(numbers).status, 'error');
  assert.deepEqual(cache.peek(numbers).value, { n: 7 }, 'a value that fails the schema is never stored');

  answer = () => new Promise(() => {});
  const timedOut = await cache.refresh(numbers);
  assert.match(timedOut.error ?? '', /Timed out/);
  assert.deepEqual(timedOut.value, { n: 7 });

  answer = async () => ({ n: 8 });
  const recovered = await cache.refresh(numbers);
  assert.deepEqual([recovered.status, recovered.value, recovered.error], ['fresh', { n: 8 }, null]);
});

test('cache ignores unreadable or invalid files and reports a first failure without a value', async t => {
  const cacheDir = await temporaryDirectory(t);
  await writeFile(join(cacheDir, 'numbers.json'), '{"value":{"n":"corrupt"},"fetchedAt":"2026-01-01T00:00:00Z"');
  const cache = createSourceCache({
    cacheDir: join(cacheDir, 'missing', 'nested'),
    load: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(createSourceCache({ cacheDir, load: async () => ({}) }).peek(numbers).status, 'never');
  const entry = await cache.refresh(numbers);
  assert.deepEqual([entry.status, entry.value, entry.fetchedAt, entry.error], ['error', undefined, null, 'offline']);
});

test('requests are bounded: server errors are retried once, client errors are not', async () => {
  const seen: string[] = [];
  const answers = [json({}, 503), json({ ok: true }), json({}, 404), json({}, 500), json({}, 500)];
  const fetch = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return answers.shift()!;
  }) as typeof globalThis.fetch;
  const request = createRequester({ fetch, retryDelayMs: 0 });
  assert.deepEqual(await (await request('https://example.org/a')).json(), { ok: true });
  await assert.rejects(request('https://example.org/b'), /404 from/);
  await assert.rejects(request('https://example.org/c'), /500 from/);
  assert.deepEqual(
    seen.map(url => url.slice(-1)),
    ['a', 'a', 'b', 'c', 'c'],
  );
});

test('registry discovers one source per definition file and skips underscore files', async () => {
  const ids = sources.map(source => source.id);
  assert.deepEqual(ids, allSourceIds);
  const files = await readdir(new URL('../packages/sources/definitions/', import.meta.url));
  assert.ok(files.includes('_template.ts'));
  assert.equal(files.filter(name => !name.startsWith('_')).length, ids.length);
  assert.deepEqual(
    (await discoverSources()).map(source => source.id),
    ids,
  );
  for (const source of sources) {
    assert.ok(source.title && source.authority && source.ttlMs > 0 && source.overlay);
    assert.match(new URL(source.homepage).hostname, /(^|\.)(idescat|transparenciacatalunya|gencat|fgc)\.cat$/);
    assert.ok(!(source.env ?? []).some(variable => variable.required), 'Catalan open data needs no API key');
    // Timetables and directories are checked daily, the annual sales workbook weekly.
    assert.equal(source.ttlMs, (source.id === sales.id ? 7 * 24 : 24) * hour);
  }
  assert.throws(() =>
    defineSource({ ...numbers, id: 'Bad Id', title: '', authority: '', homepage: 'x', fetch: async () => ({}) }),
  );
});

/** A minimal EMEX answer with the indicator ids the live API uses. */
function emexProfile(values: Record<string, string>) {
  const field = (id: string) => ({ id, v: `${values[id]},1,1` });
  return {
    fitxes: {
      gg: {
        g: [
          {
            tt: {
              t: [
                {
                  r: '2025',
                  l: 'https://www.idescat.cat/pub/?id=inddt&n=396',
                  ff: { f: [field('f261'), field('f262')] },
                },
                { r: '2025', l: 'https://www.idescat.cat/pub/?id=censph&n=538', ff: { f: field('f321') } },
                {
                  r: '2025',
                  l: 'https://www.idescat.cat/pub/?id=censph&n=479',
                  ff: { f: [field('f184'), field('f263')] },
                },
                {
                  r: '2025',
                  l: 'https://www.idescat.cat/pub/?id=lh&n=22999',
                  ff: { f: [field('f407'), field('f406')] },
                },
              ],
            },
          },
        ],
      },
    },
  };
}

/** The all-municipalities EMEX table: the same figures in every town's column, dated 2025. */
function emexTable(codes: string[], values: Record<string, string>) {
  return {
    fitxes: {
      indicadors: { i: Object.entries(values).map(([id, v]) => ({ id, r: '2025', v: codes.map(() => v).join(',') })) },
      cols: { col: codes.map(id => ({ scheme: 'mun', id })) },
    },
  };
}

test('the Idescat table for every municipality becomes dated metrics; a town without a column gets none', () => {
  const places = [
    { code: alcoletge, name: 'Alcoletge', comarca: 'Segrià' },
    { code: '999999', name: 'Nowhere', comarca: 'Enlloc' },
  ];
  const metrics = emexTableMetrics(
    places,
    emexTable([alcoletge], { f261: '16.70', f262: '220.3', f321: '3679', f184: '616', f263: '3679', f407: '0.0' }),
  );
  assert.deepEqual(Object.keys(metrics), [alcoletge]);
  assert.deepEqual(
    metrics[alcoletge].map(entry => [entry.kind, entry.value, entry.observedAt]),
    [
      ['population', 3679, '2025'],
      ['area_km2', 16.7, '2025'],
      ['population_density_per_km2', 220.3, '2025'],
      ['foreign_population_percent', 16.7, '2025'],
    ],
  );
  // A rent of zero stands for "not published"; every figure cites the town's public Idescat page.
  assert.ok(metrics[alcoletge].every(entry => entry.sourceUrl === emexPageUrl(alcoletge)));
  assert.ok(metrics[alcoletge].every(entry => entry.geographyName === 'Alcoletge'));
});

test('Idescat profiles become dated metrics; unpublished figures stay unknown', () => {
  const town = { code: alcoletge, name: 'Alcoletge', comarca: 'Segrià' };
  const metrics = emexMetrics(
    town,
    emexProfile({ f261: '16.70', f262: '220.3', f321: '3679', f184: '616', f263: '3679', f407: '0', f406: '_' }),
  );
  const byKind = Object.fromEntries(metrics.map(entry => [entry.kind, entry]));
  assert.deepEqual(Object.keys(byKind).sort(), [
    'area_km2',
    'foreign_population_percent',
    'population',
    'population_density_per_km2',
  ]);
  assert.equal(byKind.area_km2.value, 16.7);
  assert.equal(byKind.population_density_per_km2.value, 220.3);
  assert.equal(byKind.foreign_population_percent.value, 16.7);
  assert.equal(byKind.foreign_population_percent.sourceUrl, 'https://www.idescat.cat/pub/?id=censph&n=479');
  assert.ok(metrics.every(entry => entry.observedAt === '2025' && entry.geographyName === 'Alcoletge'));
  // More foreign residents than residents is a broken answer, not a 100% share.
  assert.ok(
    !emexMetrics(town, emexProfile({ f184: '50', f263: '10' })).some(
      entry => entry.kind === 'foreign_population_percent',
    ),
  );
});

test('facility counts tolerate the directory code format and never report a zero', () => {
  const cap = "Salut|Centres sanitaris|1. Centres d'atenció primària (CAP)|";
  const rows = [
    { idequipament: '1', nom: 'Biblioteca', categoria: 'Cultura|Biblioteques||', codi_municipi: '80312' },
    { idequipament: '2', nom: 'CAP Calaf', codi_municipi: '80312' },
    { idequipament: '3', nom: 'Consultori local Alcoletge', codi_municipi: alcoletge },
    { idequipament: '4', nom: 'CAP Balaguer', categoria: cap, codi_municipi: alcoletge },
    { idequipament: '4', nom: 'CAP Balaguer', categoria: cap, codi_municipi: alcoletge },
    { idequipament: '5', nom: 'ASSIR CAP Balaguer', categoria: cap, codi_municipi: alcoletge },
    { idequipament: '6', nom: 'Hospital de dia', codi_municipi: alcoletge },
    {
      idequipament: '7',
      nom: 'Pista',
      categoria: 'Esports. Lleure|Instal·lacions esportives|Pista|',
      codi_municipi: '999999',
    },
  ];
  const counts = countFacilities(rows, ['080312', alcoletge, '431573'], '2026-11-22');
  const summary = (code: string) => counts[code].map(entry => `${entry.kind}=${entry.count}`);
  assert.deepEqual(summary('080312'), ['primary_care=1', 'library=1']);
  assert.deepEqual(summary(alcoletge), ['primary_care=2']);
  assert.deepEqual(counts['431573'], [], 'no listed facility means unknown, not zero');
  assert.equal(counts['999999'], undefined);
  assert.ok(
    counts['080312'].every(entry => entry.observedAt === '2026-11-22' && entry.sourceUrl.endsWith('/d/8gmd-gz7i')),
  );
});

const towns = baseline.snapshot.municipalities;
const comarques = [...new Set(towns.map(town => town.comarca))];
const today = baseline.snapshot.generatedOn;
const day = today.replaceAll('-', '');
/** How registers write a name with an article: "Pobla de Segur, la". */
const registerName = (name: string) => name.replace(/^(el|la|els|les) (.+)$/, '$2, $1').replace(/^l'(.+)$/, "$1, l'");

/** A minimal .xlsx file with one sheet, enough for the workbook reader. */
function workbook(sheetName: string, rows: (string | number | null)[][]) {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>';
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const cell = (value: string | number | null, row: number, column: number) => {
    const ref = `${String.fromCharCode(65 + column)}${row + 1}`;
    if (value === null) return '';
    return typeof value === 'number'
      ? `<c r="${ref}"><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${value.replaceAll('&', '&amp;')}</t></is></c>`;
  };
  const sheet = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((value, c) => cell(value, r, c)).join('')}</row>`)
    .join('');
  return zipSync({
    '[Content_Types].xml': strToU8(
      `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `${xml}<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `${xml}<workbook xmlns="${main}" xmlns:r="${relationships}"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${xml}<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(`${xml}<worksheet xmlns="${main}"><sheetData>${sheet}</sheetData></worksheet>`),
  });
}

/** The rows of an annual sales sheet in the published layout, with one price for every data row. */
function salesSheet(scope: 'municipis' | 'ambits', year: number, price: number) {
  const priceColumn = scope === 'municipis' ? 17 : 16;
  const row = (cells: Record<number, string | number>) =>
    Array.from({ length: 19 }, (_, column) => cells[column] ?? null);
  const data =
    scope === 'municipis'
      ? // The workbook lists towns above 2,000 residents by five-digit code: here only Alcoletge.
        [row({ 0: '25012', 1: 'Alcoletge', 4: 30, [priceColumn]: price })]
      : comarques.map(comarca => row({ 0: comarca, [priceColumn]: price - 100 }));
  return [
    row({ 0: 'Compravendes registrades' }),
    row({ 0: `Període: gener ${year} - desembre ${year}` }),
    row({}),
    row({ [priceColumn - 1]: 'Preu / m2 construït' }),
    row({ [priceColumn]: 'Habitatge usat' }),
    ...data,
  ];
}

/** A small GTFS archive: one RL1 train from Lleida to Alcoletge today, and a line outside the corridor. */
function gtfs(options: { feedEnd?: string; calendar?: boolean } = {}) {
  const file = (...lines: string[]) => strToU8(`﻿${lines.join('\r\n')}\r\n`);
  return zipSync({
    'feed_info.txt': file(
      'feed_publisher_name,feed_version,feed_start_date,feed_end_date',
      `FGC,test-feed,${day.slice(0, 4)}0101,${options.feedEnd ?? `${day.slice(0, 4)}1231`}`,
    ),
    'calendar_dates.txt': file('service_id,date,exception_type', `S1,${day},1`, `S2,${day},2`, `BUS,${day},1`),
    'trips.txt': file('route_id,service_id,trip_id', 'RL1,S1,T1', 'RL1,S2,T2', 'L6,BUS,T9'),
    'stop_times.txt': file(
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
      'T1,08:10:00,08:11:00,AT1,2',
      'T1,08:00:00,08:00:00,LE1,1',
      'T2,09:00:00,09:00:00,LE1,1',
      'T2,09:10:00,09:10:00,AT1,2',
      'T9,09:00:00,09:00:00,XX1,1',
    ),
    'stops.txt': file(
      'stop_id,stop_name,stop_lat,stop_lon',
      'LE1,Lleida-Pirineus,41.6207,0.6327',
      'AT1,Alcoletge,41.6445,0.6936',
      'XX1,Elsewhere,41.4,2.1',
    ),
    'shapes.txt': file('shape_id', '1'),
    ...(options.calendar ? { 'calendar.txt': file('service_id', 'S1') } : {}),
  });
}

/** Canned rows for each Socrata dataset the sources query. */
function socrataRows(dataset: string, params: URLSearchParams) {
  if (params.get('$select')?.startsWith('max(any)')) return [{ latest: dataset === 'kvmv-ahh4' ? '2026' : '2023' }];
  const filler = (count: number, row: (index: number) => Record<string, string>) =>
    Array.from({ length: count }, (_, index) => row(index));
  switch (dataset) {
    case '8gmd-gz7i':
      return towns.map(({ code }, index) => ({
        idequipament: String(index),
        nom: 'Biblioteca',
        categoria: 'Cultura|Biblioteques||',
        codi_municipi: code.replace(/^0/, ''),
      }));
    case '7gqm-722r':
      return [
        ...filler(600, index => ({ codi: String(900000 + index), classificacio: "Municipi rural d'atenció especial" })),
        { codi: alcoletge, classificacio: 'Municipi rural' },
      ];
    case 'kvmv-ahh4':
      return towns.map(town => ({
        codi_centre: `25${town.code}`,
        denominaci_completa: `Escola ${town.name}`,
        codi_municipi_6: town.code,
        curs: '2026/2027',
        codi_naturalesa: '1',
        coordenades_geo_y: String(town.centre.latitude),
        coordenades_geo_x: String(town.centre.longitude),
        epri: 'EPRI',
      }));
    case '2dhj-q3r8':
      return [
        ...filler(600, index => ({ municipi: `Poble ${index}`, comarca: 'Enlloc', establiments: '1' })),
        ...towns.map(town => ({
          municipi: registerName(town.name),
          comarca: town.comarca,
          establiments: '12',
          densitat_comercial_est_1: '3.5',
        })),
      ];
    case 'ivft-vegh':
      return [
        ...filler(1200, index => ({ registre: `S${index}`, municipi: `Poble ${index % 50}`, comarca: 'Enlloc' })),
        { registre: 'S90001', municipi: 'Alcoletge', comarca: 'Segrià' },
        { registre: 'S90002', municipi: 'ALCOLETGE', comarca: 'Segria' },
      ];
    default:
      return undefined;
  }
}

/** Answers every registered source from canned data, so the whole live path runs without a network. */
function officialFetch(
  log: string[] = [],
  overrides: (url: URL) => Response | Promise<Response> | undefined = () => undefined,
) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    log.push(url.hostname);
    const override = overrides(url);
    if (override) return override;
    if (url.hostname === 'api.idescat.cat') {
      return json(
        emexTable(
          towns.map(town => town.code),
          { f261: '10', f262: '50.5', f321: '505', f184: '101', f263: '505', f407: '400', f406: '9' },
        ),
      );
    }
    if (url.hostname === 'www.fgc.cat') return new Response(gtfs());
    if (url.hostname === 'habitatge.gencat.cat') {
      const [, scope, year] = /Trimestrals_per_(municipis|ambits)_(\d{4})\.xlsx$/.exec(url.pathname) ?? [];
      // Only last year's annual workbook exists, as on the real site for most of a year.
      if (Number(year) !== Number(today.slice(0, 4)) - 1) return json({}, 404);
      return new Response(workbook(year, salesSheet(scope as 'municipis' | 'ambits', Number(year), 1000)));
    }
    if (url.pathname.startsWith('/api/views/')) return json({ rowsUpdatedAt: Date.parse(`${today}T02:00:00Z`) / 1000 });
    const rows = socrataRows(url.pathname.replace(/^\/resource\/|\.json$/g, ''), url.searchParams);
    return rows ? json(rows) : json({}, 404);
  }) as typeof globalThis.fetch;
}

const sourceTowns = towns.map(({ code, name, comarca, centre }) => ({ code, name, comarca, centre }));

test('the shipped sources run against an injected fetch and validate their own output', async () => {
  const context = createSourceContext({ municipalities: sourceTowns, fetch: officialFetch(), now: clock().now });
  const metrics = await runSource(emex, context);
  const services = await runSource(equipaments, context);
  assert.deepEqual(Object.keys(metrics).sort(), towns.map(town => town.code).sort());
  assert.equal(metrics[alcoletge].find(entry => entry.kind === 'foreign_population_percent')?.value, 20);
  assert.deepEqual(
    services['080312'].map(entry => [entry.kind, entry.count, entry.observedAt]),
    [['library', 1, today]],
  );
  for (const source of sources) await runSource(source, context);
});

test('names without codes are joined by normalised name and comarca, and only when the match is clean', () => {
  assert.equal(normaliseName('Pobla de Segur, la'), normaliseName('la Pobla de Segur'));
  assert.equal(normaliseName("Albi,  l'"), normaliseName('l’Albi'));
  assert.equal(normaliseName('  ÀGER '), 'ager');
  assert.notEqual(normaliseName('Vilanova de la Barca'), normaliseName('Vilanova de Meià'));

  const places = [
    { code: '251713', name: 'la Pobla de Segur', comarca: 'Pallars Jussà' },
    { code: '250024', name: 'Àger', comarca: 'Noguera' },
    { code: '250122', name: 'Alcoletge', comarca: 'Segrià' },
    { code: '252154', name: 'Talarn', comarca: 'Pallars Jussà' },
    { code: '111111', name: 'Vilanova', comarca: 'Noguera' },
    { code: '222222', name: 'Vilanova', comarca: 'Noguera' },
  ];
  const rows = [
    { registre: 'S1', municipi: 'Pobla de Segur, la', comarca: 'Pallars Jussà' },
    { registre: 'S2', municipi: 'Pobla de Segur, la', comarca: 'Pallars Jussa' },
    { registre: 'S2', municipi: 'Pobla de Segur, la', comarca: 'Pallars Jussà' },
    { registre: 'S3', municipi: 'Àger', comarca: 'Noguera' },
    // The same name under another comarca, or under none, makes the town doubtful.
    { registre: 'S4', municipi: 'Àger', comarca: 'Segrià' },
    { registre: 'S5', municipi: 'Alcoletge' },
    { registre: 'S6', municipi: 'Vilanova', comarca: 'Noguera' },
    { registre: 'S7', municipi: 'Barcelona', comarca: 'Barcelonès' },
    { registre: 'S8' },
  ];
  assert.deepEqual([...matchTownsByName(places, rows).keys()], ['251713']);
  const counts = countSocialServices(rows, places, '2026-11-19');
  assert.deepEqual(counts['251713'], [
    {
      kind: 'social_services',
      count: 2,
      observedAt: '2026-11-19',
      sourceUrl: 'https://analisi.transparenciacatalunya.cat/d/ivft-vegh',
    },
  ]);
  // No clean match means the kind is left out, so readers see "unknown" and never a zero.
  for (const code of ['250024', '250122', '252154', '111111', '222222']) assert.deepEqual(counts[code], []);
});

test('retail figures join by name, keep explicit zeroes and skip towns the census does not name', () => {
  const places = [
    { code: '250371', name: 'les Avellanes i Santa Linya', comarca: 'Noguera' },
    { code: '259046', name: 'Castell de Mur', comarca: 'Pallars Jussà' },
    { code: '252154', name: 'Talarn', comarca: 'Pallars Jussà' },
  ];
  const metrics = retailMetrics(
    [
      {
        municipi: 'Avellanes i Santa Linya, les',
        comarca: 'Noguera',
        establiments: '2',
        densitat_comercial_est_1: '4.5',
      },
      { municipi: 'Castell de Mur', comarca: 'Pallars Jussà', establiments: '0', densitat_comercial_est_1: '0' },
      { municipi: 'Talarn', comarca: 'Pallars Jussà', establiments: 'n/d' },
    ],
    places,
    '2023',
  );
  assert.deepEqual(
    metrics['250371'].map(entry => [entry.kind, entry.value, entry.observedAt, entry.geographyName]),
    [
      ['retail_establishments', 2, '2023', 'les Avellanes i Santa Linya'],
      ['retail_per_1000', 4.5, '2023', 'les Avellanes i Santa Linya'],
    ],
  );
  assert.equal(metrics['259046'][0].value, 0, 'the census states this zero itself');
  assert.deepEqual(metrics['252154'], []);
});

test('rural status comes from the published label, never from a guess', () => {
  const statuses = ruralStatuses(
    [
      { codi: '250024', classificacio: "Municipi rural d'atenció especial" },
      { codi: '252154', classificacio: 'Municipi rural' },
      { codi: '252347', classificacio: 'Municipi amb aplicació parcial de les mesures del règim especial' },
      { codi: '250169', classificacio: 'Municipi amb aplicació de les mesures del règim especial' },
    ],
    ['250024', '252154', '252347', '250169', alcoletge],
    '2026-10-06',
  );
  assert.deepEqual(
    ['250024', '252154', '252347', '250169', alcoletge].map(code => [
      code,
      statuses[code].category,
      statuses[code].effectiveFrom,
    ]),
    [
      ['250024', 'special_attention', '2026-02-24'],
      ['252154', 'rural', '2026-02-24'],
      ['252347', 'partial', '2026-02-24'],
      // Added by Resolució PRE/3375/2026.
      ['250169', 'rural', '2026-09-29'],
      [alcoletge, 'not_listed', null],
    ],
  );
  assert.match(statuses['250169'].legalUrl ?? '', /documentId=1055370/);
  assert.equal(statuses[alcoletge].legalUrl, undefined);
  assert.ok(Object.values(statuses).every(status => status.observedAt === '2026-10-06'));
  assert.throws(() => ruralStatuses([{ codi: alcoletge, classificacio: 'Municipi nou' }], [alcoletge], '2026'));
  assert.throws(() => ruralStatuses([{ codi: alcoletge }], [alcoletge], '2026'), /without a classification/);
});

test('schools are kept by distance to a town centre, or by municipality when they have no coordinates', () => {
  const centre = { latitude: 41.6445, longitude: 0.6936 };
  const places = [{ code: alcoletge, name: 'Alcoletge', comarca: 'Segrià', centre }];
  const row = (id: string, extra: Record<string, string>) => ({
    codi_centre: id,
    denominaci_completa: `Escola ${id}`,
    codi_municipi_6: '251207',
    curs: '2026/2027',
    codi_naturalesa: '2',
    epri: 'EPRI',
    ...extra,
  });
  const schools = schoolsNear(
    [
      row('near', { coordenades_geo_y: '41.62', coordenades_geo_x: '0.63', eso: 'ESO', nom_localitat: ' Lleida ' }),
      row('far', { coordenades_geo_y: '42.4', coordenades_geo_x: '1.1' }),
      row('unlocated-here', { codi_municipi_6: alcoletge, codi_naturalesa: '1' }),
      row('unlocated-elsewhere', {}),
      row('no-stage', { codi_municipi_6: alcoletge, epri: '' }),
    ],
    places,
  );
  assert.deepEqual(
    schools.map(school => [school.id, school.public, school.stages.join('+'), school.locality]),
    [
      ['near', false, 'primary+eso', 'Lleida'],
      ['unlocated-here', true, 'primary', null],
    ],
  );
  assert.equal(schools[1].coordinates, null);
  assert.ok(schools.every(school => school.observedAt === '2026/2027' && school.sourceUrl.endsWith('/d/kvmv-ahh4')));
});

test('the annual sales sheet becomes dated resale metrics and a changed layout is refused', () => {
  const places = [
    { code: alcoletge, name: 'Alcoletge', comarca: 'Segrià' },
    { code: '252154', name: 'Talarn', comarca: 'Pallars Jussà' },
  ];
  const sheets = { municipis: salesSheet('municipis', 2025, 975.85), ambits: salesSheet('ambits', 2025, 1323) };
  const value = salesMetrics(sheets, places, 2025);
  assert.deepEqual(
    value.townMetrics[alcoletge].map(entry => [entry.kind, entry.value, entry.observedAt, entry.sourceUrl]),
    [
      ['resale_transactions', 30, '2025', salesUrl('municipis', 2025)],
      ['resale_eur_per_m2', 975.85, '2025', salesUrl('municipis', 2025)],
    ],
  );
  assert.deepEqual(value.townMetrics['252154'], [], 'towns the statistic does not cover get no figure');
  assert.deepEqual(
    value.comarcaMetrics.Segrià.map(entry => [entry.value, entry.geography, entry.geographyName, entry.sourceUrl]),
    [[1223, 'comarca', 'Segrià', salesUrl('ambits', 2025)]],
  );
  // A sheet for another period, such as a quarter of a year in progress, is not an annual figure.
  assert.throws(() => salesMetrics(sheets, places, 2026), /Unexpected annual municipis/);
  // A comarca the workbook does not price is left out; pricing none at all is a broken download.
  assert.deepEqual(
    Object.keys(
      salesMetrics(sheets, [...places, { code: '999999', name: 'Nowhere', comarca: 'Enlloc' }], 2025).comarcaMetrics,
    ),
    ['Pallars Jussà', 'Segrià'],
  );
  assert.throws(
    () => salesMetrics(sheets, [{ code: '999999', name: 'Nowhere', comarca: 'Enlloc' }], 2025),
    /No comarca resale reference price found/,
  );
});

test('sales use the latest complete year and a network failure never downgrades to an older one', async () => {
  const seen: string[] = [];
  const context = (answer: (year: number) => Response) =>
    createSourceContext({
      municipalities: sourceTowns,
      now: clock().now,
      retryDelayMs: 0,
      fetch: (async (input: string | URL | Request) => {
        const [, scope, year] = /per_(municipis|ambits)_(\d{4})/.exec(String(input)) ?? [];
        seen.push(year);
        const response = answer(Number(year));
        return response.ok
          ? new Response(workbook(year, salesSheet(scope as 'municipis' | 'ambits', Number(year), 1000)))
          : response;
      }) as typeof globalThis.fetch,
    });
  const thisYear = Number(today.slice(0, 4));
  // Last year's annual sheet is not out yet: the year before is used.
  const older = await runSource(
    sales,
    context(year => json({}, year === thisYear - 1 ? 404 : 200)),
  );
  assert.equal(older.year, thisYear - 2);
  assert.ok(!seen.includes(String(thisYear)), 'the year in progress is never asked for');
  // The server is failing: report it, so the cache keeps the newer value it already has.
  await assert.rejects(
    runSource(
      sales,
      context(year => json({}, year === thisYear - 1 ? 503 : 200)),
    ),
    /503 from/,
  );
  const pinned = createSourceContext({ municipalities: sourceTowns, env: { SALES_YEAR: '2019' }, now: clock().now });
  await assert.rejects(runSource(sales, pinned));
});

test('the rail feed is reduced to the RL1/RL2 corridor and refused when it does not cover today', async () => {
  const feed = await readRail(gtfs(), today);
  assert.deepEqual(
    [feed.observedAt, feed.validFrom, feed.validThrough, feed.sourceUrl],
    ['test-feed', today, today, 'https://www.fgc.cat/google/google_transit.zip'],
  );
  assert.deepEqual(feed.dates, { [today]: ['S1'] }, 'removed and off-corridor services are not active');
  assert.deepEqual(
    feed.stops.map(stop => [stop.id, stop.municipalityCode]),
    [
      ['LE1', '251207'],
      ['AT1', alcoletge],
    ],
  );
  assert.deepEqual(feed.trips[0], {
    service: 'S1',
    line: 'RL1',
    calls: [
      ['LE1', 28800, 28800],
      ['AT1', 29400, 29460],
    ],
  });
  assert.equal(feed.trips.length, 2);
  rail.schema.parse(feed);
  await assert.rejects(readRail(gtfs({ feedEnd: `${day.slice(0, 4)}0102` }), today), /does not cover today/);
  await assert.rejects(readRail(gtfs({ calendar: true }), today), /calendar format changed/);
  await assert.rejects(readRail(gtfs(), '2020-01-01'), /does not cover today/);
  await assert.rejects(readRail(zipSync({ 'stops.txt': strToU8('stop_id\n') }), today), /Missing feed_info/);
});

/** A test source that reports a new population for Alcoletge and for a code outside the snapshot. */
function populationSource(overrides: Partial<Parameters<typeof defineSource<Record<string, Metric[]>>>[0]> = {}) {
  return defineSource<Record<string, Metric[]>>({
    id: 'test-population',
    title: 'Test population',
    authority: 'Test',
    homepage: 'https://example.org/population',
    ttlMs: hour,
    schema: z.record(municipalityCode, z.array(metric)),
    fetch: context => context.json('https://example.org/population.json'),
    overlay: withMetrics,
    ...overrides,
  });
}

function population(value: number, town: { code: string; name: string }): Record<string, Metric[]> {
  const entry: Metric = {
    kind: 'population',
    value,
    unit: 'residents',
    geography: 'municipality',
    geographyName: town.name,
    observedAt: '2026',
    sourceUrl: 'https://example.org/population',
  };
  return { [town.code]: [entry], '999999': [{ ...entry, geographyName: 'Nowhere' }] };
}

test('live data overlays cached values on the committed snapshot and keeps them when a refresh fails', async t => {
  const cacheDir = await temporaryDirectory(t);
  const time = clock();
  const town = baseline.snapshot.municipalities.find(({ code }) => code === alcoletge)!;
  let respond = () => json(population(4000, town));
  const fetch = (async () => respond()) as typeof globalThis.fetch;
  const options = { cacheDir, fetch, now: time.now, sources: [populationSource()], retryDelayMs: 0 };
  const live = createLiveData(options);

  // Nothing cached: exactly the committed data, in the shape loadData() returns.
  assert.deepEqual(live.current(), baseline);
  assert.deepEqual(
    live.status().map(source => [source.id, source.status, source.applied]),
    [['test-population', 'never', false]],
  );

  const [warmed] = await live.warm();
  assert.deepEqual([warmed.status, warmed.applied, warmed.error], ['fresh', true, null]);
  const current = live.current();
  assert.deepEqual(Object.keys(current), ['snapshot', 'policies', 'travelEstimates']);
  const metricOf = (data: typeof baseline, kind: string) =>
    data.snapshot.townMetrics[alcoletge].find(entry => entry.kind === kind);
  assert.deepEqual(
    [metricOf(current, 'population')?.value, metricOf(current, 'population')?.observedAt],
    [4000, '2026'],
  );
  assert.equal(metricOf(current, 'population')?.sourceUrl, 'https://example.org/population');
  // Everything the source did not report keeps its committed value, date and source.
  assert.deepEqual(metricOf(current, 'area_km2'), metricOf(baseline, 'area_km2'));
  assert.deepEqual(current.snapshot.municipalities, baseline.snapshot.municipalities);
  assert.equal(current.snapshot.townMetrics['999999'], undefined, 'unknown municipality codes are ignored');
  assert.deepEqual(current.snapshot.rail, baseline.snapshot.rail);
  assert.deepEqual(current.policies, baseline.policies);
  assert.equal(live.current(), current, 'the overlay is computed once per cache change');

  // The source goes down after the value expires: the last good value is still served.
  time.advance(2 * hour);
  respond = () => json({ error: 'maintenance' }, 503);
  const [failed] = await live.warm();
  assert.deepEqual([failed.status, failed.applied, failed.fetchedAt], ['error', true, warmed.fetchedAt]);
  assert.match(failed.error ?? '', /503/);
  assert.equal(metricOf(live.current(), 'population')?.value, 4000);

  // A restart with the source still down serves the cached value from disk.
  const restarted = createLiveData(options);
  assert.equal(metricOf(restarted.current(), 'population')?.value, 4000);

  // start() refreshes in the background; reads never wait for it.
  time.advance(2 * hour);
  respond = () => json(population(4100, town));
  restarted.start();
  assert.equal(metricOf(restarted.current(), 'population')?.value, 4000);
  await restarted.idle();
  restarted.stop();
  assert.equal(metricOf(restarted.current(), 'population')?.value, 4100);
  assert.equal(restarted.status()[0].status, 'fresh');
});

test('live data falls back to the committed snapshot when a source is down or its overlay is unsafe', async t => {
  const time = clock();
  const town = baseline.snapshot.municipalities.find(({ code }) => code === alcoletge)!;
  const down = (async () => {
    throw new Error('network unreachable');
  }) as typeof globalThis.fetch;
  const offline = createLiveData({
    cacheDir: await temporaryDirectory(t),
    fetch: down,
    now: time.now,
    sources: [populationSource()],
    retryDelayMs: 0,
  });
  const [status] = await offline.warm();
  assert.deepEqual([status.status, status.applied, status.error], ['error', false, 'network unreachable']);
  assert.deepEqual(offline.current(), baseline);

  const ok = (async () => json(population(4000, town))) as typeof globalThis.fetch;
  const renaming = populationSource({
    id: 'test-renaming',
    overlay: data => ({
      ...data,
      snapshot: {
        ...data.snapshot,
        municipalities: data.snapshot.municipalities.map(entry => ({ ...entry, code: '000000' })),
      },
    }),
  });
  const wrongScope = populationSource({
    id: 'test-wrong-scope',
    overlay: (data, value) => withMetrics(data, { [alcoletge]: value['999999'] }),
  });
  const keyed = populationSource({
    id: 'test-keyed',
    env: [{ name: 'TEST_SOURCE_KEY', description: 'Key for the test API', required: true }],
  });
  const unsafe = createLiveData({
    cacheDir: await temporaryDirectory(t),
    fetch: ok,
    now: time.now,
    sources: [renaming, wrongScope, keyed],
    env: {},
  });
  const statuses = await unsafe.warm();
  assert.deepEqual(
    statuses.map(source => [source.status, source.applied]),
    [
      ['fresh', false],
      ['fresh', false],
      ['error', false],
    ],
  );
  assert.match(statuses[0].notAppliedReason ?? '', /may not change the list of municipalities/);
  assert.match(statuses[1].notAppliedReason ?? '', /Overlay rejected/);
  assert.match(statuses[2].error ?? '', /Missing environment variable TEST_SOURCE_KEY/);
  assert.deepEqual(statuses[2].env, [
    { name: 'TEST_SOURCE_KEY', description: 'Key for the test API', required: true, set: false },
  ]);
  assert.deepEqual(unsafe.current(), baseline);

  // A cache older than the committed snapshot must not overwrite it.
  const cacheDir = await temporaryDirectory(t);
  const before = Date.parse(`${baseline.snapshot.generatedOn}T12:00:00Z`) - 48 * hour;
  await createLiveData({ cacheDir, fetch: ok, now: () => new Date(before), sources: [populationSource()] }).warm();
  const later = createLiveData({ cacheDir, fetch: ok, now: time.now, sources: [populationSource()] });
  assert.deepEqual(later.current(), baseline);
  assert.match(later.status()[0].notAppliedReason ?? '', /snapshot is newer/);
});

test('the registered sources warm from an injected fetch into a valid live snapshot', async t => {
  const hosts: string[] = [];
  const time = clock();
  const live = createLiveData({ cacheDir: await temporaryDirectory(t), fetch: officialFetch(hosts), now: time.now });
  const statuses = await live.warm();
  assert.deepEqual(
    statuses.map(source => [source.id, source.status, source.applied, source.error]),
    allSourceIds.map(id => [id, 'fresh', true, null]),
  );
  const { snapshot } = live.current();
  validateSnapshot(snapshot);
  assert.equal(snapshot.version, baseline.snapshot.version);
  const metricOf = (kind: string) => snapshot.townMetrics[alcoletge].find(entry => entry.kind === kind);
  const serviceOf = (kind: string, code = alcoletge) => snapshot.services?.[code].find(entry => entry.kind === kind);
  assert.equal(metricOf('population')?.value, 505);
  assert.equal(serviceOf('library')?.observedAt, today);
  // Kinds the directory did not list this time keep their committed count.
  const committed = baseline.snapshot.services?.[alcoletge] ?? [];
  assert.deepEqual(
    snapshot.services?.[alcoletge].map(entry => entry.kind),
    committed.map(entry => entry.kind),
  );
  assert.deepEqual(
    serviceOf('sports'),
    committed.find(entry => entry.kind === 'sports'),
  );

  // Every other part of the snapshot is live too, each value with its own date and source.
  assert.deepEqual(
    snapshot.municipalities.map(({ code, name, comarca, centre }) => ({ code, name, comarca, centre })),
    baseline.snapshot.municipalities.map(({ code, name, comarca, centre }) => ({ code, name, comarca, centre })),
    'sources never change which municipalities exist, their names or their centres',
  );
  const town = snapshot.municipalities.find(({ code }) => code === alcoletge);
  assert.deepEqual([town?.rural.category, town?.rural.observedAt], ['rural', today]);
  assert.deepEqual([snapshot.rail.observedAt, snapshot.rail.stops.length], ['test-feed', 2]);
  assert.deepEqual([snapshot.schools.length, snapshot.schoolDirectory.observedAt], [towns.length, today]);
  assert.deepEqual([metricOf('resale_eur_per_m2')?.value, metricOf('resale_eur_per_m2')?.observedAt], [1000, '2025']);
  assert.deepEqual([metricOf('retail_establishments')?.value, metricOf('retail_per_1000')?.observedAt], [12, '2023']);
  assert.ok(
    Object.values(snapshot.comarcaMetrics).every(([entry]) => entry.value === 900 && entry.observedAt === '2025'),
  );
  assert.deepEqual(Object.keys(snapshot.comarcaMetrics), Object.keys(baseline.snapshot.comarcaMetrics));
  // Counts that follow from schools, stops and shops are recomputed from the fresh data, exactly.
  assert.deepEqual(
    [serviceOf('school')?.count, serviceOf('rail_station')?.count, serviceOf('retail')?.count],
    [1, 1, 12],
  );
  assert.equal(serviceOf('rail_station')?.observedAt, 'test-feed');
  assert.equal(serviceOf('rail_station', '252347'), undefined, 'a stop the feed no longer lists is not counted');
  assert.deepEqual([serviceOf('social_services')?.count, serviceOf('social_services')?.observedAt], [2, today]);
  assert.equal(serviceOf('pharmacy'), undefined);

  assert.deepEqual([...new Set(hosts)].sort(), [
    'analisi.transparenciacatalunya.cat',
    'api.idescat.cat',
    'habitatge.gencat.cat',
    'www.fgc.cat',
  ]);
  const requests = hosts.length;
  await live.warm();
  assert.equal(hosts.length, requests, 'warming again does not refetch fresh sources');
});

test('a slow or failing heavy source neither delays nor undoes the other sources', async t => {
  const time = clock();
  let releaseFeed: (response: Response) => void = () => {};
  const fetch = officialFetch([], url => {
    // The timetable download hangs and the sales workbook is broken.
    if (url.hostname === 'www.fgc.cat') return new Promise<Response>(resolve => void (releaseFeed = resolve));
    if (url.hostname === 'habitatge.gencat.cat') return new Response(strToU8('not a workbook'));
    return undefined;
  });
  const cacheDir = await temporaryDirectory(t);
  const live = createLiveData({ cacheDir, fetch, now: time.now, retryDelayMs: 0, refreshTimeoutMs: 60_000 });
  const warming = live.warm();
  const pending = () =>
    live
      .status()
      .filter(source => source.refreshing)
      .map(source => source.id);
  while (pending().length > 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(pending(), ['fgc-gtfs']);

  // While the feed is still downloading, everything else is already served.
  const during = live.current().snapshot;
  assert.equal(during.townMetrics[alcoletge].find(entry => entry.kind === 'population')?.value, 505);
  assert.equal(during.services?.[alcoletge].find(entry => entry.kind === 'social_services')?.count, 2);
  assert.deepEqual(during.rail, baseline.snapshot.rail, 'the committed timetable stays until a new one is valid');
  assert.deepEqual(during.comarcaMetrics, baseline.snapshot.comarcaMetrics, 'so do the committed sale prices');
  const byId = () => Object.fromEntries(live.status().map(source => [source.id, source]));
  assert.deepEqual(
    [byId()['gencat-compravendes-habitatge'].status, byId()['gencat-compravendes-habitatge'].applied],
    ['error', false],
  );
  assert.equal(live.status().filter(source => source.applied).length, allSourceIds.length - 2);

  releaseFeed(new Response(gtfs()));
  await warming;
  assert.equal(live.current().snapshot.rail.observedAt, 'test-feed');
  assert.deepEqual([byId()['fgc-gtfs'].status, byId()['fgc-gtfs'].applied], ['fresh', true]);

  // A feed that no longer covers today is refused and the last good timetable is kept.
  time.advance(25 * hour);
  const stale = createLiveData({
    cacheDir,
    now: time.now,
    retryDelayMs: 0,
    fetch: officialFetch([], url =>
      url.hostname === 'www.fgc.cat' ? new Response(gtfs({ feedEnd: `${day.slice(0, 4)}0102` })) : undefined,
    ),
  });
  const refreshed = Object.fromEntries((await stale.warm()).map(source => [source.id, source]));
  assert.deepEqual([refreshed['fgc-gtfs'].status, refreshed['fgc-gtfs'].applied], ['error', true]);
  assert.match(refreshed['fgc-gtfs'].error ?? '', /does not cover today/);
  assert.equal(stale.current().snapshot.rail.observedAt, 'test-feed');
});
