import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { open } from '../packages/db/database.ts';
import { createStore, seedRuntime } from '../packages/profiles/store.ts';

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
