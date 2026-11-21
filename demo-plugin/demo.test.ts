import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDemo, updateDemo } from './demo.ts';

test('onboarding validates the active step and handles a zero monthly surplus', () => {
  const { runId } = openDemo({ persona: 'onboarding' });
  assert.throws(() => updateDemo({ runId, action: 'answer', question: 'savings', answer: 1 }), /current question/);
  updateDemo({ runId, action: 'answer', question: 'town', answer: 'Manresa' });
  assert.throws(() => updateDemo({ runId, action: 'answer', question: 'bedrooms', answer: 0 }), /whole number/);
  for (const [question, answer] of [
    ['bedrooms', 2], ['household', 3], ['employment', 'Full-time employee'],
    ['income', 2000], ['spending', 2000], ['savings', 3000],
  ] as const) updateDemo({ runId, action: 'answer', question, answer });
  const view = openDemo({ runId });
  assert.ok('plan' in view);
  assert.equal(view.plan?.months, null);
  const next = updateDemo({ runId, action: 'sample_bank' });
  assert.ok('plan' in next);
  assert.deepEqual(next.plan, { saved: 18400, target: 54000, monthly: 720, months: 50 });
});

test('MCP transport serves the widget and supports each of the four scenarios', async t => {
  const proc = spawn(process.execPath, ['server.ts'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0' } });
  t.after(() => proc.kill());
  const [line] = await once(proc.stdout, 'data');
  const port = /localhost:(\d+)\/preview/.exec(line.toString())?.[1];
  assert.ok(port, 'The test server reports its bound port.');
  const origin = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'arrela-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin));
  await client.connect(transport);
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  const ui = tools.find(tool => tool.name === 'open_demo')?._meta?.ui as { resourceUri?: string } | undefined;
  assert.equal(ui?.resourceUri, 'ui://arrela/journey.html');
  const resource = await client.readResource({ uri: 'ui://arrela/journey.html' });
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
  const update = (action: string, args = {}) => call('update_demo', { runId, action, ...args });
  const open = (persona: string) => call('open_demo', { runId, persona });

  await open('progress');
  const progress = await update('join_quest');
  assert.equal((progress.progress as { xp: number }).xp, 450);
  assert.equal(((await update('join_quest')).progress as { xp: number }).xp, 450);

  const unread = await open('shortcuts');
  assert.equal(unread.unread, 5);
  assert.deepEqual(unread.inbox, []);
  const read = await update('read_inbox');
  assert.equal(read.unread, 0);
  assert.equal((read.inbox as unknown[]).length, 5);
  assert.equal((await update('choose_shortcut', { opportunity: 'rule' })).chosen, 'rule');

  await open('payoff');
  assert.deepEqual((await update('final_payment')).payoff, { original: 165000, remaining: 0, percent: 100, paid: true });
  await update('restart_persona');
  assert.equal(((await open('payoff')).payoff as { remaining: number }).remaining, 620);
  assert.equal((await open('shortcuts')).chosen, 'rule');
  await update('restart_all');
  assert.equal((await open('shortcuts')).unread, 5);
  assert.equal(((await open('progress')).progress as { xp: number }).xp, 350);
  assert.notEqual((await call('open_demo')).runId, runId);
});
