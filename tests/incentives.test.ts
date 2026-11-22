import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncentivesInput } from '../packages/contracts/places.ts';
import { eligibility, policyEffect, policyId } from '../packages/contracts/places.ts';
import type { Person } from '../packages/contracts/planner.ts';
import { buildPlace } from '../packages/model/place.ts';
import { getTown, loadData } from '../packages/places/data.ts';
import { callStatusOn, evaluateIncentives } from '../packages/places/eligibility.ts';
import { planForPlaces } from '../packages/planner/plan.ts';

const { snapshot, policies } = loadData();
const today = '2026-11-22';
const talarn = '252154'; // rural
const termens = '252206'; // special attention
const tremp = '252347'; // partial: attached nuclei only
const calaf = '080312'; // not listed as rural, 3,627 residents
const balaguer = '250404'; // not listed as rural, 17,667 residents

type Household = NonNullable<IncentivesInput['household']>;

function check(
  id: string,
  municipalityCode: string,
  input: Omit<IncentivesInput, 'municipalityCode'> = {},
  asOf = today,
) {
  const results = evaluateIncentives(
    policies,
    getTown(snapshot, municipalityCode),
    { municipalityCode, ...input },
    asOf,
  );
  const result = results.find(entry => entry.id === id);
  assert(result, `${id} is evaluated`);
  return eligibility.parse(result);
}

