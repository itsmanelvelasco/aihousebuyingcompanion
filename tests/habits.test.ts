import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIHabits } from '../apps/habits-agent/agent.ts';
import { createHabitsApi } from '../apps/habits-agent/server.ts';
import { createHabitStore } from '../apps/habits-agent/store.ts';
import { summarySchema } from '../packages/contracts/habits.ts';
import { open } from '../packages/db/database.ts';
import { suggestHabits } from '../packages/finance/habits.ts';
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
    assert.equal((await (await fetch(`${base}/users/demo/habits`, { headers })).json()).checkins.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    db.close();
  }
});
