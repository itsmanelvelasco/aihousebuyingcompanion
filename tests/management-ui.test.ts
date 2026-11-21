import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createProfileApi } from '../apps/profile-api/server.ts';

test('local management shell keeps data authenticated and blocks foreign origins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relocat-management-'));
  const server = createProfileApi(root, 'test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(`${base}/manage/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-src 'self'/);
    const html = await page.text();
    assert.match(html, /Tell us what you need/);
    assert.match(html, /data-relocat-theme/);
    assert.match(html, /id="interviewer-frame"/);
    assert.doesNotMatch(html, /test-token/);
    assert.equal((await fetch(`${base}/manage/app.mjs`)).status, 200);
    assert.equal((await fetch(`${base}/users`)).status, 401);
    assert.equal((await fetch(`${base}/manage/`, { headers: { Origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await fetch(`${base}/manage/`, { method: 'POST' })).status, 405);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      request(`${base}/manage/`, { headers: { Host: 'foreign.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject).end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`${base}/manage`, { redirect: 'manual' })).headers.get('location'), '/manage/');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
