import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { registerPlannerTools } from '../apps/mcp-server/planner-tools.ts';
import type { Policy, Snapshot } from '../packages/contracts/places.ts';
import type { Person, Place } from '../packages/contracts/planner.ts';
import { person as personSchema, place as placeSchema, planResult } from '../packages/contracts/planner.ts';
import { buildPerson } from '../packages/model/person.ts';
import { buildPlace } from '../packages/model/place.ts';
import { loadData } from '../packages/places/data.ts';
import { planForPlaces } from '../packages/planner/plan.ts';

const asOf = '2026-11-22';
const source = { observedAt: '2025', sourceUrl: 'https://example.org/data' };

function placeFixture(code: string, rural: Place['rural'], eurPerM2: number | null = 1000): Place {
  return {
    municipalityCode: code,
    name: `Town ${code}`,
    comarca: 'Test',
    rural,
    centre: { latitude: 42, longitude: 1 },
    indicators: {
      population: null,
      densityPerKm2: null,
      foreignPopulationPercent: null,
      resaleEurPerM2:
        eurPerM2 === null ? null : { ...source, value: eurPerM2, unit: 'EUR/m2', geography: 'municipality' },
      rentEurPerMonth: null,
    },
    services: [],
    dataMissing: [],
  };
}
const ruralPlace = placeFixture('250001', 'rural');
const cityPlace = placeFixture('250002', 'not_listed');

function policyFixture(overrides: Partial<Policy> & Pick<Policy, 'id' | 'intent' | 'mechanism'>): Policy {
  return {
    version: 'test',
    title: `Fixture ${overrides.id}`,
    authority: 'Test authority',
    beneficiary: 'household',
    effectiveFrom: '2026-01-01',
    effectiveThrough: '2026-12-31',
    sourceUrl: 'https://example.org/policy',
    legalUrl: 'https://example.org/law',
    lastVerified: '2026-11-01',
    benefit: 'Fixture benefit',
    notes: [],
    ...overrides,
  };
}
/** Standard transfer tax 10%; 5% in rural and special-attention municipalities. */
const reducedTax = policyFixture({
  id: 'itp_buy',
  intent: 'buy',
  mechanism: 'reduced_tax_rate',
  effect: {
    kind: 'transfer_tax_rate',
    standardRate: 0.1,
    reducedRate: { rural: 0.05, special_attention: 0.05, other: 0.1 },
  },
});
const moveDeduction = policyFixture({
  id: 'irpf_move',
  intent: 'move',
  mechanism: 'tax_deduction',
  effect: { kind: 'one_off_eur', amount: { rural: 750, special_attention: 1000, other: 0 } },
});
const buyDeduction = policyFixture({
  id: 'irpf_buy',
  intent: 'buy',
  mechanism: 'tax_deduction',
  effect: {
    kind: 'annual_rate_of_cost',
    cost: 'purchase_payments',
    rate: { rural: 0.15, special_attention: 0.15, other: 0 },
    maxBaseEur: 9040,
  },
});
const purchaseGrant = (effectiveThrough: string) =>
  policyFixture({
    id: 'renovation_grant_2026',
    intent: 'buy',
    mechanism: 'grant',
    effectiveThrough,
    municipalityCodes: ['250001'],
    effect: { kind: 'one_off_eur', amount: { rural: 3000, special_attention: 3000, other: 0 } },
  });

/** Facts that make the reduced transfer tax and the relocation deduction fully eligible. */
const verifiedHousehold: Person['household'] = {
  primaryResidence: true,
  age: 30,
  children: [{ age: 2 }],
  firstRuralMove: true,
  filing: 'individual',
  irpfNetTaxBaseEur: 20_000,
  itpFamilyNetTaxBaseEur: 30_000,
  itpTransaction: true,
  satisfiesItpOccupancyRules: true,
};

