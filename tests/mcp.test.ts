import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../apps/mcp-server/http.ts';
import { loadTownExplorerPage } from '../apps/mcp-server/town-explorer.ts';
import { homeSearchResult } from '../packages/contracts/listings.ts';
import {
  businessResult,
  incentivesResult,
  municipalityListResult,
  profileRecommendationResult,
  profileResult,
  recommendationResult,
  schoolResult,
  transportResult,
} from '../packages/contracts/places.ts';
import { loadData } from '../packages/places/data.ts';

const { snapshot, policies, travelEstimates } = loadData();
const server = createHttpServer(snapshot, policies, {
  today: () => '2026-11-21',
  travelEstimates,
  listings: {},
  townExplorerPage: loadTownExplorerPage(),
});
const client = new Client({ name: 'relocat-tests', version: '1.0.0' });
let base: URL;
const travelDate = '2026-11-23';
const termens = '252206';
const balaguer = '250404';

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  base = new URL(`http://127.0.0.1:${address.port}/`);
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
});

after(async () => {
  await client.close();
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
});

async function tool(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  assert(!response.isError, JSON.stringify(response.content));
  assert(response.structuredContent);
  return response.structuredContent;
}

test('discovers schemas and exposes sourced profiles, schools and business indicators', async () => {
  assert.equal(client.getServerVersion()?.name, 'relocat');
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 35);
  // Every tool reads only, except the ones that act on the signed-in person's own record: saving
  // answers, and managing their own bank data.
  const writers = listed.tools.filter(tool => !tool.annotations?.readOnlyHint).map(tool => tool.name);
  assert.deepEqual(writers.sort(), [
    'confirm_statement_import',
    'connect_my_bank',
    'delete_statement_import',
    'disconnect_my_bank',
    'preview_statement_import',
    'save_my_inputs',
    'sync_my_bank',
  ]);
  assert(listed.tools.every(tool => tool.inputSchema && tool.outputSchema));
  // No tool takes a user id from the model; this server has no accounts, so personal tools say so.
  for (const tool of listed.tools) assert(!('userId' in (tool.inputSchema.properties ?? {})), tool.name);
  const personal = await client.callTool({ name: 'get_person', arguments: {} });
  assert(personal.isError);
  const profileTool = listed.tools.find(tool => tool.name === 'recommend_towns_for_profile');
  assert.deepEqual(Object.keys(profileTool?.inputSchema.properties ?? {}).sort(), ['limit', 'profile']);
  assert.deepEqual(profileTool?.inputSchema.required, ['profile']);
  assert.equal(profileTool?.inputSchema.additionalProperties, true);

  const coverage = municipalityListResult.parse(await tool('list_catalonia_municipalities', { query: 'termens' }));
  assert.deepEqual(
    coverage.municipalities.map(town => town.code),
    [termens],
  );
  const profile = profileResult.parse(await tool('get_town_profile', { municipalityCode: termens, travelDate }));
  assert.equal(profile.municipality.name, 'Térmens');
  assert(profile.dataMissing.includes('rent_eur_per_month'));
  assert(profile.metrics.every(metric => metric.observedAt && metric.sourceUrl.startsWith('https:')));
  assert(profile.travelEstimates.some(estimate => estimate.destinationId === 'lleida' && estimate.publicTransport));
  assert.equal(profile.railway.sampleConnectionToLleida?.scheduleCoverage, 'covered');

  const schools = schoolResult.parse(
    await tool('get_nearby_schools', { municipalityCode: termens, stage: 'eso', mode: 'rail', travelDate }),
  );
  assert(schools.schools.some(journey => journey.school.municipalityCode === balaguer && journey.rail?.line === 'RL2'));
  const business = businessResult.parse(await tool('get_business_activity', { municipalityCode: termens }));
  assert(business.metrics.some(metric => metric.kind === 'retail_establishments' && metric.observedAt === '2023'));
});

