import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import type { Metric } from '../packages/contracts/places.ts';
import { metric, municipalityCode } from '../packages/contracts/places.ts';
import { loadData } from '../packages/places/data.ts';
import { createSourceCache } from '../packages/sources/cache.ts';
import equipaments, { countFacilities } from '../packages/sources/definitions/gencat-equipaments.ts';
import emex, { emexMetrics } from '../packages/sources/definitions/idescat-emex.ts';
import { createRequester, createSourceContext } from '../packages/sources/http.ts';
import { createLiveData } from '../packages/sources/live.ts';
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
  assert.deepEqual(ids, ['gencat-equipaments', 'idescat-emex']);
  const files = await readdir(new URL('../packages/sources/definitions/', import.meta.url));
  assert.ok(files.includes('_template.ts'));
  assert.equal(files.filter(name => !name.startsWith('_')).length, ids.length);
  assert.deepEqual(
    (await discoverSources()).map(source => source.id),
    ids,
  );
  for (const source of sources) {
    assert.ok(source.title && source.authority && source.ttlMs > 0 && source.overlay);
    assert.match(new URL(source.homepage).hostname, /(^|\.)(idescat|transparenciacatalunya|gencat)\.cat$/);
    assert.deepEqual(source.env ?? [], [], 'Catalan open data needs no API key');
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

/** Answers the two real sources from canned data, so the whole live path runs without a network. */
function officialFetch(log: string[] = []) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    log.push(url.hostname);
    if (url.hostname === 'api.idescat.cat') {
      return json(
        emexProfile({ f261: '10', f262: '50.5', f321: '505', f184: '101', f263: '505', f407: '400', f406: '9' }),
      );
    }
    if (url.pathname.startsWith('/api/views/'))
      return json({ rowsUpdatedAt: Date.parse('2026-11-22T02:00:00Z') / 1000 });
    return json(
      baseline.snapshot.municipalities.map(({ code }, index) => ({
        idequipament: String(index),
        nom: 'Biblioteca',
        categoria: 'Cultura|Biblioteques||',
        codi_municipi: code.replace(/^0/, ''),
      })),
    );
  }) as typeof globalThis.fetch;
}

test('the shipped sources run against an injected fetch and validate their own output', async () => {
  const context = createSourceContext({ municipalities: baseline.snapshot.municipalities, fetch: officialFetch() });
  const metrics = await runSource(emex, context);
  const services = await runSource(equipaments, context);
  assert.deepEqual(Object.keys(metrics).sort(), baseline.snapshot.municipalities.map(town => town.code).sort());
  assert.equal(metrics[alcoletge].find(entry => entry.kind === 'foreign_population_percent')?.value, 20);
  assert.deepEqual(
    services['080312'].map(entry => [entry.kind, entry.count, entry.observedAt]),
    [['library', 1, '2026-11-22']],
  );
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
    [
      ['gencat-equipaments', 'fresh', true, null],
      ['idescat-emex', 'fresh', true, null],
    ],
  );
  const { snapshot } = live.current();
  assert.equal(snapshot.version, baseline.snapshot.version);
  assert.equal(snapshot.townMetrics[alcoletge].find(entry => entry.kind === 'population')?.value, 505);
  assert.equal(snapshot.services?.[alcoletge].find(entry => entry.kind === 'library')?.observedAt, '2026-11-22');
  // Kinds the directory did not list this time keep their committed count.
  const committed = baseline.snapshot.services?.[alcoletge] ?? [];
  assert.deepEqual(
    snapshot.services?.[alcoletge].map(entry => entry.kind),
    committed.map(entry => entry.kind),
  );
  assert.deepEqual(
    snapshot.services?.[alcoletge].find(entry => entry.kind === 'sports'),
    committed.find(entry => entry.kind === 'sports'),
  );
  assert.deepEqual([...new Set(hosts)].sort(), ['analisi.transparenciacatalunya.cat', 'api.idescat.cat']);
  await live.warm();
  assert.equal(new Set(hosts).size, 2);
  const requests = hosts.length;
  await live.warm();
  assert.equal(hosts.length, requests, 'warming again does not refetch fresh sources');
});
