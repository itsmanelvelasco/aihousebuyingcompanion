import assert from 'node:assert/strict';
import test from 'node:test';
import { getView, InterviewConflictError, openDemo, saveLaiaInterview, updateDemo } from './demo.ts';

test('Laia’s first scenario uses earmarked savings and confirmed contributions on the same rehearsal', async () => {
  const { runId } = openDemo({ newRun: true, persona: 'onboarding' });
  updateDemo({ runId, action: 'sample_bank' });
  updateDemo({ runId, action: 'answer_batch', answers: { reserve: 5_000, debtPayments: 150 } });
  const snapshot = {
    profile: {
      householdSize: 3, location: 'Manresa', homeType: 'Flat', amenities: 'A park',
      confirmedSalary: 2_900, confirmedSpending: 2_180, monthly: 600, target: 30_000, saved: 6_000,
    },
    cash: { monthlyInflows: 2_900, monthlyCostOfLiving: 2_180, monthlyExpenses: { Rent: 900 }, estimatedMonthlySalary: 2_900 },
    source: 'demo', currency: 'EUR',
  };
  const board = await saveLaiaInterview(runId, snapshot);
  assert.ok('interview' in board);
  assert.deepEqual(board.interview, snapshot);
  assert.equal(board.answers.household, 3);
  assert.equal(board.answers.town, 'Manresa');
  assert.equal(board.answers.debtPayments, 150);
  assert.equal(board.answers.savings, 18_400);
  assert.equal(board.firstScenario?.baselineMonths, 40);
  assert.equal(board.firstScenario?.remaining, 24_000);
  assert.ok(board.firstScenario.suggestions.length);
  assert.equal(board.plan, null);

  const other = openDemo({ newRun: true, persona: 'onboarding' });
  assert.ok('interview' in other && other.interview === null);
  const marc = openDemo({ runId, persona: 'progress' });
  assert.ok(!('interview' in marc));
  await assert.rejects(saveLaiaInterview(runId, snapshot), InterviewConflictError);
  const resumed = openDemo({ pairCode: board.pairCode, persona: 'onboarding' });
  assert.ok('interview' in resumed && resumed.interview?.profile.householdSize === 3);
  const reset = updateDemo({ runId, action: 'restart_persona' });
  assert.ok('interview' in reset && reset.interview === null && reset.firstScenario === null);
  assert.deepEqual(reset.answers, {});
});

test('replacing, validating and retrying an interview never publishes raw data or resurrects a reset', async () => {
  const { runId, revision } = openDemo({ newRun: true, persona: 'onboarding' });
  const input = { profile: { householdSize: 2 }, currency: 'EUR', source: null };
  const board = await saveLaiaInterview(runId, input, revision);
  assert.ok('interview' in board && board.firstScenario === null);
  for (const invalid of [
    { ...input, transactions: ['raw'] },
    { ...input, profile: { householdSize: 1.5 } },
    { ...input, currency: 'USD' },
    { ...input, source: 'csv', cash: { monthlyInflows: 1, monthlyCostOfLiving: 1, estimatedMonthlySalary: null, monthlyExpenses: { 'private merchant': 1 } } },
  ]) await assert.rejects(saveLaiaInterview(runId, invalid));
  assert.equal(getView(runId).revision, board.revision);
  const replaced = await saveLaiaInterview(runId, { ...input, profile: { saved: 10, monthly: -1, target: 20 } }, board.revision);
  assert.ok('answers' in replaced);
  assert.equal(replaced.answers.household, undefined);
  assert.equal(replaced.firstScenario?.remaining, 10);
  assert.equal(replaced.firstScenario?.baselineMonths, null);
  await assert.rejects(saveLaiaInterview(runId, input, board.revision), InterviewConflictError);
  const pendingSave = saveLaiaInterview(runId, input);
  updateDemo({ runId, action: 'restart_all' });
  await assert.rejects(pendingSave, InterviewConflictError);
  const reset = getView(runId);
  assert.ok('interview' in reset && reset.interview === null);
});
