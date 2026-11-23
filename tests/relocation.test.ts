import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { combineRelocationData, loadData, validateSnapshot } from '../packages/places/data.ts';
import { recommendTowns } from '../packages/places/recommend.ts';
import { getRelocationResearch } from '../packages/places/relocation.ts';

const raw = () => JSON.parse(readFileSync(new URL('../data/relocat-pilot-data.json', import.meta.url), 'utf8'));
const official = () =>
  validateSnapshot(JSON.parse(readFileSync(new URL('../data/towns.json', import.meta.url), 'utf8')));

test('joins research by string code without replacing official statistics or importing historical leads', () => {
  const source = raw();
  source.publicDataSnapshot.townMetrics = { '080312': [{ value: -999 }] };
  const snapshot = combineRelocationData(official(), source);
  assert.deepEqual(snapshot.townMetrics, official().townMetrics);
  assert.equal(snapshot.municipalities.length, 947);
  assert.equal(snapshot.relocation?.municipalities.length, 3);
  assert.equal(snapshot.relocation?.municipalities[0].municipalityCode, '080312');
  assert(!('publicDataSnapshot' in snapshot.relocation!));
  assert(!('historicalResearch' in snapshot.relocation!));
});

test('rejects duplicate opportunities, duplicate towns, orphan codes and invalid evidence', () => {
  for (const mutate of [
    (d: any) => d.municipalities.push(d.municipalities[0]),
    (d: any) => d.municipalities[1].opportunities.push(d.municipalities[0].opportunities[0]),
    (d: any) => {
      d.municipalities[0].municipalityCode = '999999';
    },
    (d: any) => {
      d.municipalities[0].name = 'Wrong town';
    },
    (d: any) => {
      d.municipalities[0].opportunities[0].housingRentEurPerMonth.min = 999;
    },
    (d: any) => {
      d.municipalities[0].opportunities[0].sources = [];
    },
    (d: any) => {
      d.municipalities[2].opportunities[0].applicationDeadline = '2026-12-13';
    },
  ]) {
    const source = raw();
    mutate(source);
    assert.throws(() => combineRelocationData(official(), source));
  }
});

test('keeps closed, filled, conflicting and stale evidence separate from current availability', () => {
  const { snapshot } = loadData();
  const calaf = getRelocationResearch(snapshot, '080312', '2026-11-21');
  assert.equal(calaf.opportunityChecks[0].availability, 'closed');
  assert.equal(calaf.opportunityChecks[0].deadlinePassed, true);
  const juncosa = getRelocationResearch(snapshot, '251180', '2026-11-21');
  assert.deepEqual(
    juncosa.opportunityChecks.map(x => x.availability),
    ['filled', 'needs_verification'],
  );
  const ulldemolins = getRelocationResearch(snapshot, '431573', '2027-01-01');
  assert.equal(ulldemolins.research?.opportunities[0].housingRentEurPerMonth, null);
  assert.equal(ulldemolins.research?.opportunities[0].baseBusinessFeeEurPerMonth, 250);
  assert.equal(ulldemolins.opportunityChecks[0].availability, 'needs_verification');
  assert.equal(ulldemolins.opportunityChecks[0].checkedBeforeAsOf, true);
  assert.equal(ulldemolins.opportunityChecks[0].conflictingDeadlines, true);
  assert.equal(ulldemolins.opportunityChecks[0].eligibilityStatus, 'needs_verification');
  const unresearched = getRelocationResearch(snapshot, '250024', '2026-11-21');
  assert.equal(unresearched.coverage, 'not_researched');
  assert.equal(unresearched.research, null);
  assert.equal(unresearched.checkedOn, null);
});

test('research cannot change hard budget filters, scores or ranking', () => {
  const { snapshot, policies } = loadData();
  const input = { housing: { tenure: 'rent' as const, maxBudgetEur: 400 }, limit: 10 };
  const combined = recommendTowns(snapshot, policies, input, '2026-11-21');
  const base = recommendTowns(official(), policies, input, '2026-11-21');
  assert.deepEqual(combined.excluded, base.excluded);
  const scores = (r: typeof base) => r.towns.map(t => [t.municipality.code, t.score, t.housingEstimate]);
  assert.deepEqual(scores(combined), scores(base));
});