test('serves the fictional interviewer cash-flow card and compares a savings habit', async () => {
  const start = await tool('start_homebuying_interview', {});
  assert(typeof start === 'object' && start !== null && 'openingQuestion' in start);
  assert.match(String(start.openingQuestion), /bank CSV.*fictional demo bank account.*monthly income and spending/);
  const launcher = (await client.listTools()).tools.find(entry => entry.name === 'start_homebuying_interview');
  assert.match(launcher?.description ?? '', /I want to buy a new home/);
  assert.match(client.getInstructions() ?? '', /call start_homebuying_interview before asking/);
  const voiceUri = 'ui://relocat/start-talking.html';
  assert.deepEqual(launcher?._meta?.ui, { resourceUri: voiceUri });
  const voiceCard = (await client.readResource({ uri: voiceUri })).contents[0];
  assert.equal(voiceCard.mimeType, 'text/html;profile=mcp-app');
  assert('text' in voiceCard);
  assert.match(voiceCard.text, /Start talking/);
  assert.match(JSON.stringify(start), /how many people will live in the home/);
  const sample = await tool('sample_cash_flow', {});
  assert(typeof sample === 'object' && sample !== null && 'monthlyNetCashFlow' in sample);
  // The demo statement runs from 1 August to 25 October: August and September are averaged, October is partial.
  assert.equal(sample.monthlyNetCashFlow, 873.5);
  assert.deepEqual(
    [
      'completeMonths' in sample && sample.completeMonths,
      'partialMonths' in sample && sample.partialMonths,
      'averageBasis' in sample && sample.averageBasis,
    ],
    [['2026-08', '2026-09'], ['2026-10'], 'complete_months'],
  );
  const resource = await client.readResource({ uri: 'ui://relocat/cash-flow.html' });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  const input = { target: 30_000, saved: 6_000, monthly: 600, currency: 'EUR' };
  const first = await tool('generate_home_savings_scenario', input);
  assert.deepEqual(first, { currency: 'EUR', remaining: 24_000, baselineMonths: 40, suggestions: [] });
  const demo = await tool('generate_home_savings_scenario', { ...input, useDemoBank: true });
  assert.match(JSON.stringify(demo), /Weekly money check-in/);
  const plan = await tool('compare_home_savings', { target: 30_000, saved: 6_000, monthly: 600, habit: 75 });
  assert.deepEqual(plan, { remaining: 24_000, baselineMonths: 40, withHabitMonths: 36 });
});

test('serves the read-only Town Explorer widget and preserves headless municipality tools', async () => {
  const { tools } = await client.listTools();
  const launcher = tools.find(tool => tool.name === 'show_town_explorer');
  const appMeta = launcher?._meta?.ui as { resourceUri: string; visibility: string[] } | undefined;
  assert(appMeta?.resourceUri);
  assert.deepEqual(appMeta.visibility, ['model']);
  for (const name of ['list_catalonia_municipalities', 'get_town_profile']) {
    assert.equal(tools.find(tool => tool.name === name)?._meta?.ui, undefined);
  }
  assert.deepEqual(await tool('show_town_explorer', {}), { municipalityCode: null });
  const selection = await tool('show_town_explorer', { municipalityCode: '080312' });
  assert.deepEqual(selection, { municipalityCode: '080312' });
  const profile = profileResult.parse(await tool('get_town_profile', selection));
  assert.equal(profile.municipality.name, 'Calaf');
  assert.equal(profile.travelEstimates.length, 6);
  assert((await client.callTool({ name: 'show_town_explorer', arguments: { municipalityCode: '083015' } })).isError);

  const recommendation = {
    tool: 'recommend_towns',
    arguments: { schoolStages: ['eso'], schoolMode: 'rail', maxSchoolJourneyMinutes: 50, travelDate, limit: 3 },
  };
  assert.deepEqual(await tool('show_town_explorer', { recommendation }), { municipalityCode: null, recommendation });
  const exploratory = { tool: 'recommend_towns_for_profile', arguments: { profile: { hasChildren: true }, limit: 3 } };
  assert.deepEqual(await tool('show_town_explorer', { recommendation: exploratory }), {
    municipalityCode: null,
    recommendation: exploratory,
  });
  const badInput = { ...recommendation, arguments: { ...recommendation.arguments, schoolMode: 'walking_only' } };
  assert((await client.callTool({ name: 'show_town_explorer', arguments: { recommendation: badInput } })).isError);

  const discovery = await client.listResources();
  assert(discovery.resources.some(resource => resource.uri === appMeta.resourceUri));
  const {
    contents: [widget],
  } = await client.readResource({ uri: appMeta.resourceUri });
  assert.equal(widget.mimeType, 'text/html;profile=mcp-app');
  assert('text' in widget);
  assert.match(widget.text, /<title>ReloCat Town Explorer<\/title>/);
  assert.doesNotMatch(widget.text, /<!-- WIDGET -->/);
  const preview = await fetch(new URL('/preview', base));
  assert.equal(preview.status, 200);
  assert.equal(await preview.text(), widget.text);
});