function personFixture(overrides: Partial<Person> = {}, finances: Partial<Person['finances']> = {}): Person {
  return {
    id: 'person-1',
    synthetic: true,
    household: verifiedHousehold,
    householdSize: 3,
    currentMunicipalityCode: null,
    finances: {
      monthlyIncomeCents: 250_000,
      monthlyExpensesCents: 200_000,
      currentSavingsCents: 1_200_000,
      emergencyReserveCents: 200_000,
      basis: 'declared',
      asOf: '2026-11-01',
      ...finances,
    },
    home: { floorAreaM2: 100, budgetCents: null, depositRate: 0.2 },
    habits: [],
    ...overrides,
  };
}
const habit = (status: 'proposed' | 'active' | 'paused', adherence: number | null = null) => ({
  id: `habit-${status}`,
  title: 'Cook at home',
  category: 'food' as const,
  monthlySavingCents: 10_000,
  status,
  adherence,
});

function plan(person: Person, places: Place[], policies: Policy[], assumptions = {}) {
  const result = planForPlaces(person, places, policies, assumptions, asOf);
  // Every output must satisfy the contract.
  planResult.parse(result);
  return result;
}
const only = (result: z.infer<typeof planResult>) => result.plans[0];

test('upfront cash is deposit, standard transfer tax and fees, and the timeline is rounded up', () => {
  const item = only(plan(personFixture(), [cityPlace], [reducedTax]));
  // €100,000 home: 20% + 10% + 2% = €32,000; €10,000 available; €500 a month → 44 months.
  assert.equal(item.purchasePriceCents, 10_000_000);
  assert.equal(item.priceBasis, 'municipal_eur_per_m2');
  assert.deepEqual(item.baseline, { upfrontCashCents: 3_200_000, monthlySavingsCents: 50_000, months: 44 });
  assert.equal(item.status, 'estimated');
  assert.equal(item.monthsSaved, 0);
});

test('zero or negative savings give no finite timeline', () => {
  for (const monthlyExpensesCents of [250_000, 300_000]) {
    const item = only(plan(personFixture({}, { monthlyExpensesCents }), [ruralPlace], [reducedTax]));
    assert.equal(item.status, 'no_positive_savings');
    assert.equal(item.baseline?.months, null);
    assert.equal(item.withPlaceBenefits?.months, null);
    assert.equal(item.monthsSaved, null);
  }
});

test('a target already reached takes zero months even without positive savings', () => {
  const rich = personFixture({}, { currentSavingsCents: 5_000_000, monthlyExpensesCents: 300_000 });
  const item = only(plan(rich, [cityPlace], [reducedTax]));
  assert.equal(item.status, 'target_reached');
  assert.equal(item.baseline?.months, 0);
  assert.equal(item.withPlaceBenefits?.months, 0);
});

test('unknown finances are insufficient data, never zero', () => {
  for (const finances of [{ currentSavingsCents: null }, { monthlyIncomeCents: null }]) {
    const item = only(plan(personFixture({}, finances), [cityPlace], [reducedTax]));
    assert.equal(item.status, 'insufficient_data');
    assert.equal(item.baseline, null);
    assert(item.dataMissing.some(entry => entry.startsWith('person.finances.')));
  }
});

test('a rural place with a reduced transfer tax needs fewer months than a non-rural one at the same price', () => {
  const result = plan(personFixture(), [cityPlace, ruralPlace], [reducedTax]);
  const [first, second] = result.plans;
  assert.equal(first.place.municipalityCode, ruralPlace.municipalityCode, 'shortest timeline sorts first');
  // 5% of €100,000 less tax: €27,000 upfront, €17,000 to save → 34 months instead of 44.
  assert.equal(first.withPlaceBenefits?.upfrontCashCents, 2_700_000);
  assert.equal(first.withPlaceBenefits?.months, 34);
  assert.equal(first.baseline?.months, 44);
  assert.equal(first.monthsSavedByPlace, 10);
  assert.equal(first.monthsSaved, 10);
  const tax = first.benefits.find(benefit => benefit.policyId === 'itp_buy');
  assert.deepEqual(
    [tax?.kind, tax?.amountCents, tax?.counted, tax?.eligibilityStatus],
    ['upfront_cost_reduction', 500_000, true, 'eligible'],
  );
  assert.equal(second.withPlaceBenefits?.months, 44);
  const cityTax = second.benefits.find(benefit => benefit.policyId === 'itp_buy');
  assert.equal(cityTax?.counted, false);
  assert.equal(cityTax?.eligibilityStatus, 'ineligible');
  assert.match(cityTax?.explanation ?? '', /criteria not met/);
});

