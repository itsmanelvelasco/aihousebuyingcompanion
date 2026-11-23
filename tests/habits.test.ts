import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createOpenAIHabits } from '../apps/habits-agent/agent.ts';
import { createHabitsApi, createHabitsHandler } from '../apps/habits-agent/server.ts';
import { createHabitStore } from '../apps/habits-agent/store.ts';
import type { Caller, PersonScope } from '../apps/mcp-server/identity.ts';
import { registerPlannerTools } from '../apps/mcp-server/planner-tools.ts';
import { goalSchema, stateSchema, summarySchema } from '../packages/contracts/habits.ts';
import type { Place } from '../packages/contracts/planner.ts';
import { planResult } from '../packages/contracts/planner.ts';
import { open } from '../packages/db/database.ts';
import { suggestHabits } from '../packages/finance/habits.ts';
import { buildPerson } from '../packages/model/person.ts';
import { loadData } from '../packages/places/data.ts';
import { planForPlaces } from '../packages/planner/plan.ts';
import { createStore } from '../packages/profiles/store.ts';

const summary = summarySchema.parse({
  synthetic: true,
  currency: 'EUR',
  from: '2026-08-01',
  to: '2026-10-31',
  monthCount: 3,
  dataStatus: 'observed',
  incomeCents: 600000,
  expenseCents: 650000,
  spendingByCategory: { subscriptions: 5000, food: 50000 },
});
test('rules use aggregates, handle incomplete history and never claim savings', () => {
  const result = suggestHabits(summary);
  assert.equal(result.source, 'rules');
  assert.equal(result.suggestions[0].title, 'Review the cash-flow gap');
  assert.ok(result.suggestions.some(item => item.title === 'Review optional subscriptions'));
  assert.equal(suggestHabits({ ...summary, dataStatus: 'unknown' }).suggestions.length, 1);
  // Suggestions are as fabricated or as real as the totals they were made from, complete history or not.
  assert.equal(result.synthetic, true);
  const real = summarySchema.parse({ ...summary, synthetic: false });
  assert.deepEqual(
    [suggestHabits(real).synthetic, suggestHabits({ ...real, dataStatus: 'partial' }).synthetic],
    [false, false],
  );
  const { synthetic: _flag, ...unflagged } = summary;
  assert.equal(summarySchema.safeParse(unflagged).success, false, 'the flag is never defaulted');
  assert.equal(summarySchema.safeParse({ ...summary, merchant: 'Private merchant', transactions: [] }).success, false);
});
test('Responses calls use Sol, bounded structured output and no stored identity; invalid responses fail', async () => {
  let request: Record<string, any> = {};
  const suggestion = {
    title: 'A weekly review',
    action: 'Review your plan once a week if helpful.',
    category: 'other',
  };
  const ai = createOpenAIHabits({
    apiKey: 'fake-test-key',
    fetcher: (async (_url: unknown, options: RequestInit) => {
      request = JSON.parse(String(options.body));
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify({ suggestions: [suggestion] }) }],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 30 },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  const result = await ai.suggest(summary);
  assert.equal(result.model, 'gpt-6.2-sol');
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 1024);
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(JSON.parse(request.input), summary);
  assert.equal(result.suggestions.length, 1);
  assert.equal(JSON.stringify(result).includes('fake-test-key'), false);
  const invalid = createOpenAIHabits({
    apiKey: 'fake',
    fetcher: (async () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '{"suggestions":[]}' }] }],
        }),
      )) as typeof fetch,
  });
  await assert.rejects(invalid.suggest(summary));
  await assert.rejects(createOpenAIHabits().suggest(summary), /not configured/);
});
test('habit goals and check-ins persist, remain isolated and AI attempt cap survives restart', async () => {
  const db = open(':memory:');
  const doc = { schemaVersion: 1, synthetic: true };
  const profile = createStore(db);
  for (const id of ['demo', 'other'])
    await profile.create(id, { details: { ...doc, id }, preferences: doc, 'bank-account': doc });
  const store = createHabitStore(db);
  const goal = {
    id: 'weekly-review',
    title: 'Weekly review',
    action: 'Review the plan',
    category: 'other',
    targetDaysPerWeek: 1,
    plannedMonthlySavingCents: null,
    active: true,
  };
  try {
    await store.saveGoal('demo', goal);
    const checkin = { id: 'check-1', date: '2026-11-21', completed: true };
    assert.equal((await store.checkin('demo', goal.id, checkin)).inserted, true);
    assert.equal((await store.checkin('demo', goal.id, checkin)).inserted, false);
    await assert.rejects(store.checkin('demo', goal.id, { ...checkin, completed: false }), /conflict/);
    const restarted = createHabitStore(db);
    assert.equal((await restarted.read('demo')).checkins.length, 1);
    assert.equal((await restarted.read('other')).goals.length, 0);
    await Promise.all([store.reserveCall(2, '2026-11-21'), store.reserveCall(2, '2026-11-21')]);
    await assert.rejects(restarted.reserveCall(2, '2026-11-21'), /limit/);
    assert.equal((await restarted.reserveCall(2, '2026-11-22')).attempts, 1);
    await assert.rejects(store.read('../escape'));
  } finally {
    db.close();
  }
});
test('a habit keeps the day it started: set when created or switched back on, kept otherwise', async () => {
  const db = open(':memory:');
  const doc = { schemaVersion: 1, synthetic: true };
  await createStore(db).create('demo', { details: { ...doc, id: 'demo' }, preferences: doc, 'bank-account': doc });
  let now = '2026-11-22T10:00:00Z';
  const store = createHabitStore(db, () => new Date(now));
  const goal = {
    id: 'cook',
    title: 'Cook at home',
    action: 'Cook four dinners a week',
    category: 'food',
    targetDaysPerWeek: 4,
    plannedMonthlySavingCents: 10_000,
  };
  const startOf = async (id: string) => (await store.read('demo')).goals.find(item => item.id === id)?.startedOn;
  try {
    // Created active: it starts the day it is created, and the answer says so.
    assert.equal((await store.saveGoal('demo', goal)).startedOn, '2026-11-22');
    // The person may say when they really started; a goal created switched off has not started.
    assert.equal(
      (await store.saveGoal('demo', { ...goal, id: 'walk', startedOn: '2026-09-01' })).startedOn,
      '2026-09-01',
    );
    assert.equal((await store.saveGoal('demo', { ...goal, id: 'later', active: false })).startedOn, null);

    // A replacement that does not state the day keeps it, as a client that never knew the field would send.
    now = '2026-12-05T10:00:00Z';
    await store.saveGoal('demo', { ...goal, title: 'Cook at home more' }, true);
    assert.equal(await startOf('cook'), '2026-11-22');
    // Pausing keeps the day as history; switching back on starts again that day.
    await store.saveGoal('demo', { ...goal, active: false }, true);
    assert.equal(await startOf('cook'), '2026-11-22');
    now = '2027-01-10T10:00:00Z';
    await store.saveGoal('demo', { ...goal, active: true }, true);
    assert.equal(await startOf('cook'), '2027-01-10');
    // Sending back the stored object on the way to switching it on does not bring the old day back.
    await store.saveGoal('demo', { ...goal, active: false, startedOn: '2027-01-10' }, true);
    now = '2027-02-01T10:00:00Z';
    await store.saveGoal('demo', { ...goal, active: true, startedOn: '2027-01-10' }, true);
    assert.equal(await startOf('cook'), '2027-02-01');
    // A goal first switched on gets its day then, and a stated day is honoured on any replacement.
    await store.saveGoal('demo', { ...goal, id: 'later', active: true }, true);
    assert.equal(await startOf('later'), '2027-02-01');
    await store.saveGoal('demo', { ...goal, id: 'walk', startedOn: '2026-08-15' }, true);
    assert.equal(await startOf('walk'), '2026-08-15');
    // A habit that has not started is not an active habit with a start in the future.
    await assert.rejects(store.saveGoal('demo', { ...goal, id: 'plan', startedOn: '2027-03-01' }), /future/);
    assert.equal(
      (await store.saveGoal('demo', { ...goal, id: 'tomorrow', startedOn: '2027-02-02' })).startedOn,
      '2027-02-02',
    );
    // The contract carries the field: absent reads as unknown, and a non-date is refused.
    assert.equal(goalSchema.parse(goal).startedOn, null);
    assert.equal(goalSchema.safeParse({ ...goal, startedOn: 'yesterday' }).success, false);
    stateSchema.parse(await store.read('demo'));
  } finally {
    db.close();
  }
});