test('screens a three-town rural rail shortlist and requires opt-in to comarca purchase prices', async () => {
  const args = {
    travelDate,
    ruralOnly: true,
    schoolStages: ['eso'],
    schoolMode: 'rail',
    maxSchoolJourneyMinutes: 50,
    housing: { tenure: 'buy', homeSizeM2: 85, maxBudgetEur: 130_000 },
  };
  const localOnly = recommendationResult.parse(await tool('recommend_towns', args));
  assert.deepEqual(
    localOnly.towns.map(town => town.municipality.code),
    ['252402'],
  );
  assert(
    localOnly.excluded.some(
      town => town.municipalityCode === termens && town.dataMissing.includes('resale_eur_per_m2'),
    ),
  );

  const shortlist = recommendationResult.parse(
    await tool('recommend_towns', {
      ...args,
      housing: { ...args.housing, allowComarcaEstimate: true },
    }),
  );
  assert.deepEqual(
    shortlist.towns.map(town => town.municipality.code),
    [termens, '252402', '252542'],
  );
  assert.deepEqual(
    shortlist.towns.map(town => town.housingEstimate?.metric.geography),
    ['comarca', 'municipality', 'comarca'],
  );
  assert(
    shortlist.towns.every(
      town =>
        town.schools[0].rail && town.incentives.every(policy => policy.eligibilityStatus === 'needs_verification'),
    ),
  );

  const invalid = await client.callTool({
    name: 'recommend_towns',
    arguments: { housing: { tenure: 'buy', maxBudgetEur: 100_000 } },
  });
  assert(invalid.isError);
});

test('ranks family profiles by listed local school stages and flags property-level checks', async () => {
  const family = profileRecommendationResult.parse(
    await tool('recommend_towns_for_profile', {
      profile: { householdType: 'family', hasChildren: true, hasDog: true, workMode: 'remote' },
    }),
  );
  assert.equal(family.profileAssessment.status, 'ranked');
  assert(family.profileAssessment.followUps.some(reason => /school stages/.test(reason)));
  assert(family.profileAssessment.verificationNeeded.some(reason => /pet permission/.test(reason)));
  assert(family.profileAssessment.verificationNeeded.some(reason => /broadband/.test(reason)));
  assert.equal(family.towns.length, 3);
  for (const town of family.towns) {
    assert(town.schools.length > 0);
    assert(
      town.schools.every(
        journey => journey.school.municipalityCode === town.municipality.code && journey.school.sourceUrl,
      ),
    );
    assert.match(town.matchReasons.join(' '), /education stage/);
    assert.equal(town.commute, null);
  }
  assert.equal(family.excluded.length, 0);
});

test('uses the household profile to rank by setting or to suggest exploratory towns', async () => {
  const singleRemote = { householdType: 'single', hasChildren: false, hasDog: false, workMode: 'remote' };
  const explore = profileRecommendationResult.parse(
    await tool('recommend_towns_for_profile', { profile: singleRemote }),
  );
  assert.equal(explore.profileAssessment.status, 'exploratory');
  assert.equal(explore.profileAssessment.verificationNeeded.length, 1);
  assert(explore.towns.every(town => town.score === null && town.schools.length === 0));
  for (const preferredSetting of ['larger_town', 'rural']) {
    const ranked = profileRecommendationResult.parse(
      await tool('recommend_towns_for_profile', {
        profile: { ...singleRemote, preferredSetting },
      }),
    );
    assert.equal(ranked.profileAssessment.status, 'ranked');
    if (preferredSetting === 'larger_town') {
      assert.equal(ranked.towns[0].municipality.code, balaguer);
      assert(ranked.towns[0].metrics.some(metric => metric.kind === 'population' && metric.sourceUrl));
    } else {
      assert(ranked.towns.every(town => ['rural', 'special_attention'].includes(town.municipality.rural.category)));
    }
  }
});

