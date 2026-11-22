import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInputStore, maxInputs, supersededInputs } from '../apps/profile-api/inputs.ts';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { inputSchema, resolveInputs } from '../packages/contracts/inputs.ts';
import { open } from '../packages/db/database.ts';
import { createStore } from '../packages/profiles/store.ts';

test('multiple app inputs persist, combine partial answers, expose conflicts and preserve isolation', async () => {
  const db = open(':memory:');
  const document = { schemaVersion: 1, synthetic: true };
  const store = createStore(db);
  for (const id of ['demo', 'other'])
    await store.create(id, {
      details: { ...document, id, householdSize: 2 },
      preferences: { ...document, goal: 'buy_primary_home', housingBudgetCents: 16000000 },
      'bank-account': { ...document, snapshotDate: '2026-11-21', balanceCents: 1000000 },
    });
  const server = createProfileApi(db, 'test');
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
    assert.deepEqual(await (await post([input])).json(), { inserted: 0, replaced: 0, duplicates: 1, pruned: 0 });
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
    // A batch is all or nothing: one invalid record stores none of it.
    assert.equal(
      (
        await post([
          { ...input, id: 'new-item' },
          { ...input, id: 'bad', data: {} },
        ])
      ).status,
      400,
    );
    assert.equal((await createInputStore(db).read('demo')).inputs.length, 2);
    // The same ID with different content updates the client's own record in place.
    const corrected = { ...input, data: { housing: { ...input.data.housing, homeSizeM2: 90 } } };
    assert.deepEqual(await (await post([corrected])).json(), { inserted: 0, replaced: 1, duplicates: 0, pruned: 0 });
    const stored = await createInputStore(db).read('demo');
    assert.equal(stored.inputs.length, 2);
    assert.equal(stored.inputs[0].data.housing?.homeSizeM2, 90);
    const modified = { ...manual, data: { housing: { budgetCents: 13000000 } } };
    assert.equal(
      (await fetch(`${base}/inputs/manual-1`, { method: 'PUT', headers, body: JSON.stringify(modified) })).status,
      200,
    );
    assert.equal((await fetch(`${base}/inputs/manual-1`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await createInputStore(db).read('demo')).inputs.length, 1);
    assert.equal((await createInputStore(db).read('other')).inputs.length, 0);
    await Promise.all(['concurrent-1', 'concurrent-2'].map(id => post([{ ...input, id }])));
    assert.equal((await createInputStore(db).read('demo')).inputs.length, 3);
    assert.equal((await fetch(`${base.replace('/demo', '/missing')}/inputs`, { headers })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    db.close();
  }
});

async function profile(id: string) {
  const db = open(':memory:');
  const document = { schemaVersion: 1, synthetic: true };
  await createStore(db).create(id, { details: { ...document, id }, preferences: document, 'bank-account': document });
  return db;
}

function record(index: number, source: string, data: unknown, confirmed = false) {
  return {
    id: `${source}-${index}`,
    source,
    confirmed,
    synthetic: true,
    observedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    data,
  };
}

test('a profile stays writable past the record cap: superseded records go, winning values stay', async () => {
  const db = await profile('demo');
  const inputs = createInputStore(db);
  try {
    // A confirmed manual fact and a confirmed interview fact that nothing ever supersedes.
    await inputs.add('demo', { inputs: [record(0, 'manual', { rural: { required: true } }, true)] });
    await inputs.add('demo', { inputs: [record(1, 'interview', { household: { size: 3 } }, true)] });
    // The board saves one record per answer: the same field, hundreds of times.
    let pruned = 0;
    for (let index = 2; index < maxInputs + 40; index++)
      pruned += (
        await inputs.add('demo', { inputs: [record(index, 'interview', { housing: { budgetCents: index } })] })
      ).pruned;
    const stored = (await inputs.read('demo')).inputs;
    assert.equal(stored.length, maxInputs);
    assert.equal(pruned, 40);
    const ids = new Set(stored.map(input => input.id));
    assert.ok(ids.has('manual-0') && ids.has('interview-1'), 'records that still decide a field are kept');
    assert.ok(!ids.has('interview-2') && ids.has(`interview-${maxInputs + 39}`), 'the oldest superseded go first');
    const context = await inputs.context('demo');
    assert.equal(context.resolved.data.housing?.budgetCents, maxInputs + 39);
    assert.equal(context.resolved.data.rural?.required, true);
    assert.equal(context.resolved.data.household?.size, 3);
    // Superseded records of the source being written go before those of another source.
    await inputs.add('demo', { inputs: [record(900, 'manual', { rural: { required: false } }, true)] });
    assert.ok(!(await inputs.read('demo')).inputs.some(input => input.id === 'manual-0'));
  } finally {
    db.close();
  }
});

test('pruning never changes what the inputs resolve to, and a full set of live records is refused clearly', async () => {
  const sources = ['interview', 'manual', 'bank', 'listing'];
  const all = Array.from({ length: 120 }, (_, index) =>
    inputSchema.parse(
      record(
        index % 50,
        sources[index % 4],
        {
          ...(index % 3 ? { housing: { budgetCents: 1000 + (index % 7) } } : { household: { size: 1 + (index % 5) } }),
          ...(index % 11 ? {} : { finance: { currentSavingsCents: index } }),
        },
        index % 2 === 0,
      ),
    ),
  ).map((input, index) => ({ ...input, id: `r-${index}` }));
  const superseded = new Set(supersededInputs(all).map(input => input.id));
  assert.ok(superseded.size > 50);
  assert.deepEqual(resolveInputs(all.filter(input => !superseded.has(input.id))), resolveInputs(all));

  // Records with one shared timestamp all take part in resolution, so none of them is superseded.
  const db = await profile('demo');
  const inputs = createInputStore(db);
  try {
    const tie = (index: number) => ({ ...record(0, 'manual', { household: { size: 2 } }), id: `tie-${index}` });
    for (let start = 0; start < maxInputs; start += 50)
      await inputs.add('demo', { inputs: Array.from({ length: 50 }, (_, offset) => tie(start + offset)) });
    await assert.rejects(inputs.add('demo', { inputs: [tie(maxInputs)] }), /none is superseded/);
    assert.equal((await inputs.read('demo')).inputs.length, maxInputs);
    // A newer answer supersedes them all, so the profile is writable again.
    assert.equal((await inputs.add('demo', { inputs: [record(5, 'manual', { household: { size: 4 } })] })).pruned, 1);
  } finally {
    db.close();
  }
});
