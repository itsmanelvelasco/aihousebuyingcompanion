import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeSearchResult } from '../packages/contracts/listings.ts';
import { open } from '../packages/db/database.ts';
import { createListingBudget } from '../packages/listings/budget.ts';
import type { ListingSearchConfig } from '../packages/listings/search.ts';
import { searchHomes } from '../packages/listings/search.ts';
import { loadData } from '../packages/places/data.ts';

const { snapshot } = loadData();
/** Each call gets its own budget unless the test supplies one, so tests do not share caps or cache. */
const freshSearch = (data: typeof snapshot, raw: unknown, config: ListingSearchConfig) =>
  searchHomes(data, raw, { budget: createListingBudget(), ...config });
const input = { municipalityCodes: ['080312'], operation: 'buy', maxPriceEur: 150000, minBedrooms: 2, limitPerTown: 2 };
const now = () => new Date('2026-11-21T13:00:00Z');
const response = (results: unknown[]) =>
  new Response(JSON.stringify({ output: { results } }), {
    headers: { 'Content-Type': 'application/json', 'X-Treg-Cost-Micro': '380' },
  });

test('live adapter sends bounded search hints and returns only deduplicated Idealista links', async () => {
  let calls = 0;
  const result = homeSearchResult.parse(
    await freshSearch(
      snapshot,
      { ...input, municipalityCodes: ['080312', '080312'] },
      {
        token: 'test-secret',
        org: 'test-team',
        now,
        fetch: async (url, options) => {
          calls++;
          assert.equal(url, 'https://treg.to/call/treg.google.serp.organic');
          const headers = new Headers(options?.headers);
          assert.equal(headers.get('X-Treg-Route-Max-Cost'), '0.01');
          assert.equal(headers.get('Cache-Control'), 'no-cache');
          assert.equal(headers.get('X-Treg-Token'), 'test-secret');
          assert.equal(headers.get('X-Treg-Org'), 'test-team');
          assert.equal(options?.redirect, 'error');
          const body = JSON.parse(options?.body as string);
          assert.match(body.q, /"Calaf" "Anoia" venta vivienda hasta 150000 euros 2 dormitorios/);
          assert.equal(body.country, 'es');
          return response([
            { title: 'Wrong domain', url: 'https://idealista.com.evil.test/inmueble/1/' },
            { title: 'Not a listing', url: 'https://www.idealista.com/venta-viviendas/calaf-barcelona/' },
            { title: 'Unsafe URL', url: 'https://user:secret@www.idealista.com/inmueble/1/' },
            {
              title: 'Property example',
              url: 'https://www.idealista.com/inmueble/123/?tracking=1',
              snippet: 'Source text',
            },
            { title: 'Duplicate', link: 'https://idealista.com/en/inmueble/123/' },
            { title: 'Second example', link: 'https://www.idealista.com/inmueble/456/', description: 'Another source' },
            { title: 'Beyond limit', url: 'https://www.idealista.com/inmueble/789/' },
          ]);
        },
      },
    ),
  );
  assert.equal(calls, 1);
  const search = result.searches[0];
  assert.equal(search.status, 'ok');
  assert.equal(search.costUsd, 0.00038);
  assert.deepEqual(
    search.examples.map(e => e.listingId),
    ['123', '456'],
  );
  assert(search.examples.every(e => e.municipalityCode === null && e.availability === 'unknown' && !e.filtersVerified));
  assert.equal(search.examples[0].url, 'https://www.idealista.com/inmueble/123/');
  assert(!JSON.stringify(result).includes('test-secret'));
});

test('missing credentials, empty results and provider failures remain distinct', async () => {
  const missing = await freshSearch(snapshot, input, {
    now,
    fetch: async () => {
      throw new Error('must not call');
    },
  });
  assert.equal(missing.searches[0].status, 'provider_unavailable');
  assert.match(missing.searches[0].searchUrl, /^https:\/\/www.google.com\/search\?q=/);
  const empty = await freshSearch(snapshot, input, { token: 'test', now, fetch: async () => response([]) });
  assert.equal(empty.searches[0].status, 'no_indexed_examples');
  for (const [status, code] of [
    [401, 'authentication'],
    [402, 'quota_or_cost_limit'],
    [429, 'rate_limited'],
    [503, 'upstream_error'],
  ] as const) {
    const failed = await freshSearch(snapshot, input, {
      token: 'test',
      now,
      fetch: async () => new Response('sensitive-provider-error', { status }),
    });
    assert.equal(failed.searches[0].status, 'provider_error');
    assert.equal(failed.searches[0].errorCode, code);
    assert(!JSON.stringify(failed).includes('sensitive-provider-error'));
  }
  for (const fetcher of [
    async () => new Response('{}'),
    async () => {
      throw new Error('private-token');
    },
  ]) {
    const failed = await freshSearch(snapshot, input, { token: 'test', now, fetch: fetcher });
    assert.equal(failed.searches[0].status, 'provider_error');
    assert(!JSON.stringify(failed).includes('private-token'));
  }
});

