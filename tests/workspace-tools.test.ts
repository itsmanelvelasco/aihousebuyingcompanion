import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerWorkspaceTools, handleWorkspaceHttp } from '../apps/mcp-server/workspace-tools.ts';
import type { WorkspaceConfig } from '../apps/mcp-server/workspace-tools.ts';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { createStore } from '../apps/profile-api/store.ts';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
async function connect(config?: WorkspaceConfig) {
  const server = new McpServer({ name: 'workspace-test', version: '1' });
  registerWorkspaceTools(server, '<!doctype html><title>Workspace</title>', config);
  const client = new Client({ name: 'workspace-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { server, client };
}

test('React workspace MCP adapter persists reviewed profiles/inputs/bank data without model-facing raw records or credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relocat-workspace-'));
  await createStore(root).create('user-a', {
    details: { schemaVersion: 1, synthetic: true, id: 'user-a', name: 'Fictional household' },
    preferences: { schemaVersion: 1, synthetic: true },
    'bank-account': { schemaVersion: 1, synthetic: true, currency: 'EUR' },
  });
  const api = createProfileApi(root, 'server-only-token');
  const baseUrl = await listen(api);
  const { server, client } = await connect({ baseUrl, token: 'server-only-token' });
  const call = (path: string, method = 'GET', body?: unknown) => client.callTool({ name: 'workspace_request', arguments: { path, method, ...(body === undefined ? {} : { body }) } });
  try {
    const tools = await client.listTools();
    const open = tools.tools.find(tool => tool.name === 'open_input_workspace')!;
    assert.equal((open._meta?.ui as { resourceUri: string }).resourceUri, 'ui://relocat/input-workspace-v1.html');
    const operation = tools.tools.find(tool => tool.name === 'workspace_request')!;
    assert.deepEqual((operation._meta?.ui as { visibility: string[] }).visibility, ['app']);
    assert.equal(operation._meta?.['openai/widgetAccessible'], true);
    const rendered = await client.callTool({ name: 'open_input_workspace', arguments: { userId: 'user-a' } });
    assert.deepEqual(rendered.structuredContent, { userId: 'user-a', configured: true, synthetic: true });
    const resource = await client.readResource({ uri: 'ui://relocat/input-workspace-v1.html' });
    assert.match(String(resource.contents[0].mimeType), /profile=mcp-app/);
    const list = await call('/users');
    assert.deepEqual(list._meta?.workspace, { users: ['user-a'] });
    assert.equal(list.structuredContent, undefined);
    assert(!JSON.stringify(list.content).includes('user-a'));
    const preferences = { schemaVersion: 1, synthetic: true, minimumBedrooms: 3 };
    assert(!((await call('/users/user-a/preferences', 'PUT', preferences)).isError));
    assert.deepEqual((await call('/users/user-a/preferences'))._meta?.workspace, preferences);
    const input = { id: 'interview-1', source: 'interview', observedAt: '2026-11-21T12:00:00Z', confirmed: false, synthetic: true, data: { household: { size: 3 } } };
    assert(!((await call('/users/user-a/inputs', 'POST', { inputs: [input] })).isError));
    assert.equal(((await call('/users/user-a/inputs'))._meta?.workspace as { inputs: unknown[] }).inputs.length, 1);
    const account = { id: 'account-a', name: 'Fictional account', currency: 'EUR', openingBalanceCents: 0, openingDate: '2026-11-01', synthetic: true };
    assert(!((await call('/users/user-a/bank/accounts', 'POST', account)).isError));
    assert.equal(((await call('/users/user-a/bank/accounts?asOf=2026-11-21'))._meta?.workspace as { accounts: unknown[] }).accounts.length, 1);
    assert(!((await call('/users/user-a/bank/runtime', 'POST', { enabled: false })).isError));
    const events = await call('/users/user-a/bank/events?after=0&limit=2');
    assert.ok(events._meta?.workspace);
    const invalid = await call('/users/user-a/preferences', 'PUT', { synthetic: false });
    assert.equal(invalid.isError, true);
    assert(!JSON.stringify(invalid).includes('server-only-token'));
    assert(!JSON.stringify(invalid).includes(baseUrl));
    assert(!JSON.stringify(list).includes('server-only-token'));
  } finally {
    await client.close(); await server.close(); await close(api);
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace adapter rejects unsafe origins/routes/queries and sanitizes redirect, upstream and unconfigured failures', async () => {
  let calls = 0;
  const api = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer secret-token');
    assert.equal(req.headers.cookie, undefined);
    if (req.url === '/users/redirect') { res.writeHead(302, { Location: 'https://should-not-connect.example' }).end(); return; }
    if (req.url === '/users/failure') { res.writeHead(500).end('secret-token upstream URL https://private.example'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ token: 'secret-token', nested: { apiKey: 'private-key', note: 'secret-token never leaves' } }));
  });
  const baseUrl = await listen(api);
  const { client, server } = await connect({ baseUrl, token: 'secret-token' });
  try {
    for (const path of ['https://private.example/users', '//private.example/users', '/users/../users', '/users/user-a%2fdetails', '/users/user-a\\details', '/users?token=private', '/users/user-a/bank/transactions?limit=501', '/users/user-a/bank/events?after=-1', '/users/user-a/bank/events?limit=2&limit=3', '/users/user-a/bank/transactions?from=2026-02-31']) {
      assert.equal((await client.callTool({ name: 'workspace_request', arguments: { path } })).isError, true, path);
    }
    assert.equal(calls, 0);
    for (const path of ['/users/redirect', '/users/failure']) {
      const result = await client.callTool({ name: 'workspace_request', arguments: { path } });
      assert.equal(result.isError, true);
      assert(!JSON.stringify(result).includes('secret-token'));
      assert(!JSON.stringify(result).includes('private.example'));
    }
    const clean = await client.callTool({ name: 'workspace_request', arguments: { path: '/users' } });
    assert(!JSON.stringify(clean).includes('secret-token'));
    assert(!JSON.stringify(clean).includes('private-key'));
  } finally { await client.close(); await server.close(); await close(api); }
  for (const config of [undefined, { baseUrl: 'http://remote.example', token: 'secret-token' }, { baseUrl: 'https://u:p@remote.example', token: 'secret-token' }]) {
    const { client, server } = await connect(config);
    try {
      const opened = await client.callTool({ name: 'open_input_workspace', arguments: {} });
      assert.equal((opened.structuredContent as { configured: boolean }).configured, false);
      assert.equal((await client.callTool({ name: 'workspace_request', arguments: { path: '/users' } })).isError, true);
    } finally { await client.close(); await server.close(); }
  }
});

test('workspace local preview blocks foreign Host/Origin, unexpected methods and oversized bodies', async () => {
  const preview = createServer(async (req, res) => { if (!await handleWorkspaceHttp(req, res)) res.writeHead(404).end(); });
  const base = await listen(preview);
  const body = JSON.stringify({ path: '/users' });
  try {
    const ordinary = await fetch(`${base}/workspace/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body });
    assert.equal(ordinary.status, 200); assert.equal((await ordinary.json()).isError, true);
    assert.equal((await fetch(`${base}/workspace/api`)).status, 405);
    assert.equal((await fetch(`${base}/workspace/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body })).status, 403);
    assert.equal((await fetch(`${base}/workspace/api`, { method: 'POST', body })).status, 415);
    assert.equal((await fetch(`${base}/workspace/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(262145) })).status, 413);
    assert.equal((await fetch(`${base}/workspace/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      request(`${base}/workspace/api`, { method: 'POST', headers: { Host: 'foreign.example', 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end(body);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`${base}/unrelated`)).status, 404);
  } finally { await close(preview); }
});
