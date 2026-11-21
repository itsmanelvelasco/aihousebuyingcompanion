import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputSchema, resolveInputs, buildRecommendationInput } from '../packages/contracts/inputs.ts';

function input(id: string, source: string, data: unknown, confirmed = true, observedAt = '2026-11-21T10:00:00Z') {
  return inputSchema.parse({ id, source, data, confirmed, observedAt, synthetic: true });
}
test('input resolution preserves unknown, zero and false, handles source recency and explicit conflicts', () => {
  const resolved = resolveInputs([
    input('old', 'interview', { household: { dependants: 2 } }, true, '2026-11-20T10:00:00Z'),
    input('new', 'interview', { household: { dependants: 0 }, rural: { required: false }, finance: { currentSavingsCents: 0 } }),
    input('bank', 'bank', { finance: { currentSavingsCents: 500 } }, false),
    input('clear', 'manual', { location: { selectedMunicipalityCode: null } })
  ]);
  assert.equal(resolved.data.household?.dependants, 0);
  assert.equal(resolved.data.rural?.required, false);
  assert.equal(resolved.data.finance?.currentSavingsCents, 0);
  assert.equal(resolved.data.location?.selectedMunicipalityCode, null);
  assert.equal(resolved.provenance['finance.currentSavingsCents'][0].inputId, 'new');
  assert.equal(resolveInputs([input('a', 'manual', { household: { size: 2 } }), input('b', 'manual', { household: { size: 3 } })]).conflicts.length, 1);
  assert.equal(resolveInputs([input('a', 'interview', { school: { stages: ['eso', 'primary'] } }), input('b', 'manual', { school: { stages: ['primary', 'eso', 'eso'] } })]).conflicts.length, 0);
});

test('town adapter converts cents, requires purchase area, explicit consent and complete constraints', () => {
  const base = input('base', 'manual', { housing: { tenure: 'buy', budgetCents: 13000000, homeSizeM2: 85 } });
  const unconfirmed = buildRecommendationInput(resolveInputs([base, input('consent', 'interview', { housing: { allowComarcaEstimate: true } }, false)]));
  assert.equal(unconfirmed.ready, true);
  assert.equal(unconfirmed.input?.housing?.maxBudgetEur, 130000);
  assert.equal(unconfirmed.input?.housing?.allowComarcaEstimate, undefined);
  assert.ok(unconfirmed.unsupportedFields.includes('housing.allowComarcaEstimate:requires_confirmation'));
  const confirmed = buildRecommendationInput(resolveInputs([base, input('consent', 'interview', { housing: { allowComarcaEstimate: true } })]));
  assert.equal(confirmed.input?.housing?.allowComarcaEstimate, true);
  assert.equal(buildRecommendationInput(resolveInputs([input('incomplete', 'manual', { housing: { tenure: 'buy', budgetCents: 10000000 } })])).ready, false);
  for (const data of [{ transport: { maxCommuteMinutes: 40 } }, { school: { mode: 'rail' } }, { housing: { minimumBedrooms: 3 } }]) {
    assert.equal(buildRecommendationInput(resolveInputs([base, input('constraint', 'interview', data)])).ready, false);
  }
  assert.equal(inputSchema.safeParse({ ...base, data: { finance: { monthlyIncomeCents: -100 } } }).success, false);
  assert.equal(inputSchema.safeParse({ ...base, data: { household: {} } }).success, false);
});
