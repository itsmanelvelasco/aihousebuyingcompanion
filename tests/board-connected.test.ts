import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { profileResult } from '../packages/contracts/places.ts';
import { startApp } from './support/app.ts';

test('the public demo board shows the fictional persona’s bank feed read-only, next to the municipality tools', async t => {
  const server = await startApp();
  const { origin, db } = server;
  const client = new Client({ name: 'demo-board-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const toolNames = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of [
    'recommend_towns',
    'recommend_towns_for_profile',
    'get_applicable_incentives',
    'open_demo',
    'update_demo',
    'get_bank_updates',
    'get_demo_bank_updates',
    'get_demo_person',
  ])
    assert(toolNames.includes(name), name);
  const town = await client.callTool({ name: 'get_town_profile', arguments: { municipalityCode: '252206' } });
  assert(!town.isError, JSON.stringify(town.content));
  const profile = profileResult.parse(town.structuredContent);
  assert.equal(profile.travelEstimates.length, 6);
  assert(profile.travelEstimates.some(estimate => estimate.destinationId === 'lleida' && estimate.publicTransport));

  // The operator's demo feed gives user-001 a ledger; the board only ever reads it.
  const admin = { Authorization: 'Bearer admin-test-token', 'Content-Type': 'application/json' };
  const seeded = await fetch(`${origin}/api/users/user-001/bank/demo`, { method: 'POST', headers: admin, body: '{}' });
  assert.equal(seeded.status, 201);

  const open = await client.callTool({ name: 'open_demo', arguments: {} });
  assert(!open.isError, JSON.stringify(open.content));
  const first = open.structuredContent as Record<string, unknown>;
  const runId = first.runId;
  const connection = first.connection as Record<string, unknown>;
  assert.deepEqual(
    [connection.mode, connection.readOnly, connection.userId, connection.synthetic],
    ['public_demo', true, 'user-001', true],
  );
  assert(Number(connection.ledgerRevision) >= 1);
  assert.ok(connection.summary);
  assert.equal((first.townScreening as Record<string, unknown>).completeHomeMatch, false);

  const inputsBefore = db.all('SELECT * FROM input_records');
  const update = await client.callTool({
    name: 'update_demo',
    arguments: {
      runId,
      action: 'answer_batch',
      answers: { town: 'Manresa', bedrooms: 2, household: 3, income: 2900, spending: 2180, savings: 18400 },
    },
  });
  assert(!update.isError, JSON.stringify(update.content));
  assert.equal(((update.structuredContent as Record<string, unknown>).answers as Record<string, unknown>).income, 2900);
  // The answers live in the run only: the stored persona is exactly as it was.
  assert.deepEqual(db.all('SELECT * FROM input_records'), inputsBefore);
  const context = await (await fetch(`${origin}/api/users/user-001/context`, { headers: admin })).json();
  assert.equal(context.inputCount, 0);
  assert.equal(context.resolved.data.finance.monthlyIncomeCents, 290_000, 'the fixture value, not the typed one');

  // New movements from the feed reach the board without anybody writing through it.
  const revision = Number(connection.ledgerRevision);
  await server.app.profiles.bankRuntime.tick('user-001');
  const refreshed = await client.callTool({ name: 'update_demo', arguments: { runId, action: 'refresh_data' } });
  const later = (refreshed.structuredContent as Record<string, unknown>).connection as Record<string, unknown>;
  assert(Number(later.ledgerRevision) > revision);
  for (const action of ['start_bank_runtime', 'stop_bank_runtime'])
    assert((await client.callTool({ name: 'update_demo', arguments: { runId, action } })).isError, action);

  const bank = await client.callTool({ name: 'update_demo', arguments: { runId, action: 'sample_bank' } });
  assert(!bank.isError, JSON.stringify(bank.content));
  assert.equal(((bank.structuredContent as Record<string, unknown>).bank as Record<string, unknown>).savings, 18400);

  const response = await fetch(`${origin}/preview/state?run=${runId}`);
  const serialized = await response.text();
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert(!serialized.includes('admin-test-token'));
  assert(!serialized.includes('"transactions":'));
  assert(!serialized.includes('profileContext'));

  // The other personas map to their own fictional person.
  const marc = await client.callTool({ name: 'open_demo', arguments: { runId, persona: 'progress' } });
  assert.equal(
    ((marc.structuredContent as Record<string, unknown>).connection as Record<string, unknown>).userId,
    'user-002',
  );
});