test('validates all municipality codes before spending and isolates partial failures', async () => {
  let calls = 0;
  const config = {
    token: 'test',
    now,
    fetch: async () => {
      calls++;
      return response([]);
    },
  };
  await assert.rejects(freshSearch(snapshot, { ...input, municipalityCodes: ['080312', '999999'] }, config));
  assert.equal(calls, 0);
  const mixed = await freshSearch(
    snapshot,
    { ...input, municipalityCodes: ['080312', '251180'] },
    {
      ...config,
      fetch: async () => (++calls === 1 ? new Response('', { status: 503 }) : response([])),
    },
  );
  assert.deepEqual(
    mixed.searches.map(s => s.status),
    ['provider_error', 'no_indexed_examples'],
  );
});

test('a full budget is an explicit result that keeps the free search links, and it survives a restart', async () => {
  const db = open(':memory:');
  try {
    let calls = 0;
    let time = new Date('2026-11-21T13:00:10Z');
    const fetcher = async () => {
      calls++;
      return response([{ title: 'Home', url: `https://www.idealista.com/inmueble/${calls}/` }]);
    };
    const limits = { dailyLimit: 3, perMinuteLimit: 2, cacheTtlMs: 0 };
    const config = () => ({ token: 'test', now: () => time, fetch: fetcher, budget: createListingBudget(limits, db) });
    const three = { ...input, municipalityCodes: ['080312', '251180', '250024'] };
    const first = homeSearchResult.parse(await searchHomes(snapshot, three, config()));
    assert.deepEqual(
      first.searches.map(item => [item.status, item.errorCode]),
      [
        ['ok', null],
        ['ok', null],
        ['budget_exhausted', 'minute_limit'],
      ],
    );
    assert.equal(calls, 2, 'the refused town made no paid call');
    assert.match(first.searches[2].searchUrl, /^https:\/\/www\.google\.com\/search\?q=/);
    assert.deepEqual(first.searches[2].examples, []);
    assert.ok(first.limitations.some(text => text.includes('budget_exhausted')));
    // The next minute allows one more, then the day is spent. A new budget object over the same
    // database (a restarted server) still knows it.
    time = new Date('2026-11-21T13:01:10Z');
    const second = await searchHomes(snapshot, three, config());
    assert.deepEqual(
      second.searches.map(item => item.errorCode),
      [null, 'daily_limit', 'daily_limit'],
    );
    assert.equal(calls, 3);
    time = new Date('2026-11-21T23:59:59Z');
    assert.equal((await searchHomes(snapshot, input, config())).searches[0].status, 'budget_exhausted');
    time = new Date('2026-11-22T00:00:00Z');
    assert.equal((await searchHomes(snapshot, input, config())).searches[0].status, 'ok');
    assert.equal(calls, 4);
  } finally {
    db.close();
  }
});

test('an identical search within the cache time is not a second charge', async () => {
  let calls = 0;
  let time = new Date('2026-11-21T13:00:00Z');
  const config = {
    token: 'test',
    now: () => time,
    budget: createListingBudget({ dailyLimit: 2, perMinuteLimit: 5, cacheTtlMs: 60_000 }),
    fetch: async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 503 })
        : response([{ title: 'Home', url: 'https://www.idealista.com/inmueble/7/' }]);
    },
  };
  // A failure is not cached: the retry reaches the provider.
  assert.equal((await searchHomes(snapshot, input, config)).searches[0].status, 'provider_error');
  const paid = (await searchHomes(snapshot, input, config)).searches[0];
  assert.equal(paid.costUsd, 0.00038);
  assert.equal(paid.cached, undefined);
  time = new Date('2026-11-21T13:00:30Z');
  const retry = homeSearchResult.parse(await searchHomes(snapshot, input, config)).searches[0];
  assert.equal(calls, 2);
  assert.equal(retry.cached, true);
  assert.equal(retry.costUsd, 0);
  assert.deepEqual(retry.examples, paid.examples);
  // The budget is spent, yet the cached search still answers; a different search is refused.
  assert.equal(
    (await searchHomes(snapshot, { ...input, minBedrooms: 3 }, config)).searches[0].errorCode,
    'daily_limit',
  );
  time = new Date('2026-11-21T13:02:00Z');
  assert.equal((await searchHomes(snapshot, input, config)).searches[0].status, 'budget_exhausted');
  assert.equal(calls, 2);
});
