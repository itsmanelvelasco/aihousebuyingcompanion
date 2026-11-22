import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInputStore } from '../apps/profile-api/inputs.ts';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { createStore } from '../packages/profiles/store.ts';

test('multiple app inputs persist, combine partial answers, expose conflicts and preserve isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relocat-input-'));
  const document = { schemaVersion: 1, synthetic: true };
  const store = createStore(root);
  for (const id of ['demo', 'other'])
    await store.create(id, {
      details: { ...document, id, householdSize: 2 },
      preferences: { ...document, goal: 'buy_primary_home', housingBudgetCents: 16000000 },
      'bank-account': { ...document, snapshotDate: '2026-11-21', balanceCents: 1000000 },
    });
  const server = createProfileApi(root, 'test');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/users/demo`;
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
  const input = {
    id: 'interview-1',
    source: 'interview',
    confirmed: true,
    synthetic: true,
    observedAt: '2026-11-21T10:00:00Z',
    data: { housing: { homeSizeM2: 85, budgetCents: 13000000, allowComarcaEstimate: false } },
  };
  const post = (inputs: unknown[]) =>
    fetch(`${base}/inputs`, { method: 'POST', headers, body: JSON.stringify({ inputs }) });
  try {
    assert.equal((await fetch(`${base}/context`)).status, 401);
    assert.equal((await post([input])).status, 200);
    assert.deepEqual(await (await post([input])).json(), { inserted: 0, duplicates: 1 });
    let context = await (await fetch(`${base}/context`, { headers })).json();
    assert.equal(context.resolved.data.housing.budgetCents, 13000000);
    assert.equal(context.recommendation.input.housing.maxBudgetEur, 130000);
    assert.equal(context.recommendation.input.housing.allowComarcaEstimate, false);
    assert.equal(context.recommendation.ready, true);
    assert.equal(context.resolved.data.finance.currentSavingsCents, 1000000);
    const manual = { ...input, id: 'manual-1', source: 'manual', data: { housing: { budgetCents: 14000000 } } };
    assert.equal((await post([manual])).status, 200);
    context = await (await fetch(`${base}/context`, { headers })).json();
    assert.ok(
      context.resolved.conflicts.some((conflict: { field: string }) => conflict.field === 'housing.budgetCents'),
    );
    assert.equal(context.recommendation.ready, false);
    assert.equal((await post([{ ...input, id: 'profile-snapshot', source: 'profile' }])).status, 400);
    assert.equal((await post([{ ...input, id: 'bad', data: { unknown: true } }])).status, 400);
    assert.equal(
      (
        await post([
          { ...input, id: 'new-item' },
          { ...input, data: { housing: { homeSizeM2: 40 } } },
        ])
      ).status,
      409,
    );
    assert.equal((await createInputStore(root).read('demo')).inputs.length, 2);
    const modified = { ...manual, data: { housing: { budgetCents: 13000000 } } };
    assert.equal(
      (await fetch(`${base}/inputs/manual-1`, { method: 'PUT', headers, body: JSON.stringify(modified) })).status,
      200,
    );
    assert.equal((await fetch(`${base}/inputs/manual-1`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await createInputStore(root).read('demo')).inputs.length, 1);
    assert.equal((await createInputStore(root).read('other')).inputs.length, 0);
    await Promise.all(['concurrent-1', 'concurrent-2'].map(id => post([{ ...input, id }])));
    assert.equal((await createInputStore(root).read('demo')).inputs.length, 3);
    assert.equal((await fetch(`${base.replace('/demo', '/missing')}/inputs`, { headers })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