test('a stored habit that started after the bank period counts in the plan; one that ran during it does not', async () => {
  const db = open(':memory:');
  const doc = { schemaVersion: 1, synthetic: true };
  await createStore(db).create('user-001', {
    details: { ...doc, id: 'user-001' },
    preferences: doc,
    'bank-account': doc,
  });
  let now = '2026-10-10T10:00:00Z';
  const store = createHabitStore(db, () => new Date(now));
  const goal = { title: 'Cook at home', action: 'Cook', category: 'food', targetDaysPerWeek: 4 };
  const place: Place = {
    municipalityCode: '250002',
    name: 'Town',
    comarca: 'Test',
    rural: 'not_listed',
    centre: { latitude: 42, longitude: 1 },
    indicators: {
      population: null,
      densityPerKm2: null,
      foreignPopulationPercent: null,
      resaleEurPerM2: {
        observedAt: '2025',
        sourceUrl: 'https://example.org/data',
        value: 1000,
        unit: 'EUR/m2',
        geography: 'municipality',
      },
      rentEurPerMonth: null,
    },
    services: [],
    dataMissing: [],
  };
  const taxRule = {
    id: 'itp_buy' as const,
    version: 'test',
    title: 'Transfer tax',
    authority: 'Test',
    beneficiary: 'household' as const,
    intent: 'buy' as const,
    mechanism: 'reduced_tax_rate' as const,
    effectiveFrom: '2026-01-01',
    effectiveThrough: '2099-12-31',
    sourceUrl: 'https://example.org/policy',
    legalUrl: 'https://example.org/law',
    lastVerified: '2026-11-01',
    benefit: 'Fixture',
    notes: [],
    effect: {
      kind: 'transfer_tax_rate' as const,
      standardRate: 0.1,
      reducedRate: { rural: 0.05, special_attention: 0.05, other: 0.1 },
    },
  };
  try {
    // One habit was already running in October, inside the observed months; one starts in November.
    await store.saveGoal('user-001', { ...goal, id: 'during', plannedMonthlySavingCents: 8_000 });
    now = '2026-11-05T10:00:00Z';
    await store.saveGoal('user-001', { ...goal, id: 'after', plannedMonthlySavingCents: 10_000 });
    // The demo persona is fed by the bank: both monthly figures are observed, August to October.
    const person = buildPerson({
      userId: 'user-001',
      synthetic: true,
      context: {
        resolved: {
          data: { finance: { currentSavingsCents: 1_000_000 }, housing: { homeSizeM2: 100 } },
          provenance: { 'finance.currentSavingsCents': [{ confirmed: true, observedAt: '2026-11-01T00:00:00Z' }] },
        },
      },
      bankSummary: {
        from: '2026-08-01',
        to: '2026-10-31',
        monthCount: 3,
        dataStatus: 'observed',
        incomeCents: 750_000,
        expenseCents: 600_000,
        synthetic: true,
      },
      habitState: await store.read('user-001'),
    });
    assert.deepEqual(
      [person.finances.basis, person.finances.expensesBasis, person.finances.asOf, person.finances.bankSynthetic],
      ['bank_observed', 'bank_observed', '2026-10-31', true],
    );
    assert.deepEqual(
      person.habits.map(habit => [habit.id, habit.startedOn]),
      [
        ['during', '2026-10-10'],
        ['after', '2026-11-05'],
      ],
    );
    const result = planForPlaces(person, [place], [taxRule], {}, '2026-11-22');
    const [plan] = result.plans;
    // €500 a month observed; only the habit that started after the period is added on top.
    assert.deepEqual([plan.baseline?.monthlySavingsCents, plan.withHabits?.monthlySavingsCents], [50_000, 60_000]);
    assert.ok((plan.withHabits?.months ?? 0) < (plan.baseline?.months ?? 0), 'the stored habit shortens the wait');
    assert.deepEqual(
      result.habits?.map(effect => [effect.habitId, effect.counted, effect.reason]),
      [
        ['during', false, 'inside_bank_figures'],
        ['after', true, 'counted'],
      ],
    );
  } finally {
    db.close();
  }
});

