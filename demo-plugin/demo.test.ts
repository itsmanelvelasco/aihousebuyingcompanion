import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDemo, updateDemo } from './demo.ts';

test('onboarding batches answers atomically and separates the upfront and payoff milestones', () => {
  const { runId } = openDemo({ persona: 'onboarding' });
  assert.throws(() => updateDemo({
    runId, action: 'answer_batch', answers: { town: 'Manresa', bedrooms: 0 },
  }), /whole number/);
  const blank = openDemo({ runId });
  assert.ok('answers' in blank);
  assert.deepEqual(blank.answers, {});
  const details = updateDemo({
    runId, action: 'answer_batch', answers: { town: 'Manresa', bedrooms: 2, household: 3, employment: 'Full-time employee' },
  });
  assert.ok('group' in details);
  assert.deepEqual(details.group?.questions.map(question => question.id), ['income', 'spending', 'savings']);
  updateDemo({ runId, action: 'answer_batch', answers: { income: 2000, spending: 2000, savings: 3000 } });
  const view = openDemo({ runId });
  assert.ok('plan' in view);
  assert.equal(view.plan?.upfrontMonths, null);
  assert.equal(view.plan?.debtFreeMonths, null);
  const next = updateDemo({ runId, action: 'sample_bank' });
  assert.ok('plan' in next);
  assert.deepEqual(next.plan, { saved: 18400, target: 54000, monthly: 720, upfrontMonths: 50, termMonths: 240, debtFreeMonths: 290 });
  const refined = updateDemo({ runId, action: 'answer_batch', answers: {
    budget: 160000, homeSize: 85, schoolStages: 'ESO', commuteTime: 45, debtPayments: 100, reserve: 5000,
  } });
  assert.ok('answers' in refined);
  assert.equal(refined.answers.homeSize, 85);
  assert.deepEqual(refined.plan, { saved: 13400, target: 48000, monthly: 620, upfrontMonths: 56, termMonths: 240, debtFreeMonths: 296 });
  assert.throws(() => updateDemo({ runId, action: 'answer_batch', answers: { cashTarget: 0 } }), /whole number/);
});

