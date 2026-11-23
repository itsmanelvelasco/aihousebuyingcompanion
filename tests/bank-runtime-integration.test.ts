import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHabitStore } from '../apps/habits-agent/store.ts';
import { createHttpServer } from '../apps/mcp-server/http.ts';
import { createProfileApiHandler } from '../apps/profile-api/server.ts';
import { createPeople } from '../apps/server/people.ts';
import { open } from '../packages/db/database.ts';
import { loadData } from '../packages/places/data.ts';
import { createStore } from '../packages/profiles/store.ts';

test('real bank runtime changes are readable across MCP connections without raw records or credentials', async () => {
  const db = open(':memory:');
  const document = { schemaVersion: 1, synthetic: true };
  await createStore(db).create('demo', {
    details: { ...document, id: 'demo' },
    preferences: document,
    'bank-account': {
      ...document,
      snapshotDate: '2026-11-21',
      balanceCents: 1800000,
      monthlyIncomeCents: 290000,
      monthlyExpensesCents: 200000,
      debtPaymentsCents: 18000,
    },
  });
  const token = 'integration-secret-token';
  const api = createProfileApiHandler(db, token);
  // The tools reach the stores in-process through a handle bound to the caller's own person.
  const people = createPeople({
    ...api.people,
    habits: createHabitStore(db).read,
    // Nothing here saves a habit.
    saveHabit: async () => {
      throw new Error('Habits are not saved in this test');
    },
  });
  const { snapshot, policies } = loadData();
  const mcp = createHttpServer(snapshot, policies, {
    caller: { me: people.own('demo'), scopes: ['person:read'], demo: null },
  });
  mcp.listen(0, '127.0.0.1');
  await once(mcp, 'listening');
  const mcpAddress = mcp.address();
  assert(mcpAddress && typeof mcpAddress === 'object');
  const endpoint = new URL(`http://127.0.0.1:${mcpAddress.port}/mcp`);
  let client = new Client({ name: 'runtime-integration', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const tools = await client.listTools();
    assert(tools.tools.some(tool => tool.name === 'get_bank_updates'));
    const before = await client.callTool({ name: 'get_bank_updates', arguments: {} });
    assert(!before.isError);
    assert.equal((before.structuredContent as Record<string, unknown>).latestRevision, 0);
    // Naming a user is not possible: the argument does not exist.
    assert((await client.callTool({ name: 'get_bank_updates', arguments: { userId: 'demo' } })).isError);
    const tick = await api.bankRuntime.tick('demo');
    assert.equal(tick.inserted, 1);
    const update = await client.callTool({ name: 'get_bank_updates', arguments: { after: 0 } });
    assert(!update.isError);
    const data = update.structuredContent as { nextCursor: number; latestRevision: number; events: unknown[] };
    assert(data.events.length >= 2);
    assert(data.nextCursor > 0);
    assert(!JSON.stringify(update).includes(token));
    assert(!JSON.stringify(update).includes('description'));
    const summary = await client.callTool({
      name: 'get_bank_summary',
      arguments: { from: '2026-08-01', to: '2026-10-31' },
    });
    assert(!summary.isError);
    const aggregates = summary.structuredContent as Record<string, unknown>;
    assert.equal(aggregates.incomeCents, 870000);
    assert.equal(aggregates.averageMonthlySavingsCents, 72000);
    assert(!('transactions' in aggregates));
    assert(!JSON.stringify(summary).includes(token));
    const status = await client.callTool({ name: 'get_bank_runtime', arguments: {} });
    assert(!status.isError);
    assert.equal((status.structuredContent as Record<string, unknown>).tickCount, 1);
    await client.close();
    client = new Client({ name: 'runtime-reconnect', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const replay = await client.callTool({ name: 'get_bank_updates', arguments: { after: 0 } });
    assert.deepEqual(replay.structuredContent, update.structuredContent);
    const after = await client.callTool({
      name: 'get_bank_updates',
      arguments: { after: data.nextCursor },
    });
    assert(!after.isError);
    assert.deepEqual((after.structuredContent as Record<string, unknown>).events, []);
  } finally {
    await client.close();
    await api.bankRuntime.close();
    await new Promise<void>((resolve, reject) => mcp.close(error => (error ? reject(error) : resolve())));
    db.close();
  }
});
