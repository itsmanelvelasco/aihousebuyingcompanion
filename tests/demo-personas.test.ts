import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createHabitStore } from '../apps/habits-agent/store.ts';
import { createInputStore } from '../apps/profile-api/inputs.ts';
import { demoDefaultPlaces } from '../apps/web/launch.ts';
import { createAccounts } from '../packages/auth/accounts.ts';
import { accessConfig } from '../packages/config/env.ts';
import type { PlanResult } from '../packages/contracts/planner.ts';
import { open } from '../packages/db/database.ts';
import { buildPerson } from '../packages/model/person.ts';
import { buildPlace } from '../packages/model/place.ts';
import { loadData } from '../packages/places/data.ts';
import { planForPlaces } from '../packages/planner/plan.ts';
import { createStore } from '../packages/profiles/store.ts';
import { demoStories } from '../scripts/generate-users.ts';
import { reseedDemo, seedDemoStories } from '../scripts/reseed-demo.ts';

/**
 * The story the public demo tells with no click, computed by the real planner on the committed
 * fixtures. A fixture change that flattens it (the same timeline three times, as it once was)
 * fails here.
 */
const fixtures = resolve('data/users');
const personas = accessConfig({}).demoUserIds;
/** The plan date is fixed: a benefit tied to the purchase depends on the day the person could buy. */
const planDate = '2026-11-23';
const [BALAGUER, TALARN, TERMENS] = ['250404', '252154', '252206'];
const { snapshot, policies } = loadData();

/**
 * A database as the server makes it: the fixture documents of each persona copied in (what
 * `seedRuntime` does for every folder), then the stories of the demo personas.
 */
async function demoDatabase() {
  const db = open(':memory:');
  const profiles = createStore(db);
  for (const id of personas) {
    const read = async (section: string) => JSON.parse(await readFile(join(fixtures, id, `${section}.json`), 'utf8'));
    await profiles.create(id, {
      details: await read('details'),
      preferences: await read('preferences'),
      'bank-account': await read('bank-account'),
    });
  }
  assert.deepEqual((await seedDemoStories(db, { fixtures, ids: personas })).written, [
    'user-002',
    'user-003',
    'user-004',
  ]);
  return db;
}

async function planOf(db: ReturnType<typeof open>, id: string, codes = demoDefaultPlaces): Promise<PlanResult> {
  const person = buildPerson({
    userId: id,
    synthetic: true,
    context: await createInputStore(db).context(id),
    habitState: await createHabitStore(db).read(id),
  });
  const places = codes.map(code => buildPlace(snapshot, code));
  return planForPlaces(person, places, policies, undefined, planDate);
}

const placeOf = (plan: PlanResult, code: string) => {
  const found = plan.plans.find(item => item.place.municipalityCode === code);
  assert.ok(found, `no plan for ${code}`);
  return found;
};
const counted = (plan: PlanResult, code: string) =>
  placeOf(plan, code)
    .benefits.filter(benefit => benefit.counted)
    .map(benefit => benefit.policyId)
    .sort();

test('the demo opens on places where a rural measure makes a difference', () => {
  assert.deepEqual(personas, ['user-001', 'user-002', 'user-003', 'user-004']);
  assert.deepEqual(Object.keys(demoStories), personas);
  const rural = (code: string) => snapshot.municipalities.find(town => town.code === code)?.rural.category;
  assert.deepEqual(demoDefaultPlaces, [BALAGUER, TALARN, TERMENS]);
  assert.deepEqual(demoDefaultPlaces.map(rural), ['not_listed', 'rural', 'special_attention']);
});