test('active habits reduce months and adherence scales them', () => {
  const full = only(plan(personFixture({ habits: [habit('active')] }), [cityPlace], [reducedTax]));
  assert.equal(full.withHabits?.monthlySavingsCents, 60_000);
  assert.equal(full.withHabits?.months, 37);
  assert.equal(full.monthsSavedByHabits, 7);
  const half = only(plan(personFixture({ habits: [habit('active', 0.5)] }), [cityPlace], [reducedTax]));
  assert.equal(half.withHabits?.monthlySavingsCents, 55_000);
  assert.equal(half.withHabits?.months, 40);
  assert.equal(half.baseline?.months, 44, 'the baseline never includes habits');
  const paused = only(plan(personFixture({ habits: [habit('paused')] }), [cityPlace], [reducedTax]));
  assert.equal(paused.monthsSavedByHabits, 0);
});

test('proposed habits count only with includeProposedHabits', () => {
  const person = personFixture({ habits: [habit('proposed')] });
  assert.equal(only(plan(person, [cityPlace], [reducedTax])).withHabits?.months, 44);
  const included = only(plan(person, [cityPlace], [reducedTax], { includeProposedHabits: true }));
  assert.equal(included.withHabits?.months, 37);
});

test('unverified benefits are listed but count only with includeUnverifiedBenefits', () => {
  const person = personFixture({ household: undefined });
  const byDefault = only(plan(person, [ruralPlace], [reducedTax]));
  const tax = byDefault.benefits[0];
  assert.deepEqual([tax.eligibilityStatus, tax.counted, tax.amountCents], ['needs_verification', false, 500_000]);
  assert.equal(byDefault.withPlaceBenefits?.months, 44);
  assert.equal(byDefault.monthsSavedByPlace, 0);
  const included = only(plan(person, [ruralPlace], [reducedTax], { includeUnverifiedBenefits: true }));
  assert.equal(included.benefits[0].counted, true);
  assert.match(included.benefits[0].explanation, /not verified/);
  assert.equal(included.withPlaceBenefits?.months, 34);
});

test('a closed call is never counted; an open purchase grant lowers the upfront cash', () => {
  const flags = { includeUnverifiedBenefits: true };
  const closed = only(plan(personFixture(), [ruralPlace], [reducedTax, purchaseGrant('2026-09-10')], flags));
  const closedGrant = closed.benefits.find(benefit => benefit.policyId === 'renovation_grant_2026');
  assert.deepEqual([closedGrant?.callStatus, closedGrant?.counted], ['closed', false]);
  assert.equal(closed.withPlaceBenefits?.upfrontCashCents, 2_700_000);
  const open = only(plan(personFixture(), [ruralPlace], [reducedTax, purchaseGrant('2026-12-31')], flags));
  const openGrant = open.benefits.find(benefit => benefit.policyId === 'renovation_grant_2026');
  assert.deepEqual([openGrant?.kind, openGrant?.callStatus, openGrant?.counted], ['one_off_cash', 'open', true]);
  assert.equal(open.withPlaceBenefits?.upfrontCashCents, 2_400_000);
});

