import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createInputStore } from '../apps/profile-api/inputs.ts';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { createAccounts } from '../packages/auth/accounts.ts';
import { accessConfig } from '../packages/config/env.ts';
import { open } from '../packages/db/database.ts';
import { createStore, seedRuntime } from '../packages/profiles/store.ts';
import { reseedDemo } from '../scripts/reseed-demo.ts';

test('API authorizes requests, persists sections and rejects unsafe or malformed writes', async () => {
  const db = open(':memory:');
  const server = createProfileApi(db, 'test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const profile = {
    details: { schemaVersion: 1, synthetic: true, id: 'demo-1', name: 'Fictional household' },
    preferences: { schemaVersion: 1, synthetic: true, schoolStages: ['ESO'] },
    'bank-account': { schemaVersion: 1, synthetic: true, balanceCents: 10000, currency: 'EUR' },
  };
  try {
    assert.equal((await fetch(`${base}/users`)).status, 401);
    assert.equal(
      (await fetch(`${base}/users`, { method: 'POST', headers, body: JSON.stringify(profile) })).status,
      201,
    );
    assert.equal(
      (await fetch(`${base}/users`, { method: 'POST', headers, body: JSON.stringify(profile) })).status,
      409,
    );
    assert.deepEqual(await (await fetch(`${base}/users`, { headers })).json(), { users: ['demo-1'] });
    assert.deepEqual(await (await fetch(`${base}/users/demo-1`, { headers })).json(), profile);
    const replacement = { schemaVersion: 1, synthetic: true, schoolStages: ['primaria'], carAvailable: false };
    assert.equal(
      (await fetch(`${base}/users/demo-1/preferences`, { method: 'PUT', headers, body: JSON.stringify(replacement) }))
        .status,
      200,
    );
    assert.deepEqual(await createStore(db).read('demo-1', 'preferences'), replacement);
    assert.deepEqual(
      await (await fetch(`${base}/users/demo-1/bank-account`, { headers })).json(),
      profile['bank-account'],
    );
    assert.equal((await fetch(`${base}/users/missing`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/users/demo-1/credentials`, { headers })).status, 404);
    assert.equal(
      (
        await fetch(`${base}/users`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...profile, details: { ...profile.details, id: '../escape' } }),
        })
      ).status,
      400,
    );
    assert.equal((await fetch(`${base}/users/demo-1%2f..%2fescape/details`, { headers })).status, 400);
    assert.equal(
      (
        await fetch(`${base}/users/demo-1/details`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ ...profile.details, id: 'other' }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(`${base}/users/demo-1/preferences`, { method: 'PUT', headers, body: '{bad' })).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/users/demo-1/preferences`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ ...replacement, synthetic: false }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/users/demo-1/preferences`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ ...replacement, huge: 'x'.repeat(270000) }),
        })
      ).status,
      413,
    );
    assert.deepEqual(await (await fetch(`${base}/users/demo-1/preferences`, { headers })).json(), replacement);

    // A real person is stored and returned as real; the flag is a boolean, required, and one per person.
    const real = {
      details: { schemaVersion: 1, synthetic: false, id: 'p-real', name: 'A real household' },
      preferences: { schemaVersion: 1, synthetic: false },
      'bank-account': { schemaVersion: 1, synthetic: false },
    };
    const create = (value: unknown) => fetch(`${base}/users`, { method: 'POST', headers, body: JSON.stringify(value) });
    assert.equal((await create(real)).status, 201);
    assert.deepEqual(await (await fetch(`${base}/users/p-real`, { headers })).json(), real);
    const store = createStore(db);
    assert.deepEqual([store.isSynthetic('p-real'), store.isSynthetic('demo-1')], [false, true]);
    const { synthetic: _flag, ...unflagged } = real.preferences;
    for (const invalid of [
      { ...real, details: { ...real.details, id: 'p-mixed' }, preferences: { ...real.preferences, synthetic: true } },
      { ...real, details: { ...real.details, id: 'p-missing' }, preferences: unflagged },
      { ...real, details: { ...real.details, id: 'p-text', synthetic: 'no' } },
    ])
      assert.equal((await create(invalid)).status, 400);
    // Replacing a document never relabels it: real stays real.
    const relabel = await fetch(`${base}/users/p-real/preferences`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ schemaVersion: 1, synthetic: true, goal: 'buy_primary_home' }),
    });
    assert.equal(relabel.status, 400);
    assert.match((await relabel.json()).error, /synthetic flag of a stored document cannot be changed/);
    const kept = await fetch(`${base}/users/p-real/preferences`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ schemaVersion: 1, synthetic: false, goal: 'buy_primary_home' }),
    });
    assert.equal(kept.status, 200);
    assert.equal((await store.read('p-real', 'preferences')).synthetic, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    db.close();
  }
});

test('runtime seeding preserves existing user edits and skips broken fixtures', async () => {
  const source = await mkdtemp(join(tmpdir(), 'relocat-seed-'));
  const db = open(':memory:');
  const document = { schemaVersion: 1 as const, synthetic: true as const };
  const fixture = async (id: string, details: unknown) => {
    await mkdir(join(source, id));
    await writeFile(join(source, id, 'details.json'), JSON.stringify(details));
    await writeFile(join(source, id, 'preferences.json'), JSON.stringify(document));
    await writeFile(join(source, id, 'bank-account.json'), JSON.stringify(document));
  };
  try {
    await fixture('demo', { ...document, id: 'demo' });
    await fixture('broken', { ...document, id: 'someone-else' });
    const first = await seedRuntime(source, db);
    assert.deepEqual(first.seeded, ['demo']);
    assert.deepEqual(
      first.skipped.map(item => item.id),
      ['broken'],
    );
    const store = createStore(db);
    assert.deepEqual(await store.list(), ['demo']);
    await store.write('demo', 'preferences', { ...document, edited: true });
    assert.deepEqual((await seedRuntime(source, db)).seeded, []);
    assert.equal((await store.read('demo', 'preferences')).edited, true);
  } finally {
    db.close();
    await rm(source, { recursive: true, force: true });
  }
});

test('the demo personas declare their purchase savings, and reseeding brings a database with old fixtures up to date', async () => {
  const fixtures = resolve('data/users');
  const personas = accessConfig({}).demoUserIds;
  assert.deepEqual(personas, ['user-001', 'user-002', 'user-003', 'user-004']);
  const db = open(':memory:');
  try {
    // A database seeded before the fixtures declared savings: the same documents without the field.
    const profiles = createStore(db);
    const inputs = createInputStore(db);
    for (const id of [...personas, 'user-005']) {
      const read = async (section: string) => JSON.parse(await readFile(join(fixtures, id, `${section}.json`), 'utf8'));
      const { purchaseSavingsCents: _dropped, ...preferences } = await read('preferences');
      await profiles.create(id, {
        details: await read('details'),
        preferences,
        'bank-account': await read('bank-account'),
      });
    }
    const savingsOf = async (id: string) =>
      ((await inputs.context(id)).resolved.data.finance as { currentSavingsCents?: number } | undefined)
        ?.currentSavingsCents;
    assert.equal(await savingsOf('user-001'), undefined, 'the old fixtures state no purchase savings');
    // A person who signed up, with documents of their own, and an id of the allowlist that an account owns.
    const person = await createAccounts(db).signUp({
      email: 'ada@example.com',
      password: 'correct horse battery',
      address: 'a',
    });
    db.run('UPDATE accounts SET user_id = ? WHERE id = ?', 'user-004', person.id);
    const before = (id: string) =>
      JSON.stringify(db.all('SELECT section, document FROM profile_sections WHERE user_id = ? ORDER BY section', id));
    const [owned, outside, real] = [before('user-004'), before('user-005'), before(person.userId)];
    // Something a persona accumulated at run time stays.
    await inputs.add('user-002', {
      inputs: [
        {
          id: 'note',
          source: 'manual',
          observedAt: '2026-11-22T10:00:00Z',
          confirmed: true,
          synthetic: true,
          data: { household: { size: 2 } },
        },
      ],
    });

    const dry = await reseedDemo(db, { fixtures, ids: personas, dryRun: true });
    assert.deepEqual(dry.updated, ['user-001', 'user-002', 'user-003']);
    assert.equal(await savingsOf('user-001'), undefined, 'a dry run writes nothing');

    const outcome = await reseedDemo(db, { fixtures, ids: [...personas, 'user-999', '../escape'] });
    assert.deepEqual(
      [outcome.updated, outcome.created, outcome.unchanged],
      [['user-001', 'user-002', 'user-003'], [], []],
    );
    assert.deepEqual(
      outcome.skipped.map(item => [item.id, /belongs to an account|not a valid id|ENOENT/.test(item.reason)]),
      [
        ['user-999', true],
        ['../escape', true],
        ['user-004', true],
      ],
    );
    // The three personas now resolve the savings their fixture declares; the plan has a figure to work with.
    for (const id of ['user-001', 'user-002', 'user-003']) {
      const declared = JSON.parse(await readFile(join(fixtures, id, 'preferences.json'), 'utf8')).purchaseSavingsCents;
      assert.ok(declared > 0);
      assert.equal(await savingsOf(id), declared, id);
      assert.equal((await inputs.context(id)).synthetic, true);
    }
    assert.equal((await inputs.read('user-002')).inputs.length, 1, 'saved answers of a persona are untouched');
    // Never touched: an id an account owns, an id outside the allowlist, and the person who signed up.
    assert.deepEqual([before('user-004'), before('user-005'), before(person.userId)], [owned, outside, real]);
    // Running it again changes nothing, and a persona that is missing is created.
    assert.deepEqual((await reseedDemo(db, { fixtures, ids: ['user-001', 'user-006'] })).unchanged, ['user-001']);
    assert.equal(
      await savingsOf('user-006'),
      JSON.parse(await readFile(join(fixtures, 'user-006', 'preferences.json'), 'utf8')).purchaseSavingsCents,
    );
  } finally {
    db.close();
  }
});