test('uses school stages from the profile and handles an older purchase budget without floor area', async () => {
  const profile = { householdType: 'family', hasChildren: true, workMode: 'remote', preferredSetting: 'rural' };
  const shortlist = profileRecommendationResult.parse(
    await tool('recommend_towns_for_profile', {
      profile: { ...profile, schoolStages: ['eso'] },
      limit: 2,
    }),
  );
  assert.equal(shortlist.towns.length, 2);
  assert(shortlist.towns.every(town => town.schools.some(journey => journey.school.stages.includes('eso'))));
  assert.equal(shortlist.profileAssessment.ignoredCriteria, undefined);

  const older = await client.callTool({
    name: 'recommend_towns_for_profile',
    arguments: {
      profile,
      schoolStages: ['eso'],
      limit: 2,
      housing: { tenure: 'buy', maxBudgetEur: 130_000 },
    },
  });
  assert(!older.isError);
  const compatible = profileRecommendationResult.parse(older.structuredContent);
  assert.deepEqual(compatible.towns, shortlist.towns);
  assert.deepEqual(compatible.profileAssessment.ignoredCriteria, ['housing']);
  assert(compatible.towns.every(town => town.housingEstimate === null));
  assert.match(JSON.stringify(older.content), /Use recommend_towns for budget/);
});

test('serves Calaf, Juncosa and Ulldemolins from the fixed demo snapshot', async () => {
  const towns = [
    { code: '080312', name: 'Calaf', esoCode: '080312', rural: 'not_listed', hasMunicipalResale: true },
    { code: '251180', name: 'Juncosa', esoCode: '251018', rural: 'special_attention', hasMunicipalResale: false },
    { code: '431573', name: 'Ulldemolins', esoCode: '430496', rural: 'special_attention', hasMunicipalResale: false },
  ];
  for (const { code, name, esoCode, rural, hasMunicipalResale } of towns) {
    const profile = profileResult.parse(await tool('get_town_profile', { municipalityCode: code, travelDate }));
    assert.equal(profile.municipality.code, code);
    assert.equal(profile.municipality.name, name);
    assert.equal(profile.municipality.rural.category, rural);
    assert.equal(profile.dataMissing.includes('resale_eur_per_m2'), !hasMunicipalResale);
    assert(
      profile.comarcaMetrics.some(metric => metric.kind === 'resale_eur_per_m2' && metric.geography === 'comarca'),
    );
    assert.equal(profile.railway.sampleConnectionToLleida, null);

    const eso = schoolResult.parse(
      await tool('get_nearby_schools', { municipalityCode: code, stage: 'eso', travelDate }),
    );
    const school = eso.schools.find(journey => journey.school.municipalityCode === esoCode);
    assert(school);
    assert.equal(school.mode, esoCode === code ? 'estimated_walk' : 'unknown');
    const grant = profile.incentives.find(entry => entry.id === 'renovation_grant_2026');
    assert.equal(grant?.callStatus, rural === 'special_attention' ? 'closed' : undefined);
  }
});

test('covers all six travel endpoints for every mapped municipality', async () => {
  for (const { code } of snapshot.municipalities) {
    const profile = profileResult.parse(
      await tool('get_town_profile', { municipalityCode: code, travelDate: '2026-12-05' }),
    );
    assert.deepEqual(
      profile.travelEstimates.map(row => row.destinationId),
      ['lleida', 'barcelona', 'bcn_t1', 'bcn_t2', 'girona', 'girona_airport'],
    );

    const barcelona = profile.travelEstimates.find(row => row.destinationId === 'barcelona');
    assert(barcelona);
    assert(barcelona.car.sourceUrl.startsWith('https:'));
    const sample = barcelona.publicTransport;
    if (sample) assert.equal(sample.sampleDate, '2026-11-23');
    const gironaAirport = profile.travelEstimates.find(row => row.destinationId === 'girona_airport');
    assert(gironaAirport?.car.durationMinutes);
  }
  const uncovered = profileResult.parse(await tool('get_town_profile', { municipalityCode: '252154' }));
  assert(uncovered.travelEstimates.every(row => row.publicTransport === null));
  const profile = profileResult.parse(await tool('get_town_profile', { municipalityCode: '251180' }));
  const lleida = profile.travelEstimates.find(row => row.destinationId === 'lleida');
  assert.equal(lleida?.publicTransport?.mode, 'bus');
  assert.equal(lleida?.publicTransport?.sampleCount, 2);
});

