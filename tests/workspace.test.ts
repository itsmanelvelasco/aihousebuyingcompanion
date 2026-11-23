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
import { createHabitsHandler } from '../apps/habits-agent/server.ts';
import type { Caller } from '../apps/mcp-server/identity.ts';
import { registerPlannerTools } from '../apps/mcp-server/planner-tools.ts';
import { loadWorkspacePage, registerWorkspace, workspaceResult, workspaceUri } from '../apps/mcp-server/workspace.ts';
import type { HabitDraft, ToolResult } from '../apps/web/client.ts';
import {
  createToolClient,
  describeFailure,
  httpCallTool,
  isNoPlaceRefusal,
  newHabitId,
  saveHabitArguments,
  ToolError,
} from '../apps/web/client.ts';
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
import {
  habitCategories,
  isWhatIfHabit,
  readHabitForm,
  whatIfHabit,
  withWhatIfHabits,
} from '../apps/web/habit-form.ts';
import {
  demoDefaultPlaces,
  emptyLaunch,
  launchRequestFromQuery,
  openingPlaces,
  parseLaunch,
  subjectOf,
  workspaceLaunch,
} from '../apps/web/launch.ts';
import { habitFormMessages } from '../apps/web/messages/habit-form.messages.ts';
import { placesMessages } from '../apps/web/messages/places.messages.ts';
import { suggestMessages } from '../apps/web/messages/suggest.messages.ts';
import type { SchoolStage } from '../apps/web/suggest.ts';
import { noChoices, parseFloorArea, suggestionView, suggestRequest } from '../apps/web/suggest.ts';
import {
  addedTransactions,
  applyHabitOverrides,
  baselineMonthlySavingsCents,
  benefitSummary,
  benefitView,
  conflictSources,
  effectiveOverrides,
  factSourceLabel,
  habitMonthlyEffectCents,
  habitPlanView,
  habitSwitchedOn,
  indicatorViews,
  lastCompleteMonths,
  longestTimeline,
  planChanges,
  planHeadline,
  planNotes,
  timelineSteps,
} from '../apps/web/view-model.ts';
import { safeId } from '../packages/contracts/ids.ts';
import { recommendationInput } from '../packages/contracts/places.ts';
import type { Person } from '../packages/contracts/planner.ts';
import { habitCategory, planInput, planResult } from '../packages/contracts/planner.ts';
import { open } from '../packages/db/database.ts';
import { translator } from '../packages/i18n/messages.ts';
import { buildPlace } from '../packages/model/place.ts';
import { loadData } from '../packages/places/data.ts';
import { recommendTowns } from '../packages/places/recommend.ts';
import { planForPlaces } from '../packages/planner/plan.ts';
import { createStore } from '../packages/profiles/store.ts';

const demoIds = ['user-001', 'user-002'];
const demoSubject = { kind: 'demo', demoId: 'user-001' } as const;

