import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadWorkspacePage, registerWorkspace, workspaceResult, workspaceUri } from '../apps/mcp-server/workspace.ts';
import { createToolClient, describeFailure, httpCallTool, ToolError } from '../apps/web/client.ts';
import { fixtureCallTool } from '../apps/web/fixtures/client.ts';
import { fixtureNoSavings, fixturePlan } from '../apps/web/fixtures/plan.ts';
import {
  formatAgo,
  formatDate,
  formatDuration,
  formatDurationShort,
  formatEuros,
  formatMonthsSaved,
  safeHref,
} from '../apps/web/format.ts';
import { launchFromQuery, parseLaunch, workspaceLaunch } from '../apps/web/launch.ts';
import {
  applyHabitOverrides,
  benefitSummary,
  benefitView,
  effectiveOverrides,
  habitCounted,
  habitMonthlyEffectCents,
  indicatorViews,
  lastCompleteMonths,
  longestTimeline,
  planHeadline,
  planNotes,
  timelineSteps,
} from '../apps/web/view-model.ts';
import { planInput, planResult } from '../packages/contracts/planner.ts';

function workspaceServer() {
  const server = new McpServer({ name: 'relocat-test', version: '1.0.0' });
  registerWorkspace(server, loadWorkspacePage() ?? '<!doctype html><title>not built</title>');
  return server;
}