test('benefits paid after the purchase are shown and not counted; relocation cash arrives a tax year late', () => {
  const policies = [reducedTax, moveDeduction, buyDeduction];
  const item = only(plan(personFixture(), [ruralPlace], policies));
  const byId = Object.fromEntries(item.benefits.map(benefit => [benefit.policyId, benefit]));
  assert.deepEqual(
    [byId.irpf_buy.kind, byId.irpf_buy.amountCents, byId.irpf_buy.counted],
    ['annual_cash', null, false],
  );
  assert.deepEqual(
    [byId.irpf_move.kind, byId.irpf_move.amountCents, byId.irpf_move.counted],
    ['one_off_cash', 75_000, true],
  );
  // €17,000 to save: 12 months × €500 = €6,000, then €750 arrives, €10,250 left → 21 more months.
  assert.equal(item.withPlaceBenefits?.months, 33);
  // Someone who already lives there has that money in their figures already.
  const resident = personFixture({ currentMunicipalityCode: ruralPlace.municipalityCode });
  const residentPlan = only(plan(resident, [ruralPlace], policies));
  assert.equal(residentPlan.benefits.find(benefit => benefit.policyId === 'irpf_move')?.counted, false);
  assert.equal(residentPlan.withPlaceBenefits?.months, 34);
});

test('two reduced transfer-tax rates are alternatives and never add up', () => {
  const second = { ...reducedTax, title: 'Second reduced rate' };
  const item = only(plan(personFixture(), [ruralPlace], [reducedTax, second]));
  assert.deepEqual(
    item.benefits.map(benefit => benefit.counted),
    [true, false],
  );
  assert.equal(item.withPlaceBenefits?.upfrontCashCents, 2_700_000);
});

test('a policy without a machine-readable effect is unquantified and not counted', () => {
  const item = only(plan(personFixture(), [ruralPlace], [reducedTax, { ...moveDeduction, effect: undefined }]));
  const move = item.benefits.find(benefit => benefit.policyId === 'irpf_move');
  assert.deepEqual([move?.kind, move?.amountCents, move?.counted], ['unquantified', null, false]);
});

test('a missing price or a missing standard tax rate is insufficient data, and sorts last', () => {
  const noPrice = placeFixture('250003', 'rural', null);
  const result = plan(personFixture(), [noPrice, cityPlace], [reducedTax]);
  assert.deepEqual(
    result.plans.map(item => item.status),
    ['estimated', 'insufficient_data'],
  );
  const missing = result.plans[1];
  assert.deepEqual(
    [missing.purchasePriceCents, missing.priceBasis, missing.baseline, missing.monthsSaved],
    [null, 'unknown', null, null],
  );
  assert(missing.dataMissing.some(entry => entry.includes('resale price')));
  const noRate = only(plan(personFixture(), [cityPlace], [moveDeduction]));
  assert.equal(noRate.status, 'insufficient_data');
  assert(noRate.dataMissing.some(entry => entry.includes('transfer-tax rate')));
});

test('an explicit budget is the price; a comarca price is flagged', () => {
  const budget = personFixture({ home: { floorAreaM2: null, budgetCents: 8_000_000, depositRate: 0.1 } });
  const budgeted = only(plan(budget, [placeFixture('250004', 'not_listed', null)], [reducedTax]));
  assert.deepEqual([budgeted.priceBasis, budgeted.baseline?.upfrontCashCents], ['budget', 1_760_000]);
  const proxy = placeFixture('250005', 'not_listed');
  if (proxy.indicators.resaleEurPerM2) proxy.indicators.resaleEurPerM2.geography = 'comarca';
  const flagged = only(plan(personFixture(), [proxy], [reducedTax]));
  assert.equal(flagged.priceBasis, 'comarca_eur_per_m2');
  assert(flagged.dataMissing.some(entry => entry.includes('comarca average used')));
  assert(flagged.assumptions.some(entry => entry.includes('comarca average')));
});

test('limitations say this is not mortgage approval or guaranteed aid', () => {
  const text = plan(personFixture(), [cityPlace], [reducedTax]).limitations.join(' ');
  assert.match(text, /not a mortgage offer/);
  assert.match(text, /No aid, grant or tax benefit is guaranteed/);
});

