import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bankRuntime,
  bankSummary,
  bankUpdates,
  createToolClient,
  httpCallTool,
  ToolError,
} from '../apps/web/client.ts';
import type { Subject } from '../apps/web/launch.ts';
import { subjectOf, workspaceLaunch } from '../apps/web/launch.ts';
import { addedTransactions, lastCompleteMonths } from '../apps/web/view-model.ts';
import { person as personSchema, planResult } from '../packages/contracts/planner.ts';
import { Browser, mcp, startApp } from './support/app.ts';

/**
 * The two halves cannot drift: the widget's own client and schemas (`apps/web/client.ts`,
 * `launch.ts`) parse the answers of the real MCP server, started in-process over a temporary
 * database. Nothing here is a fixture; a renamed field or tool on either side fails this file.
 */

const assumptions = { includeProposedHabits: false, includeUnverifiedBenefits: false };
const codes = ['251207', '250404'];
const period = lastCompleteMonths(new Date().toISOString().slice(0, 10), 3);

test('the widget client parses real tool answers for a demo persona, a signed-in person and nobody', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin, db } = server;
  // user-001 gets a ledger with history and a first event, as the demo feed provides.
  const seeded = await fetch(`${origin}/api/users/user-001/bank/demo`, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-test-token', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(seeded.status, 201);

  // The standalone page: same-origin calls that carry the session cookie when there is one.
  const page = (browser?: Browser) =>
    createToolClient(
      httpCallTool(`${origin}/mcp`, (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            Origin: origin,
            ...(browser ? { Cookie: `rc_session=${browser.cookies.get('rc_session')}` } : {}),
          },
        }),
      ),
    );

  // ------------------------------------------------------------ not signed in
  const anonymous = page();
  const nobody = await anonymous.launch({ municipalityCodes: codes });
  assert.deepEqual([nobody.subject, nobody.signedIn, nobody.municipalityCodes], ['none', false, codes]);
  assert.deepEqual(nobody.demoIds, ['user-001', 'user-002', 'user-003', 'user-004']);
  assert.deepEqual(subjectOf(nobody), { kind: 'none' });
  assert.equal((await anonymous.municipalities()).length > 3, true);
  // A personal tool without a session is a typed "sign in", never sample data.
  for (const call of [
    () => anonymous.plan({ subject: { kind: 'me' }, municipalityCodes: codes, assumptions }),
    () => anonymous.bankRuntime({ kind: 'me' }),
    () => anonymous.bankUpdates({ kind: 'me' }, 0),
    () => anonymous.saveInputs({ household: { size: 2 } }, true),
  ])
    await assert.rejects(call, (error: unknown) => error instanceof ToolError && error.kind === 'signin');

  // ------------------------------------------------------------- demo persona
  const launch = await anonymous.launch({ demoId: 'user-001', municipalityCodes: codes });
  const demo = subjectOf(launch);
  assert.deepEqual(demo, { kind: 'demo', demoId: 'user-001' });
  const demoPlan = await anonymous.plan({ subject: demo, municipalityCodes: codes, assumptions });
  assert.equal(demoPlan.plans.length, 2);
  assert.deepEqual([demoPlan.person.id, demoPlan.person.synthetic], ['user-001', true]);
  const runtime = await anonymous.bankRuntime(demo);
  assert.equal(runtime.userId, 'user-001');
  const summary = await anonymous.bankSummary(demo, period);
  assert.deepEqual([summary.synthetic, summary.monthCount, summary.dataStatus], [true, 3, 'observed']);
  const head = await anonymous.bankUpdates(demo, 0, 1);
  assert.equal(head.latestRevision >= 1, true);
  // One new movement on a ledger of many is one new transaction (the review's "16 new transactions" defect).
  const before = await anonymous.bankUpdates(demo, Math.max(0, head.latestRevision - 5), 100);
  const size = before.events.at(-1)?.transactionCount ?? null;
  assert(size !== null && size > 10, `the seeded ledger has many movements (${size})`);
  await server.app.profiles.bankRuntime.tick('user-001');
  const after = await anonymous.bankUpdates(demo, before.nextCursor, 100);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].transactionCount, size + 1, 'the event carries the size of the ledger');
  assert.equal(addedTransactions(size, after.events), 1);
  // An inline what-if of that person plans without any identity.
  const whatIf = await anonymous.plan({ person: demoPlan.person, municipalityCodes: codes, assumptions });
  assert.equal(whatIf.plans.length, 2);

  // The raw results also parse with the exported schemas, for every tool the widget reads.
  const raw = async (name: string, args: Record<string, unknown>) =>
    (await mcp(origin, name, args)).result?.structuredContent;
  bankUpdates.parse(await raw('get_demo_bank_updates', { demoId: 'user-001' }));
  bankRuntime.parse(await raw('get_demo_bank_runtime', { demoId: 'user-001' }));
  bankSummary.parse(await raw('get_demo_bank_summary', { demoId: 'user-001', ...period }));
  planResult.parse(await raw('plan_home_savings', { demoId: 'user-002', municipalityCodes: codes }));
  personSchema.parse(await raw('get_demo_person', { demoId: 'user-003' }));
  workspaceLaunch.parse(await raw('show_workspace', { demoId: 'user-004' }));

  // --------------------------------------------------------- signed-in person
  const browser = new Browser(origin);
  await browser.signUp('ada@example.com');
  const signedIn = page(browser);
  const mine = await signedIn.launch({ municipalityCodes: codes });
  assert.deepEqual([mine.subject, mine.signedIn, mine.demoId], ['me', true, null]);
  const me: Subject = subjectOf(mine);
  // A new account has nothing saved: the plan says what is missing instead of inventing figures.
  const empty = await signedIn.plan({ subject: me, municipalityCodes: codes, assumptions });
  assert.equal(empty.person.synthetic, false);
  // Nothing about a real person is labelled synthetic before they have any bank data.
  assert.equal((await signedIn.bankSummary(me, period)).synthetic, false);
  assert.equal((await signedIn.bankUpdates(me, 0)).synthetic, false);
  assert.equal(empty.person.finances.monthlyIncomeCents, null);
  assert(
    empty.plans.every(plan => plan.baseline === null || plan.baseline.months === null || plan.dataMissing.length > 0),
  );
  const saved = await signedIn.saveInputs(
    {
      finance: { monthlyIncomeCents: 320_000, monthlyExpensesCents: 210_000, currentSavingsCents: 2_500_000 },
      housing: { tenure: 'buy', budgetCents: 15_000_000 },
    },
    true,
  );
  assert.deepEqual([saved.saved, saved.inputCount], [true, 1]);
  // What the person saved is stored as real, and so are the documents of their profile.
  const ownId = db.get<{ user_id: string }>('SELECT user_id FROM accounts')?.user_id ?? '';
  assert.deepEqual(db.all('SELECT synthetic FROM input_records WHERE user_id = ?', ownId), [{ synthetic: 0 }]);
  assert.deepEqual(db.all('SELECT DISTINCT synthetic FROM profile_sections WHERE user_id = ?', ownId), [
    { synthetic: 0 },
  ]);
  assert.deepEqual(db.all("SELECT DISTINCT synthetic FROM profile_sections WHERE user_id = 'user-001'"), [
    { synthetic: 1 },
  ]);
  const planned = await signedIn.plan({ subject: me, municipalityCodes: codes, assumptions });
  assert.equal(planned.person.finances.monthlyIncomeCents, 320_000);
  assert.equal(planned.person.home.budgetCents, 15_000_000);
  assert(
    planned.plans.some(plan => plan.baseline?.months != null),
    'a finite timeline from the saved figures',
  );
  // The personal bank tools answer for an empty ledger in the shape the strip reads.
  const ownUpdates = await signedIn.bankUpdates(me, 0);
  assert.deepEqual([ownUpdates.latestRevision, ownUpdates.events.length], [0, 0]);
  assert.equal((await signedIn.bankRuntime(me)).enabled, false);
  assert.equal((await signedIn.bankSummary(me, period)).transactionCount, 0);
  const session = { Cookie: `rc_session=${browser.cookies.get('rc_session')}`, Origin: origin };
  personSchema.parse((await mcp(origin, 'get_person', {}, session)).result?.structuredContent);
  workspaceLaunch.parse((await mcp(origin, 'show_workspace', {}, session)).result?.structuredContent);
  // Signed in, a demo persona can still be looked at; it stays the persona's data, not the person's.
  const looked = await signedIn.plan({ subject: demo, municipalityCodes: codes, assumptions });
  assert.equal(looked.person.id, 'user-001');
  assert.equal(looked.person.synthetic, true);
  // The plan says for each habit what it did, and the widget reads that instead of the habit's status.
  assert.deepEqual(planned.habits, []);
  // A demo persona declares no savings for the purchase: its balance is not used for them, so no timeline is invented.
  assert.equal(looked.person.finances.currentSavingsCents, null);
  assert.ok(looked.plans.every(plan => plan.dataMissing.includes('person.finances.currentSavingsCents')));
  assert.notEqual(looked.person.finances.monthlyIncomeCents, 320_000);
});