test('MCP transport serves the widget and supports each of the four scenarios', async t => {
  const proc = spawn(process.execPath, ['server.ts'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', PUBLIC_ORIGIN: 'https://relocat.example' } });
  t.after(() => proc.kill());
  const [line] = await once(proc.stdout, 'data');
  const port = /localhost:(\d+)\/preview/.exec(line.toString())?.[1];
  assert.ok(port, 'The test server reports its bound port.');
  const origin = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'relo-cat-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin));
  await client.connect(transport);
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  const ui = tools.find(tool => tool.name === 'open_demo')?._meta?.ui as { resourceUri?: string } | undefined;
  assert.equal(ui?.resourceUri, 'ui://relocat/journey-v6.html');
  const resource = await client.readResource({ uri: 'ui://relocat/journey-v6.html' });
  const [widget] = resource.contents;
  assert.equal(widget.mimeType, 'text/html;profile=mcp-app');
  assert.ok('text' in widget);
  assert.match(widget.text, /Demo personas/);
  const preview = await fetch(origin + '/preview');
  assert.equal(preview.status, 200);
  await preview.arrayBuffer();

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result.content));
    return result.structuredContent as Record<string, unknown>;
  }

  const first = await call('open_demo');
  const runId = first.runId;
  assert.equal(first.persona, 'onboarding');
  assert.equal(first.boardUrl, 'https://relocat.example/preview');
  assert.equal(first.sharedBoard, true);
  const reopened = await call('open_demo');
  assert.equal(reopened.runId, runId);
  const update = (action: string, args = {}) => call('update_demo', { runId, action, ...args });
  const open = (persona: string) => call('open_demo', { runId, persona });

  const home = await update('answer_batch', { answers: { town: 'Manresa', bedrooms: 2, household: 3 } });
  const live = await fetch(origin + '/preview/state');
  assert.equal(live.headers.get('Access-Control-Allow-Origin'), '*');
  const synced = await live.json();
  assert.deepEqual(synced.answers, home.answers);
  assert.equal(synced.revision, home.revision);
  assert.equal(synced.runId, runId);
  assert.equal((await fetch(origin + '/preview/state?run=invalid')).status, 400);

  await open('progress');
  const progress = await update('join_quest');
  assert.equal((progress.progress as { xp: number; rank: number }).xp, 450);
  assert.equal((progress.progress as { rank: number }).rank, 2);
  assert.match(String(progress.message), /Level up/);
  assert.equal(((await update('join_quest')).progress as { xp: number }).xp, 450);
  const accepted = await update('adopt_habit', { habit: 'coffee' });
  assert.equal((accepted.progress as { estimate: number }).estimate, 12);
  const checked = await update('complete_habit', { habit: 'coffee' });
  assert.equal((checked.progress as { xp: number }).xp, 550);
  assert.equal((checked.progress as { estimate: number }).estimate, 22);
  assert.equal((checked.progress as { saved: number }).saved, 32400);
  assert.equal(((await update('complete_habit', { habit: 'coffee' })).progress as { xp: number }).xp, 550);

  const unread = await open('shortcuts');
  assert.equal(unread.unread, 5);
  assert.deepEqual(unread.inbox, []);
  const read = await update('read_inbox');
  assert.equal(read.unread, 0);
  assert.equal(read.pastMonths, 24);
  const inbox = read.inbox as { id: string; upfrontMonths: number; debtFreeMonths: number; waypoint: { label: string; offset: number } }[];
  assert.equal(inbox.length, 5);
  assert.equal(inbox.find(item => item.id === 'rule')?.upfrontMonths, 0);
  assert.equal(inbox.find(item => item.id === 'rule')?.debtFreeMonths, 240);
  assert.deepEqual(inbox.find(item => item.id === 'job')?.waypoint, { label: 'Change jobs', offset: 4 });
  assert.deepEqual(inbox.slice(0, 3).map(item => item.id), ['rule', 'listing', 'job']);
  const previewed = await update('preview_shortcut', { opportunity: 'listing' });
  assert.equal(previewed.previewed, 'listing');
  assert.equal(previewed.chosen, null);
  assert.equal((await update('choose_shortcut')).chosen, 'listing');
  await update('preview_shortcut', { opportunity: 'job' });
  const kept = await update('keep_route');
  assert.equal(kept.chosen, 'listing');
  assert.equal(kept.previewed, null);

  const debtFree = { original: 165000, remaining: 0, otherDebt: 0, percent: 100, paid: true };
  const finish = await open('payoff');
  assert.deepEqual(finish.payoff, debtFree);
  assert.equal(finish.credits, null);
  assert.match(String(finish.message), /Want to see the credits/);
  assert.ok((await update('show_credits')).credits);
  assert.equal((await update('hide_credits')).credits, null);
  await update('show_credits');
  assert.equal(((await update('replay_payment')).payoff as { remaining: number }).remaining, 620);
  const replay = await update('final_payment');
  assert.deepEqual(replay.payoff, debtFree);
  assert.equal(replay.credits, null);
  await update('replay_payment');
  assert.deepEqual((await update('restart_persona')).payoff, debtFree);
  assert.equal((await open('shortcuts')).chosen, 'listing');
  await update('restart_all');
  assert.equal((await open('shortcuts')).unread, 5);
  assert.equal(((await open('progress')).progress as { xp: number }).xp, 350);
  const separate = await call('open_demo', { newRun: true, persona: 'payoff' });
  assert.notEqual(separate.runId, runId);
  assert.equal(separate.sharedBoard, false);
  const stage = await call('open_demo');
  assert.equal(stage.runId, runId);
  assert.equal(stage.persona, 'progress');
});