test('buildPerson keeps unknowns null, counts debt once and treats bank data as evidence', () => {
  const stamp = { observedAt: '2026-11-10T00:00:00Z' };
  const data = {
    finance: { monthlyIncomeCents: 250_000, monthlyExpensesCents: 180_000, debtPaymentsCents: 20_000 },
    household: { size: 3 },
    housing: { homeSizeM2: 90 },
  };
  const unconfirmed = {
    resolved: { data, provenance: { 'finance.monthlyIncomeCents': [{ confirmed: false, ...stamp }] } },
  };
  const declared = buildPerson({ userId: 'user-001', context: unconfirmed });
  personSchema.parse(declared);
  assert.equal(declared.finances.monthlyExpensesCents, 200_000, 'declared debt is added once');
  assert.deepEqual(
    [declared.finances.currentSavingsCents, declared.finances.basis, declared.finances.asOf, declared.home.budgetCents],
    [null, 'declared', '2026-11-10', null],
  );
  const bankSummary = {
    from: '2026-08-01',
    to: '2026-10-31',
    monthCount: 3,
    dataStatus: 'observed' as const,
    incomeCents: 780_000,
    expenseCents: 630_000,
  };
  const observed = buildPerson({ userId: 'user-001', context: unconfirmed, bankSummary });
  assert.deepEqual(
    [observed.finances.monthlyIncomeCents, observed.finances.monthlyExpensesCents, observed.finances.basis],
    [260_000, 210_000, 'bank_observed'],
  );
  assert.equal(observed.finances.asOf, '2026-10-31');
  const confirmed = {
    resolved: { data, provenance: { 'finance.monthlyIncomeCents': [{ confirmed: true, ...stamp }] } },
  };
  const mixed = buildPerson({ userId: 'user-001', context: confirmed, bankSummary });
  assert.deepEqual(
    [mixed.finances.monthlyIncomeCents, mixed.finances.monthlyExpensesCents, mixed.finances.basis],
    [250_000, 210_000, 'mixed'],
  );
  const partial = buildPerson({
    userId: 'user-001',
    context: { resolved: { data: {} } },
    bankSummary: { ...bankSummary, dataStatus: 'partial' },
  });
  assert.deepEqual(
    [partial.finances.monthlyIncomeCents, partial.finances.basis, partial.householdSize],
    [null, 'unknown', null],
  );
});

test('buildPerson maps habit goals and check-ins', () => {
  const goal = { title: 'Cook at home', action: 'Cook four dinners a week', category: 'food', targetDaysPerWeek: 4 };
  const person = buildPerson({
    userId: 'user-001',
    context: { resolved: { data: {} } },
    habitState: {
      schemaVersion: 1,
      synthetic: true,
      userId: 'user-001',
      goals: [
        { ...goal, id: 'cook', plannedMonthlySavingCents: 12_000 },
        { ...goal, id: 'old', active: false },
      ],
      checkins: [
        { id: 'c1', goalId: 'cook', date: '2026-11-01', completed: true },
        { id: 'c2', goalId: 'cook', date: '2026-11-02', completed: false },
      ],
    } as Parameters<typeof buildPerson>[0]['habitState'],
  });
  assert.deepEqual(
    person.habits.map(item => [item.id, item.status, item.monthlySavingCents, item.adherence]),
    [
      ['cook', 'active', 12_000, 0.5],
      ['old', 'paused', null, null],
    ],
  );
});

