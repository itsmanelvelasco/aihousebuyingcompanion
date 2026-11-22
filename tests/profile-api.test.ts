import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { seedRuntime } from '../packages/profiles/store.ts';

test('API authorizes requests, persists sections and rejects unsafe or malformed writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relocat-api-'));
  const server = createProfileApi(root, 'test-token');
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
    assert.deepEqual(JSON.parse(await readFile(join(root, 'demo-1/preferences.json'), 'utf8')), replacement);
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
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime seeding preserves existing user edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relocat-seed-'));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const { createStore } = await import('../packages/profiles/store.ts');
  const document = { schemaVersion: 1 as const, synthetic: true as const };
  try {
    await createStore(source).create('demo', {
      details: { ...document, id: 'demo' },
      preferences: document,
      'bank-account': document,
    });
    await seedRuntime(source, target);
    await createStore(target).write('demo', 'preferences', { ...document, edited: true });
    await seedRuntime(source, target);
    assert.equal((await createStore(target).read('demo', 'preferences')).edited, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
