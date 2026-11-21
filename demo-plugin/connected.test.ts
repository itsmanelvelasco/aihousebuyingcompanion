import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createStore } from '../apps/profile-api/store.ts';
import { createProfileApi } from '../apps/profile-api/server.ts';
import { profileResult } from '../packages/contracts/places.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function assertProgress(view: unknown, saved: number, total: number) {
  const board = view as Record<string, unknown>;
  assert.deepEqual([board.answeredBasic, board.totalQuestions], [saved, total]);
}

test('connected board persists interview inputs, reads runtime bank data and serves municipality tools together', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relocat-plugin-'));
  const doc = { schemaVersion: 1, synthetic: true };
  for (let n = 1; n <= 4; n++) {
    const id = `user-00${n}`;
    await createStore(root).create(id, { details: { ...doc, id, householdSize: 3 }, preferences: { ...doc, goal: 'buy_primary_home', housingBudgetCents: 13000000, minimumBedrooms: 2, schoolStages: ['eso'], maxCommuteMinutes: 120 }, 'bank-account': { ...doc, snapshotDate: '2026-11-21', balanceCents: 1840000, monthlyIncomeCents: 290000, monthlyExpensesCents: 208000, debtPaymentsCents: 10000 } });
  }
  const api = createProfileApi(root, 'test-token');
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const address = api.address(); assert(address && typeof address !== 'string');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const proc = spawn(process.execPath, ['server.ts'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', PROFILE_API_URL: apiUrl, PROFILE_API_TOKEN: 'test-token' } });
  t.after(async () => { proc.kill(); await new Promise<void>(resolve => api.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const [line] = await once(proc.stdout, 'data');
  const port = /localhost:(\d+)\/preview/.exec(String(line))?.[1]; assert(port);
  const client = new Client({ name: 'connected-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  t.after(() => client.close());
  const toolNames = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['recommend_towns', 'recommend_towns_for_profile', 'get_applicable_incentives', 'open_demo', 'update_demo', 'get_bank_updates']) assert(toolNames.includes(name), name);
  const town = await client.callTool({ name: 'get_town_profile', arguments: { municipalityCode: '252206' } });
  assert(!town.isError, JSON.stringify(town.content));
  const profile = profileResult.parse(town.structuredContent);
  assert.equal(profile.travelEstimates.length, 6);
  assert(profile.travelEstimates.some(estimate => estimate.destinationId === 'lleida' && estimate.publicTransport));
  const open = await client.callTool({ name: 'open_demo', arguments: {} });
  assert(!open.isError, JSON.stringify(open.content));
  const first = open.structuredContent as Record<string, unknown>;
  const runId = first.runId;
  assert.equal((first.connection as Record<string, unknown>).userId, 'user-001');
  assertProgress(first, 8, 16);
  const update = await client.callTool({ name: 'update_demo', arguments: { runId, action: 'answer_batch', answers: { budget: 130000, floorArea: 85, destinationCode: '251207', maxCommuteMinutes: 120, schoolStages: ['eso'], schoolMode: 'rail', allowComarcaEstimate: true, upfrontTarget: 54000, spending: 2180, spendingIncludesDebt: true } } });
  assert(!update.isError, JSON.stringify(update.content));
  assertProgress(update.structuredContent, 13, 16);
  const context = await (await fetch(`${apiUrl}/users/user-001/context`, { headers: { Authorization: 'Bearer test-token' } })).json();
  assert.equal(context.resolved.data.housing.homeSizeM2, 85);
  assert.equal(context.resolved.data.finance.monthlyExpensesCents, 218000);
  assert.equal(context.resolved.data.finance.debtPaymentsCents, 0);
  const refined = await client.callTool({ name: 'update_demo', arguments: { runId, action: 'answer_batch', answers: {
    homeSize: 86, currentTown: 'Barcelona', dependants: 1, commuteTo: 'Lleida', commuteTime: 90,
    schoolStages: 'Primary and ESO', transport: 'Train, no car', spending: 2000, debtPayments: 100, reserve: 5000, cashTarget: 55000
  } } });
  assert(!refined.isError, JSON.stringify(refined.content));
  // Floor area, commute time and cash target have canonical and legacy names.
  // Only the newly supplied reserve advances this count.
  assertProgress(refined.structuredContent, 14, 16);
  const refinedContext = await (await fetch(`${apiUrl}/users/user-001/context`, { headers: { Authorization: 'Bearer test-token' } })).json();
  assert.equal(refinedContext.resolved.data.housing.homeSizeM2, 86);
  assert.equal(refinedContext.resolved.data.finance.monthlyExpensesCents, 200000);
  assert.equal(refinedContext.resolved.data.finance.debtPaymentsCents, 10000);
  assert.equal(refinedContext.resolved.data.finance.emergencyReserveCents, 500000);
  assert.equal(refinedContext.resolved.data.transport.destinationCode, '251207');
  assert.deepEqual(refinedContext.resolved.data.school.stages, ['eso', 'primary']);
  const bank = await client.callTool({ name: 'update_demo', arguments: { runId, action: 'sample_bank' } });
  assert(!bank.isError, JSON.stringify(bank.content));
  const bankView = bank.structuredContent as Record<string, unknown>;
  assert.equal((bankView.bank as Record<string, unknown>).savings, 18400);
  assert.ok((bankView.connection as Record<string, unknown>).summary);
  assert.equal((bankView.townScreening as Record<string, unknown>).completeHomeMatch, false);
  const response = await fetch(`http://127.0.0.1:${port}/preview/state?run=${runId}`);
  const serialized = await response.text();
  assert(!serialized.includes('test-token'));
  assert(!serialized.includes('"transactions":'));

  const voice = await client.callTool({ name: 'save_laia_interview', arguments: {
    runId, expectedRevision: bankView.revision, currency: 'EUR', source: null,
    profile: { householdSize: 3, homeType: 'Flat', location: 'Manresa', target: 54000, saved: 24000, monthly: 700 },
  } });
  assert(!voice.isError, JSON.stringify(voice.content));
  const savedBoard = await (await fetch(`http://127.0.0.1:${port}/preview/state?run=${runId}`)).json();
  assert.equal(savedBoard.firstScenario.baselineMonths, 43);
  assert.equal(savedBoard.interview.profile.homeType, 'Flat');
  assert.equal(savedBoard.plan, null);
  assertProgress(savedBoard, 15, 16);
  assert.deepEqual(savedBoard.group.questions.map((question: { id: string }) => question.id), ['employment']);
  const completed = await client.callTool({ name: 'update_demo', arguments: { runId, action: 'answer_batch',
    answers: { employment: 'Full time', emergencyReserve: 0, spending: 0, allowComarcaEstimate: false, schoolStages: [] },
  } });
  assert(!completed.isError, JSON.stringify(completed.content));
  const complete = completed.structuredContent as Record<string, unknown>;
  // With no school stages the earlier rail-mode answer is no longer required.
  assertProgress(complete, 15, 15);
  assert.equal(complete.group, null);
  assert.equal((complete.firstScenario as { baselineMonths: number }).baselineMonths, 43);
  const separate = await client.callTool({ name: 'open_demo', arguments: { newRun: true, persona: 'onboarding' } });
  assert.equal((separate.structuredContent as Record<string, unknown>).interview, null);
});
