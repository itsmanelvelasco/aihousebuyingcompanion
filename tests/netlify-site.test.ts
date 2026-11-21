import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// JavaScript build entry point is deliberately also importable for deployment checks.
// @ts-expect-error no declaration file for the standalone build script
import { buildManagementSite, profileGateway } from '../scripts/build-management-site.mjs';

test('Netlify build emits only dashboard/interviewer assets and a separate restricted function', async () => {
  const output = await mkdtemp(join(tmpdir(), 'relocat-netlify-'));
  await buildManagementSite(output);
  const html = await readFile(join(output, 'public/index.html'), 'utf8');
  assert(html.includes('src="/manage/app.mjs"'));
  assert(html.includes('Hosted voice is unavailable'));
  assert((await readFile(join(output, 'public/manage/app.mjs'), 'utf8')).includes('Bearer ${state.token}'));
  assert.deepEqual((await readdir(join(output, 'public/interviewer'))).sort(), ['app.mjs', 'finances.mjs', 'index.html']);
  const gateway = await readFile(join(output, 'functions/profile-api.mjs'), 'utf8');
  assert(gateway.startsWith('export default async function profileGateway'));
  assert(gateway.includes("'/users/*'"));
  assert(!gateway.includes('OPENAI_API_KEY'));
  await writeFile(join(output, 'public/accidental-secret.txt'), 'must not publish');
  await assert.rejects(buildManagementSite(output), /Unexpected file/);
});

test('Netlify gateway requires caller auth, forwards only approved data, and never enables paid voice', async () => {
  const oldOrigin = process.env.PROFILE_API_ORIGIN;
  const originalFetch = globalThis.fetch;
  const site = 'https://relo.cat';
  const req = (path: string, init: RequestInit = {}) => new Request(site + path, init);
  let calls = 0;
  try {
    delete process.env.PROFILE_API_ORIGIN;
    assert.equal((await profileGateway(req('/users'))).status, 401);
    assert.equal((await profileGateway(req('/users', { headers: { Authorization: 'Bearer caller' } }))).status, 503);
    process.env.PROFILE_API_ORIGIN = 'https://profiles.example.org';
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(String(input), 'https://profiles.example.org/users/user-001/details');
      assert.equal(init?.redirect, 'error'); assert(init?.signal);
      const headers = new Headers(init?.headers);
      assert.deepEqual([...headers.keys()].sort(), ['authorization', 'content-type']);
      assert.equal(headers.get('authorization'), 'Bearer caller');
      assert.equal(new TextDecoder().decode(init?.body as Uint8Array), '{"synthetic":true}');
      return new Response('{"saved":true}', { status: 200, headers: { 'Set-Cookie': 'secret=value' } });
    };
    const response = await profileGateway(req('/users/user-001/details', { method: 'PUT', headers: {
      Authorization: 'Bearer caller', 'Content-Type': 'application/json', Cookie: 'secret=value', Origin: site
    }, body: '{"synthetic":true}' }));
    assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(calls, 1);
    assert.equal((await profileGateway(req('/users/user-001/details', { method: 'POST' }))).status, 405);
    assert.equal((await profileGateway(req('/users/user-001/unknown'))).status, 404);
    assert.equal((await profileGateway(req('/users', { headers: { Origin: 'https://foreign.example' } }))).status, 403);
    assert.equal((await profileGateway(req('/users', { method: 'POST', headers: { Authorization: 'Bearer caller', 'Content-Type': 'application/json' }, body: 'x'.repeat(262145) }))).status, 413);
    process.env.INTERVIEWER_API_ORIGIN = 'https://voice.example.org';
    for (const path of ['/interviewer/voice', '/interviewer/classify']) {
      assert.equal((await profileGateway(req(path, { method: 'POST', headers: { Authorization: 'Bearer caller' } }))).status, 503);
    }
    assert.equal(calls, 1);
    globalThis.fetch = async () => { throw new Error('private upstream credentials'); };
    const failed = await profileGateway(req('/users', { headers: { Authorization: 'Bearer caller' } }));
    assert.equal(failed.status, 502); assert(!(await failed.text()).includes('private'));
  } finally {
    globalThis.fetch = originalFetch;
    if (oldOrigin === undefined) delete process.env.PROFILE_API_ORIGIN; else process.env.PROFILE_API_ORIGIN = oldOrigin;
    delete process.env.INTERVIEWER_API_ORIGIN;
  }
});