/** The workspace tool for an anonymous caller of a server whose public demo offers two personas. */
function workspaceServer(signedIn = false) {
  const server = new McpServer({ name: 'relocat-test', version: '1.0.0' });
  const persona = { userId: 'x', synthetic: true } as never;
  registerWorkspace(server, loadWorkspacePage() ?? '<!doctype html><title>not built</title>', {
    me: signedIn ? persona : null,
    scopes: signedIn ? ['person:read', 'person:write'] : [],
    demo: { ids: demoIds, open: id => (demoIds.includes(id) ? persona : null) },
  });
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

    assert.ok(!('userId' in ((tool.inputSchema.properties ?? {}) as object)), 'the tool takes no user id');

    const opened = await client.callTool({
      name: 'show_workspace',
      arguments: { demoId: 'user-001', municipalityCodes: ['250404', '080312', '250404'] },
    });
    assert.ok(!opened.isError);
    const launch = workspaceLaunch.parse(opened.structuredContent);
    assert.deepEqual(launch, {
      subject: 'demo',
      demoId: 'user-001',
      signedIn: false,
      demoIds,
      municipalityCodes: ['250404', '080312'],
    });
    assert.deepEqual(workspaceResult.parse(opened.structuredContent), launch);
    assert.deepEqual(subjectOf(launch), demoSubject);

    // Nobody signed in and no persona asked for: the workspace opens with no person.
    const bare = await client.callTool({ name: 'show_workspace', arguments: {} });
    assert.deepEqual(workspaceLaunch.parse(bare.structuredContent), { ...emptyLaunch, demoIds });
    // A user id, or a persona outside the allowlist, is not something the tool accepts.
    for (const args of [{ userId: 'user-001' }, { demoId: 'user-003' }, { demoId: 'p-someone' }])
      assert.equal((await client.callTool({ name: 'show_workspace', arguments: args })).isError, true);

    const invalid = await client.callTool({ name: 'show_workspace', arguments: { municipalityCodes: ['25'] } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('show_workspace answers "me" for a signed-in caller and never names who that is', async () => {
  const server = workspaceServer(true);
  const client = new Client({ name: 'workspace-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const mine = await client.callTool({ name: 'show_workspace', arguments: {} });
    const launch = workspaceLaunch.parse(mine.structuredContent);
    assert.deepEqual([launch.subject, launch.demoId, launch.signedIn], ['me', null, true]);
    assert.deepEqual(subjectOf(launch), { kind: 'me' });
    assert.ok(!JSON.stringify(mine).includes('"x"'), 'the person id is not in the launch');
    const demo = await client.callTool({ name: 'show_workspace', arguments: { demoId: 'user-002' } });
    const asked = workspaceLaunch.parse(demo.structuredContent);
    assert.deepEqual([asked.subject, asked.demoId, asked.signedIn], ['demo', 'user-002', true]);
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
    const result = await call('show_workspace', { demoId: 'user-002' });
    assert.deepEqual(parseLaunch(result.structuredContent).demoId, 'user-002');
    assert.equal((await createToolClient(call).launch({ municipalityCodes: ['250404'] })).subject, 'none');
    // A tool the server does not have is an explicit, typed failure.
    await assert.rejects(
      createToolClient(call).plan({ subject: demoSubject, municipalityCodes: ['250404'], assumptions }),
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
  const byUser = await client.plan({ subject: demoSubject, municipalityCodes: codes, assumptions });
  assert.equal(byUser.plans.length, 3);
  const edited = applyHabitOverrides(byUser.person, { 'monthly-rail-pass': true });
  const whatIf = await client.plan({ person: edited, municipalityCodes: codes, assumptions });
  assert.equal(whatIf.person.habits.find(habit => habit.id === 'monthly-rail-pass')?.status, 'active');
  await client.plan({ subject: { kind: 'me' }, municipalityCodes: codes, assumptions });
  // A stored person is named by `me` or by a demo persona; a user id is never sent.
  assert.deepEqual(
    sent.map(({ name, userId, demoId, me, person }) => [name, userId, demoId, me, person !== undefined]),
    [
      ['plan_home_savings', undefined, 'user-001', undefined, false],
      ['plan_home_savings', undefined, undefined, undefined, true],
      ['plan_home_savings', undefined, undefined, true, false],
    ],
  );

  sent.length = 0;
  const updates = await client.bankUpdates(demoSubject, 0);
  assert.equal(updates.synthetic, true);
  assert.equal(updates.nextCursor, 2);
  assert.equal((await client.bankSummary(demoSubject, lastCompleteMonths('2026-11-22', 3))).monthCount, 3);
  await client.bankRuntime({ kind: 'me' });
  // The demo persona goes through the read-only demo tools, the signed-in person through the personal ones.
  assert.deepEqual(
    sent.map(({ name, demoId, userId }) => [name, demoId, userId]),
    [
      ['get_demo_bank_updates', 'user-001', undefined],
      ['get_demo_bank_summary', 'user-001', undefined],
      ['get_bank_runtime', undefined, undefined],
    ],
  );
  assert.equal((await client.municipalities()).length, 3);

  const missing = createToolClient(fixtureCallTool('plan-error', 0));
  await assert.rejects(
    missing.plan({ subject: demoSubject, municipalityCodes: codes, assumptions }),
    (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.kind, 'unavailable');
      assert.match(error.message, /plan_home_savings/);
      return true;
    },
  );
  const wrongShape = createToolClient(async () => ({ structuredContent: { plans: 'soon' } }));
  await assert.rejects(wrongShape.plan({ subject: demoSubject, municipalityCodes: codes, assumptions }), {
    kind: 'invalid',
  });
  const thrown = createToolClient(async () => {
    throw new Error('MCP error -32001: Request timed out');
  });
  await assert.rejects(thrown.bankRuntime(demoSubject), { kind: 'failed', message: 'Request timed out' });
  // A personal tool without a session says "sign in", which the page turns into a sign-in prompt.
  const anonymous = createToolClient(async () => ({
    isError: true,
    content: [{ type: 'text', text: 'Sign in to ReloCat to use your own profile.' }],
    _meta: { 'mcp/www_authenticate': ['Bearer resource_metadata="https://relo.example/x"'] },
  }));
  await assert.rejects(anonymous.plan({ subject: { kind: 'me' }, municipalityCodes: codes, assumptions }), {
    kind: 'signin',
  });
  assert.equal(describeFailure('get_bank_updates', '').message, 'The get_bank_updates tool returned an error.');
});

test('launch arguments are read defensively', () => {
  assert.deepEqual(parseLaunch(undefined), emptyLaunch);
  // The shape of an older server (a user id) is not a launch: the workspace opens with nobody.
  assert.deepEqual(parseLaunch({ userId: 'user-001', municipalityCodes: ['250404'] }), emptyLaunch);
  assert.deepEqual(
    parseLaunch({ ...emptyLaunch, subject: 'demo', demoId: 'user-001', municipalityCodes: ['bad'] }),
    emptyLaunch,
  );
  assert.deepEqual(subjectOf({ ...emptyLaunch, subject: 'demo', demoId: null }), { kind: 'none' });
  assert.deepEqual(launchRequestFromQuery('?demo=user-003&towns=250404,x,250404,080312'), {
    demoId: 'user-003',
    municipalityCodes: ['250404', '080312'],
  });
  // The address cannot name a stored person: `user` is ignored, and so is a malformed demo id.
  assert.deepEqual(launchRequestFromQuery('?user=p-123&towns=250404'), { municipalityCodes: ['250404'] });
  assert.deepEqual(launchRequestFromQuery('?demo=../etc'), { municipalityCodes: [] });
  assert.deepEqual(launchRequestFromQuery(''), { municipalityCodes: [] });
});

test('new transactions are the growth of the ledger, not the sum of its sizes', async () => {
  // One new movement on a 15-movement ledger is one new transaction, not sixteen.
  assert.equal(addedTransactions(15, [{ transactionCount: 16 }]), 1);
  assert.equal(
    addedTransactions(15, [{ transactionCount: 16 }, { transactionCount: 17 }, { transactionCount: 19 }]),
    4,
  );
  assert.equal(addedTransactions(15, []), 0);
  assert.equal(addedTransactions(15, [{ transactionCount: 15 }]), 0, 'an edit changes the ledger without adding');
  assert.equal(addedTransactions(15, [{ transactionCount: 12 }]), 0, 'a deletion is not a negative number of new ones');
  assert.equal(addedTransactions(null, [{ transactionCount: 16 }]), null, 'unknown before: say so, do not guess');

  // The fixture speaks the same language as the real feed: sizes after each change.
  const fixture = createToolClient(fixtureCallTool('1', 0));
  const first = await fixture.bankUpdates(demoSubject, 0);
  assert.deepEqual(
    first.events.map(event => event.transactionCount),
    [181, 184],
  );
  let later = first;
  for (let poll = 0; poll < 4 && later.events.length !== 1; poll++) later = await fixture.bankUpdates(demoSubject, 2);
  assert.deepEqual(
    later.events.map(event => event.transactionCount),
    [186],
  );
  assert.equal(addedTransactions(first.events.at(-1)?.transactionCount ?? null, later.events), 2);
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

  // Saving something, but more than 600 months away: no number, and not the "saving nothing" wording.
  const beyond = { ...fixtureNoSavings.plans[0], status: 'beyond_horizon' as const };
  planResult.parse({ ...fixtureNoSavings, plans: [beyond] });
  assert.deepEqual(
    [planHeadline(beyond).tone, planHeadline(beyond).headline, planHeadline(beyond).statusText],
    ['none', 'No finite timeline', 'No timeline: at this rate the upfront cash is more than 50 years away'],
  );
  assert.equal(timelineSteps(beyond, scale)[2].text, 'No finite timeline');

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
    ['unverified', false, 'Not counted', '€1,200 per year, if confirmed'],
  );
  assert.equal(unverified.eligibilityLabel, 'Eligibility needs verification');
  assert.deepEqual([closed.callLabel, closed.amountLabel], ['Call closed', 'Amount not computed']);
  assert.deepEqual([ineligible.tone, ineligible.confirmed], ['ineligible', false]);
  // An ineligible benefit never shows an amount as the person's: the planner sends none, and a
  // nominal figure is worded as what the measure is worth to someone else.
  const youthAid = {
    ...fixturePlan.plans[0].benefits[3],
    kind: 'one_off_cash' as const,
    eligibilityStatus: 'ineligible' as const,
    counted: false,
  };
  assert.equal(
    benefitView({ ...youthAid, amountCents: null, nominalAmountCents: 1_500_000 }).amountLabel,
    'Not eligible (worth up to €15,000 to those who qualify)',
  );
  assert.equal(benefitView({ ...youthAid, amountCents: null }).amountLabel, 'Not eligible: no amount');
  // A result from before the planner cleared the amount is not shown as the person's either.
  assert.doesNotMatch(benefitView({ ...youthAid, amountCents: 1_500_000 }).amountLabel, /^€/);

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
  assert.equal(habitSwitchedOn(cook, false), true);
  assert.equal(habitSwitchedOn(rail, false), false);
  assert.equal(habitSwitchedOn(rail, true), true);
  assert.equal(habitSwitchedOn(insurance, true), false);
  assert.equal(habitSwitchedOn(cook, false, { [cook.id]: false }), false);

  const edited = applyHabitOverrides(person, { [cook.id]: false, [rail.id]: true });
  assert.deepEqual(
    edited.habits.map(habit => habit.status),
    ['paused', 'active', 'active', 'paused'],
  );
  assert.equal(person.habits[0].status, 'active', 'the stored person is not mutated');
  // A habit switched on starts after the observed figures (as of 2026-11-01), so the planner adds it on top.
  assert.deepEqual(
    edited.habits.map(habit => habit.startedOn),
    [undefined, undefined, '2026-11-02', undefined],
  );
  const kept = applyHabitOverrides(person, { [cook.id]: true }).habits[0];
  assert.deepEqual([kept.status, kept.startedOn], ['active', undefined], 'an already active habit keeps its start');
  planInput.parse({ person: edited, municipalityCodes: ['250404'] });

  // Overrides that restate the stored status are dropped, so the plan is read by user id again.
  assert.deepEqual(effectiveOverrides(person, { [cook.id]: true, [insurance.id]: false }, false), {});
  assert.deepEqual(effectiveOverrides(person, { [rail.id]: true }, true), {});
  assert.deepEqual(effectiveOverrides(person, { [rail.id]: true }, false), { [rail.id]: true });
  assert.equal(habitMonthlyEffectCents(fixturePlan), 15_500);
  assert.equal(habitMonthlyEffectCents({ ...fixturePlan, plans: [fixturePlan.plans[2]] }), null);
});

test('a habit reads as counted only when the plan says it counted it', () => {
  const { person } = fixturePlan;
  const [cook, , rail, insurance] = person.habits;
  // The fixture's plan counted the two active habits.
  assert.deepEqual(
    person.habits.map(habit => habitPlanView(habit, fixturePlan, habitSwitchedOn(habit, false)).state),
    ['counted', 'counted', 'off', 'off'],
  );
  assert.deepEqual(
    [habitPlanView(cook, fixturePlan, true).label, habitPlanView(cook, fixturePlan, true).countedMonthlyCents],
    ['Counted in plan', 12_000],
  );
  assert.deepEqual(
    [habitPlanView(rail, fixturePlan, false).label, habitPlanView(insurance, fixturePlan, false).label],
    [null, null],
  );

  // The same stored, active habit when the planner withheld it: figures observed in the bank, start unknown.
  const withheld = {
    habits: [
      {
        habitId: cook.id,
        counted: false,
        countedMonthlyCents: 0,
        reason: 'start_unknown' as const,
        explanation: 'Shown, not counted: your monthly spending comes from bank movements up to 2026-10-31.',
      },
    ],
  };
  const view = habitPlanView(cook, withheld, habitSwitchedOn(cook, false));
  assert.equal(habitSwitchedOn(cook, false), true, 'it is still switched on');
  assert.deepEqual([view.state, view.label, view.countedMonthlyCents], ['withheld', 'Shown, not counted', 0]);
  assert.match(view.explanation ?? '', /bank movements up to 2026-10-31/);

  // A plan that does not say what it did claims nothing: neither counted nor left out.
  for (const silent of [null, undefined, { habits: undefined }, { habits: [] }])
    assert.deepEqual(
      [habitPlanView(cook, silent, true).state, habitPlanView(cook, silent, true).label],
      ['unknown', null],
    );
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

test('the details panel reads what changed from two plans and never does the sums itself', async () => {
  // Same plan twice: nothing changed, so nothing is claimed.
  assert.deepEqual(planChanges(fixturePlan, fixturePlan), []);
  const [first, ...rest] = fixturePlan.plans;
  const benefit = first.benefits.find(item => item.counted);
  assert(benefit && first.withPlaceBenefits, 'the fixture counts a benefit in its first place');
  const before = {
    ...fixturePlan,
    plans: [
      {
        ...first,
        withPlaceBenefits: { ...first.withPlaceBenefits, months: 20 },
        benefits: first.benefits.map(item =>
          item === benefit ? { ...item, counted: false, eligibilityStatus: 'needs_verification' as const } : item,
        ),
      },
      ...rest,
    ],
  };
  // Both timelines are quoted as the planner gave them; the panel does not subtract one from the other.
  assert.deepEqual(planChanges(before, fixturePlan), [
    {
      place: first.place.name,
      lines: [
        `Counted now: ${benefit.title}.`,
        `The wait is now ${formatDuration(first.withPlaceBenefits.months).toLowerCase()}; it was 1 year 8 months.`,
      ],
    },
  ]);
  assert.deepEqual(planChanges(fixturePlan, before)[0].lines[0], `No longer counted: ${benefit.title}.`);
  // A place that was not in the earlier plan has nothing to compare with.
  assert.deepEqual(planChanges({ ...fixturePlan, plans: rest }, { ...fixturePlan, plans: [first] }), []);
  // A timeline that appears, and a status that changes without being counted.
  const noTimeline = {
    ...fixturePlan,
    plans: [{ ...first, withPlaceBenefits: null, baseline: null, withHabits: null }],
  };
  assert.match(
    planChanges(noTimeline, { ...fixturePlan, plans: [first] })[0].lines.at(-1) ?? '',
    /^A timeline can be estimated now: /,
  );
  const other = first.benefits.find(item => !item.counted && item.eligibilityStatus !== 'ineligible');
  assert(other);
  const ruledOut = {
    ...fixturePlan,
    plans: [
      {
        ...first,
        benefits: first.benefits.map(item =>
          item === other ? { ...item, eligibilityStatus: 'ineligible' as const } : item,
        ),
      },
    ],
  };
  assert.deepEqual(planChanges({ ...fixturePlan, plans: [first] }, ruledOut), [
    { place: first.place.name, lines: [`Does not apply to you: ${other.title}.`] },
  ]);

  assert.equal(factSourceLabel('interview'), 'Said in the interview');
  assert.equal(factSourceLabel('what_if'), 'This estimate only, not saved');
  assert.equal(factSourceLabel('somewhere'), 'Source not recorded');
  const candidate = (source: string) => ({ value: 1, text: '1', source, observedAt: '2026-11-01', confirmed: true });
  assert.deepEqual(conflictSources({ candidates: [candidate('manual'), candidate('interview')] }), [
    'interview',
    'manual',
  ]);
  assert.deepEqual(conflictSources({ candidates: [candidate('manual'), candidate('bank')] }), ['manual']);

  // Saving names the source of the answer; the default is "typed in by the person".
  const calls: Record<string, unknown>[] = [];
  const client = createToolClient(async (_name, args) => {
    calls.push(args);
    return { structuredContent: { saved: true, inputId: 'x', inputCount: 1 } };
  });
  await client.saveInputs({ eligibility: { itpBuyerNetTaxBaseEur: null } }, true);
  await client.saveInputs({ eligibility: { primaryResidence: true } }, true, 'interview');
  assert.deepEqual(calls, [
    { data: { eligibility: { itpBuyerNetTaxBaseEur: null } }, confirmed: true, source: 'manual' },
    { data: { eligibility: { primaryResidence: true } }, confirmed: true, source: 'interview' },
  ]);
});

// ----------------------------------------------------------------- languages

/** Intl writes narrow and non-breaking spaces around units; the assertions read them as plain spaces. */
const plain = (text: string | null) => (text ?? '').replace(/\s/g, ' ');

test('with no language stated the workspace prints the English it always printed', () => {
  const [ager] = fixturePlan.plans;
  assert.equal(planHeadline(ager).headline, planHeadline(ager, 'en').headline);
  assert.deepEqual(timelineSteps(ager, 60), timelineSteps(ager, 60, 'en'));
  assert.deepEqual(benefitView(ager.benefits[1]), benefitView(ager.benefits[1], 'en'));
  assert.equal(benefitView(ager.benefits[1]).amountLabel, '€1,200 per year, if confirmed');
  assert.equal(benefitSummary(ager.benefits), '1 of 4 benefits counted');
  assert.equal(
    planHeadline(ager).priceText,
    '€94,500 home, priced from the comarca average price per m² (no municipal figure)',
  );
  assert.deepEqual(
    [formatEuros(null), formatDate(null), formatDuration(null), formatMonthsSaved(null), formatAgo(0, 2 * 86_400_000)],
    ['Unknown', 'Unknown', 'No finite timeline', 'Not comparable', '2 days ago'],
  );
});

test('the view models speak Catalan and Spanish, with figures written as each language writes them', () => {
  const [ager] = fixturePlan.plans;
  const catalan = planHeadline(ager, 'ca');
  assert.equal(catalan.headline, 'A punt d’aquí a 1 any i 3 mesos');
  assert.equal(
    plain(catalan.priceText),
    'Habitatge de 94.500 €, preu segons la mitjana comarcal per m² (sense xifra municipal)',
  );
  assert.equal(catalan.savedTotalText, '9 mesos abans');
  const spanish = planHeadline(ager, 'es');
  assert.equal(spanish.headline, 'A punto dentro de 1 año y 3 meses');
  assert.equal(spanish.statusText, 'Estimado');
  assert.equal(spanish.savedByHabitsText, '4 meses antes');

  assert.deepEqual(
    timelineSteps(ager, 60, 'ca').map(step => [step.label, step.text, step.shortText]),
    [
      ['Base', '2 anys', '2 a'],
      ['Amb hàbits', '1 any i 8 mesos', '1 a 8 m'],
      ['Amb aquest lloc', '1 any i 3 mesos', '1 a 3 m'],
    ],
  );
  assert.equal(timelineSteps(ager, 60, 'es')[2].savedText, '5 meses antes');
  assert.equal(formatMonthsSaved(1, 'ca'), '1 mes abans');
  assert.equal(formatMonthsSaved(-3, 'es'), '3 meses más tarde');
  assert.equal(formatAgo(0, 30_000, 'ca'), 'fa 30 s');
  assert.equal(formatAgo(0, 2 * 86_400_000, 'es'), 'hace 2 días');

  // The honest labels survive translation: counted, unverified and ineligible stay three different things.
  const [counted, unverified, , ineligible] = ager.benefits;
  assert.deepEqual(
    [benefitView(counted, 'ca').countedLabel, benefitView(counted, 'ca').eligibilityLabel],
    ['Comptat al pla', 'Elegible segons les dades aportades'],
  );
  assert.deepEqual(
    [
      benefitView(unverified, 'ca').countedLabel,
      benefitView(unverified, 'ca').eligibilityLabel,
      plain(benefitView(unverified, 'ca').amountLabel),
    ],
    ['No comptat', 'Elegibilitat: cal verificar-ho', '1.200 € l’any, si es confirma'],
  );
  assert.deepEqual(
    [
      benefitView(unverified, 'es').eligibilityLabel,
      plain(benefitView(unverified, 'es').amountLabel),
      benefitView(ineligible, 'es').amountLabel,
    ],
    ['Elegibilidad: hay que verificarlo', '1200 € al año, si se confirma', 'No elegible: sin importe'],
  );
  // The tone and the flags are data, not text: no language changes what is counted or confirmed.
  for (const locale of ['ca', 'es'] as const)
    assert.deepEqual(
      ager.benefits.map(benefit => {
        const view = benefitView(benefit, locale);
        return [view.tone, view.counted, view.confirmed];
      }),
      ager.benefits.map(benefit => {
        const view = benefitView(benefit);
        return [view.tone, view.counted, view.confirmed];
      }),
    );
  assert.equal(benefitSummary(ager.benefits, 'ca'), 'Comptats: 1 de 4 avantatges');
  assert.equal(benefitSummary([], 'es'), 'Ninguna ventaja recogida para este lugar');
  assert.equal(habitPlanView(fixturePlan.person.habits[0], fixturePlan, true, 'es').label, 'Contado en el plan');
  assert.equal(factSourceLabel('bank', 'ca'), 'Observat als moviments bancaris');
  assert.equal(factSourceLabel('somewhere', 'es'), 'Fuente no registrada');
});

test('unknown stays a word in every language, never zero and never a number', () => {
  const [, , camarasa] = fixturePlan.plans;
  const unknown = { en: 'Unknown', ca: 'Desconegut', es: 'Desconocido' } as const;
  const noTimeline = { en: 'No finite timeline', ca: 'Sense termini finit', es: 'Sin plazo finito' } as const;
  const notEstimated = { en: 'Not estimated', ca: 'No estimat', es: 'No estimado' } as const;
  for (const locale of ['en', 'ca', 'es'] as const) {
    assert.equal(formatEuros(null, locale), unknown[locale]);
    assert.equal(formatDate(null, locale), unknown[locale]);
    assert.equal(formatDuration(null, locale), noTimeline[locale]);
    assert.doesNotMatch(formatDurationShort(null, locale), /\d/);
    // A place with no figures: the indicators say unknown, with no source invented.
    const rent = indicatorViews(camarasa.place, locale).find(item => item.key === 'rentEurPerMonth');
    assert.deepEqual([rent?.value, rent?.known, rent?.sourceUrl], [unknown[locale], false, null]);
    // A plan the planner could not estimate: no step shows a number.
    for (const step of timelineSteps(camarasa, 60, locale)) {
      assert.equal(step.text, notEstimated[locale]);
      assert.equal(step.barPercent, null);
    }
    // Savings of zero or less: the headline is words, in the tone of "no end date".
    const none = planHeadline(fixtureNoSavings.plans[0], locale);
    assert.deepEqual([none.tone, none.headline], ['none', noTimeline[locale]]);
    assert.doesNotMatch(none.savedTotalText, /\d/);
  }
  assert.equal(planHeadline(camarasa, 'ca').priceText, 'Preu de compra desconegut');
  assert.equal(planHeadline(camarasa, 'es').headline, 'No hay datos suficientes para estimar');
});

test('what an answer changed is told in the language on screen, in the planner’s own figures', () => {
  const [first, ...rest] = fixturePlan.plans;
  assert(first.withPlaceBenefits, 'the fixture estimates its first place');
  const before = {
    ...fixturePlan,
    plans: [{ ...first, withPlaceBenefits: { ...first.withPlaceBenefits, months: 20 } }, ...rest],
  };
  assert.deepEqual(planChanges(before, fixturePlan, 'ca'), [
    { place: first.place.name, lines: ['Termini ara: 1 any i 3 mesos; abans: 1 any i 8 mesos.'] },
  ]);
  assert.deepEqual(planChanges(before, fixturePlan, 'es'), [
    { place: first.place.name, lines: ['Plazo ahora: 1 año y 3 meses; antes: 1 año y 8 meses.'] },
  ]);
});

test('the tool client states its language to the planner and words its own failures in it', async () => {
  const sent: Record<string, unknown>[] = [];
  const fixture = fixtureCallTool('1', 0);
  const record = (name: string, args: Record<string, unknown>) => {
    sent.push({ name, ...args });
    return fixture(name, args);
  };
  const codes = fixturePlan.plans.map(plan => plan.place.municipalityCode);
  // No language stated: the call is what it always was.
  await createToolClient(record).plan({ subject: demoSubject, municipalityCodes: codes, assumptions });
  assert.equal('locale' in sent[0], false);
  assert.equal(createToolClient(record).locale, 'en');

  const catalan = createToolClient(record, 'ca');
  await catalan.plan({ subject: demoSubject, municipalityCodes: codes, assumptions });
  await catalan.plan({ person: fixturePlan.person, municipalityCodes: codes, assumptions });
  assert.deepEqual(
    sent.slice(1).map(({ name, locale }) => [name, locale]),
    [
      ['plan_home_savings', 'ca'],
      ['plan_home_savings', 'ca'],
    ],
  );
  // Only the tools agreed to take a language get one: the bank tools and the launch stay as they were.
  sent.length = 0;
  await catalan.bankRuntime(demoSubject);
  await catalan.launch({ municipalityCodes: codes });
  await catalan.municipalities();
  assert.ok(sent.every(call => !('locale' in call)));

  // A reason the server gave is shown as received; the client's own sentences follow its language.
  assert.equal(
    describeFailure('plan_home_savings', '', 'ca').message,
    'L’eina plan_home_savings ha retornat un error.',
  );
  assert.equal(
    describeFailure('plan_home_savings', 'Tool plan_home_savings not found', 'es').message,
    'Este servidor todavía no ofrece la herramienta plan_home_savings.',
  );
  assert.equal(
    describeFailure('x', 'MCP error -32000: El servidor està ocupat', 'es').message,
    'El servidor està ocupat',
  );
  const broken = createToolClient(async () => ({ structuredContent: { nonsense: true } }), 'es');
  await assert.rejects(broken.plan({ subject: demoSubject, municipalityCodes: codes, assumptions }), {
    kind: 'invalid',
    message: 'La herramienta plan_home_savings ha respondido con una forma que este espacio de trabajo no sabe leer.',
  });
  const refused = httpCallTool(
    'http://localhost/mcp',
    (async () => new Response('', { status: 502 })) as typeof fetch,
    'ca',
  );
  await assert.rejects(refused('plan_home_savings', {}), {
    kind: 'failed',
    message: 'El punt d’accés MCP ha respost amb HTTP 502.',
  });
});

test('the built page carries the three languages and the language switcher', t => {
  const page = loadWorkspacePage();
  if (!page) return t.skip('apps/web/dist/workspace.js is not built');
  // One sentence of each language (plain ASCII ones: the bundler escapes accented letters), the
  // switcher's style from the theme and its element in the bundle.
  for (const text of ['How soon could you buy?', 'Quan podries comprar?', 'Tu propio plan.'])
    assert.ok(page.includes(text), `the bundle holds “${text}”`);
  assert.match(page, /\.rc-lang \[aria-pressed="true"\]/);
  assert.match(page, /className:\s*"rc-lang"/);
  assert.match(page, /"aria-pressed"/);
});

// ---------------------------------------------------------------- suggestions, habits, no place

const typedPerson = (home: { budgetCents: number | null; floorAreaM2: number | null }): Person => ({
  ...fixturePlan.person,
  home: { ...fixturePlan.person.home, ...home },
});

test('the suggestions ask with what is known and never send a budget the server cannot price', () => {
  const stages = { ...noChoices, schoolStages: ['primary', 'eso'] as SchoolStage[], ruralOnly: true };
  // Budget and floor area known: cents become euros at this boundary and the server screens on price.
  assert.deepEqual(suggestRequest(typedPerson({ budgetCents: 10_800_000, floorAreaM2: 80 }), stages), {
    budget: 'used',
    request: {
      housing: { tenure: 'buy', maxBudgetEur: 108_000, homeSizeM2: 80 },
      schoolStages: ['primary', 'eso'],
      ruralOnly: true,
      limit: 8,
    },
  });
  // A budget without a floor area is left out and said to be, instead of guessing a size.
  const noArea = suggestRequest(typedPerson({ budgetCents: 10_800_000, floorAreaM2: null }), noChoices);
  assert.deepEqual(noArea, { budget: 'no_area', request: { limit: 8 } });
  // The area typed into the form completes it; nothing typed keeps the one on record.
  assert.equal(
    suggestRequest(typedPerson({ budgetCents: 10_800_000, floorAreaM2: null }), { ...noChoices, floorAreaM2: 65 })
      .request.housing?.homeSizeM2,
    65,
  );
  assert.deepEqual(suggestRequest(typedPerson({ budgetCents: null, floorAreaM2: 80 }), noChoices), {
    budget: 'no_budget',
    request: { limit: 8 },
  });
  // Nobody on screen: the suggestions still work, with nothing personal in the request.
  assert.deepEqual(suggestRequest(null, noChoices), { budget: 'no_budget', request: { limit: 8 } });
  assert.deepEqual(['80', '72,5', ' 90 ', '', 'abc', '0', '-4', '99999'].map(parseFloorArea), [
    80,
    72.5,
    90,
    null,
    null,
    null,
    null,
    null,
  ]);
});

test('the suggestions show the real tool’s answer as returned: ranked places, reasons, compromises and exclusions', async () => {
  const { snapshot, policies } = loadData();
  const sent: Record<string, unknown>[] = [];
  // The real screening behind a fake transport: the client must parse what the server really answers.
  const real = (locale: 'ca' | 'es' | undefined) =>
    createToolClient(async (name, args) => {
      sent.push({ name, ...args });
      if (name !== 'recommend_towns') return { isError: true, content: [{ type: 'text', text: `${name} not found` }] };
      const { locale: language, ...input } = recommendationInput.parse(args);
      return {
        structuredContent: recommendTowns(snapshot, policies, input, '2026-11-23', undefined, language ?? 'en'),
      };
    }, locale);
  const { request } = suggestRequest(typedPerson({ budgetCents: 10_800_000, floorAreaM2: 80 }), {
    schoolStages: ['primary'],
    ruralOnly: true,
    floorAreaM2: null,
  });
  const spanish = await real('es').recommend(request);
  assert.deepEqual(sent[0], { name: 'recommend_towns', ...request, locale: 'es' });
  const names = Object.fromEntries(snapshot.municipalities.map(town => [town.code, town.name]));
  const view = suggestionView(spanish, ['252402'], 8, names);
  assert.ok(view.places.length >= 1);
  // The server's own sentences, in the language asked for, untouched.
  assert.deepEqual(view.places[0].reasons, spanish.towns[0].matchReasons);
  assert.deepEqual(view.places[0].compromises, spanish.towns[0].tradeoffs);
  assert.match(view.places[0].reasons.join(' '), /Clasificación rural oficial/);
  // Hard filters ran on the server; what they excluded is listed with its reason, never dropped.
  assert.equal(view.excluded.length, spanish.excluded.length);
  assert.ok(view.excluded.length > 0);
  // Every exclusion is counted; the first ones are listed, each with its name and its reason.
  assert.ok(view.excludedCount >= view.excluded.length);
  assert.equal(view.excludedCount, spanish.excludedCount);
  const first = view.excluded[0];
  assert.equal(first.name, names[first.code]);
  assert.ok(first.reasons.length > 0);
  assert.deepEqual(view.limitations, spanish.limitations);
  // A place already compared is marked, and is not offered again.
  const vallfogona = view.places.find(place => place.code === '252402');
  assert.equal(vallfogona?.compared, true);
  assert.ok(!view.addable.includes('252402'));

  // With nothing asked every pilot place comes back unranked; only what fits under the limit is addable.
  const open = await real(undefined).recommend({ limit: 8 });
  assert.equal('locale' in sent[1], false, 'no language stated: nothing is added to the call');
  const compared = open.towns.slice(0, 6).map(town => town.municipality.code);
  const all = suggestionView(open, compared, 8);
  assert.equal(all.places.length, 8);
  assert.deepEqual(
    all.addable,
    open.towns.slice(6, 8).map(town => town.municipality.code),
  );
  assert.deepEqual(suggestionView(open, [], 0).addable, []);
  assert.deepEqual(suggestionView(open, compared, 7).addable.length, 1, 'only what still fits under the limit');
  assert.equal(
    suggestionView(spanish, [], 8).excluded.every(item => item.name === null),
    true,
    'without the list a code stays a code',
  );

  // Empty, error and unavailable states come from the tool, never from sample data.
  const none = suggestionView(
    await createToolClient(fixtureCallTool('suggest-none', 0)).recommend({ limit: 8 }),
    [],
    8,
  );
  assert.deepEqual([none.places.length, none.addable.length, none.excluded.length > 0], [0, 0, true]);
  await assert.rejects(createToolClient(fixtureCallTool('suggest-error', 0)).recommend({ limit: 8 }), {
    kind: 'failed',
    message: 'Provide homeSizeM2 (constructed floor area) with a purchase budget to estimate a resale price.',
  });
  const old = createToolClient(
    async name => ({ isError: true, content: [{ type: 'text', text: `MCP error -32602: Tool ${name} not found` }] }),
    'ca',
  );
  await assert.rejects(old.recommend({ limit: 8 }), {
    kind: 'unavailable',
    message: 'Aquest servidor encara no ofereix l’eina recommend_towns.',
  });
});

test('the habit form reads a habit, refuses what it cannot use and assumes no saving that was not typed', () => {
  const fields = { title: '  Cook at home ', category: 'food', monthlySaving: '120', status: 'active', startedOn: '' };
  assert.deepEqual(readHabitForm(fields, '2026-11-23'), {
    ok: true,
    habit: { title: 'Cook at home', category: 'food', monthlySavingCents: 12_000, status: 'active' },
  });
  const read = (change: Partial<typeof fields>) => readHabitForm({ ...fields, ...change }, '2026-11-23');
  const habitOf = (change: Partial<typeof fields>) => {
    const outcome = read(change);
    assert.ok(outcome.ok);
    return outcome.habit;
  };
  // No figure typed: null, never zero. A decimal comma is an amount.
  assert.equal(habitOf({ monthlySaving: '' }).monthlySavingCents, null);
  assert.equal(habitOf({ monthlySaving: '35,50' }).monthlySavingCents, 3550);
  assert.deepEqual(habitOf({ status: 'paused', startedOn: '2026-11-10', category: 'made-up' }), {
    title: 'Cook at home',
    category: 'other',
    monthlySavingCents: 12_000,
    status: 'paused',
    startedOn: '2026-11-10',
  });
  assert.deepEqual(
    [
      read({ title: '   ' }),
      read({ title: 'x'.repeat(81) }),
      read({ monthlySaving: 'a lot' }),
      read({ monthlySaving: '-5' }),
      read({ startedOn: '2026-13-45' }),
      read({ startedOn: '10/11/2026' }),
      read({ startedOn: '2026-11-25' }),
    ].map(outcome => (outcome.ok ? 'ok' : outcome.error)),
    ['titleMissing', 'titleLong', 'savingInvalid', 'savingInvalid', 'startInvalid', 'startInvalid', 'startFuture'],
  );
  // One day of slack for the person's own calendar day.
  assert.equal(read({ startedOn: '2026-11-24' }).ok, true);
  // Every error has its sentence in the three languages.
  for (const locale of ['en', 'ca', 'es'] as const) {
    const t = translator(habitFormMessages, locale);
    for (const key of ['titleMissing', 'titleLong', 'savingInvalid', 'startInvalid', 'startFuture'] as const)
      assert.ok(t(key).length > 10, `${locale} ${key}`);
  }
  // The categories offered are exactly those of the contract.
  assert.deepEqual([...habitCategories], habitCategory.options);
});

test('a saved habit goes to save_my_habit for the signed-in person; a server without the tool is an error state', async () => {
  const sent: Record<string, unknown>[] = [];
  const fixture = fixtureCallTool('signed-in', 0);
  const client = createToolClient((name, args) => {
    sent.push({ name, ...args });
    return fixture(name, args);
  });
  const draft: HabitDraft = {
    title: 'Cook at home',
    category: 'food',
    monthlySavingCents: 12_000,
    status: 'active',
    startedOn: '2026-11-23',
  };
  await client.saveHabit(draft);
  // The tool's arguments and nothing else: an id made from the title, `active` for the status, no
  // user id and no person.
  const { id, ...rest } = sent[0];
  assert.match(String(id), /^cook-at-home-[a-z0-9]+$/);
  assert.deepEqual(rest, {
    name: 'save_my_habit',
    title: 'Cook at home',
    category: 'food',
    monthlySavingCents: 12_000,
    active: true,
    startedOn: '2026-11-23',
  });
  assert.deepEqual(saveHabitArguments({ ...draft, id: 'cook-at-home', status: 'paused', startedOn: undefined }), {
    id: 'cook-at-home',
    title: 'Cook at home',
    category: 'food',
    monthlySavingCents: 12_000,
    active: false,
  });
  // Ids hold only what an id may hold, whatever was typed, and two habits of one title stay apart.
  assert.equal(newHabitId('Cuinar a casa: dilluns i dimarts!', 'x1'), 'cuinar-a-casa-dilluns-i-dimarts-x1');
  assert.equal(newHabitId('Añadir càlcul', 'x1'), 'anadir-calcul-x1');
  assert.equal(newHabitId('¿¡…!?', 'x1'), 'habit-x1');
  assert.match(newHabitId('x'.repeat(80), 'x1'), /^x{40}-x1$/);
  for (const title of ['Cuinar a casa', '¿¡…!?', 'x'.repeat(80)])
    assert.ok(safeId.safeParse(newHabitId(title)).success);
  await assert.rejects(createToolClient(fixtureCallTool('habit-error', 0), 'es').saveHabit(draft), {
    kind: 'unavailable',
    message: 'Este servidor todavía no ofrece la herramienta save_my_habit.',
  });
  const anonymous = createToolClient(async () => ({
    isError: true,
    content: [{ type: 'text', text: 'Sign in to ReloCat to use your own profile.' }],
    _meta: { 'mcp/www_authenticate': ['Bearer resource_metadata="https://relo.example/x"'] },
  }));
  await assert.rejects(anonymous.saveHabit(draft), { kind: 'signin' });
});

test('a what-if habit joins the person sent to the planner, is labelled by its id and changes the real plan', () => {
  const draft: HabitDraft = {
    title: 'Sell the second car',
    category: 'transport',
    monthlySavingCents: 15_000,
    status: 'active',
  };
  const habit = whatIfHabit({ ...draft, startedOn: '2026-11-23' }, 1);
  assert.deepEqual(habit, {
    id: 'what-if-habit-1',
    title: 'Sell the second car',
    category: 'transport',
    monthlySavingCents: 15_000,
    status: 'active',
    adherence: null,
    startedOn: '2026-11-23',
  });
  assert.equal(isWhatIfHabit(habit), true);
  assert.equal(fixturePlan.person.habits.some(isWhatIfHabit), false);
  const person = withWhatIfHabits(fixturePlan.person, [habit]);
  assert.equal(person.habits.length, fixturePlan.person.habits.length + 1);
  assert.equal(fixturePlan.person.habits.includes(habit), false, 'the stored person is not changed');
  assert.equal(withWhatIfHabits(fixturePlan.person, []), fixturePlan.person);
  assert.ok(planInput.safeParse({ person, municipalityCodes: ['250404'] }).success);

  // The real planner, on a person with declared figures: the what-if habit is counted and shortens the wait.
  const { snapshot, policies } = loadData();
  const declared: Person = {
    id: 'what-if',
    synthetic: false,
    householdSize: null,
    currentMunicipalityCode: null,
    finances: {
      monthlyIncomeCents: 229_000,
      monthlyExpensesCents: 169_010,
      currentSavingsCents: 1_574_600,
      emergencyReserveCents: 0,
      basis: 'declared',
      asOf: null,
    },
    home: { floorAreaM2: null, budgetCents: 10_800_000, depositRate: 0.2 },
    habits: [],
  };
  const places = [buildPlace(snapshot, '250404')];
  const before = planForPlaces(declared, places, policies, undefined, '2026-11-23');
  const after = planForPlaces(withWhatIfHabits(declared, [habit]), places, policies, undefined, '2026-11-23');
  assert.equal(before.plans[0].monthsSavedByHabits, 0);
  assert.ok((after.plans[0].monthsSavedByHabits ?? 0) > 0);
  assert.deepEqual(
    after.habits?.map(effect => [effect.habitId, effect.counted]),
    [['what-if-habit-1', true]],
  );
  assert.equal(habitPlanView(habit, after, true).state, 'counted');
  // A paused what-if habit is shown and not counted.
  const paused = whatIfHabit({ ...draft, status: 'paused' }, 2);
  const withPaused = planForPlaces(withWhatIfHabits(declared, [paused]), places, policies, undefined, '2026-11-23');
  assert.equal(withPaused.plans[0].monthsSavedByHabits, 0);
});

test('a demo persona opens on the default places; with no place the plan is asked for and a refusal is not an error', async () => {
  const demo = { kind: 'demo', demoId: 'user-004' } as const;
  assert.deepEqual(openingPlaces(demo, []), demoDefaultPlaces);
  assert.deepEqual(openingPlaces(demo, ['251207']), ['251207'], 'places that were asked for are kept');
  assert.deepEqual(openingPlaces({ kind: 'me' }, []), []);
  assert.deepEqual(openingPlaces({ kind: 'none' }, []), []);
  assert.ok(demoDefaultPlaces.every(code => /^\d{6}$/.test(code)) && demoDefaultPlaces.length >= 2);

  // A server that plans without a place: no plans and the person.
  const client = createToolClient(fixtureCallTool('1', 0));
  const noPlace = await client.plan({ subject: demoSubject, municipalityCodes: [], assumptions });
  assert.deepEqual(noPlace.plans, []);
  assert.equal(noPlace.person.id, fixturePlan.person.id);
  assert.equal(baselineMonthlySavingsCents(noPlace), null, 'no place and no anywhere-plan: not estimated, not zero');
  assert.equal(habitMonthlyEffectCents(noPlace), null);

  // A server from before that refuses the empty list: nothing to plan yet. Sign-in is still passed on.
  const refuses = createToolClient(async () => ({
    isError: true,
    content: [{ type: 'text', text: 'The request or the stored data did not match the contract.' }],
  }));
  const refusal = await refuses
    .plan({ subject: demoSubject, municipalityCodes: [], assumptions })
    .catch(error => error);
  assert.ok(refusal instanceof ToolError);
  assert.equal(isNoPlaceRefusal([], refusal), true);
  assert.equal(isNoPlaceRefusal(['250404'], refusal), false, 'with a place a failure is a failure');
  assert.equal(isNoPlaceRefusal([], new ToolError('plan_home_savings', 'signin', 'Sign in')), false);
});

test('the new catalogs say the same things in the three languages', () => {
  for (const locale of ['en', 'ca', 'es'] as const) {
    const suggest = translator(suggestMessages, locale);
    const habit = translator(habitFormMessages, locale);
    const places = translator(placesMessages, locale);
    assert.match(suggest('resultsTitle', { count: 1 }), /1/);
    assert.match(suggest('resultsTitle', { count: 3 }), /3/);
    assert.match(suggest('excluded', { count: 16 }), /16/);
    assert.match(suggest('addAll', { count: 3 }), /3/);
    assert.match(suggest('budgetNoArea', { budget: '108.000 €' }), /108\.000 €/);
    // The what-if version says, in every language, that nothing is saved.
    for (const key of ['introWhatIf', 'introDemo', 'addedWhatIf'] as const) assert.ok(habit(key).length > 20);
    assert.match(places('empty'), /<b>.*<\/b>/);
  }
  assert.equal(translator(suggestMessages, 'en')('summary'), 'Suggest places for me');
  assert.equal(translator(suggestMessages, 'ca')('summary'), 'Suggereix-me llocs');
  assert.equal(translator(suggestMessages, 'es')('summary'), 'Sugiéreme lugares');
  assert.equal(translator(habitFormMessages, 'en')('summary'), 'Add a habit');
  assert.match(translator(habitFormMessages, 'ca')('introDemo'), /persona fictícia.*no es desa/);
  assert.match(translator(habitFormMessages, 'es')('introWhatIf'), /no se guarda/);
});

test('the habit form saves through the real save_my_habit tool and the real plan counts the new habit', async () => {
  const db = open(':memory:');
  const doc = { schemaVersion: 1, synthetic: false };
  await createStore(db).create('p-1', { details: { ...doc, id: 'p-1' }, preferences: doc, 'bank-account': doc });
  const habits = createHabitsHandler({ token: 'habits-test-token', db });
  const { snapshot, policies } = loadData();
  const today = new Date().toISOString().slice(0, 10);
  // A signed-in person with declared figures; the habit store is the real one.
  const caller: Caller = {
    scopes: ['person:read', 'person:write'],
    demo: null,
    challenge: () => 'Bearer resource_metadata="https://relocat.test/.well-known/oauth-protected-resource"',
    me: {
      userId: 'p-1',
      synthetic: false,
      context: async () => ({
        resolved: {
          data: {
            finance: { monthlyIncomeCents: 229_000, monthlyExpensesCents: 169_010, currentSavingsCents: 1_574_600 },
            housing: { budgetCents: 10_800_000 },
          },
          provenance: Object.fromEntries(
            ['monthlyIncomeCents', 'monthlyExpensesCents', 'currentSavingsCents'].map(field => [
              `finance.${field}`,
              [{ confirmed: true, observedAt: '2026-11-01T00:00:00Z' }],
            ]),
          ),
        },
      }),
      inputs: async () => ({ inputs: [] }),
      saveInputs: async () => ({ inserted: 0, duplicates: 0 }),
      bankSummary: async () => {
        throw new Error('no bank');
      },
      bankUpdates: async () => ({}),
      bankRuntime: async () => ({}),
      bankBalanceCents: async () => null,
      habits: () => habits.read('p-1'),
      saveHabit: (goal: unknown, replace = false) => habits.save('p-1', goal, replace),
    },
  };
  const server = new McpServer({ name: 'habit-form-test', version: '1' });
  registerPlannerTools(server, { snapshot, policies, today: () => today, caller });
  const mcp = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  try {
    const client = createToolClient(
      (name, args) => mcp.callTool({ name, arguments: args }) as Promise<ToolResult>,
      'ca',
    );
    const me = { kind: 'me' } as const;
    const before = await client.plan({ subject: me, municipalityCodes: ['250404'], assumptions });
    assert.equal(before.person.habits.length, 0);
    assert.equal(before.plans[0].monthsSavedByHabits, 0);

    // What the form reads is what the tool accepts.
    const read = readHabitForm(
      {
        title: 'Cuinar a casa entre setmana',
        category: 'food',
        monthlySaving: '120',
        status: 'active',
        startedOn: today,
      },
      today,
    );
    assert.ok(read.ok);
    await client.saveHabit(read.habit);
    const after = await client.plan({ subject: me, municipalityCodes: ['250404'], assumptions });
    assert.deepEqual(
      after.person.habits.map(habit => [
        habit.title,
        habit.category,
        habit.monthlySavingCents,
        habit.status,
        habit.startedOn,
      ]),
      [['Cuinar a casa entre setmana', 'food', 12_000, 'active', today]],
    );
    assert.match(after.person.habits[0].id, /^cuinar-a-casa-entre-setmana-[a-z0-9]+$/);
    assert.ok((after.plans[0].monthsSavedByHabits ?? 0) > 0, 'the new habit shortens the wait');
    assert.equal(after.habits?.[0].counted, true);

    // A paused habit with no figure is stored as such: no saving is invented and nothing is counted.
    const paused = readHabitForm(
      { title: 'Anar en bici', category: 'transport', monthlySaving: '', status: 'paused', startedOn: '' },
      today,
    );
    assert.ok(paused.ok);
    await client.saveHabit(paused.habit);
    const both = await client.plan({ subject: me, municipalityCodes: ['250404'], assumptions });
    assert.deepEqual(
      both.person.habits.map(habit => [habit.status, habit.monthlySavingCents]),
      [
        ['active', 12_000],
        ['paused', null],
      ],
    );
    assert.equal(both.plans[0].withHabits?.months, after.plans[0].withHabits?.months);
    // A day the server refuses comes back as the server's own sentence, for the form to show.
    await assert.rejects(client.saveHabit({ ...read.habit, startedOn: '2099-01-01' }), { kind: 'failed' });
  } finally {
    await mcp.close();
    db.close();
  }
});