test('every policy has a parsed effect and a dated official source', () => {
  assert.deepEqual(policies.map(entry => entry.id).sort(), [...policyId.options].sort());
  for (const entry of policies) {
    assert(entry.effect, `${entry.id} has an effect`);
    policyEffect.parse(entry.effect);
    assert.equal(entry.lastVerified, today);
    assert.match(entry.sourceUrl, /^https:\/\/([a-z]+\.)?gencat\.cat\//);
    assert.match(entry.legalUrl, /^https:\/\/(www\.boe\.es|dogc\.gencat\.cat)\//);
  }
});

/** A buyer with the cash in hand, so every purchase below happens on the plan date. */
function buyer(budgetEur: number, household: Household): Person {
  return {
    id: 'buyer',
    synthetic: true,
    household,
    householdSize: 3,
    currentMunicipalityCode: null,
    finances: {
      monthlyIncomeCents: 300_000,
      monthlyExpensesCents: 200_000,
      currentSavingsCents: 100_000_000,
      emergencyReserveCents: 0,
      basis: 'declared',
      asOf: today,
    },
    home: { floorAreaM2: null, budgetCents: budgetEur * 100, depositRate: 0.2 },
    habits: [],
  };
}
function planned(code: string, budgetEur: number, household: Household) {
  const [plan] = planForPlaces(buyer(budgetEur, household), [buildPlace(snapshot, code)], policies, {}, today).plans;
  const benefit = (id: string) => {
    const found = plan.benefits.find(entry => entry.policyId === id);
    assert(found, `${id} is listed`);
    return found;
  };
  return { plan, benefit };
}
const family: Household = {
  primaryResidence: true,
  age: 45,
  children: [{ age: 5, meetsItpSchooling: true, inDesignatedSchool: true }],
  itpFamilyNetTaxBaseEur: 30_000,
  itpBuyerNetTaxBaseEur: 20_000,
  itpTransaction: true,
  satisfiesItpOccupancyRules: true,
  largeFamily: false,
  singleParent: false,
  disability65: false,
};

test('the verified transfer-tax figures give the tax a real purchase pays', () => {
  // €150,000: 10% is €15,000. Rural 4% is €6,000 (€9,000 less); special attention 3% is €4,500 (€10,500 less).
  for (const [code, saving, upfront] of [
    [talarn, 900_000, 3_900_000],
    [termens, 1_050_000, 3_750_000],
  ] as const) {
    const { plan, benefit } = planned(code, 150_000, family);
    assert.deepEqual(plan.transferTax, {
      standardCents: 1_500_000,
      baselineCents: 1_500_000,
      baselinePolicyId: null,
      couldBeLower: false,
    });
    assert.deepEqual([benefit('itp_buy').amountCents, benefit('itp_buy').counted], [saving, true]);
    assert.equal(plan.withPlaceBenefits?.upfrontCashCents, upfront);
    // The rehabilitation rate is the same rate for a different purchase; its facts are unknown here.
    assert.deepEqual([benefit('itp_rehab_buy').amountCents, benefit('itp_rehab_buy').counted], [saving, false]);
  }
  // Outside the rural list the general rate stays and nothing is saved.
  const city = planned(balaguer, 150_000, family);
  // The place is not covered: no amount of the buyer's own, and the nominal saving there is nothing.
  assert.deepEqual(
    [city.benefit('itp_buy').amountCents, city.benefit('itp_buy').nominalAmountCents, city.benefit('itp_buy').counted],
    [null, 0, false],
  );
  assert.equal(city.plan.withPlaceBenefits?.upfrontCashCents, 4_800_000);

  // The general tariff by value: €700,000 pays 10% of €600,000 and 11% of the rest, €71,000.
  // €1,600,000 pays €60,000 + €33,000 + €72,000 + 13% of €100,000 = €178,000.
  assert.equal(planned(balaguer, 700_000, family).plan.transferTax?.standardCents, 7_100_000);
  assert.equal(planned(balaguer, 1_600_000, family).plan.transferTax?.standardCents, 17_800_000);

  // Each 5% rate for the whole of Catalonia halves the tax in a town that is not rural, and never adds up.
  for (const [id, facts] of [
    ['itp_young_buyer', { age: 30 }],
    ['itp_large_family', { largeFamily: true }],
    ['itp_single_parent', { singleParent: true }],
    ['itp_disability', { disability65: true }],
  ] as const) {
    const { plan, benefit } = planned(balaguer, 150_000, { ...family, ...facts });
    assert.deepEqual(
      [plan.transferTax?.baselineCents, plan.transferTax?.baselinePolicyId, benefit(id).amountCents],
      [750_000, id, 750_000],
    );
    assert.equal(plan.baseline?.upfrontCashCents, 4_050_000);
  }
});

test('the verified deduction and aid figures give the amounts a household is shown', () => {
  const mover: Household = {
    primaryResidence: true,
    age: 30,
    filing: 'individual',
    irpfNetTaxBaseEur: 20_000,
    firstRuralMove: true,
  };
  // The relocation deduction: €750 rural, €1,000 special attention, doubled for a single-parent family.
  for (const [code, singleParent, amount] of [
    [talarn, false, 750],
    [talarn, true, 1500],
    [termens, false, 1000],
    [termens, true, 2000],
  ] as const) {
    const move = check('irpf_move', code, { eventDate: '2026-12-01', household: { ...mover, singleParent } });
    assert.deepEqual([move.eligibilityStatus, move.screenedAmountEur], ['eligible', amount]);
  }
  assert.equal(
    check('irpf_move', balaguer, { eventDate: '2026-12-01', household: mover }).eligibilityStatus,
    'ineligible',
  );
  // Without the single-parent fact the plan shows the plain amount for the category.
  assert.equal(planned(termens, 150_000, { ...family, ...mover }).benefit('irpf_move').amountCents, 100_000);

  // Yearly deductions: the rate by category and the cap the law states, never an amount the plan cannot know.
  const rural = planned(talarn, 150_000, family);
  const special = planned(termens, 150_000, family);
  assert.match(
    rural.benefit('irpf_buy').explanation,
    /^15% a year of home-purchase payments, on at most €6,000 a year\./,
  );
  assert.match(
    special.benefit('irpf_buy').explanation,
    /^20% a year of home-purchase payments, on at most €6,000 a year\./,
  );
  // The law caps the rent deduction by amount (€600, €1,200 joint), not the rent it applies to.
  assert.match(
    rural.benefit('irpf_rent').explanation,
    /^15% a year of rent paid, capped at €600 a year \(€1,200 on a joint return\)\./,
  );
  assert.match(special.benefit('irpf_rent').explanation, /^20% a year of rent paid, capped at €600 a year/);
  for (const id of ['irpf_buy', 'irpf_rent'])
    assert.deepEqual([rural.benefit(id).amountCents, rural.benefit(id).counted], [null, false]);

  // "€15,000 or less, limited to 20% of the cost": the lower of the two.
  for (const [budgetEur, amount] of [
    [50_000, 1_000_000],
    [75_000, 1_500_000],
    [150_000, 1_500_000],
  ]) {
    const aid = planned(termens, budgetEur, family).benefit('youth_purchase_small_town');
    assert.equal(aid.nominalAmountCents, amount);
    // The amount is the household's own only while it is not ruled out.
    assert.equal(aid.amountCents, aid.eligibilityStatus === 'ineligible' ? null : amount);
  }
  // The renovation grant is real but depends on works the purchase plan does not model: it is not listed there.
  assert.equal(policies.find(entry => entry.id === 'renovation_grant_2026')?.effect?.kind, 'unquantified');
  assert.equal(
    rural.plan.benefits.some(entry => entry.policyId === 'renovation_grant_2026'),
    false,
  );
});

test('the new effect shapes parse and reject malformed figures', () => {
  const rent = { kind: 'annual_rate_of_cost', cost: 'rent', rate: { rural: 0.15, special_attention: 0.2 } };
  assert.equal(policyEffect.safeParse(rent).success, true, 'neither cap is mandatory');
  assert.equal(policyEffect.safeParse({ ...rent, maxAmountEur: { individual: 600, joint: 1200 } }).success, true);
  assert.equal(policyEffect.safeParse({ ...rent, maxAmountEur: { individual: 600 } }).success, false);
  assert.equal(policyEffect.safeParse({ ...rent, maxAmountEur: 600 }).success, false);
  const aid = { kind: 'one_off_rate_of_price', rate: 0.2, maxAmountEur: 15_000 };
  assert.equal(policyEffect.safeParse(aid).success, true);
  assert.equal(policyEffect.safeParse({ ...aid, rate: 20 }).success, false, 'rates are 0–1');
  assert.equal(policyEffect.safeParse({ kind: 'one_off_rate_of_price', rate: 0.2 }).success, false);
  const tax = { kind: 'transfer_tax_rate', standardRate: 0.1, reducedRate: { rural: 0.04, special_attention: 0.03 } };
  assert.equal(policyEffect.safeParse({ ...tax, standardTariff: generalTariff }).success, true);
  assert.equal(policyEffect.safeParse({ ...tax, standardTariff: [] }).success, false);
  assert.equal(
    policyEffect.safeParse({ ...tax, standardTariff: [{ fromEur: 600_000, rate: 0.11 }] }).success,
    false,
    'a tariff starts at zero',
  );
  assert.equal(
    policyEffect.safeParse({ ...tax, standardTariff: [...generalTariff].reverse() }).success,
    false,
    'brackets ascend',
  );
});

const youngItpBuyer: Household = {
  primaryResidence: true,
  age: 35,
  itpBuyerNetTaxBaseEur: 36_000,
  itpTransaction: true,
  satisfiesItpOccupancyRules: true,
};

test('screens the 5% young-buyer ITP rate in every municipality, rural or not', () => {
  for (const code of [talarn, termens, tremp, calaf, balaguer]) {
    const eligible = check('itp_young_buyer', code, { eventDate: '2026-12-01', household: youngItpBuyer });
    assert.equal(eligible.geographicStatus, 'applies');
    assert.equal(eligible.measureStatus, 'active');
    assert.equal(eligible.eligibilityStatus, 'eligible');
    assert.equal(eligible.callStatus, 'unknown', 'a tax rate has no application call');
  }
  const screen = (household: Household, eventDate = '2026-12-01') =>
    check('itp_young_buyer', balaguer, { eventDate, household });
  assert.match(screen({ ...youngItpBuyer, age: 36 }).unmetCriteria.join(' '), /35 or younger/);
  assert.match(screen({ ...youngItpBuyer, itpBuyerNetTaxBaseEur: 36_000.01 }).unmetCriteria.join(' '), /36,000/);
  assert.equal(screen({ ...youngItpBuyer, primaryResidence: false }).eligibilityStatus, 'ineligible');
  // The 35-year limit dates from 27 June 2025; earlier purchases followed a rule that is not encoded.
  assert.equal(screen(youngItpBuyer, '2025-06-27').eligibilityStatus, 'eligible');
  const earlier = screen(youngItpBuyer, '2025-06-26');
  assert.equal(earlier.measureStatus, 'upcoming');
  assert.equal(earlier.eligibilityStatus, 'needs_verification');
});

test('an unknown age or tax base never qualifies for the young-buyer rate', () => {
  const catalogue = check('itp_young_buyer', balaguer, { eventDate: '2026-12-01' });
  assert.equal(catalogue.eligibilityStatus, 'needs_verification');
  assert.deepEqual(catalogue.unmetCriteria, []);
  assert.equal(catalogue.missingCriteria.length, 5);
  for (const fact of ['age', 'itpBuyerNetTaxBaseEur'] as const) {
    const { [fact]: _omitted, ...partial } = youngItpBuyer;
    const result = check('itp_young_buyer', balaguer, { eventDate: '2026-12-01', household: partial });
    assert.equal(result.eligibilityStatus, 'needs_verification', fact);
    assert.equal(result.missingCriteria.length, 1);
  }
});

test('screens the other 5% ITP rates that apply anywhere in Catalonia', () => {
  const base: Household = { primaryResidence: true, itpTransaction: true, satisfiesItpOccupancyRules: true };
  const screen = (id: string, household: Household) =>
    check(id, balaguer, { eventDate: '2026-12-01', household: { ...base, ...household } });

  for (const [id, fact] of [
    ['itp_large_family', 'largeFamily'],
    ['itp_single_parent', 'singleParent'],
  ] as const) {
    assert.equal(screen(id, { [fact]: true, itpFamilyNetTaxBaseEur: 36_000 }).eligibilityStatus, 'eligible');
    assert.equal(screen(id, { [fact]: false, itpFamilyNetTaxBaseEur: 36_000 }).eligibilityStatus, 'ineligible');
    assert.equal(screen(id, { itpFamilyNetTaxBaseEur: 36_000 }).eligibilityStatus, 'needs_verification');
    // Above €36,000 the limit may still be met through the €14,000 per extra child: unknown, not excluded.
    const above = screen(id, { [fact]: true, itpFamilyNetTaxBaseEur: 40_000 });
    assert.equal(above.eligibilityStatus, 'needs_verification');
    assert.match(above.missingCriteria.join(' '), /14,000/);
  }
  assert.equal(
    screen('itp_disability', { disability65: true, itpFamilyNetTaxBaseEur: 36_000 }).eligibilityStatus,
    'eligible',
  );
  assert.equal(
    screen('itp_disability', { disability65: true, itpFamilyNetTaxBaseEur: 36_001 }).eligibilityStatus,
    'ineligible',
  );
  assert.equal(screen('itp_disability', { itpFamilyNetTaxBaseEur: 30_000 }).eligibilityStatus, 'needs_verification');
});

const generalTariff = [
  { fromEur: 0, rate: 0.1 },
  { fromEur: 600_000, rate: 0.11 },
  { fromEur: 900_000, rate: 0.12 },
  { fromEur: 1_500_000, rate: 0.13 },
];

const rehabBuyer: Household = {
  primaryResidence: true,
  pre1970: true,
  itpBuyerNetTaxBaseEur: 36_000,
  itpTransaction: true,
  satisfiesItpRehabilitationRules: true,
};

test('screens the reduced ITP rate for a rural home bought to rehabilitate', () => {
  const eligible = check('itp_rehab_buy', termens, { eventDate: '2026-12-01', household: rehabBuyer });
  assert.equal(eligible.eligibilityStatus, 'eligible');
  assert.equal(eligible.geographicStatus, 'applies');
  assert.equal(eligible.measureStatus, 'active');
  // A tax rate has no application call.
  assert.equal(eligible.callStatus, 'unknown');
  assert.deepEqual(eligible.missingCriteria, []);
  // No school-age child is required, unlike the TMR / TEA rate for the same purchase.
  assert.equal(
    check('itp_buy', termens, { eventDate: '2026-12-01', household: rehabBuyer }).eligibilityStatus,
    'needs_verification',
  );

  const overLimit = check('itp_rehab_buy', termens, {
    eventDate: '2026-12-01',
    household: { ...rehabBuyer, itpBuyerNetTaxBaseEur: 36_000.01 },
  });
  assert.equal(overLimit.eligibilityStatus, 'ineligible');
  assert.match(overLimit.unmetCriteria.join(' '), /36,000/);

  const modern = check('itp_rehab_buy', termens, {
    eventDate: '2026-12-01',
    household: { ...rehabBuyer, pre1970: false },
  });
  assert.equal(modern.eligibilityStatus, 'ineligible');
  assert.match(modern.unmetCriteria.join(' '), /1970/);
});

test('treats missing rehabilitation-purchase facts as unknown', () => {
  const catalogue = check('itp_rehab_buy', talarn, { eventDate: '2026-12-01' });
  assert.equal(catalogue.eligibilityStatus, 'needs_verification');
  assert.deepEqual(catalogue.unmetCriteria, []);
  assert.equal(catalogue.missingCriteria.length, 5);

  const undated = check('itp_rehab_buy', talarn, { household: rehabBuyer });
  assert.equal(undated.eligibilityStatus, 'needs_verification');
  assert.match(undated.missingCriteria.join(' '), /event date/);

  const { itpBuyerNetTaxBaseEur: _omitted, ...withoutTaxBase } = rehabBuyer;
  const noTaxBase = check('itp_rehab_buy', talarn, { eventDate: '2026-12-01', household: withoutTaxBase });
  assert.equal(noTaxBase.eligibilityStatus, 'needs_verification');
  assert.match(noTaxBase.missingCriteria.join(' '), /36,000/);
});

test('applies the rehabilitation-purchase rate only inside its dates and rural scope', () => {
  const dated = (eventDate: string, code = termens) =>
    check('itp_rehab_buy', code, { eventDate, household: rehabBuyer });

  assert.equal(dated('2029-07-16').measureStatus, 'active');
  assert.equal(dated('2029-07-16').eligibilityStatus, 'eligible');
  const after = dated('2029-07-17');
  assert.equal(after.measureStatus, 'ended');
  assert.equal(after.eligibilityStatus, 'needs_verification');
  assert.deepEqual(after.unmetCriteria, []);
  assert.equal(dated('2025-08-19').measureStatus, 'upcoming');
  // In force, but before the initial rural list of 24 February 2026 the classification is not in the snapshot.
  const beforeList = dated('2026-02-23');
  assert.equal(beforeList.measureStatus, 'active');
  assert.equal(beforeList.geographicStatus, 'needs_verification');
  assert.equal(dated('2026-02-24').geographicStatus, 'applies');

  const notRural = dated('2026-12-01', calaf);
  assert.equal(notRural.geographicStatus, 'does_not_apply');
  assert.equal(notRural.eligibilityStatus, 'ineligible');

  for (const [nucleus, status] of [
    [undefined, 'needs_verification'],
    ['Tremp', 'does_not_apply'],
    ['Palau de Noguera', 'applies'],
  ] as const) {
    const partial = check('itp_rehab_buy', tremp, { eventDate: '2026-12-01', nucleus, household: rehabBuyer });
    assert.equal(partial.geographicStatus, status);
    assert.equal(partial.eligibilityStatus !== 'eligible', status !== 'applies');
  }
});

const youngBuyer: Household = {
  primaryResidence: true,
  age: 35,
  purchasePriceEur: 300_000,
  ownsHomeInSpain: false,
  incomeWithinFiveIprem: true,
};

test('never reports the state youth purchase aid as open or eligible without a Catalan call', () => {
  const policy = policies.find(entry => entry.id === 'youth_purchase_small_town');
  assert.equal(policy?.callWindow, null);

  const best = check('youth_purchase_small_town', termens, { eventDate: '2026-12-01', household: youngBuyer });
  assert.equal(best.callStatus, 'unknown');
  assert.equal(best.measureStatus, 'active');
  assert.equal(best.geographicStatus, 'applies');
  assert.equal(best.eligibilityStatus, 'needs_verification');
  assert.deepEqual(best.unmetCriteria, []);
  assert.equal(best.missingCriteria.length, 1);
  assert.match(best.missingCriteria[0], /No Catalan call/);
  assert.match(best.nextStep, /future call/);
  assert.equal(best.screenedAmountEur, undefined);

  // The call status follows the verification date, not the purchase date.
  for (const asOf of ['2025-12-31', '2026-11-22', '2031-01-01']) {
    assert.equal(check('youth_purchase_small_town', termens, {}, asOf).callStatus, 'unknown');
  }
});

test('applies the decree thresholds for the state youth purchase aid', () => {
  const screen = (household: Household, eventDate = '2026-12-01') =>
    check('youth_purchase_small_town', termens, { eventDate, household });

  assert.match(screen({ ...youngBuyer, age: 36 }).unmetCriteria.join(' '), /35 or younger/);
  assert.equal(screen({ ...youngBuyer, age: 36 }).eligibilityStatus, 'ineligible');
  assert.match(screen({ ...youngBuyer, purchasePriceEur: 300_001 }).unmetCriteria.join(' '), /300,000/);
  assert.match(screen({ ...youngBuyer, ownsHomeInSpain: true }).unmetCriteria.join(' '), /another home in Spain/);
  assert.match(screen({ ...youngBuyer, incomeWithinFiveIprem: false }).unmetCriteria.join(' '), /IPREM/);
  assert.match(screen({ ...youngBuyer, primaryResidence: false }).unmetCriteria.join(' '), /habitual residence/);

  // Contracts signed from 1 January 2026 qualify; earlier ones do not.
  assert.deepEqual(screen(youngBuyer, '2026-01-01').unmetCriteria, []);
  assert.equal(screen(youngBuyer, '2026-01-01').measureStatus, 'active');
  const early = screen(youngBuyer, '2025-12-31');
  assert.equal(early.measureStatus, 'upcoming');
  assert.match(early.unmetCriteria.join(' '), /1 January 2026/);
  assert.equal(screen(youngBuyer, '2030-12-31').measureStatus, 'active');
  assert.equal(screen(youngBuyer, '2031-01-01').measureStatus, 'ended');
});

test('treats missing youth purchase facts as unknown, never as met or unmet', () => {
  const catalogue = check('youth_purchase_small_town', termens);
  assert.equal(catalogue.eligibilityStatus, 'needs_verification');
  assert.deepEqual(catalogue.unmetCriteria, []);
  // Five household facts, the contract date and the unpublished call.
  assert.equal(catalogue.missingCriteria.length, 7);

  const { ownsHomeInSpain: _omitted, ...unknownOwnership } = youngBuyer;
  const partial = check('youth_purchase_small_town', termens, { eventDate: '2026-12-01', household: unknownOwnership });
  assert.deepEqual(partial.unmetCriteria, []);
  assert.match(partial.missingCriteria.join(' '), /another home in Spain/);
});

test('scopes the youth purchase aid by resident population, not by rural status', () => {
  const geography = (code: string, nucleus?: string) =>
    check('youth_purchase_small_town', code, { eventDate: '2026-12-01', nucleus, household: youngBuyer });

  // Calaf is not a rural municipality but has fewer than 10,000 residents.
  assert.equal(geography(calaf).geographicStatus, 'applies');
  // Tremp as a whole is under the threshold, so the partial rural listing does not matter here.
  assert.equal(geography(tremp).geographicStatus, 'applies');
  assert.equal(geography(tremp, 'Tremp').geographicStatus, 'applies');

  const large = geography(balaguer);
  assert.equal(large.geographicStatus, 'does_not_apply');
  assert.equal(large.eligibilityStatus, 'ineligible');
  // A separate small nucleus of a larger municipality may qualify: unknown, not excluded.
  const smallNucleus = geography(balaguer, 'Hostal Nou');
  assert.equal(smallNucleus.geographicStatus, 'needs_verification');
  assert.equal(smallNucleus.eligibilityStatus, 'needs_verification');
  assert.equal(geography(balaguer, 'Balaguer').geographicStatus, 'does_not_apply');

  const listed = new Set(policies.find(entry => entry.id === 'youth_purchase_small_town')?.municipalityCodes);
  for (const town of snapshot.municipalities) {
    const population = snapshot.townMetrics[town.code].find(metric => metric.kind === 'population');
    assert(population);
    assert.equal(listed.has(town.code), population.value <= 10_000, town.name);
  }
});

test('keeps the closed 2026 renovation call and the catalogue by intent unchanged', () => {
  const grant = check('renovation_grant_2026', termens);
  assert.equal(grant.callStatus, 'closed');
  assert.equal(check('renovation_grant_2026', termens, {}, '2026-05-17').callStatus, 'upcoming');
  assert.equal(check('renovation_grant_2026', termens, {}, '2026-05-18').callStatus, 'open');
  assert.equal(check('renovation_grant_2026', termens, {}, '2026-09-09').callStatus, 'open');
  // The call closed at 14:00 on 10 September. A date has no time of day, so the closing day reads closed.
  const grantPolicy = policies.find(entry => entry.id === 'renovation_grant_2026');
  assert(grantPolicy);
  assert.deepEqual(grantPolicy.callWindow, {
    opensOn: '2026-05-18',
    closesOn: '2026-09-10',
    closesAtLocalTime: '14:00',
  });
  assert.equal(check('renovation_grant_2026', termens, {}, '2026-09-10').callStatus, 'closed');
  // A call with no stated closing time stays open through its last day, and a grant's own dates are its window.
  const wholeDay = { ...grantPolicy, callWindow: { opensOn: '2026-05-18', closesOn: '2026-09-10' } };
  assert.equal(callStatusOn(wholeDay, '2026-09-10'), 'open');
  assert.equal(callStatusOn(wholeDay, '2026-09-11'), 'closed');
  assert.equal(callStatusOn({ ...grantPolicy, callWindow: undefined }, '2026-09-10'), 'open');
  assert.equal(callStatusOn({ ...grantPolicy, callWindow: null }, '2026-09-10'), 'unknown');

  const town = getTown(snapshot, termens);
  const ids = (intent: IncentivesInput['intent']) =>
    evaluateIncentives(policies, town, { municipalityCode: termens, intent }, today).map(entry => entry.id);
  assert.deepEqual(ids('buy'), [
    'irpf_buy',
    'itp_buy',
    'itp_rehab_buy',
    'itp_young_buyer',
    'itp_large_family',
    'itp_single_parent',
    'itp_disability',
    'youth_purchase_small_town',
  ]);
  assert.deepEqual(ids('renovate'), ['irpf_renovate', 'renovation_grant_2026']);
  assert.deepEqual(ids('move'), ['irpf_move']);
  assert.deepEqual(ids('rent'), ['irpf_rent']);
});