test('buildPlace falls back to the comarca price and names every missing indicator', () => {
  const metric = (kind: string, value: number, geography: 'municipality' | 'comarca', geographyName: string) => ({
    ...source,
    kind,
    value,
    unit: 'unit',
    geography,
    geographyName,
  });
  const town = {
    code: '250001',
    name: 'Testville',
    comarca: 'Testland',
    recommendable: true,
    identity: source,
    centre: { latitude: 42, longitude: 1, name: 'Testville', ...source },
    rural: { ...source, category: 'rural', effectiveFrom: '2026-02-24' },
  };
  const snapshot = {
    municipalities: [town],
    townMetrics: { '250001': [metric('population', 500, 'municipality', 'Testville')] },
    comarcaMetrics: { Testland: [metric('resale_eur_per_m2', 900, 'comarca', 'Testland')] },
  } as unknown as Snapshot;
  const before = buildPlace(snapshot, '250001');
  placeSchema.parse(before);
  assert.equal(before.indicators.resaleEurPerM2?.geography, 'comarca');
  assert.equal(before.indicators.rentEurPerMonth, null);
  assert.equal(before.indicators.densityPerKm2, null);
  assert.deepEqual(before.services, []);
  for (const name of ['densityPerKm2', 'foreignPopulationPercent', 'rentEurPerMonth', 'services'])
    assert(before.dataMissing.includes(name), name);
  assert(before.dataMissing.some(entry => entry.startsWith('resaleEurPerM2 (municipal figure not published')));

  // The same code reads the indicators and services another agent is adding to the snapshot.
  const after = buildPlace(
    {
      ...snapshot,
      townMetrics: {
        '250001': [
          metric('population', 500, 'municipality', 'Testville'),
          metric('area_km2', 25, 'municipality', 'Testville'),
          metric('foreign_population_percent', 8.5, 'municipality', 'Testville'),
        ],
      },
      services: { '250001': [{ kind: 'pharmacy', count: 1, ...source }] },
    } as unknown as Snapshot,
    '250001',
  );
  assert.equal(after.indicators.densityPerKm2?.value, 20);
  assert.equal(after.indicators.foreignPopulationPercent?.value, 8.5);
  assert.deepEqual(after.services, [{ kind: 'pharmacy', count: 1, ...source }]);
  assert(!after.dataMissing.includes('services'));
  assert.throws(() => buildPlace(snapshot, '999999'), /outside this snapshot/);
});