test('uses dated rail trips and reports dates outside the snapshot', async () => {
  const query = {
    municipalityCode: termens,
    destinationCode: balaguer,
    travelDate,
    departFrom: '07:45',
    departBy: '07:50',
  };
  const response = transportResult.parse(await tool('get_transport_options', query));
  assert.equal(response.scheduleCoverage, 'covered');
  assert.equal(response.totalDepartures, 1);
  assert.equal(response.routes[0].departure, '07:49:00');
  assert.equal(response.routes[0].arrival, '07:57:30');
  assert.equal(response.routes[0].durationMinutes, 9);
  const expired = transportResult.parse(await tool('get_transport_options', { ...query, travelDate: '2027-02-01' }));
  assert.equal(expired.scheduleCoverage, 'outside_snapshot');
  assert.deepEqual(expired.routes, []);
});

test('keeps call availability, exact geographic scope and household eligibility independent', async () => {
  const catalogue = incentivesResult.parse(
    await tool('get_applicable_incentives', { municipalityCode: termens, intent: 'renovate' }),
  );
  const grant = catalogue.incentives.find(entry => entry.id === 'renovation_grant_2026');
  assert.equal(grant?.callStatus, 'closed');
  assert.equal(grant.eligibilityStatus, 'needs_verification');

  const household = {
    primaryResidence: true,
    age: 35,
    filing: 'individual',
    irpfNetTaxBaseEur: 30_000,
    firstRuralMove: true,
    singleParent: false,
  };
  const input = { municipalityCode: termens, intent: 'move', eventDate: travelDate, household };
  const move = incentivesResult.parse(await tool('check_housing_incentives', input)).incentives[0];
  assert.equal(move.eligibilityStatus, 'eligible');
  assert.match(move.benefit, /special attention €1,000/);
  assert.equal(move.screenedAmountEur, 1000);
  const matchingMeasure = incentivesResult.parse(await tool('get_applicable_incentives', input)).incentives[0];
  assert.deepEqual(matchingMeasure, move);
  const overLimit = incentivesResult.parse(
    await tool('check_housing_incentives', {
      ...input,
      household: { ...household, irpfNetTaxBaseEur: 30_001 },
    }),
  );
  assert.equal(overLimit.incentives[0].eligibilityStatus, 'ineligible');

  const future = incentivesResult.parse(
    await tool('check_housing_incentives', {
      ...input,
      eventDate: '2028-01-01',
      household: { ...household, irpfNetTaxBaseEur: 30_001 },
    }),
  );
  assert.equal(future.incentives[0].eligibilityStatus, 'needs_verification');
  assert.deepEqual(future.incentives[0].unmetCriteria, []);

  for (const [nucleus, status] of [
    [undefined, 'needs_verification'],
    ['Tremp', 'does_not_apply'],
    ['Palau de Noguera', 'applies'],
  ]) {
    const area = incentivesResult.parse(
      await tool('check_housing_incentives', {
        municipalityCode: '252347',
        intent: 'buy',
        eventDate: travelDate,
        nucleus,
      }),
    );
    // The state youth purchase aid is scoped by resident population, so Tremp qualifies as a whole.
    // The 5% rates for young buyers, large and single-parent families and disability apply in every municipality.
    const everywhere = area.incentives.filter(entry => entry.territory === 'catalonia');
    assert.equal(everywhere.length, 4);
    assert(everywhere.every(entry => entry.geographicStatus === 'applies'));
    const ruralScoped = area.incentives.filter(
      entry => entry.id !== 'youth_purchase_small_town' && entry.territory !== 'catalonia',
    );
    assert.deepEqual(
      ruralScoped.map(entry => entry.id),
      ['irpf_buy', 'itp_buy', 'itp_rehab_buy'],
    );
    assert(ruralScoped.every(entry => entry.geographicStatus === status));
    assert.equal(area.incentives.length, ruralScoped.length + everywhere.length + 1);
    assert(area.incentives.every(entry => entry.eligibilityStatus !== 'eligible'));
  }
});

