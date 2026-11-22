import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBankTools } from '../apps/mcp-server/bank-tools.ts';
import type { Caller, PersonReader, PersonWriter } from '../apps/mcp-server/identity.ts';
import { analyzeTransactions } from '../packages/finance/cashflow.ts';

/** A person handle whose store answers carry fields the tools must never pass on. */
function person(userId: string, options: { synthetic: boolean; broken?: 'throws' | 'invalid' }): PersonWriter {
  const calls: string[] = [];
  const guard = () => {
    if (options.broken === 'throws') throw new Error('secret-token upstream stack at https://internal.example');
  };
  const reader: PersonReader & { calls: string[] } = {
    userId,
    synthetic: options.synthetic,
    calls,
    context: async () => null,
    inputs: async () => ({ inputs: [] }),
    habits: async () => ({}),
    bankBalanceCents: async () => null,
    async bankUpdates(after, limit) {
      calls.push(`updates:${after}:${limit}`);
      guard();
      if (options.broken === 'invalid') return { synthetic: false };
      return {
        synthetic: options.synthetic,
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
      };
    },
    async bankRuntime() {
      guard();
      return {
        synthetic: true,
        userId,
        enabled: true,
        intervalMs: 5000,
        lastTickAt: null,
        lastError: 'secret-token upstream stack',
        tickCount: 2,
      };
    },
    async bankSummary({ from, to }) {
      guard();
      return {
        ...analyzeTransactions([], from, to),
        synthetic: options.synthetic,
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
      };
    },
  };
  return Object.assign(reader, { saveInputs: async () => ({ inserted: 0, duplicates: 0 }) });
}

async function connect(caller: Caller) {
  const server = new McpServer({ name: 'bank-test', version: '1' });
  registerBankTools(server, caller);
  const client = new Client({ name: 'test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test('bank tools read the caller’s own ledger, take no user id and never pass on store internals', async () => {
  const me = person('p-me', { synthetic: false });
  const demoPersona = person('user-001', { synthetic: true });
  const { client, close } = await connect({
    me,
    scopes: ['person:read'],
    demo: { ids: ['user-001'], open: id => (id === 'user-001' ? demoPersona : null) },
  });
  try {
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), [
      'get_bank_runtime',
      'get_bank_summary',
      'get_bank_updates',
      'get_demo_bank_runtime',
      'get_demo_bank_summary',
      'get_demo_bank_updates',
    ]);
    assert(list.tools.every(tool => tool.annotations?.readOnlyHint));
    for (const tool of list.tools)
      assert(!('userId' in (tool.inputSchema.properties ?? {})), `${tool.name} takes a userId`);

    const updates = await client.callTool({ name: 'get_bank_updates', arguments: { after: 2 } });
    assert(!updates.isError);
    assert.equal((updates.structuredContent as Record<string, unknown>)?.nextCursor, 3);
    assert(!JSON.stringify(updates).includes('secret-token'));
    assert.deepEqual((me as unknown as { calls: string[] }).calls, ['updates:2:50']);
    assert.equal(
      (updates.structuredContent as Record<string, unknown>)?.synthetic,
      false,
      'the flag is passed through',
    );
    assert.match(JSON.stringify(updates.content), /real bank data/);
    assert.doesNotMatch(JSON.stringify(updates.content), /synthetic demo data/);

    // A user id from the model is not an argument: the call is refused and reads nothing.
    const named = await client.callTool({ name: 'get_bank_updates', arguments: { userId: 'user-001' } });
    assert(named.isError);
    assert.equal((me as unknown as { calls: string[] }).calls.length, 1);

    const demoUpdates = await client.callTool({ name: 'get_demo_bank_updates', arguments: { demoId: 'user-001' } });
    assert(!demoUpdates.isError);
    assert.equal((demoUpdates.structuredContent as Record<string, unknown>)?.synthetic, true);
    assert.match(JSON.stringify(demoUpdates.content), /synthetic demo data/);
    const outside = await client.callTool({ name: 'get_demo_bank_updates', arguments: { demoId: 'p-me' } });
    assert(outside.isError, 'only the allowlisted demo ids can be named');

    const runtime = await client.callTool({ name: 'get_bank_runtime', arguments: {} });
    assert(!runtime.isError);
    assert.equal(
      (runtime.structuredContent as Record<string, unknown>)?.lastError,
      'Background bank feed needs attention.',
    );
    const summary = await client.callTool({
      name: 'get_bank_summary',
      arguments: { from: '2026-10-01', to: '2026-10-31' },
    });
    assert(!summary.isError);
    assert.equal((summary.structuredContent as Record<string, unknown>)?.dataStatus, 'unknown');
    for (const leaked of ['secret-token', 'private-merchant', 'private-account'])
      assert(!JSON.stringify(summary).includes(leaked), leaked);
    assert(!('transactions' in (summary.structuredContent as Record<string, unknown>)));
    const badRange = await client.callTool({
      name: 'get_bank_summary',
      arguments: { from: '2026-10-02', to: '2026-10-31' },
    });
    assert(badRange.isError);
  } finally {
    await close();
  }
});

test('bank tools turn store failures and unexpected shapes into one plain error', async () => {
  for (const broken of ['throws', 'invalid'] as const) {
    const { client, close } = await connect({
      me: person('p-me', { synthetic: false, broken }),
      scopes: ['person:read'],
      demo: null,
    });
    try {
      const result = await client.callTool({ name: 'get_bank_updates', arguments: {} });
      assert(result.isError);
      assert(!/secret-token|internal\.example|stack/.test(JSON.stringify(result)));
    } finally {
      await close();
    }
  }
});

test('without a signed-in person the personal bank tools ask for sign-in and the demo tools are absent', async () => {
  const { client, close } = await connect({
    me: null,
    scopes: [],
    demo: null,
    challenge: () => 'Bearer resource_metadata="https://relo.example/.well-known/oauth-protected-resource"',
  });
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, ['get_bank_runtime', 'get_bank_summary', 'get_bank_updates']);
    const result = await client.callTool({ name: 'get_bank_runtime', arguments: {} });
    assert(result.isError);
    assert.match(JSON.stringify(result.content), /Sign in to ReloCat/);
    assert.match(String((result._meta?.['mcp/www_authenticate'] as string[] | undefined)?.[0]), /resource_metadata=/);
  } finally {
    await close();
  }
  // A credential without the read scope is told which permission is missing.
  const limited = await connect({
    me: person('p-me', { synthetic: false }),
    scopes: [],
    demo: null,
    challenge: () => 'Bearer x',
  });
  try {
    const result = await limited.client.callTool({ name: 'get_bank_runtime', arguments: {} });
    assert(result.isError);
    assert.match(JSON.stringify(result.content), /person:read/);
  } finally {
    await limited.close();
  }
});
