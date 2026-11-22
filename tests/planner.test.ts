import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { registerPlannerTools } from '../apps/mcp-server/planner-tools.ts';
import { inputSchema, resolveInputs } from '../packages/contracts/inputs.ts';
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
    effectiveThrough: '2099-12-31',
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
  // Old enough to need the schooling facts, young enough to stay under 16 in every plan below.
  children: [{ age: 5, inDesignatedSchool: true, meetsItpSchooling: true }],
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
const habit = (
  status: 'proposed' | 'active' | 'paused',
  adherence: number | null = null,
  startedOn?: string,
): Person['habits'][number] => ({
  id: `habit-${status}`,
  title: 'Cook at home',
  category: 'food',
  monthlySavingCents: 10_000,
  status,
  adherence,
  ...(startedOn ? { startedOn } : {}),
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

test('a purchase grant counts only while its call is open on the day of the purchase', () => {
  const flags = { includeUnverifiedBenefits: true };
  const grantOf = (item: ReturnType<typeof only>) => benefitOf(item, 'renovation_grant_2026');
  const closed = only(plan(personFixture(), [ruralPlace], [reducedTax, purchaseGrant('2026-09-10')], flags));
  assert.deepEqual([grantOf(closed).callStatus, grantOf(closed).counted], ['closed', false]);
  assert.equal(closed.withPlaceBenefits?.upfrontCashCents, 2_700_000);
  // Open until after the purchase: €5,000 less tax and €3,000 of grant → €24,000 upfront, 28 months.
  const open = only(plan(personFixture(), [ruralPlace], [reducedTax, purchaseGrant('2099-12-31')], flags));
  assert.deepEqual(
    [grantOf(open).kind, grantOf(open).callStatus, grantOf(open).counted],
    ['one_off_cash', 'open', true],
  );
  assert.equal(open.withPlaceBenefits?.upfrontCashCents, 2_400_000);
  assert.equal(open.withPlaceBenefits?.months, 28);
  assert.equal(open.estimatedPurchaseDate, '2029-03-22');
  // Open today, closed long before the 34 months it takes to buy: the grant never reaches this purchase.
  const tooEarly = only(plan(personFixture(), [ruralPlace], [reducedTax, purchaseGrant('2026-12-31')], flags));
  assert.deepEqual([grantOf(tooEarly).callStatus, grantOf(tooEarly).counted], ['open', false]);
  assert.match(grantOf(tooEarly).explanation, /open today but closes before 2029-09-22, the day you could buy/);
  assert.equal(tooEarly.withPlaceBenefits?.upfrontCashCents, 2_700_000);
  assert.equal(tooEarly.withPlaceBenefits?.months, 34);
  // The call closes the month after the purchase with the grant (28 months): it still counts.
  const justInTime = only(plan(personFixture(), [ruralPlace], [reducedTax, purchaseGrant('2029-04-30')], flags));
  assert.equal(grantOf(justInTime).counted, true);
  assert.equal(justInTime.withPlaceBenefits?.months, 28);
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

test('cash that arrives after the purchase is not counted, whatever the measure', () => {
  const policies = [reducedTax, moveDeduction];
  const move = (item: ReturnType<typeof only>) => benefitOf(item, 'irpf_move');
  const saved = (currentSavingsCents: number, list = policies) =>
    only(plan(personFixture({}, { currentSavingsCents }), [ruralPlace], list));
  // €27,000 upfront, €21,000 available, €500 a month: 12 months, the very month the €750 arrives.
  const twelve = saved(2_300_000);
  assert.equal(twelve.withPlaceBenefits?.months, 12);
  assert.equal(move(twelve).counted, false);
  assert.match(move(twelve).explanation, /you could buy in 12 month\(s\), before this money arrives 12 months after/);
  // One month more to save and the €750 is in hand before the purchase: 13 months become 12.
  assert.equal(saved(2_250_000, [reducedTax]).withPlaceBenefits?.months, 13);
  const thirteen = saved(2_250_000);
  assert.equal(move(thirteen).counted, true);
  assert.equal(thirteen.withPlaceBenefits?.months, 12);
  // Already able to buy: nothing that arrives later shortens anything.
  const ready = saved(5_000_000);
  assert.equal(ready.status, 'target_reached');
  assert.equal(move(ready).counted, false);
  assert.match(move(ready).explanation, /already have the upfront cash/);
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

// ------------------------------------------------- baseline transfer tax

/** The real shape of the rural rate: 4% rural, 3% special attention, with the general tariff by value. */
const generalTariff = [
  { fromEur: 0, rate: 0.1 },
  { fromEur: 600_000, rate: 0.11 },
  { fromEur: 900_000, rate: 0.12 },
  { fromEur: 1_500_000, rate: 0.13 },
];
const ruralRate = policyFixture({
  id: 'itp_buy',
  intent: 'buy',
  mechanism: 'reduced_tax_rate',
  effect: {
    kind: 'transfer_tax_rate',
    standardRate: 0.1,
    standardTariff: generalTariff,
    reducedRate: { rural: 0.04, special_attention: 0.03, other: 0.1 },
  },
});
/** 5% for buyers aged 35 or younger, in every municipality of Catalonia. */
const youngRate = policyFixture({
  id: 'itp_young_buyer',
  intent: 'buy',
  mechanism: 'reduced_tax_rate',
  territory: 'catalonia',
  effect: {
    kind: 'transfer_tax_rate',
    standardRate: 0.1,
    standardTariff: generalTariff,
    reducedRate: { rural: 0.05, special_attention: 0.05, other: 0.05 },
  },
});
const buyerAged = (age: number | undefined, itpBuyerNetTaxBaseEur: number | undefined = 20_000) =>
  personFixture({ household: { ...verifiedHousehold, age, itpBuyerNetTaxBaseEur } });
const benefitOf = (item: ReturnType<typeof only>, id: string) => {
  const benefit = item.benefits.find(entry => entry.policyId === id);
  assert(benefit, `${id} is listed`);
  return benefit;
};

test('a verified young buyer starts from the 5% rate, so a rural place saves less than for an older buyer', () => {
  const policies = [ruralRate, youngRate];
  const older = only(plan(buyerAged(45), [ruralPlace], policies));
  // €100,000 home, aged 45: 20% + 10% + 2% = €32,000 → 44 months; rural 4% saves €6,000 → 32 months.
  assert.deepEqual(older.transferTax, {
    standardCents: 1_000_000,
    baselineCents: 1_000_000,
    baselinePolicyId: null,
    couldBeLower: false,
  });
  assert.equal(older.baseline?.upfrontCashCents, 3_200_000);
  assert.equal(older.baseline?.months, 44);
  assert.deepEqual([benefitOf(older, 'itp_buy').amountCents, benefitOf(older, 'itp_buy').counted], [600_000, true]);
  assert.equal(older.withPlaceBenefits?.months, 32);
  assert.equal(older.monthsSavedByPlace, 12);
  const olderYoungRate = benefitOf(older, 'itp_young_buyer');
  assert.deepEqual(
    [olderYoungRate.eligibilityStatus, olderYoungRate.counted, olderYoungRate.scope],
    ['ineligible', false, 'anywhere'],
  );
  assert.match(olderYoungRate.explanation, /Not applied, criteria not met/);

  const young = only(plan(buyerAged(30), [ruralPlace], policies));
  // Aged 30 with a €20,000 tax base: 5% anywhere → €27,000 → 34 months; rural 4% saves only €1,000 → 32 months.
  assert.deepEqual(young.transferTax, {
    standardCents: 1_000_000,
    baselineCents: 500_000,
    baselinePolicyId: 'itp_young_buyer',
    couldBeLower: false,
  });
  assert.equal(young.baseline?.upfrontCashCents, 2_700_000);
  assert.equal(young.baseline?.months, 34);
  const ruralSaving = benefitOf(young, 'itp_buy');
  assert.deepEqual([ruralSaving.amountCents, ruralSaving.counted, ruralSaving.scope], [100_000, true, 'place']);
  assert.match(ruralSaving.explanation, /4% instead of the 5% you already qualify for anywhere in Catalonia/);
  assert.equal(young.withPlaceBenefits?.upfrontCashCents, 2_600_000);
  assert.equal(young.withPlaceBenefits?.months, 32);
  assert.equal(young.monthsSavedByPlace, 2);
  assert(young.monthsSavedByPlace < older.monthsSavedByPlace);
  // The young rate is listed with its worth against the general rate, and is never a saving of the place.
  const applied = benefitOf(young, 'itp_young_buyer');
  assert.deepEqual(
    [applied.kind, applied.amountCents, applied.counted, applied.scope, applied.eligibilityStatus],
    ['upfront_cost_reduction', 500_000, false, 'anywhere', 'eligible'],
  );
  assert.match(applied.explanation, /5% instead of the general 10%.*Applied to your baseline/);
  assert(young.assumptions.some(entry => /baseline transfer tax is 5%, not the general 10%/.test(entry)));
  assert.deepEqual(young.dataMissing, []);

  // Outside a rural municipality the young buyer still pays 5%, and the place adds nothing.
  const city = only(plan(buyerAged(30), [cityPlace], policies));
  assert.equal(city.baseline?.months, 34);
  assert.equal(city.monthsSavedByPlace, 0);
  assert.equal(benefitOf(city, 'itp_buy').counted, false);
});

test('an unknown age or tax base keeps the 10% baseline and says it could be lower', () => {
  const policies = [ruralRate, youngRate];
  for (const person of [buyerAged(undefined), personFixture({ household: { ...verifiedHousehold, age: 30 } })]) {
    const item = only(plan(person, [ruralPlace], policies));
    assert.deepEqual(item.transferTax, {
      standardCents: 1_000_000,
      baselineCents: 1_000_000,
      baselinePolicyId: null,
      couldBeLower: true,
    });
    assert.equal(item.baseline?.upfrontCashCents, 3_200_000);
    assert.equal(item.baseline?.months, 44);
    assert.equal(benefitOf(item, 'itp_buy').amountCents, 600_000);
    const unverified = benefitOf(item, 'itp_young_buyer');
    assert.deepEqual([unverified.eligibilityStatus, unverified.counted], ['needs_verification', false]);
    assert.match(unverified.explanation, /Not applied to your baseline until verified/);
    assert.match(unverified.explanation, /saving of this place is smaller than shown/);
    const caveat = item.dataMissing.find(entry => entry.includes('itp_young_buyer'));
    assert.match(caveat ?? '', /baseline uses the general 10% and could be as low as 5%/);
    assert(
      item.assumptions.some(entry => /A lower rate that applies anywhere in Catalonia is not assumed/.test(entry)),
    );

    // Counting unverified benefits of the place never lowers the person's own baseline.
    const optimistic = only(plan(person, [ruralPlace], policies, { includeUnverifiedBenefits: true }));
    assert.equal(optimistic.baseline?.upfrontCashCents, 3_200_000);
    assert.equal(optimistic.transferTax?.baselinePolicyId, null);
    assert.equal(benefitOf(optimistic, 'itp_young_buyer').counted, false);
  }
  // No household facts at all: same caveat, and nothing is counted.
  const blank = only(plan(personFixture({ household: undefined }), [ruralPlace], policies));
  assert.equal(blank.transferTax?.couldBeLower, true);
  assert.equal(blank.baseline?.months, 44);
  assert.equal(blank.monthsSavedByPlace, 0);
});

test('a price above the first bracket uses the general tariff by value and is flagged', () => {
  const priced = (budgetCents: number, person = buyerAged(45)) =>
    only(
      plan(
        { ...person, home: { floorAreaM2: null, budgetCents, depositRate: 0.2 } },
        [cityPlace],
        [ruralRate, youngRate],
      ),
    );
  const flagged = (item: ReturnType<typeof only>) =>
    item.assumptions.some(entry => /price is above €600,000/.test(entry));

  // The tax agency's own example: €700,000 → €60,000 + 11% of €100,000 = €71,000.
  const above = priced(70_000_000);
  assert.equal(above.transferTax?.standardCents, 7_100_000);
  assert.equal(above.baseline?.upfrontCashCents, 14_000_000 + 7_100_000 + 1_400_000);
  assert(flagged(above));
  assert(
    above.assumptions.some(entry =>
      /10% from €0, 11% from €600,000, 12% from €900,000, 13% from €1,500,000/.test(entry),
    ),
  );
  // €1,600,000 → €165,000 + 13% of €100,000 = €178,000.
  assert.equal(priced(160_000_000).transferTax?.standardCents, 17_800_000);
  // Up to €600,000 the general rate is a plain 10% and nothing is flagged.
  const atLimit = priced(60_000_000);
  assert.equal(atLimit.transferTax?.standardCents, 6_000_000);
  assert(!flagged(atLimit));

  // A reduced rate is flat on the whole price: 5% of €700,000, worth €36,000 against the tariff.
  // The buyer can afford it within two years, so the rate is still theirs on the day of the purchase.
  const wealthy = buyerAged(30);
  wealthy.finances.currentSavingsCents = 18_000_000;
  const young = priced(70_000_000, wealthy);
  assert.equal(young.baseline?.months, 22);
  assert.equal(young.transferTax?.baselineCents, 3_500_000);
  assert.equal(benefitOf(young, 'itp_young_buyer').amountCents, 3_600_000);
  assert.match(benefitOf(young, 'itp_young_buyer').explanation, /instead of the general tariff \(€71,000/);
});

test('the youth purchase aid is the lower of its ceiling and its share of the price, and is never counted without a call', () => {
  const youthAid = policyFixture({
    id: 'youth_purchase_small_town',
    intent: 'buy',
    mechanism: 'grant',
    effectiveThrough: '2030-12-31',
    municipalityCodes: [ruralPlace.municipalityCode],
    callWindow: null,
    effect: { kind: 'one_off_rate_of_price', rate: 0.2, maxAmountEur: 15_000 },
  });
  const buyer = (budgetCents: number) =>
    personFixture({
      household: {
        ...verifiedHousehold,
        ownsHomeInSpain: false,
        incomeWithinFiveIprem: true,
      },
      home: { floorAreaM2: null, budgetCents, depositRate: 0.2 },
    });
  for (const [budgetCents, expected] of [
    [10_000_000, 1_500_000], // 20% of €100,000 is €20,000: the €15,000 ceiling is lower.
    [7_500_000, 1_500_000], // Both are €15,000.
    [5_000_000, 1_000_000], // 20% of €50,000 is €10,000, below the ceiling.
  ]) {
    for (const includeUnverifiedBenefits of [false, true]) {
      const item = only(plan(buyer(budgetCents), [ruralPlace], [reducedTax, youthAid], { includeUnverifiedBenefits }));
      const aid = benefitOf(item, 'youth_purchase_small_town');
      assert.deepEqual(
        [aid.kind, aid.amountCents, aid.callStatus, aid.eligibilityStatus, aid.counted],
        ['one_off_cash', expected, 'unknown', 'needs_verification', false],
      );
      assert.match(aid.explanation, /lower of €15,000 and 20% of the price/);
      assert.match(aid.explanation, /Not counted/);
      // Only the reduced transfer tax (5% of the price) lowers the upfront cash.
      assert.equal(item.withPlaceBenefits?.upfrontCashCents, Math.round(budgetCents * 0.27));
    }
  }
  // The €300,000 ceiling is checked against the price of the plan, whatever price was stated elsewhere.
  for (const purchasePriceEur of [undefined, 100_000]) {
    const dear = buyer(40_000_000);
    dear.household = { ...dear.household, purchasePriceEur };
    for (const includeUnverifiedBenefits of [false, true]) {
      const aid = benefitOf(
        only(plan(dear, [ruralPlace], [reducedTax, youthAid], { includeUnverifiedBenefits })),
        'youth_purchase_small_town',
      );
      assert.deepEqual([aid.eligibilityStatus, aid.counted], ['ineligible', false]);
      assert.match(aid.explanation, /criteria not met: .*at most €300,000/);
    }
  }
  // At the ceiling, for a buyer with the cash in hand (so still 30 on the day of the purchase).
  const ready = buyer(30_000_000);
  ready.finances = { ...ready.finances, currentSavingsCents: 20_000_000 };
  const atCeiling = benefitOf(only(plan(ready, [ruralPlace], [reducedTax, youthAid])), 'youth_purchase_small_town');
  assert.equal(atCeiling.eligibilityStatus, 'needs_verification', 'only the missing call stands in the way');
  // An unknown price gives an unknown amount, never zero.
  const unpriced = only(plan(personFixture(), [placeFixture('250001', 'rural', null)], [reducedTax, youthAid]));
  assert.equal(benefitOf(unpriced, 'youth_purchase_small_town').amountCents, null);
});

test('a rent deduction capped by amount stays uncounted while the rent paid is unknown', () => {
  const rentDeduction = policyFixture({
    id: 'irpf_rent',
    intent: 'rent',
    mechanism: 'tax_deduction',
    effect: {
      kind: 'annual_rate_of_cost',
      cost: 'rent',
      rate: { rural: 0.15, special_attention: 0.2, other: 0 },
      maxAmountEur: { individual: 600, joint: 1200 },
    },
  });
  const renter = personFixture({
    household: { ...verifiedHousehold, paysQualifyingRent: true, satisfiesRentCompatibility: true },
  });
  const item = only(plan(renter, [ruralPlace], [reducedTax, rentDeduction], { includeUnverifiedBenefits: true }));
  const rent = benefitOf(item, 'irpf_rent');
  assert.deepEqual([rent.kind, rent.amountCents, rent.counted], ['annual_cash', null, false]);
  assert.match(rent.explanation, /15% a year of rent paid, capped at €600 a year \(€1,200 on a joint return\)/);
  assert.equal(item.withPlaceBenefits?.months, 34);
});

test('the real policy data credits a rural place only with the difference from the young-buyer rate', () => {
  const { snapshot, policies } = loadData();
  const termens = buildPlace(snapshot, '252206'); // special attention: 3% transfer tax
  assert.equal(termens.rural, 'special_attention');
  const home = { floorAreaM2: null, budgetCents: 15_000_000, depositRate: 0.2 };
  // €30,000 available and €1,000 a month: both buyers can buy well before the rural rate ends in July 2029.
  const saver = (age: number) => ({
    ...buyerAged(age),
    home,
    finances: { ...buyerAged(age).finances, currentSavingsCents: 3_200_000, monthlyIncomeCents: 300_000 },
  });
  const older = only(plan(saver(45), [termens], policies));
  const young = only(plan(saver(30), [termens], policies));
  // €150,000: 10% − 3% = €10,500 for the older buyer; 5% − 3% = €3,000 for the young one.
  assert.deepEqual([older.transferTax?.baselineCents, older.transferTax?.baselinePolicyId], [1_500_000, null]);
  assert.deepEqual([benefitOf(older, 'itp_buy').amountCents, benefitOf(older, 'itp_buy').counted], [1_050_000, true]);
  // €48,000 upfront is 18 months away; €37,500 with the 3% rate is 8.
  assert.deepEqual([older.baseline?.months, older.withPlaceBenefits?.months], [18, 8]);
  assert.equal(older.estimatedPurchaseDate, '2027-07-22');
  assert.deepEqual(
    [young.transferTax?.baselineCents, young.transferTax?.baselinePolicyId],
    [750_000, 'itp_young_buyer'],
  );
  assert.deepEqual([benefitOf(young, 'itp_buy').amountCents, benefitOf(young, 'itp_buy').counted], [300_000, true]);
  // Every rate considered is listed, each with its explanation; the Catalonia-wide ones are never place savings.
  const general = young.benefits.filter(benefit => benefit.scope === 'anywhere');
  assert.deepEqual(
    general.map(benefit => benefit.policyId),
    ['itp_young_buyer', 'itp_large_family', 'itp_single_parent', 'itp_disability'],
  );
  assert(general.every(benefit => !benefit.counted && benefit.explanation.length > 0));
  // Large-family, single-parent and disability status are unknown here: reported, not assumed either way.
  assert.equal(older.transferTax?.couldBeLower, true);
  assert.match(older.dataMissing.join(' '), /itp_large_family, itp_single_parent, itp_disability/);
  // The state youth aid has no Catalan call, so it is never counted whatever is switched on.
  const optimistic = only(plan(saver(30), [termens], policies, { includeUnverifiedBenefits: true }));
  assert.equal(benefitOf(optimistic, 'youth_purchase_small_town').counted, false);

  // Saving €500 a month from €10,000, the same purchase lands in 2033, after the rural rate ends on 16 July 2029.
  const slow = only(plan({ ...buyerAged(45), home }, [termens], policies));
  const lapsed = benefitOf(slow, 'itp_buy');
  assert.deepEqual([lapsed.amountCents, lapsed.counted], [1_050_000, false]);
  assert.match(
    lapsed.explanation,
    /in force until 2029-07-16 and is not confirmed for 2033-0\d-22, the day you could buy/,
  );
  assert.equal(slow.withPlaceBenefits?.upfrontCashCents, 4_800_000);
});

// ------------------------------------- screening on the day of the purchase

const ruralRateBetween = (effectiveFrom: string, effectiveThrough: string) => ({
  ...ruralRate,
  effectiveFrom,
  effectiveThrough,
});
const parentAged = (age: number, childAge: number) =>
  personFixture({
    household: {
      ...verifiedHousehold,
      age,
      itpBuyerNetTaxBaseEur: 20_000,
      children: [{ age: childAge, meetsItpSchooling: true }],
    },
  });

test('a reduced rate that ends before the day of the purchase is not counted, and the plan says why', () => {
  // Aged 45 with a child of 14: €100,000 rural home, €10,000 available, €500 a month, planned on 2026-11-22.
  // Counting the 4% rate gives 32 months, a purchase on 2029-07-22: six days after the measure ends.
  const policies = [ruralRateBetween('2026-01-01', '2029-07-16'), youngRate];
  const item = only(plan(parentAged(45, 14), [ruralPlace], policies));
  const rate = benefitOf(item, 'itp_buy');
  assert.deepEqual([rate.amountCents, rate.counted], [600_000, false]);
  assert.match(
    rate.explanation,
    /Not counted: the measure is in force until 2029-07-16 and is not confirmed for 2030-07-22, the day you could buy \(44 months after the plan date\)/,
  );
  assert.equal(item.withPlaceBenefits?.upfrontCashCents, 3_200_000);
  assert.equal(item.withPlaceBenefits?.months, 44);
  assert.equal(item.monthsSavedByPlace, 0);
  assert.equal(item.estimatedPurchaseDate, '2030-07-22');
  assert(
    item.assumptions.some(entry =>
      /screened on the day you could buy.*2030-07-22 \(44 months after 2026-11-22\)/.test(entry),
    ),
  );
  // In force through the very day of the purchase, and a child still under 16 then: counted, 32 months.
  const inTime = only(
    plan(parentAged(45, 10), [ruralPlace], [ruralRateBetween('2026-01-01', '2029-07-22'), youngRate]),
  );
  assert.equal(benefitOf(inTime, 'itp_buy').counted, true);
  assert.equal(inTime.withPlaceBenefits?.months, 32);
  assert.equal(inTime.estimatedPurchaseDate, '2029-07-22');
});

test('a child who is past 16 on the day of the purchase no longer earns the family rate', () => {
  const policies = [ruralRate, youngRate];
  // 14 today; 16 or 17 after the 32 months the rate would give, 17 or 18 after the 44 it takes without it.
  const item = only(plan(parentAged(45, 14), [ruralPlace], policies));
  const rate = benefitOf(item, 'itp_buy');
  assert.deepEqual([rate.eligibilityStatus, rate.counted], ['ineligible', false]);
  assert.match(rate.explanation, /applies if you buy on the plan date, but not on 2030-07-22, the day you could buy/);
  assert.match(rate.explanation, /By then you would be 48 or 49 and your child would be 17 or 18\./);
  assert.match(rate.explanation, /Criteria not met by then: At least one child up to age 16/);
  assert.equal(item.withPlaceBenefits?.months, 44);
  // 13 today is 15 or 16 after 32 months: inside the limit whenever the birthday falls.
  const younger = only(plan(parentAged(45, 13), [ruralPlace], policies));
  assert.equal(benefitOf(younger, 'itp_buy').counted, true);
  assert.equal(younger.withPlaceBenefits?.months, 32);
  // A child of 2 needs no schooling fact today, but is 4 or 5 on the day of the purchase, when it does.
  const toddler = personFixture({ household: { ...verifiedHousehold, children: [{ age: 2 }] } });
  const unknown = benefitOf(only(plan(toddler, [ruralPlace], policies)), 'itp_buy');
  assert.deepEqual([unknown.eligibilityStatus, unknown.counted], ['needs_verification', false]);
  assert.match(
    unknown.explanation,
    /it is not certain on 2030-07-22.*your child would be 5 or 6\..*ITP schooling rules/,
  );
});

test('a young buyer who is past 35 on the day of the purchase starts from the general rate', () => {
  const home = { floorAreaM2: null, budgetCents: 40_000_000, depositRate: 0.2 };
  const item = only(plan({ ...buyerAged(30), home }, [cityPlace], [ruralRate, youngRate]));
  // At 5% the upfront cash is €108,000: 196 months, when the buyer is 46. At 10% it is €128,000: 236 months.
  assert.deepEqual(item.transferTax, {
    standardCents: 4_000_000,
    baselineCents: 4_000_000,
    baselinePolicyId: null,
    couldBeLower: false,
  });
  assert.equal(item.baseline?.upfrontCashCents, 12_800_000);
  assert.equal(item.baseline?.months, 236);
  assert.equal(item.withPlaceBenefits?.months, 236);
  const rate = benefitOf(item, 'itp_young_buyer');
  assert.deepEqual([rate.eligibilityStatus, rate.amountCents], ['ineligible', 2_000_000]);
  assert.match(
    rate.explanation,
    /Not applied: it applies if you buy on the plan date, but not on 2046-07-22, the day you could buy \(236 months after the plan date\)\. By then you would be 49 or 50 and your child would be 24 or 25\. Criteria not met by then: The buyer is 35 or younger/,
  );
  assert(item.assumptions.some(entry => /baseline transfer tax is the general 10%/.test(entry)));
});

test('an age limit that a birthday decides is unverified, never assumed', () => {
  // 35 today, €22,000 available and €1,000 a month: 5 months at the 5% rate, 10 at the general 10%.
  // On either day the buyer is 35 or 36, so the rate is neither applied nor ruled out.
  const buyer = personFixture(
    { household: { ...verifiedHousehold, age: 35, itpBuyerNetTaxBaseEur: 20_000 } },
    { currentSavingsCents: 2_400_000, monthlyIncomeCents: 300_000 },
  );
  const item = only(plan(buyer, [cityPlace], [ruralRate, youngRate]));
  assert.deepEqual(item.transferTax, {
    standardCents: 1_000_000,
    baselineCents: 1_000_000,
    baselinePolicyId: null,
    couldBeLower: true,
  });
  assert.equal(item.baseline?.months, 10);
  const rate = benefitOf(item, 'itp_young_buyer');
  assert.equal(rate.eligibilityStatus, 'needs_verification');
  assert.match(
    rate.explanation,
    /it is not certain on 2027-09-22.*By then you would be 35 or 36 and your child would be 5 or 6\./,
  );
  assert.match(rate.explanation, /depends on birthdays this plan does not know/);
  // Able to buy today, the buyer is 35 on the day of the purchase and the rate is theirs.
  const today = only(
    plan({ ...buyer, finances: { ...buyer.finances, currentSavingsCents: 5_000_000 } }, [cityPlace], [youngRate]),
  );
  assert.deepEqual([today.status, today.transferTax?.baselinePolicyId], ['target_reached', 'itp_young_buyer']);
});

test('when the day of the purchase and a benefit chase each other, the benefit is left out', () => {
  // The rate starts on 2030-01-01. Without it the purchase is 44 months away (2030-07-22, in force);
  // with it, 32 months away (2029-07-22, not yet in force). Neither day agrees with itself.
  const item = only(plan(parentAged(45, 5), [ruralPlace], [ruralRateBetween('2030-01-01', '2099-12-31')]));
  const rate = benefitOf(item, 'itp_buy');
  assert.deepEqual([rate.amountCents, rate.counted], [600_000, false]);
  assert.match(rate.explanation, /Not counted: whether it applies depends on the day you could buy.*did not settle/);
  assert.equal(item.withPlaceBenefits?.months, 44);
  assert.equal(item.estimatedPurchaseDate, '2030-07-22');
  assert(item.assumptions.some(entry => /the day you could buy did not settle/.test(entry)));

  // Only the place's rate chases the day: the young buyer keeps the 5% baseline, which does settle (34 months).
  const young = only(plan(buyerAged(30), [ruralPlace], [ruralRateBetween('2029-09-01', '2099-12-31'), youngRate]));
  assert.equal(young.transferTax?.baselinePolicyId, 'itp_young_buyer');
  assert.match(benefitOf(young, 'itp_young_buyer').explanation, /Applied to your baseline/);
  assert.deepEqual([benefitOf(young, 'itp_buy').amountCents, benefitOf(young, 'itp_buy').counted], [100_000, false]);
  assert.match(benefitOf(young, 'itp_buy').explanation, /did not settle/);
  assert.deepEqual([young.baseline?.months, young.withPlaceBenefits?.months, young.monthsSavedByPlace], [34, 34, 0]);
  assert.equal(young.withPlaceBenefits?.upfrontCashCents, 2_700_000);
});

test('a rural rate does not apply to a purchase before the rural classification takes effect', () => {
  const classifiedFrom = (ruralEffectiveFrom: string | null) =>
    only(plan(personFixture(), [{ ...ruralPlace, ruralEffectiveFrom }], [reducedTax]));
  const tooEarly = classifiedFrom('2031-01-01');
  const rate = benefitOf(tooEarly, 'itp_buy');
  assert.deepEqual([rate.eligibilityStatus, rate.counted], ['ineligible', false]);
  assert.match(rate.explanation, /covered by the rural classification on the event date/);
  assert.equal(tooEarly.withPlaceBenefits?.months, 44);
  for (const known of ['2026-02-24', null]) assert.equal(classifiedFrom(known).withPlaceBenefits?.months, 34);
  // The place node carries the date the snapshot states.
  const { snapshot } = loadData();
  const town = snapshot.municipalities.find(entry => entry.code === '252206');
  assert.match(town?.rural.effectiveFrom ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(buildPlace(snapshot, '252206').ruralEffectiveFrom, town?.rural.effectiveFrom);
});

// ------------------------------------------------------------ absurd inputs

test('a budget of zero is not a price', () => {
  const free = personFixture({ home: { floorAreaM2: 100, budgetCents: 0, depositRate: 0.2 } });
  const item = only(plan(free, [cityPlace], [reducedTax]));
  assert.deepEqual(
    [item.status, item.purchasePriceCents, item.priceBasis, item.baseline, item.withPlaceBenefits],
    ['insufficient_data', null, 'unknown', null, null],
  );
  assert(item.dataMissing.includes('person.home.budgetCents (must be greater than zero)'));
  const unpriced = placeFixture('250006', 'not_listed', 0);
  assert.equal(only(plan(personFixture(), [unpriced], [reducedTax])).status, 'insufficient_data');
});

test('a timeline longer than 600 months is not given as a number', () => {
  const saving = (monthlyCents: number) =>
    only(plan(personFixture({}, { monthlyExpensesCents: 250_000 - monthlyCents }), [cityPlace], [reducedTax]));
  // €22,000 to save at one cent a month would be 2,200,000 months.
  const cent = saving(1);
  assert.equal(cent.status, 'beyond_horizon');
  assert.deepEqual(cent.baseline, { upfrontCashCents: 3_200_000, monthlySavingsCents: 1, months: null });
  assert.deepEqual([cent.withPlaceBenefits?.months, cent.monthsSaved, cent.estimatedPurchaseDate], [null, null, null]);
  assert(
    cent.assumptions.some(entry =>
      /at €0.01 a month the upfront cash is more than 600 months \(50 years\) away/.test(entry),
    ),
  );
  // €36.67 a month is exactly 600 months; one cent less is 601.
  assert.deepEqual([saving(3_667).status, saving(3_667).baseline?.months], ['estimated', 600]);
  assert.deepEqual([saving(3_666).status, saving(3_666).baseline?.months], ['beyond_horizon', null]);
  // Saving nothing is still told apart from saving too slowly.
  assert.equal(saving(0).status, 'no_positive_savings');
  // A place beyond the horizon sorts after every place with a timeline.
  const far = { ...personFixture(), home: { floorAreaM2: 100, budgetCents: null, depositRate: 0.2 } };
  const dear = placeFixture('250007', 'not_listed', 20_000);
  assert.deepEqual(
    plan(far, [dear, cityPlace], [reducedTax]).plans.map(entry => entry.status),
    ['estimated', 'beyond_horizon'],
  );
});

// ------------------------------------------------------------------ habits

test('a habit is added on top of bank-observed figures only when it started after the observed period', () => {
  const observed = (habits: Person['habits'], finances: Partial<Person['finances']> = {}, assumptions = {}) =>
    only(
      plan(
        personFixture({ habits }, { basis: 'bank_observed', asOf: '2026-10-31', ...finances }),
        [cityPlace],
        [reducedTax],
        assumptions,
      ),
    );
  for (const basis of ['bank_observed', 'mixed'] as const) {
    // No start date: the saving may already be inside the observed cash flow.
    const undated = observed([habit('active')], { basis });
    assert.deepEqual([undated.withHabits?.monthlySavingsCents, undated.withHabits?.months], [50_000, 44]);
    assert.equal(undated.monthsSavedByHabits, 0);
    assert(
      undated.assumptions.some(entry =>
        /1 active habit\(s\) are shown but not counted \(Cook at home\): your monthly savings come from bank movements up to 2026-10-31/.test(
          entry,
        ),
      ),
    );
    assert(!undated.assumptions.some(entry => /habit\(s\) add/.test(entry)));
  }
  // Started on the last observed day: inside the period. Started the day after: on top of it.
  assert.equal(observed([habit('active', null, '2026-10-31')]).withHabits?.months, 44);
  const later = observed([habit('active', null, '2026-11-01')]);
  assert.deepEqual([later.withHabits?.monthlySavingsCents, later.withHabits?.months], [60_000, 37]);
  assert(later.assumptions.some(entry => /1 habit\(s\) add €100 a month/.test(entry)));
  // Without the end of the observed period nothing can be placed after it.
  assert.equal(observed([habit('active', null, '2026-11-01')], { asOf: null }).withHabits?.months, 44);
  // Declared figures are the person's own statement of a month; their habits are counted as before.
  assert.equal(observed([habit('active')], { basis: 'declared' }).withHabits?.months, 37);
  // A proposed habit has not started, so it cannot be inside the observed figures.
  assert.equal(observed([habit('proposed')], {}, { includeProposedHabits: true }).withHabits?.months, 37);
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
  const declared = buildPerson({ userId: 'user-001', synthetic: true, context: unconfirmed });
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
  const observed = buildPerson({ userId: 'user-001', synthetic: true, context: unconfirmed, bankSummary });
  assert.deepEqual(
    [observed.finances.monthlyIncomeCents, observed.finances.monthlyExpensesCents, observed.finances.basis],
    [260_000, 210_000, 'bank_observed'],
  );
  assert.equal(observed.finances.asOf, '2026-10-31');
  const confirmed = {
    resolved: { data, provenance: { 'finance.monthlyIncomeCents': [{ confirmed: true, ...stamp }] } },
  };
  const mixed = buildPerson({ userId: 'user-001', synthetic: true, context: confirmed, bankSummary });
  assert.deepEqual(
    [mixed.finances.monthlyIncomeCents, mixed.finances.monthlyExpensesCents, mixed.finances.basis],
    [250_000, 210_000, 'mixed'],
  );
  const partial = buildPerson({
    userId: 'user-001',
    synthetic: true,
    context: { resolved: { data: {} } },
    bankSummary: { ...bankSummary, dataStatus: 'partial' },
  });
  assert.deepEqual(
    [partial.finances.monthlyIncomeCents, partial.finances.basis, partial.householdSize],
    [null, 'unknown', null],
  );
});

test('buildPerson maps confirmed eligibility inputs onto household facts and infers nothing', () => {
  const input = (id: string, confirmed: boolean, data: object) =>
    inputSchema.parse({
      id,
      source: 'interview',
      observedAt: '2026-11-10T00:00:00Z',
      confirmed,
      synthetic: true,
      data,
    });
  const resolved = resolveInputs([
    input('facts', true, {
      eligibility: {
        age: 30,
        children: [{ age: 5, meetsItpSchooling: true }],
        primaryResidence: true,
        filing: 'individual',
        itpFamilyNetTaxBaseEur: 30_000,
        itpTransaction: true,
        satisfiesItpOccupancyRules: true,
      },
      household: { size: 3, dependants: 1 },
      finance: { currentSavingsCents: 1_200_000, monthlyIncomeCents: 250_000, monthlyExpensesCents: 200_000 },
      housing: { budgetCents: 10_000_000 },
    }),
    // Said in passing, never confirmed: not a fact the screening may rely on.
    input('guess', false, { eligibility: { largeFamily: true, itpBuyerNetTaxBaseEur: 20_000 } }),
  ]);
  const stored = buildPerson({ userId: 'user-001', synthetic: true, context: { resolved } });
  assert.deepEqual(stored.household, {
    age: 30,
    children: [{ age: 5, meetsItpSchooling: true }],
    primaryResidence: true,
    filing: 'individual',
    itpFamilyNetTaxBaseEur: 30_000,
    itpTransaction: true,
    satisfiesItpOccupancyRules: true,
  });
  // With those facts a stored person gets the place's reduced rate counted: 34 months instead of 44.
  const item = only(
    plan({ ...stored, finances: { ...stored.finances, emergencyReserveCents: 200_000 } }, [ruralPlace], [reducedTax]),
  );
  assert.deepEqual(
    [benefitOf(item, 'itp_buy').eligibilityStatus, benefitOf(item, 'itp_buy').counted],
    ['eligible', true],
  );
  assert.deepEqual([item.baseline?.months, item.withPlaceBenefits?.months], [44, 34]);

  // The household size and the number of dependants never become a child, an age or a family status.
  const bare = buildPerson({
    userId: 'user-001',
    synthetic: true,
    context: { resolved: { data: { household: { size: 5, dependants: 3 } } } },
  });
  assert.equal(bare.household, undefined);
  assert.equal(
    benefitOf(
      only(
        plan({ ...bare, home: { floorAreaM2: 100, budgetCents: null, depositRate: 0.2 } }, [ruralPlace], [reducedTax]),
      ),
      'itp_buy',
    ).eligibilityStatus,
    'needs_verification',
  );
  // A conflicting (null) or malformed value is unknown; a stated purchase price is not a household fact.
  const stamp = [{ confirmed: true, observedAt: '2026-11-10T00:00:00Z' }];
  const messy = buildPerson({
    userId: 'user-001',
    synthetic: true,
    context: {
      resolved: {
        data: { eligibility: { age: 'thirty', filing: null, purchasePriceEur: 90_000, singleParent: false } },
        provenance: {
          'eligibility.age': stamp,
          'eligibility.filing': stamp,
          'eligibility.purchasePriceEur': stamp,
          'eligibility.singleParent': stamp,
        },
      },
    },
  });
  assert.deepEqual(messy.household, { singleParent: false });
  // The purchase price is not part of the input contract.
  assert.throws(() => input('price', true, { eligibility: { purchasePriceEur: 90_000 } }));
});

test('buildPerson labels data as synthetic only when the caller says so', () => {
  const context = { resolved: { data: {} } };
  assert.equal(buildPerson({ userId: 'user-001', synthetic: false, context }).synthetic, false);
  assert.equal(buildPerson({ userId: 'user-001', synthetic: true, context }).synthetic, true);
  // A context that happens to carry a flag does not stand in for the caller's statement.
  const flagged = { ...context, synthetic: true };
  assert.equal(buildPerson({ userId: 'user-001', synthetic: false, context: flagged }).synthetic, false);
  // @ts-expect-error the flag is required: there is no default
  assert.throws(() => buildPerson({ userId: 'user-001', context }));
});

test('buildPerson maps habit goals and check-ins', () => {
  const goal = { title: 'Cook at home', action: 'Cook four dinners a week', category: 'food', targetDaysPerWeek: 4 };
  const person = buildPerson({
    userId: 'user-001',
    synthetic: true,
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
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), [
      'get_my_inputs',
      'get_person',
      'get_place',
      'plan_home_savings',
      'save_my_inputs',
    ]);
    assert(list.tools.every(tool => tool.name === 'save_my_inputs' || tool.annotations?.readOnlyHint));
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
    }
    // A buyer who can buy before the rural rate ends gets it counted in the rural places and nowhere else.
    const saver = {
      ...buyerAged(45),
      home: { floorAreaM2: null, budgetCents: 15_000_000, depositRate: 0.2 },
      finances: { ...buyerAged(45).finances, currentSavingsCents: 3_200_000, monthlyIncomeCents: 300_000 },
    };
    const compared = await client.callTool({
      name: 'plan_home_savings',
      arguments: { person: saver, municipalityCodes: ['250404', '252154', '252206'] },
    });
    assert(!compared.isError, JSON.stringify(compared.content));
    const counted = Object.fromEntries(
      planResult
        .parse(compared.structuredContent)
        .plans.map(item => [
          item.place.municipalityCode,
          item.benefits.filter(benefit => benefit.counted).map(benefit => benefit.policyId),
        ]),
    );
    // Balaguer is not rural; Talarn is rural (4%); Térmens is special attention (3%).
    assert.deepEqual(counted, { '250404': [], '252154': ['itp_buy'], '252206': ['itp_buy'] });
    const everyBenefit = planResult.parse(compared.structuredContent).plans.flatMap(item => item.benefits);
    assert.equal(everyBenefit.filter(benefit => benefit.counted).length, 2);
    for (const benefit of everyBenefit) {
      assert(benefit.explanation.length > 0);
      assert.equal(
        benefit.counted && (benefit.callStatus === 'closed' || benefit.eligibilityStatus !== 'eligible'),
        false,
      );
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
      assert((await client.callTool(request)).isError, 'no caller and no inline person is a tool error');
  } finally {
    await close();
  }
});

test('MCP planner tools load the caller’s own person and tolerate absent habits and bank data', async () => {
  // A person handle is bound to one id by the server; the tools never take a user id (see tests/auth.test.ts).
  const seen: string[] = [];
  const reader = (userId: string, context: Record<string, unknown> | null) => ({
    userId,
    synthetic: false,
    context: async () => {
      seen.push(`${userId}:context`);
      return context;
    },
    inputs: async () => ({ inputs: [] }),
    saveInputs: async () => ({ inserted: 0, duplicates: 0 }),
    bankSummary: async (period: { from: string; to: string }) => {
      seen.push(`${userId}:summary:${period.from}:${period.to}`);
      throw new Error('secret-token upstream stack');
    },
    bankUpdates: async () => ({}),
    bankRuntime: async () => ({}),
    bankBalanceCents: async () => null,
    habits: async () => {
      seen.push(`${userId}:habits`);
      throw new Error('secret-token upstream stack');
    },
  });
  const stored = {
    userId: 'p-1',
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
  };
  const { snapshot } = loadData();
  const options = { snapshot, policies: [reducedTax], today: () => asOf };
  const { client, close } = await connect({
    ...options,
    caller: { me: reader('p-1', stored), scopes: ['person:read'], demo: null },
  });
  const missing = await connect({
    ...options,
    caller: { me: reader('p-404', null), scopes: ['person:read'], demo: null },
  });
  const invalid = await connect({
    ...options,
    caller: { me: reader('p-2', { resolved: 'not a context' }), scopes: ['person:read'], demo: null },
  });
  try {
    const own = await client.callTool({ name: 'get_person', arguments: {} });
    assert(!own.isError, JSON.stringify(own.content));
    const person = personSchema.parse(own.structuredContent);
    assert.deepEqual([person.id, person.synthetic], ['p-1', false]);
    assert.deepEqual([person.finances.basis, person.habits.length, person.householdSize], ['declared', 0, 2]);
    assert(seen.includes('p-1:summary:2026-08-01:2026-10-31'));
    assert(seen.includes('p-1:habits'));

    const code = snapshot.municipalities[0].code;
    const planned = await client.callTool({
      name: 'plan_home_savings',
      arguments: { me: true, municipalityCodes: [code] },
    });
    assert(!planned.isError, JSON.stringify(planned.content));
    const result = planResult.parse(planned.structuredContent);
    assert.deepEqual([result.plans[0].priceBasis, result.plans[0].baseline?.months], ['budget', 40]);
    assert(result.limitations.some(entry => entry.includes('Bank movements could not be read')));
    const unknown = await missing.client.callTool({ name: 'get_person', arguments: {} });
    assert(unknown.isError);
    const broken = await invalid.client.callTool({ name: 'get_person', arguments: {} });
    assert(broken.isError);
    // Naming somebody is not possible, and exactly one subject must be chosen.
    for (const args of [{ userId: 'p-404' }, { userId: 'p-1' }])
      assert((await client.callTool({ name: 'get_person', arguments: args })).isError);
    const both = await client.callTool({
      name: 'plan_home_savings',
      arguments: { me: true, person: person, municipalityCodes: [code] },
    });
    assert(both.isError);
    for (const response of [own, planned, unknown, broken]) assert(!JSON.stringify(response).includes('secret-token'));
  } finally {
    await close();
    await missing.close();
    await invalid.close();
  }
});
