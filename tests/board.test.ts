import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDemo, updateDemo } from '../apps/board/demo.ts';
import { stopNames } from '../apps/board/map.ts';
import { board } from '../apps/board/messages.ts';
import { sceneText } from '../apps/board/scenes.ts';
import { missingInformation, statusLabel } from '../apps/board/screen.ts';

test('onboarding batches answers atomically and separates the upfront and payoff milestones', () => {
  const { runId } = openDemo({ persona: 'onboarding' });
  assert.throws(
    () =>
      updateDemo({
        runId,
        action: 'answer_batch',
        answers: { town: 'Manresa', bedrooms: 0 },
      }),
    /whole number/,
  );
  const blank = openDemo({ runId });
  assert.ok('answers' in blank);
  assert.deepEqual(blank.answers, {});
  const details = updateDemo({
    runId,
    action: 'answer_batch',
    answers: { town: 'Manresa', bedrooms: 2, household: 3, employment: 'Full-time employee' },
  });
  assert.ok('group' in details);
  assert.deepEqual(
    details.group?.questions.map(question => question.id),
    ['income', 'spending', 'savings'],
  );
  updateDemo({ runId, action: 'answer_batch', answers: { income: 2000, spending: 2000, savings: 3000 } });
  const view = openDemo({ runId });
  assert.ok('plan' in view);
  assert.equal(view.plan?.upfrontMonths, null);
  assert.equal(view.plan?.debtFreeMonths, null);
  const next = updateDemo({ runId, action: 'sample_bank' });
  assert.ok('plan' in next);
  assert.deepEqual(next.plan, {
    saved: 18400,
    target: 54000,
    monthly: 720,
    upfrontMonths: 50,
    termMonths: 240,
    debtFreeMonths: 290,
  });
  const refined = updateDemo({
    runId,
    action: 'answer_batch',
    answers: {
      budget: 160000,
      homeSize: 85,
      schoolStages: 'ESO',
      commuteTime: 45,
      debtPayments: 100,
      reserve: 5000,
    },
  });
  assert.ok('answers' in refined);
  assert.equal(refined.answers.homeSize, 85);
  assert.deepEqual(refined.plan, {
    saved: 13400,
    target: 48000,
    monthly: 620,
    upfrontMonths: 56,
    termMonths: 240,
    debtFreeMonths: 296,
  });
  assert.throws(() => updateDemo({ runId, action: 'answer_batch', answers: { cashTarget: 0 } }), /whole number/);
});

