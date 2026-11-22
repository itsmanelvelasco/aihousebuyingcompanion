import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncentivesInput } from '../packages/contracts/places.ts';
import { eligibility, policyEffect, policyId } from '../packages/contracts/places.ts';
import { getTown, loadData } from '../packages/places/data.ts';
import { evaluateIncentives } from '../packages/places/eligibility.ts';

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

test('effects carry only the figures stated in each verified policy', () => {
  const effect = (id: string) => policies.find(entry => entry.id === id)?.effect;
  assert.deepEqual(effect('irpf_move'), {
    kind: 'one_off_eur',
    amount: { rural: 750, special_attention: 1000, other: 0 },
  });
  for (const [id, cost] of [
    ['irpf_buy', 'purchase_payments'],
    ['irpf_renovate', 'renovation'],
  ]) {
    assert.deepEqual(effect(id), {
      kind: 'annual_rate_of_cost',
      cost,
      rate: { rural: 0.15, special_attention: 0.2, other: 0 },
      maxBaseEur: 6000,
    });
  }
  const rent = effect('irpf_rent');
  assert(rent?.kind === 'annual_rate_of_cost');
  // The legal cap is €600 a year: neither rate may produce more on the modelled base.
  assert(rent.rate.rural * rent.maxBaseEur <= 600);
  assert.equal(rent.rate.special_attention * rent.maxBaseEur, 600);
  for (const id of ['itp_buy', 'itp_rehab_buy']) {
    // A municipality outside the measure keeps the general rate, so it never shows a saving.
    assert.deepEqual(effect(id), {
      kind: 'transfer_tax_rate',
      standardRate: 0.1,
      reducedRate: { rural: 0.04, special_attention: 0.03, other: 0.1 },
    });
  }
  assert.equal(effect('renovation_grant_2026')?.kind, 'unquantified');
  assert.equal(effect('youth_purchase_small_town')?.kind, 'unquantified');
});

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
  assert.equal(check('renovation_grant_2026', termens, {}, '2026-09-10').callStatus, 'open');
  assert.equal(check('renovation_grant_2026', termens, {}, '2026-05-17').callStatus, 'upcoming');

  const town = getTown(snapshot, termens);
  const ids = (intent: IncentivesInput['intent']) =>
    evaluateIncentives(policies, town, { municipalityCode: termens, intent }, today).map(entry => entry.id);
  assert.deepEqual(ids('buy'), ['irpf_buy', 'itp_buy', 'itp_rehab_buy', 'youth_purchase_small_town']);
  assert.deepEqual(ids('renovate'), ['irpf_renovate', 'renovation_grant_2026']);
  assert.deepEqual(ids('move'), ['irpf_move']);
  assert.deepEqual(ids('rent'), ['irpf_rent']);
});