test('every story record is fictional and the story files agree with the generator', async () => {
  for (const id of personas) {
    const read = async (name: string) => JSON.parse(await readFile(join(fixtures, id, `${name}.json`), 'utf8'));
    const [inputs, habits] = [await read('demo-inputs'), await read('demo-habits')];
    assert.deepEqual([inputs.synthetic, inputs.userId, habits.synthetic, habits.userId], [true, id, true, id]);
    for (const input of inputs.inputs) assert.deepEqual([input.synthetic, input.confirmed], [true, true], id);
    assert.deepEqual(habits.goals, demoStories[id].goals ?? [], id);
    assert.equal(inputs.inputs.length, demoStories[id].eligibility ? 1 : 0, id);
  }
  // The household of the rural persona agrees with what it "confirmed": one child, a buyer over 35.
  const details = JSON.parse(await readFile(join(fixtures, 'user-004', 'details.json'), 'utf8'));
  assert.deepEqual(
    [details.householdType, details.householdSize, details.dependants, details.dependantAges, details.age],
    ['couple_with_children', 3, 1, [5], 40],
  );
});

test('user-004: confirmed facts make the rural transfer tax count, and a habit shortens the wait first', async () => {
  const db = await demoDatabase();
  try {
    const plan = await planOf(db, 'user-004');
    assert.equal(plan.person.synthetic, true);
    assert.deepEqual(
      plan.habits?.map(effect => [effect.habitId, effect.counted]),
      [['cook-at-home', true]],
    );
    // Shortest first: the special-attention town, the rural one, then the town with no rural status.
    assert.deepEqual(
      plan.plans.map(item => item.place.municipalityCode),
      [TERMENS, TALARN, BALAGUER],
    );
    const months = (code: string) => {
      const item = placeOf(plan, code);
      return [item.baseline?.months, item.withHabits?.months, item.withPlaceBenefits?.months];
    };
    assert.deepEqual(months(TERMENS), [32, 27, 15]);
    assert.deepEqual(months(TALARN), [32, 27, 17]);
    assert.deepEqual(months(BALAGUER), [32, 27, 27]);
    for (const code of [TERMENS, TALARN]) {
      const item = placeOf(plan, code);
      assert.ok((item.monthsSavedByPlace ?? 0) > 0, code);
      assert.ok((item.monthsSavedByHabits ?? 0) > 0, code);
      assert.deepEqual(counted(plan, code), ['irpf_move', 'itp_buy']);
    }
    assert.equal(placeOf(plan, BALAGUER).monthsSavedByPlace, 0);
    assert.deepEqual(counted(plan, BALAGUER), []);
    // Not eligible for everything: no Catalan call exists for the state youth aid, and the buyer is over 35.
    for (const code of [TERMENS, TALARN]) {
      const youth = placeOf(plan, code).benefits.find(benefit => benefit.policyId === 'youth_purchase_small_town');
      assert.equal(youth?.counted, false);
      assert.notEqual(youth?.eligibilityStatus, 'eligible');
    }
    // Nothing that decides a measure is left to ask.
    assert.deepEqual(
      plan.nextQuestions?.filter(question => question.effect.kind === 'benefit'),
      [],
    );
  } finally {
    db.close();
  }
});

test('user-002: two active habits shorten every timeline, the paused one does not count', async () => {
  const db = await demoDatabase();
  try {
    const plan = await planOf(db, 'user-002');
    assert.deepEqual(
      plan.habits?.map(effect => [effect.habitId, effect.counted, effect.reason]),
      [
        ['cook-at-home', true, 'counted'],
        ['unused-subscriptions', true, 'counted'],
        ['bike-to-work', false, 'paused'],
      ],
    );
    for (const item of plan.plans) {
      assert.ok((item.monthsSavedByHabits ?? 0) > 0, item.place.name);
      assert.ok((item.withHabits?.months ?? Infinity) < (item.baseline?.months ?? 0), item.place.name);
      // No household fact is confirmed, so no place is credited with anything.
      assert.equal(item.monthsSavedByPlace, 0);
      assert.deepEqual(counted(plan, item.place.municipalityCode), []);
    }
  } finally {
    db.close();
  }
});