test('MCP transport serves the widget and supports each of the four scenarios', async t => {
  const proc = spawn(process.execPath, ['apps/board/server.ts'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', PUBLIC_ORIGIN: 'https://relocat.example' },
  });
  t.after(() => proc.kill());
  const [line] = await once(proc.stdout, 'data');
  const port = /localhost:(\d+)\/preview/.exec(line.toString())?.[1];
  assert.ok(port, 'The test server reports its bound port.');
  const origin = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'relocat-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin));
  await client.connect(transport);
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  const ui = tools.find(tool => tool.name === 'open_demo')?._meta?.ui as { resourceUri?: string } | undefined;
  assert.equal(ui?.resourceUri, 'ui://relocat/journey-board-v1.html');
  const resource = await client.readResource({ uri: 'ui://relocat/journey-board-v1.html' });
  const [widget] = resource.contents;
  assert.equal(widget.mimeType, 'text/html;profile=mcp-app');
  assert.ok('text' in widget);
  assert.match(widget.text, /Demo personas/);
  const preview = await fetch(`${origin}/preview`);
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
  const live = await fetch(`${origin}/preview/state`);
  assert.equal(live.headers.get('Access-Control-Allow-Origin'), null, 'the board state is same-origin only');
  const synced = await live.json();
  assert.deepEqual(synced.answers, home.answers);
  assert.equal(synced.revision, home.revision);
  assert.equal(synced.runId, runId);
  assert.equal((await fetch(`${origin}/preview/state?run=invalid`)).status, 400);

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
  const inbox = read.inbox as {
    id: string;
    upfrontMonths: number;
    debtFreeMonths: number;
    waypoint: { label: string; offset: number };
  }[];
  assert.equal(inbox.length, 5);
  assert.equal(inbox.find(item => item.id === 'rule')?.upfrontMonths, 0);
  assert.equal(inbox.find(item => item.id === 'rule')?.debtFreeMonths, 240);
  assert.deepEqual(inbox.find(item => item.id === 'job')?.waypoint, { label: 'Change jobs', offset: 4 });
  assert.deepEqual(
    inbox.slice(0, 3).map(item => item.id),
    ['rule', 'listing', 'job'],
  );
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

test('the board MCP endpoint refuses browser calls from other sites', async t => {
  const proc = spawn(process.execPath, ['apps/board/server.ts'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
  });
  t.after(() => proc.kill());
  const [line] = await once(proc.stdout, 'data');
  const port = /localhost:(\d+)\/preview/.exec(String(line))?.[1];
  assert(port);
  const call = (origin?: string) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  assert.equal((await call('https://evil.example')).status, 403);
  assert.equal((await call(`http://127.0.0.1:${port}`)).status, 200);
  assert.equal((await call()).status, 200);
});

// ------------------------------------------------------------ languages

test('the scripted scenes read the same in English as before, and in Catalan and Spanish from the same ids', () => {
  const english = sceneText();
  // The server writes the catalog's English, so the widget and the model never disagree.
  const { runId } = openDemo({ persona: 'shortcuts', newRun: true });
  const view = updateDemo({ runId, action: 'read_inbox' });
  assert.ok('inbox' in view);
  for (const route of view.inbox) {
    assert.deepEqual({ title: route.title, detail: route.detail, verify: route.verify }, english.opportunity(route.id));
    assert.equal(route.waypoint.label, english.step(route.id));
  }
  assert.equal(
    english.opportunity('rule').detail,
    'A fictional rule change reduces the upfront goal to €28,000. Your €28,000 reaches that goal. Sample rent is €1,150 and the modeled mortgage payment is €950, a €200 difference before ownership costs.',
  );
  assert.equal(
    english.habit('coffee').action,
    'Buy your four coffees at the sample station café for €2.50 each instead of €5. Try the cheaper café on your next coffee run.',
  );
  assert.deepEqual(
    english.credits.stats.map(stat => stat.value),
    ['€165,000', '20 years', '€0'],
  );
  assert.equal(english.financeNote('sampleGoal'), 'Uses the €54,000 sample upfront goal.');
  assert.equal(english.coach(1, 10).milestone, '1 quest checked off. Keep them up to free up €10 a month.');

  // The same scene in the other two languages: amounts as each writes them, and still labelled as invented.
  const catalan = sceneText('ca');
  const spanish = sceneText('es');
  assert.match(
    catalan.opportunity('rule').detail,
    /^Un canvi de norma fictici redueix l’objectiu inicial a 28\.000\s€\./,
  );
  assert.match(
    spanish.opportunity('rule').detail,
    /^Un cambio de norma ficticio reduce el objetivo inicial a 28\.000\s€\./,
  );
  assert.match(catalan.habit('coffee').action, /2,50\s€ cadascun en lloc de 5\s€/);
  assert.match(spanish.bankInsight, /ritmo de gasto de muestra te quedan 720\s€/);
  assert.equal(catalan.personaLabel('payoff'), 'Habitatge sense deutes');
  assert.match(spanish.coach(1, 10).milestone, /^1 misión completada\./);
  assert.match(catalan.coach(2, 24).milestone, /^2 missions completades\./);
  assert.deepEqual(spanish.credits.stats.at(1), { label: 'Camino de devolución', value: '20 años' });
  // Persona names and place names are not translated.
  assert.match(catalan.opportunity('listing').title, /Manresa/);
  assert.match(spanish.you, /^Marc/);
});

test('the board sends ids with its scripted text, so the widget can show its own language', () => {
  const { runId } = openDemo({ persona: 'onboarding', newRun: true });
  const view = updateDemo({ runId, action: 'answer_batch', answers: { town: 'Manresa', reserve: 4000 } });
  assert.ok('answers' in view);
  assert.equal(view.group?.id, 'home');
  assert.deepEqual(
    view.extraGroups.map(group => group.id),
    ['household', 'commute', 'buffer'],
  );
  assert.deepEqual(view.financeNotes, ['sampleGoal', 'reserve', 'unreportedDebt']);
  assert.equal(
    view.financeNote,
    'Uses the €54,000 sample upfront goal. Your emergency reserve stays out of the buying fund. Monthly saving is before any unreported debt payments.',
  );
  const catalan = sceneText('ca');
  assert.equal(catalan.groupTitle('home'), 'Explica’m l’habitatge que vols');
  assert.equal(catalan.fieldLabel('town'), 'Poble on vols comprar');
  assert.equal(sceneText('es').factLabel('savings'), 'Ahorrado');
  // A field the script does not know is shown as it is, and a place name is not an example to translate.
  assert.equal(catalan.fieldLabel('somethingElse'), 'somethingElse');
  assert.equal(catalan.example('town'), null);
});

test('the town screen names what is missing in words, never as an input path', () => {
  const paths = ['housing.homeSizeM2', 'transport.destinationCode'];
  assert.equal(missingInformation(paths), 'More information needed: home size and where you commute to.');
  assert.equal(
    missingInformation(paths, 'ca'),
    'Cal més informació: la superfície de l’habitatge i on et desplaces per feina.',
  );
  assert.equal(
    missingInformation(paths, 'es'),
    'Hace falta más información: la superficie de la vivienda y adónde te desplazas por trabajo.',
  );
  // A path with no name here is "more details"; a reason after a colon is not printed either.
  const odd = ['eligibility.somethingNew', 'school.stages:required_for_constraints', 'school.stages'];
  assert.equal(missingInformation(odd), 'More information needed: school stages and more details.');
  for (const locale of ['en', 'ca', 'es'] as const) {
    const said = missingInformation([...paths, ...odd, 'housing.tenure', 'housing.budgetCents'], locale);
    assert.doesNotMatch(said, /housing\.|transport\.|school\.|eligibility\.|required_for|[a-z][A-Z]/, locale);
  }
  assert.equal(missingInformation([], 'es'), 'Hace falta más información: resuelve los conflictos del perfil.');
  // The unknown state stays a word in each language, and an unmapped status is shown as the source wrote it.
  assert.deepEqual(
    (['en', 'ca', 'es'] as const).map(locale => statusLabel('unknown', locale)),
    ['unknown', 'desconegut', 'desconocido'],
  );
  assert.equal(statusLabel('needs_verification', 'ca'), 'cal verificar-ho');
  assert.equal(statusLabel('paused', 'es'), 'paused');
});

test('the board template carries a language switcher, and every key it names is in the catalog', () => {
  const template = readFileSync(new URL('../apps/board/widget.html', import.meta.url), 'utf8');
  assert.match(template, /class="rc-lang"[^>]*>(<button type="button" data-lang="(en|ca|es)"[^>]*>[^<]+<\/button>){3}/);
  const keys = [...template.matchAll(/data-i18n(?:-aria-label)?="([^"]+)"/g)].map(match => match[1]);
  assert.ok(keys.length >= 6);
  for (const key of keys) assert.ok(key in board.en, key);
  // The English template is what the catalog says, so the page reads the same before the script runs.
  for (const [, key, text] of template.matchAll(/data-i18n="([^"]+)">([^<]+)</g))
    assert.equal(text, board.en[key as keyof typeof board.en], key);
  // The demo stays labelled as invented in every language.
  assert.deepEqual(
    [board.en.pill, board.ca.pill, board.es.pill],
    ['Hackathon · fictional data', 'Hackathon · dades fictícies', 'Hackathon · datos ficticios'],
  );
  assert.match(board.ca.footer, /dades de mostra/);
  assert.match(board.es.demoProfile, /ficticio .* solo lectura/);
  assert.deepEqual(stopNames(), ['Start', 'Savings', 'Plan', 'Buy', 'Repay', 'Debt-free']);
  assert.deepEqual(stopNames('ca'), ['Inici', 'Estalvi', 'Pla', 'Compra', 'Retorn', 'Sense deutes']);
  // Canvas labels are drawn at 12 px in a fixed space: a translation may not be much longer than the English.
  for (const key of ['chartToday', 'chartStart', 'chartMortgageShort', 'chartPaidShort', 'stopDebtFree'] as const)
    for (const locale of ['ca', 'es'] as const)
      assert.ok(board[locale][key].length <= board.en[key].length + 4, `${locale}.${key}`);
});
