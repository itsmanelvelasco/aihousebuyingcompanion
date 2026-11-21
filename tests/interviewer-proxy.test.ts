import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { handleInterviewerProxy } from '../apps/mcp-server/interviewer-proxy.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('local interviewer bridge forwards assets/voice with correct backend origin and strips account headers', async () => {
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'must-not-forward=true' });
    res.end(JSON.stringify({ path: req.url, origin: req.headers.origin, host: req.headers.host,
      contentType: req.headers['content-type'], authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null, body: Buffer.concat(chunks).toString() }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createServer(async (req, res) => { if (!await handleInterviewerProxy(req, res, upstreamUrl)) res.writeHead(404).end(); });
  const base = await listen(proxy);
  try {
    const redirect = await fetch(`${base}/interviewer`, { redirect: 'manual' });
    assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/interviewer/');
    const asset = await fetch(`${base}/interviewer/app.mjs`);
    assert.equal(asset.status, 200); assert.equal((await asset.json()).path, '/app.mjs');
    const voice = await fetch(`${base}/interviewer/voice`, { method: 'POST', headers: {
      Origin: base, 'Content-Type': 'application/sdp', Authorization: 'Bearer do-not-forward', Cookie: 'private=true'
    }, body: 'fictional-offer' });
    assert.equal(voice.status, 200); assert.equal(voice.headers.get('set-cookie'), null);
    const result = await voice.json();
    assert.equal(result.origin, upstreamUrl); assert.equal(result.host, new URL(upstreamUrl).host);
    assert.equal(result.contentType, 'application/sdp'); assert.equal(result.body, 'fictional-offer');
    assert.equal(result.authorization, null); assert.equal(result.cookie, null);
    assert.equal((await fetch(`${base}/interviewer/classify`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '[]' })).status, 200);
    assert.equal((await fetch(`${base}/interviewer/scenario`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal((await fetch(`${base}/interviewer/voice`, { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/sdp' }, body: 'x' })).status, 403);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      request(`${base}/interviewer/`, { headers: { Host: 'public.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject).end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`${base}/interviewer/arbitrary`)).status, 404);
    assert.equal((await fetch(`${base}/interviewer/voice`)).status, 405);
    assert.equal((await fetch(`${base}/interviewer/voice`, { method: 'POST', headers: { Origin: base }, body: 'x'.repeat(65537) })).status, 413);
    assert.equal((await fetch(`${base}/unrelated`)).status, 404);
  } finally { await close(proxy); await close(upstream); }
});

test('interviewer proxy rejects nonlocal backends and sanitizes unavailable backend errors', async () => {
  for (const target of ['https://remote.example', 'http://user:password@localhost:1', 'http://127.0.0.1:1']) {
    const proxy = createServer(async (req, res) => { await handleInterviewerProxy(req, res, target); });
    const base = await listen(proxy);
    try {
      const response = await fetch(`${base}/interviewer/`);
      assert.equal(response.status, 502);
      const body = await response.text(); assert(!body.includes('password')); assert(!body.includes(target));
    } finally { await close(proxy); }
  }
});