test('user-003: without the habit no timeline ends; with it one does', async () => {
  const db = await demoDatabase();
  try {
    const plan = await planOf(db, 'user-003');
    assert.deepEqual(
      plan.habits?.map(effect => [effect.habitId, effect.counted]),
      [['weekly-market', true]],
    );
    for (const item of plan.plans) {
      assert.equal(item.baseline?.months ?? null, null, 'the baseline has no end');
      assert.ok(Number.isInteger(item.withHabits?.months), item.place.name);
    }
  } finally {
    db.close();
  }
});

test('user-001: nothing is confirmed, so the aid stays unverified and the questions are on screen', async () => {
  const db = await demoDatabase();
  try {
    const plan = await planOf(db, 'user-001');
    assert.equal(plan.person.habits.length, 0);
    assert.equal(plan.person.household, undefined);
    for (const item of plan.plans) assert.deepEqual(counted(plan, item.place.municipalityCode), []);
    const rural = placeOf(plan, TALARN).benefits.find(benefit => benefit.policyId === 'itp_buy');
    assert.deepEqual([rural?.counted, rural?.eligibilityStatus], [false, 'needs_verification']);
    const pending = plan.nextQuestions?.filter(question => question.effect.kind === 'benefit') ?? [];
    assert.ok(pending.length >= 3, 'questions that would verify a measure are pending');
    assert.ok(pending.some(question => question.id === 'primaryResidence'));
  } finally {
    db.close();
  }
});

test('seeding the stories is repeatable, leaves other records alone and never writes to a person', async () => {
  const db = await demoDatabase();
  try {
    const rows = () => [
      db.all('SELECT * FROM input_records ORDER BY 1, 2'),
      db.all('SELECT * FROM habit_goals ORDER BY 1, 2'),
    ];
    const before = JSON.stringify(rows());
    assert.deepEqual((await seedDemoStories(db, { fixtures, ids: personas })).unchanged, personas);
    assert.equal(JSON.stringify(rows()), before);
    // A persona's other answers and habits stay; a changed story record is brought back.
    const inputs = createInputStore(db);
    await inputs.add('user-004', {
      inputs: [
        {
          id: 'note',
          source: 'manual',
          observedAt: '2026-11-22T10:00:00Z',
          confirmed: true,
          synthetic: true,
          data: { household: { size: 3 } },
        },
      ],
    });
    db.run("UPDATE habit_goals SET planned_monthly_saving_cents = 1 WHERE user_id = 'user-004'");
    const dry = await seedDemoStories(db, { fixtures, ids: personas, dryRun: true });
    assert.deepEqual(dry.written, ['user-004']);
    assert.equal(
      (await createHabitStore(db).read('user-004')).goals[0].plannedMonthlySavingCents,
      1,
      'a dry run writes nothing',
    );
    assert.deepEqual((await seedDemoStories(db, { fixtures, ids: personas })).written, ['user-004']);
    assert.equal((await createHabitStore(db).read('user-004')).goals[0].plannedMonthlySavingCents, 12_000);
    assert.equal((await inputs.read('user-004')).inputs.length, 2);
    // The full reseed sees a database that is up to date.
    assert.deepEqual((await reseedDemo(db, { fixtures, ids: personas })).unchanged, personas);
    // An id of the allowlist that an account owns is a person: nothing is written for it.
    const account = await createAccounts(db).signUp({
      email: 'ada@example.com',
      password: 'correct horse battery',
      address: 'a',
    });
    db.run('DELETE FROM habit_goals WHERE user_id = ?', 'user-002');
    db.run('UPDATE accounts SET user_id = ? WHERE id = ?', 'user-002', account.id);
    const outcome = await seedDemoStories(db, { fixtures, ids: [...personas, 'user-999', '../escape'] });
    assert.deepEqual(
      outcome.skipped.map(item => item.id),
      ['../escape', 'user-002', 'user-999'],
    );
    assert.equal((await createHabitStore(db).read('user-002')).goals.length, 0);
  } finally {
    db.close();
  }
});
