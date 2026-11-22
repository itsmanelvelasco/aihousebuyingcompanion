import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBankTools } from '../apps/mcp-server/bank-tools.ts';
import { analyzeTransactions } from '../packages/finance/cashflow.ts';

test('MCP bank bridge polls authenticated aggregates and sanitizes upstream failures and extra fields', async () => {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const api = createServer((request, response) => {
    seen.push({ path: request.url ?? '', authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.includes('/bad/')) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: 'secret-token upstream stack' }));
      return;
    }
    if (request.url?.includes('/invalid/')) {
      response.end(JSON.stringify({ synthetic: false }));
      return;
    }
    if (request.url?.includes('/events'))
      response.end(
        JSON.stringify({
          synthetic: true,
          events: [
            {
              sequence: 3,
              occurredAt: '2026-11-21T12:00:00Z',
              type: 'bank.updated',
              accountCount: 1,
              transactionCount: 8,
              token: 'secret-token',
            },
          ],
          latestRevision: 3,
          nextCursor: 3,
          requiresRefresh: false,
          hasMore: false,
          token: 'secret-token',
        }),
      );
    else if (request.url?.includes('/runtime'))
      response.end(
        JSON.stringify({
          synthetic: true,
          userId: 'user-001',
          enabled: true,
          intervalMs: 5000,
          lastTickAt: null,
          lastError: 'secret-token upstream stack',
          tickCount: 2,
        }),
      );
    else
      response.end(
        JSON.stringify({
          ...analyzeTransactions([], '2026-10-01', '2026-10-31'),
          recurringExpenses: [
            {
              category: 'subscriptions',
              observedMonths: ['2026-09', '2026-10'],
              occurrenceCount: 2,
              averagePaymentCents: 1000,
              status: 'candidate_needs_confirmation',
              description: 'private-merchant',
              accountId: 'private-account',
            },
          ],
          transactions: [{ secret: true }],
          token: 'secret-token',
        }),
      );
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  assert(address && typeof address === 'object');
  const server = new McpServer({ name: 'bank-test', version: '1' });
  registerBankTools(server, { baseUrl: `http://127.0.0.1:${address.port}`, token: 'secret-token' });
  const client = new Client({ name: 'test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), [
      'get_bank_runtime',
      'get_bank_summary',
      'get_bank_updates',
    ]);
    assert(list.tools.every(tool => tool.annotations?.readOnlyHint));
    const updates = await client.callTool({ name: 'get_bank_updates', arguments: { userId: 'user-001', after: 2 } });
    assert(!updates.isError);
    assert.equal((updates.structuredContent as Record<string, unknown>)?.nextCursor, 3);
    assert(!JSON.stringify(updates).includes('secret-token'));
    assert(seen[0].path.endsWith('after=2&limit=50'));
    assert.equal(seen[0].authorization, 'Bearer secret-token');
    const runtime = await client.callTool({ name: 'get_bank_runtime', arguments: { userId: 'user-001' } });
    assert(!runtime.isError);
    assert.equal(
      (runtime.structuredContent as Record<string, unknown>)?.lastError,
      'Background bank feed needs attention.',
    );
    const summary = await client.callTool({
      name: 'get_bank_summary',
      arguments: { userId: 'user-001', from: '2026-10-01', to: '2026-10-31' },
    });
    assert(!summary.isError);
    assert.equal((summary.structuredContent as Record<string, unknown>)?.dataStatus, 'unknown');
    assert(!JSON.stringify(summary).includes('secret-token'));
    assert(!('transactions' in (summary.structuredContent as Record<string, unknown>)));
    assert(!JSON.stringify(summary).includes('private-merchant'));
    assert(!JSON.stringify(summary).includes('private-account'));
    for (const userId of ['bad', 'invalid']) {
      const result = await client.callTool({ name: 'get_bank_updates', arguments: { userId } });
      assert(result.isError);
      assert(!JSON.stringify(result).includes('secret-token'));
    }
    const badRange = await client.callTool({
      name: 'get_bank_summary',
      arguments: { userId: 'user-001', from: '2026-10-02', to: '2026-10-31' },
    });
    assert(badRange.isError);
  } finally {
    await client.close();
    await server.close();
    await new Promise<void>((resolve, reject) => api.close(error => (error ? reject(error) : resolve())));
  }
});

test('bank bridge rejects credentials in URLs and insecure non-loopback origins', () => {
  const server = new McpServer({ name: 'bank-config-test', version: '1' });
  for (const baseUrl of [
    'http://example.com',
    'https://name:secret@example.com',
    'https://example.com/path',
    'https://example.com?token=x',
  ]) {
    assert.throws(() => registerBankTools(server, { baseUrl, token: 'test' }));
  }
});
