import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { handleWorkspaceVoiceHttp, registerWorkspaceVoiceTool } from '../apps/mcp-server/workspace-voice.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test('voice MCP operation is app-only and relays only SDP to the local interviewer', async () => {
  const observed: { path?: string; origin?: string; authorization?: string; cookie?: string; body?: string } = {};
  const upstream = createServer(async (req, res) => {
    Object.assign(observed, { path: req.url, origin: req.headers.origin, authorization: req.headers.authorization, cookie: req.headers.cookie });
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    observed.body = Buffer.concat(chunks).toString();
    res.writeHead(200, { 'Content-Type': 'application/sdp' }).end('v=0\r\nfictional-answer');
  });
  const base = await listen(upstream);
  const server = new McpServer({ name: 'voice-test', version: '1' });
  registerWorkspaceVoiceTool(server, base);
  const client = new Client({ name: 'voice-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'workspace_voice_session');
    assert.deepEqual((tool?._meta?.ui as { visibility?: string[] })?.visibility, ['app']);
    const result = await client.callTool({ name: 'workspace_voice_session', arguments: { sdp: 'v=0\r\nfictional-offer' } });
    assert.equal(result.isError, undefined);
    assert.equal(result._meta?.voiceSdp, 'v=0\r\nfictional-answer');
    assert.equal(result.structuredContent, undefined);
    assert(!JSON.stringify(result.content).includes('fictional-answer'));
    assert.deepEqual(observed, { path: '/voice', origin: base, authorization: undefined, cookie: undefined, body: 'v=0\r\nfictional-offer' });
  } finally { await client.close(); await server.close(); await close(upstream); }
});

test('voice local HTTP endpoint guards browser origin, Host, content type and size; failures stay sanitized', async () => {
  let calls = 0;
  const upstream = createServer((req, res) => { calls++; req.resume(); res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"secret-upstream-key"}'); });
  const backend = await listen(upstream);
  const proxy = createServer(async (req, res) => {
    if (!await handleWorkspaceVoiceHttp(req, res, backend)) res.writeHead(404).end();
  });
  const base = await listen(proxy);
  const headers = { Origin: base, 'Content-Type': 'application/sdp', Authorization: 'Bearer private', Cookie: 'private=true' };
  try {
    assert.equal((await fetch(`${base}/workspace/voice`, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: 'v=0' })).status, 403);
    assert.equal((await fetch(`${base}/workspace/voice`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: 'v=0' })).status, 415);
    assert.equal((await fetch(`${base}/workspace/voice`)).status, 405);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      request(`${base}/workspace/voice`, { method: 'POST', headers: { Host: 'foreign.example', 'Content-Type': 'application/sdp' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end('v=0');
    });
    assert.equal(foreignHost, 403);
    assert.equal((await fetch(`${base}/workspace/voice`, { method: 'POST', headers, body: 'x'.repeat(65537) })).status, 413);
    assert.equal(calls, 0);
    const failed = await fetch(`${base}/workspace/voice`, { method: 'POST', headers, body: 'v=0' });
    assert.equal(failed.status, 502); assert.equal(calls, 1);
    const result = await failed.text();
    assert(!result.includes('secret-upstream-key')); assert(!result.includes(backend)); assert(!result.includes('private'));
  } finally { await close(proxy); await close(upstream); }
});

test('voice relay refuses remote backends and redirects without making an upstream API call', async () => {
  const destination = createServer((req, res) => { req.resume(); res.writeHead(302, { Location: 'https://remote.example/voice' }).end(); });
  const redirect = await listen(destination);
  try {
    for (const target of ['https://remote.example', 'http://user:secret@127.0.0.1:1', 'http://127.0.0.1:1/private', redirect]) {
      const server = createServer(async (req, res) => { await handleWorkspaceVoiceHttp(req, res, target); });
      const base = await listen(server);
      try {
        const response = await fetch(`${base}/workspace/voice`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/sdp' }, body: 'v=0' });
        assert.equal(response.status, 502);
        assert(!(await response.text()).includes(target));
      } finally { await close(server); }
    }
  } finally { await close(destination); }
});
