import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  businessResult, incentivesResult, municipalityListResult, profileResult, recommendationResult, schoolResult, transportResult,
} from "../packages/contracts/places.ts";
import { loadData } from "../packages/places/data.ts";
import { createHttpServer } from "../apps/mcp-server/http.ts";

const { snapshot, policies } = loadData();
const server = createHttpServer(snapshot, policies, { today: () => "2026-11-21" });
const client = new Client({ name: "relocat-tests", version: "1.0.0" });
let base: URL;
const travelDate = "2026-11-23";
const termens = "252206";
const balaguer = "250404";

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  base = new URL(`http://127.0.0.1:${address.port}/`);
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base)));
});

after(async () => {
  await client.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function tool(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  assert(!response.isError, JSON.stringify(response.content));
  assert(response.structuredContent);
  return response.structuredContent;
}

test("discovers schemas and exposes sourced profiles, schools and business indicators", async () => {
  assert.equal(client.getServerVersion()?.name, "relocat");
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 8);
  assert(listed.tools.every(tool => tool.inputSchema && tool.outputSchema && tool.annotations?.readOnlyHint));

  const coverage = municipalityListResult.parse(await tool("list_catalonia_municipalities", { query: "termens" }));
  assert.deepEqual(coverage.municipalities.map(town => town.code), [termens]);
  const profile = profileResult.parse(await tool("get_town_profile", { municipalityCode: termens, travelDate }));
  assert.equal(profile.municipality.name, "Térmens");
  assert(profile.dataMissing.includes("rent_eur_per_month"));
  assert(profile.metrics.every(metric => metric.observedAt && metric.sourceUrl.startsWith("https:")));
  assert.equal(profile.railway.sampleConnectionToLleida?.scheduleCoverage, "covered");

  const schools = schoolResult.parse(await tool("get_nearby_schools", { municipalityCode: termens, stage: "eso", mode: "rail", travelDate }));
  assert(schools.schools.some(journey => journey.school.municipalityCode === balaguer && journey.rail?.line === "RL2"));
  const business = businessResult.parse(await tool("get_business_activity", { municipalityCode: termens }));
  assert(business.metrics.some(metric => metric.kind === "retail_establishments" && metric.observedAt === "2023"));
});

test("screens a three-town rural rail shortlist and requires opt-in to comarca purchase prices", async () => {
  const args = {
    travelDate, ruralOnly: true, schoolStages: ["eso"], schoolMode: "rail", maxSchoolJourneyMinutes: 50,
    housing: { tenure: "buy", homeSizeM2: 85, maxBudgetEur: 130_000 },
  };
  const localOnly = recommendationResult.parse(await tool("recommend_towns", args));
  assert.deepEqual(localOnly.towns.map(town => town.municipality.code), ["252402"]);
  assert(localOnly.excluded.some(town => town.municipalityCode === termens && town.dataMissing.includes("resale_eur_per_m2")));

  const shortlist = recommendationResult.parse(await tool("recommend_towns", {
    ...args, housing: { ...args.housing, allowComarcaEstimate: true },
  }));
  assert.deepEqual(shortlist.towns.map(town => town.municipality.code), [termens, "252402", "252542"]);
  assert.deepEqual(shortlist.towns.map(town => town.housingEstimate?.metric.geography), ["comarca", "municipality", "comarca"]);
  assert(shortlist.towns.every(town => town.schools[0].rail && town.incentives.every(policy => policy.eligibilityStatus === "needs_verification")));

  const invalid = await client.callTool({ name: "recommend_towns", arguments: { housing: { tenure: "buy", maxBudgetEur: 100_000 } } });
  assert(invalid.isError);
});

test("uses dated rail trips and reports dates outside the snapshot", async () => {
  const query = { municipalityCode: termens, destinationCode: balaguer, travelDate, departFrom: "07:45", departBy: "07:50" };
  const response = transportResult.parse(await tool("get_transport_options", query));
  assert.equal(response.scheduleCoverage, "covered");
  assert.equal(response.totalDepartures, 1);
  assert.equal(response.routes[0].departure, "07:49:00");
  assert.equal(response.routes[0].arrival, "07:57:30");
  assert.equal(response.routes[0].durationMinutes, 9);
  const expired = transportResult.parse(await tool("get_transport_options", { ...query, travelDate: "2027-02-01" }));
  assert.equal(expired.scheduleCoverage, "outside_snapshot");
  assert.deepEqual(expired.routes, []);
});

test("keeps call availability, exact geographic scope and household eligibility independent", async () => {
  const catalogue = incentivesResult.parse(await tool("get_applicable_incentives", { municipalityCode: termens, intent: "renovate" }));
  const grant = catalogue.incentives.find(entry => entry.id === "renovation_grant_2026");
  assert.equal(grant?.callStatus, "closed");
  assert.equal(grant.eligibilityStatus, "needs_verification");

  const household = {
    primaryResidence: true, age: 35, filing: "individual", irpfNetTaxBaseEur: 30_000, firstRuralMove: true, singleParent: false,
  };
  const input = { municipalityCode: termens, intent: "move", eventDate: travelDate, household };
  const move = incentivesResult.parse(await tool("check_housing_incentives", input)).incentives[0];
  assert.equal(move.eligibilityStatus, "eligible");
  assert.match(move.benefit, /special attention €1,000/);
  assert.equal(move.screenedAmountEur, 1000);
  const matchingMeasure = incentivesResult.parse(await tool("get_applicable_incentives", input)).incentives[0];
  assert.deepEqual(matchingMeasure, move);
  const overLimit = incentivesResult.parse(await tool("check_housing_incentives", {
    ...input, household: { ...household, irpfNetTaxBaseEur: 30_001 },
  }));
  assert.equal(overLimit.incentives[0].eligibilityStatus, "ineligible");

  const future = incentivesResult.parse(await tool("check_housing_incentives", {
    ...input, eventDate: "2028-01-01", household: { ...household, irpfNetTaxBaseEur: 30_001 },
  }));
  assert.equal(future.incentives[0].eligibilityStatus, "needs_verification");
  assert.deepEqual(future.incentives[0].unmetCriteria, []);

  for (const [nucleus, status] of [[undefined, "needs_verification"], ["Tremp", "does_not_apply"], ["Palau de Noguera", "applies"]]) {
    const area = incentivesResult.parse(await tool("check_housing_incentives", {
      municipalityCode: "252347", intent: "buy", eventDate: travelDate, nucleus,
    }));
    assert(area.incentives.every(entry => entry.geographicStatus === status));
    assert(area.incentives.every(entry => entry.eligibilityStatus !== "eligible"));
  }
});

test("checks health and rejects unexpected browser origins", async () => {
  const health = await fetch(new URL("/health", base));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).snapshot.version, snapshot.version);
  const crossOrigin = await fetch(new URL("/mcp", base), { method: "POST", headers: { Origin: "https://example.com" } });
  assert.equal(crossOrigin.status, 403);
});