test('habits HTTP API enforces auth, explicit AI requests and validated persistent writes', async () => {
  const db = open(':memory:');
  const doc = { schemaVersion: 1, synthetic: true };
  await createStore(db).create('demo', {
    details: { ...doc, id: 'demo' },
    preferences: doc,
    'bank-account': doc,
  });
  const server = createHabitsApi({ token: 'test-token', db });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/limits`)).status, 401);
    const limits = await (await fetch(`${base}/limits`, { headers })).json();
    assert.equal(limits.openaiConfigured, false);
    assert.equal(limits.dollarBudgetEnforced, false);
    const rules = await fetch(`${base}/users/demo/habits/suggestions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ summary }),
    });
    assert.equal(rules.status, 200);
    assert.equal((await rules.json()).source, 'rules');
    const ai = await fetch(`${base}/users/demo/habits/suggestions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'openai', summary }),
    });
    assert.equal(ai.status, 503);
    const goal = {
      id: 'weekly',
      title: 'Weekly review',
      action: 'Review the plan',
      category: 'other',
      targetDaysPerWeek: 1,
    };
    assert.equal(
      (await fetch(`${base}/users/demo/habits`, { method: 'POST', headers, body: JSON.stringify(goal) })).status,
      201,
    );
    assert.equal(
      (
        await fetch(`${base}/users/demo/habits/weekly/checkins`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: 'check-1', date: '2026-11-21', completed: true }),
        })
      ).status,
      200,
    );
    const state = await (await fetch(`${base}/users/demo/habits`, { headers })).json();
    assert.equal(state.checkins.length, 1);
    // The goal came back with the day it started, and the state is as fictional as the persona it belongs to.
    assert.match(state.goals[0].startedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(state.synthetic, true);
    const real = { schemaVersion: 1, synthetic: false };
    await createStore(db).create('p-real', {
      details: { ...real, id: 'p-real' },
      preferences: real,
      'bank-account': real,
    });
    assert.equal((await (await fetch(`${base}/users/p-real/habits`, { headers })).json()).synthetic, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    db.close();
  }
});

test('save_my_habit and list_my_habits: the caller’s own habits, and the bank rule about the start day holds', async () => {
  const db = open(':memory:');
  const doc = { schemaVersion: 1, synthetic: false };
  for (const id of ['p-1', 'p-2'])
    await createStore(db).create(id, { details: { ...doc, id }, preferences: doc, 'bank-account': doc });
  // The real habit handler, as the server mounts it; its HTTP routes are untouched by `save`.
  const habits = createHabitsHandler({ token: 'habits-test-token', db });
  const today = new Date().toISOString().slice(0, 10);
  const { snapshot, policies } = loadData();
  /** A signed-in person whose monthly figures were observed in bank movements up to 31 October. */
  const callerOf = (userId: string, scopes: PersonScope[], withStore = true): Caller => ({
    scopes,
    demo: null,
    challenge: () => 'Bearer resource_metadata="https://relocat.test/.well-known/oauth-protected-resource"',
    me: {
      userId,
      synthetic: false,
      context: async () => ({
        resolved: {
          data: { finance: { currentSavingsCents: 1_000_000 }, housing: { budgetCents: 10_000_000 } },
          provenance: { 'finance.currentSavingsCents': [{ confirmed: true, observedAt: '2026-11-01T00:00:00Z' }] },
        },
      }),
      inputs: async () => ({ inputs: [] }),
      saveInputs: async () => ({ inserted: 0, duplicates: 0 }),
      bankSummary: async () => ({
        from: '2026-08-01',
        to: '2026-10-31',
        monthCount: 3,
        dataStatus: 'observed',
        incomeCents: 750_000,
        expenseCents: 600_000,
        synthetic: true,
      }),
      bankUpdates: async () => ({}),
      bankRuntime: async () => ({}),
      bankBalanceCents: async () => null,
      habits: () => habits.read(userId),
      ...(withStore ? { saveHabit: (goal: unknown, replace = false) => habits.save(userId, goal, replace) } : {}),
    },
  });
  const connect = async (caller: Caller) => {
    const server = new McpServer({ name: 'habit-tools-test', version: '1' });
    registerPlannerTools(server, { snapshot, policies, today: () => '2026-11-22', caller });
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  };
  const one = await connect(callerOf('p-1', ['person:read', 'person:write']));
  const two = await connect(callerOf('p-2', ['person:read', 'person:write']));
  const reader = await connect(callerOf('p-1', ['person:read']));
  const storeless = await connect(callerOf('p-1', ['person:read', 'person:write'], false));
  const habit = (response: unknown) =>
    (response as { structuredContent: { created: boolean; habit: Record<string, unknown> } }).structuredContent;
  const text = (response: unknown) => (response as { content: { text: string }[] }).content.map(item => item.text);
  try {
    const tools = (await one.listTools()).tools;
    const [list, save] = ['list_my_habits', 'save_my_habit'].map(name => tools.find(tool => tool.name === name));
    assert.deepEqual([list?.annotations?.readOnlyHint, save?.annotations?.readOnlyHint], [true, false]);
    for (const tool of [list, save]) assert(!('userId' in (tool?.inputSchema.properties ?? {})));
    assert.match(save?.description ?? '', /only when it started after the observed period/);

    // A new habit starts today; today is after the observed months, so it counts on top of them.
    const created = await one.callTool({
      name: 'save_my_habit',
      arguments: { id: 'cook', title: 'Cook at home', category: 'food', monthlySavingCents: 10_000 },
    });
    assert(!created.isError, JSON.stringify(created.content));
    assert.deepEqual(
      [
        habit(created).created,
        habit(created).habit.startedOn,
        habit(created).habit.status,
        habit(created).habit.action,
      ],
      [true, today, 'active', 'Cook at home'],
    );
    // A habit the person says they already had in October is stored with that day, and is not added on top.
    const earlier = await one.callTool({
      name: 'save_my_habit',
      arguments: {
        id: 'bus',
        title: 'Bus pass',
        category: 'transport',
        monthlySavingCents: 8_000,
        startedOn: '2026-10-10',
      },
    });
    assert.equal(habit(earlier).habit.startedOn, '2026-10-10');
    const planned = await one.callTool({
      name: 'plan_home_savings',
      arguments: { me: true, municipalityCodes: ['250404'] },
    });
    const plan = planResult.parse(planned.structuredContent);
    assert.deepEqual(
      plan.habits?.map(effect => [effect.habitId, effect.counted, effect.reason, effect.countedMonthlyCents]),
      [
        ['cook', true, 'counted', 10_000],
        ['bus', false, 'inside_bank_figures', 0],
      ],
    );
    assert.deepEqual(
      [
        plan.person.finances.expensesBasis,
        plan.plans[0].baseline?.monthlySavingsCents,
        plan.plans[0].withHabits?.monthlySavingsCents,
      ],
      ['bank_observed', 50_000, 60_000],
    );
    assert.match(text(planned)[0], /1 active habit\(s\) are shown but not counted/);

    // An update keeps what is left out, including the start day; pausing takes the habit out of the plan.
    const paused = await one.callTool({
      name: 'save_my_habit',
      arguments: { id: 'cook', title: 'Cook at home more', category: 'food', active: false },
    });
    assert.deepEqual(
      [
        habit(paused).created,
        habit(paused).habit.status,
        habit(paused).habit.monthlySavingCents,
        habit(paused).habit.startedOn,
      ],
      [false, 'paused', 10_000, today],
    );
    // No amount is never turned into one.
    const bare = await one.callTool({
      name: 'save_my_habit',
      arguments: { id: 'walk', title: 'Walk', category: 'transport' },
    });
    assert.equal(habit(bare).habit.monthlySavingCents, null);
    // A habit cannot start in the future, and the refusal is in the person's language.
    const future = await one.callTool({
      name: 'save_my_habit',
      arguments: { id: 'later', title: 'Later', category: 'other', startedOn: '2999-01-01', locale: 'es' },
    });
    assert.equal(future.isError, true);
    assert.deepEqual(text(future), ['Un hábito no puede empezar en el futuro: indica hoy o un día anterior.']);

    // Each person lists their own habits and nobody else's.
    const mine = (await one.callTool({ name: 'list_my_habits', arguments: {} })).structuredContent as {
      habits: { id: string }[];
    };
    const theirs = (await two.callTool({ name: 'list_my_habits', arguments: {} })).structuredContent as {
      habits: unknown[];
    };
    assert.deepEqual([mine.habits.map(item => item.id), theirs.habits], [['cook', 'bus', 'walk'], []]);
    // Reading does not allow writing; a server without a habit store says so plainly.
    const refused = await reader.callTool({
      name: 'save_my_habit',
      arguments: { id: 'tea', title: 'Tea', category: 'food' },
    });
    assert.equal(refused.isError, true);
    assert.match(text(refused)[0], /allow "person:write"/);
    assert.match(text(refused)[1], /^Your ReloCat connection does not allow this yet/);
    assert.equal((await reader.callTool({ name: 'list_my_habits', arguments: {} })).isError, undefined);
    const noStore = await storeless.callTool({
      name: 'save_my_habit',
      arguments: { id: 'tea', title: 'Tea', category: 'food' },
    });
    assert.deepEqual([noStore.isError, text(noStore)], [true, ['Habits cannot be saved on this server.']]);
    assert.equal((await habits.read('p-1')).goals.length, 3);
  } finally {
    await Promise.all([one, two, reader, storeless].map(client => client.close()));
    db.close();
  }
});