test('checks health and rejects unexpected browser origins', async () => {
  const health = await fetch(new URL('/health', base));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).snapshot.version, snapshot.version);
  const crossOrigin = await fetch(new URL('/mcp', base), {
    method: 'POST',
    headers: { Origin: 'https://example.com' },
  });
  assert.equal(crossOrigin.status, 403);
});

test('returns joined relocation research through MCP profiles and recommendations', async () => {
  const profile = profileResult.parse(await tool('get_town_profile', { municipalityCode: '251180' }));
  assert.equal(profile.relocation.coverage, 'researched');
  assert.equal(profile.relocation.research?.opportunities.length, 2);
  assert(profile.metrics.length > 0);
  assert(profile.relocation.research?.opportunities.every(offer => offer.sources.length));
  const calaf = recommendationResult.parse(await tool('recommend_towns', { comarca: 'Anoia' }));
  assert.equal(
    calaf.towns.find(t => t.municipality.code === '080312')?.relocation.research?.opportunities[0].id,
    'calaf-casetes-dels-mestres',
  );
  const ager = profileResult.parse(await tool('get_town_profile', { municipalityCode: '250024' }));
  assert.equal(ager.relocation.coverage, 'not_researched');
  assert.equal(ager.relocation.research, null);
});

test('MCP advertises live search and reports missing provider access without fabricating listings', async () => {
  const response = await tool('search_homes', { municipalityCodes: ['080312'], operation: 'buy' });
  const parsed = homeSearchResult.parse(response);
  assert.equal(parsed.searches[0].status, 'provider_unavailable');
  assert.deepEqual(parsed.searches[0].examples, []);
  const invalid = await client.callTool({
    name: 'search_homes',
    arguments: { municipalityCodes: ['999999'], operation: 'buy' },
  });
  assert(invalid.isError);
});

test('serves the illustrated homepage and preserves its demo links', async () => {
  const root = await fetch(base, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('Location'), '/connect');

  const homepage = await fetch(new URL('/connect', base));
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers.get('Content-Security-Policy') ?? '', /img-src data:/);
  const html = await homepage.text();
  assert.equal(html.match(/src="data:image\/jpeg;base64,/g)?.length, 3);
  assert.equal(html.match(/"data:image\/(png|svg\+xml|webp);base64,/g)?.length, 8);
  // The endpoint offered is the one this server answers on, not a fixed public address.
  assert.ok(html.includes(`<input id="endpoint" type="url" value="${new URL('/mcp', base).href}"`));
  assert.match(html, /href="\/preview"/);
  assert.match(
    html,
    /href="https:\/\/github.com\/itsmanelvelasco\/aihousebuyingcompanion\/blob\/main\/apps\/mcp-server\/README.md#data-and-refresh"/,
  );
});

test('local test UI runs real tools and rejects foreign origins and disallowed tools', async () => {
  const page = await fetch(new URL('/test', base));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Try your move/);
  const config = await (await fetch(new URL('/test/config', base))).json();
  assert.equal(config.towns.length, 18);
  assert.equal(config.liveSearchConfigured, false);
  assert(!JSON.stringify(config).includes('TREG_TOKEN'));
  const request = (tool: string, origin = base.origin) =>
    fetch(new URL('/test/run', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ tool, args: { municipalityCode: '080312' } }),
    });
  const result = await (await request('get_town_profile')).json();
  assert.equal(result.structuredContent.municipality.name, 'Calaf');
  assert.equal((await request('get_town_profile', 'https://example.com')).status, 403);
  assert.equal((await request('update_demo')).status, 400);
});