test('the workspace page inlines its bundle and styles and loads nothing from the network', () => {
  const page = loadWorkspacePage();
  assert.ok(page, 'run `npm run build` first: apps/web/dist/workspace.js is missing');
  assert.match(page, /<div id="root"><\/div>/);
  assert.doesNotMatch(page, /<!-- WIDGET -->|\/\* STYLES \*\//);
  assert.match(page, /<script>[\s\S]{50000,}<\/script>/);
  assert.match(page, /--rc-paper: light-dark\(/);
  assert.match(page, /prefers-reduced-motion/);
  assert.doesNotMatch(page, /<script[^>]+src=|<link\b|@import|url\(\s*["']?https?:/i);
  // Exactly one script and one style element survive inlining.
  assert.equal(page.match(/<\/script>/g)?.length, 1);
  assert.equal(page.match(/<\/style>/g)?.length, 1);
});

test('the workspace resource and show_workspace are discoverable and the launch parses in the widget', async () => {
  const server = workspaceServer();
  const client = new Client({ name: 'workspace-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    assert.equal(workspaceUri, 'ui://relocat/workspace-v1.html');
    const { resources } = await client.listResources();
    assert.ok(resources.some(resource => resource.uri === workspaceUri));
    const { contents } = await client.readResource({ uri: workspaceUri });
    assert.equal(contents[0].mimeType, RESOURCE_MIME_TYPE);
    assert.deepEqual((contents[0]._meta as any).ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.match(String((contents[0] as any).text), /<div id="root">/);

    const { tools } = await client.listTools();
    const tool = tools.find(candidate => candidate.name === 'show_workspace');
    assert.ok(tool);
    assert.equal((tool._meta as any).ui.resourceUri, workspaceUri);
    assert.equal(tool.annotations?.readOnlyHint, true);

    const opened = await client.callTool({
      name: 'show_workspace',
      arguments: { userId: 'user-001', municipalityCodes: ['250404', '080312', '250404'] },
    });
    assert.ok(!opened.isError);
    const launch = workspaceLaunch.parse(opened.structuredContent);
    assert.deepEqual(launch, { userId: 'user-001', municipalityCodes: ['250404', '080312'] });
    assert.deepEqual(workspaceResult.parse(opened.structuredContent), launch);

    const bare = await client.callTool({ name: 'show_workspace', arguments: {} });
    assert.deepEqual(workspaceLaunch.parse(bare.structuredContent), { userId: null, municipalityCodes: [] });

    const invalid = await client.callTool({ name: 'show_workspace', arguments: { municipalityCodes: ['25'] } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('the standalone client reaches tools with one stateless JSON-RPC call to /mcp', async () => {
  const http = createServer(async (request, response) => {
    const server = workspaceServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    await transport.handleRequest(request, response);
    await server.close();
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const call = httpCallTool(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  try {
    const result = await call('show_workspace', { userId: 'user-002' });
    assert.deepEqual(parseLaunch(result.structuredContent), { userId: 'user-002', municipalityCodes: [] });
    // A tool the server does not have is an explicit, typed failure.
    await assert.rejects(
      createToolClient(call).plan({ userId: 'user-002', municipalityCodes: ['250404'], assumptions }),
      {
        name: 'ToolError',
        kind: 'unavailable',
      },
    );
  } finally {
    http.close();
  }
});

const assumptions = { includeProposedHabits: false, includeUnverifiedBenefits: false };

test('the fixture matches the planner contract', () => {
  assert.deepEqual(planResult.parse(fixturePlan), fixturePlan);
  assert.deepEqual(planResult.parse(fixtureNoSavings), fixtureNoSavings);
  const finite = fixturePlan.plans.flatMap(plan => plan.withPlaceBenefits?.months ?? []);
  assert.deepEqual(
    finite,
    [...finite].sort((x, y) => x - y),
  );
  assert.equal(fixturePlan.plans.at(-1)?.withPlaceBenefits, null);
  for (const plan of fixturePlan.plans) {
    for (const benefit of plan.benefits) {
      if (benefit.counted) assert.notEqual(benefit.amountCents, null);
    }
    if (plan.baseline?.months != null && plan.withPlaceBenefits?.months != null)
      assert.equal(plan.monthsSaved, plan.baseline.months - plan.withPlaceBenefits.months);
  }
});

test('the tool client parses plans, sends valid inputs and never falls back to sample data', async () => {
  const sent: Record<string, unknown>[] = [];
  const fixture = fixtureCallTool('1', 0);
  const client = createToolClient((name, args) => {
    sent.push({ name, ...args });
    return fixture(name, args);
  });
  const codes = fixturePlan.plans.map(plan => plan.place.municipalityCode);
  const byUser = await client.plan({ userId: 'user-001', municipalityCodes: codes, assumptions });
  assert.equal(byUser.plans.length, 3);
  const edited = applyHabitOverrides(byUser.person, { 'monthly-rail-pass': true });
  const whatIf = await client.plan({ person: edited, municipalityCodes: codes, assumptions });
  assert.equal(whatIf.person.habits.find(habit => habit.id === 'monthly-rail-pass')?.status, 'active');
  for (const { name, ...input } of sent) {
    assert.equal(name, 'plan_home_savings');
    planInput.parse(input);
  }

  const updates = await client.bankUpdates('user-001', 0);
  assert.equal(updates.synthetic, true);
  assert.equal(updates.nextCursor, 2);
  assert.equal((await client.bankSummary('user-001', lastCompleteMonths('2026-11-22', 3))).monthCount, 3);
  assert.equal((await client.municipalities()).length, 3);

  const missing = createToolClient(fixtureCallTool('plan-error', 0));
  await assert.rejects(
    missing.plan({ userId: 'user-001', municipalityCodes: codes, assumptions }),
    (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.kind, 'unavailable');
      assert.match(error.message, /plan_home_savings/);
      return true;
    },
  );
  const wrongShape = createToolClient(async () => ({ structuredContent: { plans: 'soon' } }));
  await assert.rejects(wrongShape.plan({ userId: 'user-001', municipalityCodes: codes, assumptions }), {
    kind: 'invalid',
  });
  const thrown = createToolClient(async () => {
    throw new Error('MCP error -32001: Request timed out');
  });
  await assert.rejects(thrown.bankRuntime('user-001'), { kind: 'failed', message: 'Request timed out' });
  assert.equal(describeFailure('get_bank_updates', '').message, 'The get_bank_updates tool returned an error.');
});

test('launch arguments are read defensively', () => {
  assert.deepEqual(parseLaunch(undefined), { userId: null, municipalityCodes: [] });
  assert.deepEqual(parseLaunch({ userId: 'user-001', municipalityCodes: ['bad'] }), {
    userId: null,
    municipalityCodes: [],
  });
  assert.deepEqual(launchFromQuery('?user=user-003&towns=250404,x,250404,080312'), {
    userId: 'user-003',
    municipalityCodes: ['250404', '080312'],
  });
  assert.deepEqual(launchFromQuery(''), { userId: null, municipalityCodes: [] });
});

test('durations read as years and months, and a null timeline is never a number', () => {
  assert.equal(formatDuration(1), '1 month');
  assert.equal(formatDuration(11), '11 months');
  assert.equal(formatDuration(12), '1 year');
  assert.equal(formatDuration(30), '2 years 6 months');
  assert.equal(formatDuration(0), 'Already reached');
  assert.equal(formatDuration(null), 'No finite timeline');
  assert.equal(formatDurationShort(50), '4 y 2 mo');
  assert.equal(formatDurationShort(null), 'No timeline');
  for (const text of [formatDuration(null), formatDurationShort(null), formatMonthsSaved(null)])
    assert.doesNotMatch(text, /\d|∞/);
  assert.equal(formatMonthsSaved(5), '5 months sooner');
  assert.equal(formatMonthsSaved(1), '1 month sooner');
  assert.equal(formatMonthsSaved(0), 'No change');
  assert.equal(formatMonthsSaved(-2), '2 months later');
  assert.equal(formatMonthsSaved(null), 'Not comparable');
});

test('money, dates and ages are formatted without inventing values', () => {
  assert.equal(formatEuros(1_850_000), '€18,500');
  assert.equal(formatEuros(0), '€0');
  assert.equal(formatEuros(null), 'Unknown');
  assert.equal(formatDate('2026-11-22'), '22 Nov 2026');
  assert.equal(formatDate('2025'), '2025');
  assert.equal(formatDate(null), 'Unknown');
  assert.equal(formatAgo(1000, 3000), 'just now');
  assert.equal(formatAgo(0, 42_000), '42 s ago');
  assert.equal(formatAgo(0, 5 * 60_000), '5 min ago');
  assert.equal(formatAgo(0, 3 * 3_600_000), '3 h ago');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('https://www.idescat.cat/emex/?id=250404'), 'https://www.idescat.cat/emex/?id=250404');
});

test('timeline steps keep finite, unbounded and missing timelines apart', () => {
  const [ager, , camarasa] = fixturePlan.plans;
  const scale = longestTimeline(fixturePlan.plans);
  assert.equal(scale, 28);
  const steps = timelineSteps(ager, scale);
  assert.deepEqual(
    steps.map(step => [step.key, step.state, step.text, step.savedText]),
    [
      ['baseline', 'finite', '2 years', null],
      ['withHabits', 'finite', '1 year 8 months', '4 months sooner'],
      ['withPlaceBenefits', 'finite', '1 year 3 months', '5 months sooner'],
    ],
  );
  assert.ok(steps[0].barPercent! > steps[1].barPercent! && steps[1].barPercent! > steps[2].barPercent!);
  assert.equal(timelineSteps(fixturePlan.plans[1], scale)[0].barPercent, 100);
  assert.equal(planHeadline(ager).headline, 'Ready in 1 year 3 months');

  // Savings of zero or less: the timeline exists but has no end. No bar, no number.
  const unbounded = timelineSteps(fixtureNoSavings.plans[0], longestTimeline(fixtureNoSavings.plans));
  for (const step of unbounded) {
    assert.equal(step.state, 'none');
    assert.equal(step.months, null);
    assert.equal(step.barPercent, null);
    assert.equal(step.text, 'No finite timeline');
    assert.equal(step.savedText, null);
  }
  assert.equal(longestTimeline(fixtureNoSavings.plans), 0);
  assert.deepEqual(
    [planHeadline(fixtureNoSavings.plans[0]).tone, planHeadline(fixtureNoSavings.plans[0]).savedTotalText],
    ['none', 'Not comparable'],
  );

  // No estimate at all is a third state, not the same as an unbounded timeline.
  for (const step of timelineSteps(camarasa, scale)) {
    assert.equal(step.state, 'not_estimated');
    assert.equal(step.text, 'Not estimated');
    assert.equal(step.barPercent, null);
    assert.equal(step.upfrontCashCents, null);
  }
  assert.equal(planHeadline(camarasa).tone, 'unknown');
  assert.equal(planHeadline(camarasa).priceText, 'Purchase price unknown');

  // Zero months is "reached", and a one-month bar is still visible.
  const reached = { ...ager, withPlaceBenefits: { ...ager.withPlaceBenefits!, months: 0 } };
  assert.equal(timelineSteps(reached, scale)[2].state, 'reached');
  assert.equal(timelineSteps(reached, scale)[2].barPercent, null);
  assert.equal(planHeadline(reached).tone, 'reached');
  const short = { ...ager, baseline: { ...ager.baseline!, months: 1 } };
  assert.equal(timelineSteps(short, 400)[0].barPercent, 2);
});

test('a benefit that is not counted or not verified never reads as confirmed', () => {
  const [counted, unverified, closed, ineligible] = fixturePlan.plans[0].benefits.map(benefitView);
  assert.deepEqual(
    [counted.tone, counted.confirmed, counted.countedLabel, counted.amountLabel],
    ['counted', true, 'Counted in plan', '€4,725'],
  );
  assert.deepEqual(
    [unverified.tone, unverified.confirmed, unverified.countedLabel, unverified.amountLabel],
    ['unverified', false, 'Not counted', '€1,200 per year'],
  );
  assert.equal(unverified.eligibilityLabel, 'Eligibility needs verification');
  assert.deepEqual([closed.callLabel, closed.amountLabel], ['Call closed', 'Amount not computed']);
  assert.deepEqual([ineligible.tone, ineligible.confirmed], ['ineligible', false]);

  // Counted only because unverified benefits were switched on: counted, still flagged.
  const forced = benefitView({ ...fixturePlan.plans[0].benefits[1], counted: true });
  assert.deepEqual(
    [forced.tone, forced.confirmed, forced.countedLabel],
    ['counted_unverified', false, 'Counted, unverified'],
  );
  // Eligible but left out, for example because the call is closed.
  const leftOut = benefitView({ ...fixturePlan.plans[0].benefits[0], counted: false });
  assert.deepEqual([leftOut.tone, leftOut.countedLabel], ['not_counted', 'Not counted']);
  assert.equal(benefitSummary(fixturePlan.plans[0].benefits), '1 of 4 benefits counted');
  assert.equal(benefitSummary([]), 'No benefits listed for this place');
});

test('habit switches produce the person sent to the planner', () => {
  const { person } = fixturePlan;
  const [cook, , rail, insurance] = person.habits;
  assert.equal(habitCounted(cook, false), true);
  assert.equal(habitCounted(rail, false), false);
  assert.equal(habitCounted(rail, true), true);
  assert.equal(habitCounted(insurance, true), false);
  assert.equal(habitCounted(cook, false, { [cook.id]: false }), false);

  const edited = applyHabitOverrides(person, { [cook.id]: false, [rail.id]: true });
  assert.deepEqual(
    edited.habits.map(habit => habit.status),
    ['paused', 'active', 'active', 'paused'],
  );
  assert.equal(person.habits[0].status, 'active', 'the stored person is not mutated');
  planInput.parse({ person: edited, municipalityCodes: ['250404'] });

  // Overrides that restate the stored status are dropped, so the plan is read by user id again.
  assert.deepEqual(effectiveOverrides(person, { [cook.id]: true, [insurance.id]: false }, false), {});
  assert.deepEqual(effectiveOverrides(person, { [rail.id]: true }, true), {});
  assert.deepEqual(effectiveOverrides(person, { [rail.id]: true }, false), { [rail.id]: true });
  assert.equal(habitMonthlyEffectCents(fixturePlan), 15_500);
  assert.equal(habitMonthlyEffectCents({ ...fixturePlan, plans: [fixturePlan.plans[2]] }), null);
});

test('indicators, notes and bank periods keep unknowns and sources', () => {
  const ager = indicatorViews(fixturePlan.plans[0].place);
  assert.deepEqual(
    ager.map(item => item.value),
    ['612', '3.8 per km²', '9.6%', '€1,050 per m²', 'Unknown'],
  );
  assert.equal(ager[3].geography, 'comarca');
  assert.ok(ager.slice(0, 4).every(item => item.sourceUrl && item.observedAt));
  assert.deepEqual([ager[4].known, ager[4].sourceUrl], [false, null]);

  const notes = planNotes(fixturePlan);
  assert.equal(notes.limitations.length, 3);
  assert.equal(notes.assumptions.length, 4, 'assumptions shared by two places are listed once');
  assert.deepEqual(
    notes.dataMissing.map(group => group.place),
    ['Àger', 'Camarasa'],
  );

  assert.deepEqual(lastCompleteMonths('2026-11-22', 3), { from: '2026-08-01', to: '2026-10-31' });
  assert.deepEqual(lastCompleteMonths('2026-01-05', 3), { from: '2025-10-01', to: '2025-12-31' });
  assert.deepEqual(lastCompleteMonths('2024-03-31', 1), { from: '2024-02-01', to: '2024-02-29' });
});