async function connect(options: Parameters<typeof registerPlannerTools>[1]) {
  const server = new McpServer({ name: 'planner-test', version: '1' });
  registerPlannerTools(server, options);
  const client = new Client({ name: 'test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

test('MCP planner tools plan an inline person against the real snapshot', async () => {
  const { snapshot, policies } = loadData();
  const { client, close } = await connect({ snapshot, policies, today: () => asOf });
  try {
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), ['get_person', 'get_place', 'plan_home_savings']);
    assert(list.tools.every(tool => tool.annotations?.readOnlyHint));
    const codes = snapshot.municipalities.slice(0, 4).map(town => town.code);
    const response = await client.callTool({
      name: 'plan_home_savings',
      arguments: { person: personFixture(), municipalityCodes: [...codes, codes[0]] },
    });
    assert(!response.isError, JSON.stringify(response.content));
    const result = planResult.parse(response.structuredContent);
    assert.equal(result.asOf, asOf);
    assert.equal(result.plans.length, codes.length, 'repeated codes are planned once');
    assert.deepEqual(result.plans.map(item => item.place.municipalityCode).sort(), [...codes].sort());
    assert(result.limitations.some(entry => entry.includes('not a mortgage offer')));
    const order = result.plans.map(item => item.withPlaceBenefits?.months ?? Number.POSITIVE_INFINITY);
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
    for (const item of result.plans) {
      assert.equal(item.status === 'insufficient_data', item.baseline === null);
      if (item.status === 'insufficient_data') assert(item.dataMissing.length > 0);
      if (item.baseline?.months != null && item.withPlaceBenefits?.months != null) {
        assert(item.withPlaceBenefits.months <= (item.withHabits?.months ?? Number.POSITIVE_INFINITY));
        assert.equal(item.monthsSaved, item.baseline.months - item.withPlaceBenefits.months);
      }
      for (const benefit of item.benefits)
        if (benefit.counted) assert(benefit.callStatus !== 'closed' && benefit.eligibilityStatus !== 'ineligible');
    }

    const node = await client.callTool({ name: 'get_place', arguments: { municipalityCode: codes[0] } });
    assert.equal(placeSchema.parse(node.structuredContent).municipalityCode, codes[0]);
    const outside = await client.callTool({
      name: 'plan_home_savings',
      arguments: { person: personFixture(), municipalityCodes: ['999999'] },
    });
    assert(outside.isError);
    for (const request of [
      { name: 'plan_home_savings', arguments: { municipalityCodes: codes } },
      { name: 'plan_home_savings', arguments: { userId: 'user-001', municipalityCodes: codes } },
      { name: 'get_person', arguments: { userId: 'user-001' } },
    ])
      assert((await client.callTool(request)).isError, 'no profile API and no inline person is a tool error');
  } finally {
    await close();
  }
});

test('MCP planner tools load a stored person over HTTP and tolerate absent habits and bank data', async () => {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const api = createServer((request, response) => {
    const path = request.url ?? '';
    seen.push({ path, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (path.endsWith('/context') && path.includes('user-001'))
      return response.end(
        JSON.stringify({
          synthetic: true,
          userId: 'user-001',
          resolved: {
            data: {
              finance: { currentSavingsCents: 1_200_000, monthlyIncomeCents: 250_000, monthlyExpensesCents: 200_000 },
              housing: { budgetCents: 10_000_000 },
              household: { size: 2 },
            },
            provenance: {},
            conflicts: [],
          },
          token: 'secret-token',
        }),
      );
    response.writeHead(path.includes('/bank/') ? 500 : 404);
    response.end(JSON.stringify({ error: 'secret-token upstream stack' }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  assert(address && typeof address === 'object');
  const { snapshot } = loadData();
  const { client, close } = await connect({
    snapshot,
    policies: [reducedTax],
    today: () => asOf,
    profileApi: { baseUrl: `http://127.0.0.1:${address.port}`, token: 'secret-token' },
  });
  try {
    const stored = await client.callTool({ name: 'get_person', arguments: { userId: 'user-001' } });
    assert(!stored.isError, JSON.stringify(stored.content));
    const person = personSchema.parse(stored.structuredContent);
    assert.deepEqual([person.finances.basis, person.habits.length, person.householdSize], ['declared', 0, 2]);
    assert(seen.every(call => call.authorization === 'Bearer secret-token'));
    assert(seen.some(call => call.path === '/users/user-001/bank/summary?from=2026-08-01&to=2026-10-31'));
    assert(seen.some(call => call.path === '/users/user-001/habits'));

    const code = snapshot.municipalities[0].code;
    const planned = await client.callTool({
      name: 'plan_home_savings',
      arguments: { userId: 'user-001', municipalityCodes: [code] },
    });
    assert(!planned.isError, JSON.stringify(planned.content));
    const result = planResult.parse(planned.structuredContent);
    assert.deepEqual([result.plans[0].priceBasis, result.plans[0].baseline?.months], ['budget', 40]);
    assert(result.limitations.some(entry => entry.includes('Bank movements could not be read')));
    const unknown = await client.callTool({ name: 'get_person', arguments: { userId: 'user-404' } });
    assert(unknown.isError);
    for (const response of [stored, planned, unknown]) assert(!JSON.stringify(response).includes('secret-token'));
  } finally {
    await close();
    await new Promise<void>((resolve, reject) => api.close(error => (error ? reject(error) : resolve())));
  }
});

test('planner tools reject credentials in URLs and insecure non-loopback origins', () => {
  const { snapshot, policies } = loadData();
  for (const baseUrl of ['http://example.com', 'https://name:secret@example.com', 'https://example.com?token=x']) {
    const server = new McpServer({ name: 'planner-config-test', version: '1' });
    assert.throws(() =>
      registerPlannerTools(server, { snapshot, policies, today: () => asOf, profileApi: { baseUrl, token: 'test' } }),
    );
  }
});
