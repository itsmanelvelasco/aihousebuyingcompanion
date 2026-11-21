import assert from "node:assert/strict";
import { test } from "node:test";
import { loadData } from "../packages/places/data.ts";
import { searchHomes } from "../packages/listings/search.ts";
import { homeSearchResult } from "../packages/contracts/listings.ts";
const { snapshot } = loadData();
const input = { municipalityCodes: ["080312"], operation: "buy", maxPriceEur: 150000, minBedrooms: 2, limitPerTown: 2 };
const now = () => new Date("2026-11-21T13:00:00Z");
const response = (results: unknown[]) => new Response(JSON.stringify({ output: { results } }), {
  headers: { "Content-Type": "application/json", "X-Treg-Cost-Micro": "380" },
});

test("live adapter sends bounded search hints and returns only deduplicated Idealista links", async () => {
  let calls = 0;
  const result = homeSearchResult.parse(await searchHomes(snapshot, { ...input, municipalityCodes: ["080312", "080312"] }, {
    token: "test-secret", org: "test-team", now,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, "https://treg.to/call/treg.google.serp.organic");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("X-Treg-Route-Max-Cost"), "0.01");
      assert.equal(headers.get("Cache-Control"), "no-cache");
      assert.equal(headers.get("X-Treg-Token"), "test-secret");
      assert.equal(headers.get("X-Treg-Org"), "test-team");
      assert.equal(options?.redirect, "error");
      const body = JSON.parse(options?.body as string);
      assert.match(body.q, /"Calaf" "Anoia" venta vivienda hasta 150000 euros 2 dormitorios/);
      assert.equal(body.country, "es");
      return response([
        { title: "Wrong domain", url: "https://idealista.com.evil.test/inmueble/1/" },
        { title: "Not a listing", url: "https://www.idealista.com/venta-viviendas/calaf-barcelona/" },
        { title: "Unsafe URL", url: "https://user:secret@www.idealista.com/inmueble/1/" },
        { title: "Property example", url: "https://www.idealista.com/inmueble/123/?tracking=1", snippet: "Source text" },
        { title: "Duplicate", link: "https://idealista.com/en/inmueble/123/" },
        { title: "Second example", link: "https://www.idealista.com/inmueble/456/", description: "Another source" },
        { title: "Beyond limit", url: "https://www.idealista.com/inmueble/789/" },
      ]);
    },
  }));
  assert.equal(calls, 1);
  const search = result.searches[0];
  assert.equal(search.status, "ok");
  assert.equal(search.costUsd, 0.00038);
  assert.deepEqual(search.examples.map(e => e.listingId), ["123", "456"]);
  assert(search.examples.every(e => e.municipalityCode === null && e.availability === "unknown" && !e.filtersVerified));
  assert.equal(search.examples[0].url, "https://www.idealista.com/inmueble/123/");
  assert(!JSON.stringify(result).includes("test-secret"));
});

test("missing credentials, empty results and provider failures remain distinct", async () => {
  const missing = await searchHomes(snapshot, input, { now, fetch: async () => { throw new Error("must not call"); } });
  assert.equal(missing.searches[0].status, "provider_unavailable");
  assert.equal(missing.searches[0].idealistaSearchUrl, "https://www.idealista.com/venta-viviendas/calaf-barcelona/");
  assert.match(missing.searches[0].searchUrl, /^https:\/\/www.google.com\/search\?q=/);
  const empty = await searchHomes(snapshot, input, { token: "test", now, fetch: async () => response([]) });
  assert.equal(empty.searches[0].status, "no_indexed_examples");
  for (const [status, code] of [[401, "authentication"], [402, "quota_or_cost_limit"], [429, "rate_limited"], [503, "upstream_error"]] as const) {
    const failed = await searchHomes(snapshot, input, { token: "test", now,
      fetch: async () => new Response("sensitive-provider-error", { status }) });
    assert.equal(failed.searches[0].status, "provider_error");
    assert.equal(failed.searches[0].errorCode, code);
    assert.equal(failed.searches[0].idealistaSearchUrl, missing.searches[0].idealistaSearchUrl);
    assert(!JSON.stringify(failed).includes("sensitive-provider-error"));
  }
  for (const fetcher of [async () => new Response('{}'), async () => { throw new Error("private-token"); }]) {
    const failed = await searchHomes(snapshot, input, { token: "test", now, fetch: fetcher });
    assert.equal(failed.searches[0].status, "provider_error");
    assert(!JSON.stringify(failed).includes("private-token"));
  }
});

test("manual links work without a fetch and keep rental searches scoped to each town", async () => {
  let calls = 0;
  const result = homeSearchResult.parse(await searchHomes(snapshot, {
    municipalityCodes: ["080312", "251207"], operation: "rent", maxPriceEur: 800, minBedrooms: 2,
  }, { now, fetch: async () => { calls++; return response([]); } }));
  assert.equal(calls, 0);
  const [calaf, lleida] = result.searches;
  assert.equal(calaf.idealistaSearchUrl, null);
  assert.equal(lleida.idealistaSearchUrl, "https://www.idealista.com/alquiler-viviendas/lleida-lleida/");
  assert.match(new URL(calaf.searchUrl).searchParams.get("q") ?? "", /"Calaf".*alquiler vivienda hasta 800 euros 2 dormitorios/);
  assert(result.searches.every(search => search.examples.length === 0));
  assert(result.searches.every(search => search.checkedExamples.length === 0));
});

test("dated listing examples work without a provider and honor budget and bedroom filters", async () => {
  const request = { ...input, maxPriceEur: 131000, minBedrooms: 2 };
  const result = homeSearchResult.parse(await searchHomes(snapshot, request, { now }));
  const [example] = result.searches[0].checkedExamples;
  assert.equal(example.url, "https://www.idealista.com/inmueble/113084097/");
  assert.equal(example.askingPriceEur, 131000);
  assert.equal(example.checkedOn, "2026-11-21");
  assert.equal(example.availability, "unknown");
  for (const filter of [{ maxPriceEur: 130999 }, { minBedrooms: 3 }]) {
    const filtered = await searchHomes(snapshot, { ...request, ...filter }, { now });
    assert.equal(filtered.searches[0].checkedExamples.length, 0);
  }
});

test("validates all municipality codes before spending and isolates partial failures", async () => {
  let calls = 0;
  const config = { token: "test", now, fetch: async () => { calls++; return response([]); } };
  await assert.rejects(searchHomes(snapshot, { ...input, municipalityCodes: ["080312", "999999"] }, config));
  assert.equal(calls, 0);
  const mixed = await searchHomes(snapshot, { ...input, municipalityCodes: ["080312", "251180"] }, {
    ...config, fetch: async () => ++calls === 1 ? new Response("", { status: 503 }) : response([]),
  });
  assert.deepEqual(mixed.searches.map(s => s.status), ["provider_error", "no_indexed_examples"]);
});
