import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Caller } from '../apps/mcp-server/identity.ts';
import { registerInterviewerTools } from '../apps/mcp-server/interview-tools.ts';
import { nextQuestionsResult } from '../apps/mcp-server/planner-tools.ts';
import { createMcpServer } from '../apps/mcp-server/tools.ts';
import { voiceUrlConfig } from '../packages/config/env.ts';
import { recommendationResult } from '../packages/contracts/places.ts';
import type { PersonInput } from '../packages/contracts/planner.ts';
import { planResult } from '../packages/contracts/planner.ts';
import { loadData } from '../packages/places/data.ts';
import { Browser, startApp } from './support/app.ts';

/**
 * The journey a person takes, walked through the MCP server the way ChatGPT walks it (text or
 * voice mode): read the server instructions, follow them, and end at the one plan.
 */

const { snapshot, policies } = loadData();
const today = '2026-11-23';
const termens = '252206'; // special attention: the reduced rural transfer tax can apply
const talarn = '252154'; // rural
const balaguer = '250404'; // not listed

type Content = { text: string }[];
const textOf = (response: unknown) => (response as { content: Content }).content.map(item => item.text).join('\n');

async function connect(caller?: Caller) {
  const server = createMcpServer({ snapshot, policies, today: () => today, listings: {}, caller });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'journey-flow', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

/** A server with accounts and nobody signed in, as ChatGPT finds it before the person connects. */
const visitor: Caller = {
  me: null,
  scopes: [],
  demo: null,
  challenge: () => 'Bearer resource_metadata="https://relocat.test/.well-known/oauth-protected-resource"',
};

test('journey without an account: instructions, interview, questions with no place, towns, the plan', async () => {
  const { client, close } = await connect(visitor);
  try {
    // 1. The instructions lead to the planner flow, keep the trigger phrases, and set the calculators aside.
    const instructions = client.getInstructions() ?? '';
    for (const phrase of ['I want to buy a new home', 'Quiero comprar una vivienda', 'Vull comprar un habitatge'])
      assert(instructions.includes(phrase), phrase);
    assert.match(instructions, /call start_homebuying_interview before asking any questions/);
    assert.match(
      instructions,
      /get_next_questions for the next question.*save_my_inputs after the person confirms.*plan_home_savings for the plan.*show_workspace to see it/,
    );
    assert.match(instructions, /The plan is plan_home_savings and nothing else/);
    assert.match(
      instructions,
      /generate_home_savings_scenario and compare_home_savings are what-if calculators.*never present their result as the plan/,
    );
    assert.match(instructions, /In voice mode the flow is the same/);
    assert.doesNotMatch(instructions, /ReloCat Team/);
    // The planner flow comes before the town data guidance, and no scripted board is mentioned on this server.
    assert(instructions.indexOf('The plan is plan_home_savings') < instructions.indexOf('Use ReloCat to compare'));
    assert.doesNotMatch(instructions, /journey board/);

    // 2. "I want to buy a home".
    const start = await client.callTool({ name: 'start_homebuying_interview', arguments: {} });
    assert(!start.isError, textOf(start));
    const started = start.structuredContent as {
      openingQuestion: string;
      signedIn: boolean;
      flow: string[];
      nextSteps: string[];
      sources: Record<string, string>;
    };
    assert.match(started.openingQuestion, /bank CSV.*fictional demo bank account.*monthly income and spending/);
    assert.equal(started.signedIn, false);
    assert.deepEqual(started.flow, ['get_next_questions', 'save_my_inputs', 'plan_home_savings', 'show_workspace']);
    assert.match(started.nextSteps[0], /^Call get_next_questions with person:\{\}/);
    assert.match(started.sources.estimates, /^Go straight to get_next_questions/);
    assert.match(started.sources.demo, /Never save fictional figures to a real profile/);
    assert(
      started.nextSteps.slice(0, 5).every(step => !/generate_home_savings_scenario|compare_home_savings/.test(step)),
      'the calculators are not a step of the flow',
    );

    // 3. The first question, with no municipality and an empty person.
    const ask = async (person: PersonInput, municipalityCodes: string[] = [], locale?: string) => {
      const response = await client.callTool({
        name: 'get_next_questions',
        arguments: { person, municipalityCodes, ...(locale ? { locale } : {}) },
      });
      assert(!response.isError, textOf(response));
      return { result: nextQuestionsResult.parse(response.structuredContent), text: textOf(response) };
    };
    const first = await ask({});
    assert.deepEqual(
      first.result.nextQuestions.slice(0, 3).map(question => [question.id, question.effect.kind]),
      [
        ['monthlyIncome', 'required'],
        ['monthlyExpenses', 'required'],
        ['purchaseSavings', 'required'],
      ],
    );
    assert.deepEqual([first.result.stored, first.result.municipalityCodes], [false, []]);
    assert.equal(first.result.placeQuestion?.suggestTool, 'recommend_towns');
    assert.match(first.text, /^No place is chosen yet\. Ask next, one question at a time: “How much money comes into/);
    assert.match(first.text, /offer recommend_towns/);
    // Not signed in: the person is told the answers live in the conversation and how to connect.
    assert.match(first.result.sayNotStored ?? '', /only in this conversation.*connect your ReloCat account/);
    assert.match(first.text, /Inline person: nothing was saved/);

    // 4. Three answers go into the inline person, one at a time; each call asks the next one.
    const person: PersonInput = { finances: {} };
    const paths: Record<string, (cents: number) => void> = {
      'finance.monthlyIncomeCents': cents => Object.assign(person.finances ?? {}, { monthlyIncomeCents: cents }),
      'finance.monthlyExpensesCents': cents => Object.assign(person.finances ?? {}, { monthlyExpensesCents: cents }),
      'finance.currentSavingsCents': cents => Object.assign(person.finances ?? {}, { currentSavingsCents: cents }),
    };
    const said = [229_000, 169_010, 1_574_600];
    let current = first.result;
    for (const cents of said) {
      const question = current.nextQuestions[0];
      assert(question.inputPath in paths, question.inputPath);
      paths[question.inputPath](cents);
      current = (await ask(person)).result;
    }
    assert.deepEqual(person.finances, {
      monthlyIncomeCents: 229_000,
      monthlyExpensesCents: 169_010,
      currentSavingsCents: 1_574_600,
    });
    // What is left of the required figures is the price; nothing was invented for what was not said.
    assert.deepEqual(
      current.nextQuestions.filter(question => question.effect.kind === 'required').map(question => question.id),
      ['homeBudget', 'floorArea'],
    );
    person.home = { budgetCents: 10_800_000 };
    const beforePlace = await ask(person);
    assert.match(
      beforePlace.text,
      /^No place is chosen yet\. Ask next: ask where in Catalonia they would like to live/,
    );

    // 5. A plan with no place is valid: what is needed anywhere, and a place still to choose.
    const anywhereCall = await client.callTool({ name: 'plan_home_savings', arguments: { person } });
    assert(!anywhereCall.isError, textOf(anywhereCall));
    const anywhere = planResult.parse(anywhereCall.structuredContent);
    assert.deepEqual(anywhere.plans, []);
    // EUR 108,000: 20% + 10% + 2% = EUR 34,560; EUR 15,746 saved; EUR 599.90 a month -> 32 months.
    assert.deepEqual(
      [anywhere.withoutPlace?.baseline?.upfrontCashCents, anywhere.withoutPlace?.baseline?.months],
      [3_456_000, 32],
    );
    assert.match(textOf(anywhereCall), /^Anywhere in Catalonia, before the benefits of any place: about 32 months/);
    assert.equal(anywhere.stored, false);

    // 6. Places are recommended, then questions and the plan are asked for them.
    const towns = await client.callTool({
      name: 'recommend_towns',
      arguments: { housing: { tenure: 'buy', maxBudgetEur: 108_000, homeSizeM2: 80 }, ruralOnly: true, limit: 5 },
    });
    assert(!towns.isError, textOf(towns));
    const recommended = recommendationResult.parse(towns.structuredContent).towns.map(town => town.municipality.code);
    assert(recommended.length > 0, 'some rural pilot town fits the budget');
    const places = [...new Set([termens, recommended[0]])];
    const withPlace = await ask(person, places);
    assert.equal(withPlace.result.placeQuestion, undefined);
    assert.deepEqual(withPlace.result.municipalityCodes, places);
    assert(
      withPlace.result.nextQuestions.some(question => question.effect.kind === 'benefit'),
      'with a place, the facts that decide its aid are worth asking',
    );
    assert.match(withPlace.text, /^Ask next, one question at a time: “/);
    const planned = await client.callTool({
      name: 'plan_home_savings',
      arguments: { person, municipalityCodes: places },
    });
    const plan = planResult.parse(planned.structuredContent);
    const item = plan.plans.find(entry => entry.place.municipalityCode === termens);
    assert(item);
    assert.equal(item.baseline?.months, 32);
    // Nothing about the household is known yet: the rural rate is explained as not verified, never counted.
    const rural = item.benefits.find(benefit => benefit.policyId === 'itp_buy');
    assert.deepEqual([rural?.eligibilityStatus, rural?.counted], ['needs_verification', false]);
    assert.equal(item.monthsSavedByPlace, 0);
    assert(plan.nextQuestions?.some(question => question.effect.policyIds.includes('itp_buy')));

    // 7. A personal tool without sign-in: the challenge, and one sentence to say aloud, in Catalan.
    for (const [name, args] of [
      ['save_my_inputs', { data: { finance: { monthlyIncomeCents: 229_000 } }, confirmed: true, locale: 'ca' }],
      ['save_my_habit', { id: 'cook-at-home', title: 'Cuinar a casa', category: 'food', locale: 'ca' }],
      ['list_my_habits', { locale: 'ca' }],
      ['plan_home_savings', { me: true, locale: 'ca' }],
    ] as const) {
      const refused = await client.callTool({ name, arguments: args });
      assert.equal(refused.isError, true, name);
      const content = refused.content as Content;
      assert.equal(content[0].text.startsWith('Sign in to ReloCat to use your own profile.'), true, name);
      assert.match(content[1].text, /^Per fer servir el teu perfil de ReloCat, primer has de connectar el teu compte/);
      assert.match(content[1].text, /només en aquesta conversa\.$/);
      const meta = refused._meta as Record<string, unknown>;
      assert.match(String((meta['mcp/www_authenticate'] as string[])[0]), /resource_metadata=/);
      assert.deepEqual(Object.keys((meta['relocat/signIn'] as { say: object }).say), ['en', 'ca', 'es']);
    }
    // The host's language is used when the call states none.
    const spanish = await client.callTool({
      name: 'get_person',
      arguments: {},
      _meta: { 'openai/locale': 'es-ES' },
    });
    assert.match((spanish.content as Content)[1].text, /^Para usar tu perfil de ReloCat, primero tienes que conectar/);
  } finally {
    await close();
  }
});

test('journey signed in: confirmed answers are saved, a habit is created, and both count in the plan', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin, db } = server;
  const browser = new Browser(origin);
  await browser.signUp('laia@example.com');
  const client = new Client({ name: 'journey-flow', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', origin), {
      requestInit: { headers: { Cookie: `rc_session=${browser.cookies.get('rc_session')}`, Origin: origin } },
    }),
  );
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert(!response.isError, `${name}: ${textOf(response)}`);
    return { data: response.structuredContent as Record<string, unknown>, text: textOf(response) };
  };

  assert.match(client.getInstructions() ?? '', /The plan is plan_home_savings and nothing else/);
  const start = await call('start_homebuying_interview');
  assert.equal(start.data.signedIn, true);
  assert.match((start.data.nextSteps as string[])[0], /^Call get_next_questions with me:true/);

  // Nothing stored yet: the first questions, with no place, for "me".
  const first = nextQuestionsResult.parse((await call('get_next_questions', { me: true })).data);
  assert.deepEqual([first.stored, first.sayNotStored, first.nextQuestions[0].id], [true, null, 'monthlyIncome']);
  assert.equal(first.placeQuestion?.inputPath, 'location.selectedMunicipalityCode');

  // Each confirmed answer is saved at its input path; the next call no longer asks it.
  const save = (data: Record<string, unknown>) => call('save_my_inputs', { data, confirmed: true });
  await save({ finance: { monthlyIncomeCents: 229_000 } });
  const second = nextQuestionsResult.parse((await call('get_next_questions', { me: true })).data);
  assert.equal(second.nextQuestions[0].id, 'monthlyExpenses');
  assert(second.knownFacts.some(fact => fact.id === 'monthlyIncome' && fact.confirmed === true));
  await save({ finance: { monthlyExpensesCents: 169_010 } });
  await save({ finance: { currentSavingsCents: 1_574_600, targetCashCents: 4_000_000 } });
  await save({ housing: { budgetCents: 10_800_000 } });
  // The place the person chose is an answer like the others, and is used when the call names none.
  await save({ location: { selectedMunicipalityCode: termens } });
  const chosen = planResult.parse((await call('plan_home_savings', { me: true })).data);
  assert.deepEqual(
    chosen.plans.map(item => item.place.municipalityCode),
    [termens],
  );
  const before = chosen.plans[0];
  assert.deepEqual(
    [chosen.stored, before.status, before.monthsSavedByPlace, before.monthsSavedByHabits],
    [true, 'estimated', 0, 0],
  );
  // The stated upfront target is shown beside the computed figure, which the timeline keeps using.
  assert.deepEqual(before.upfrontTarget, {
    statedCents: 4_000_000,
    computedCents: 3_456_000,
    differenceCents: 544_000,
    usedByTimeline: 'computed',
  });
  assert.equal(before.baseline?.upfrontCashCents, 3_456_000);

  // The household facts that decide the aid, each confirmed by the person.
  await save({
    eligibility: {
      primaryResidence: true,
      birthDate: '1986-03-14',
      children: [{ birthDate: '2021-05-02', meetsItpSchooling: true, inDesignatedSchool: true }],
      itpTransaction: true,
      satisfiesItpOccupancyRules: true,
      largeFamily: false,
      singleParent: false,
      disability65: false,
      itpFamilyNetTaxBaseEur: 26_000,
    },
  });
  // A habit the person agrees to adopt.
  const habit = await call('save_my_habit', {
    id: 'cook-at-home',
    title: 'Cook at home on weekdays',
    category: 'food',
    monthlySavingCents: 12_000,
  });
  assert.deepEqual([habit.data.created, (habit.data.habit as { status: string }).status], [true, 'active']);
  assert.match(String((habit.data.habit as { startedOn: string }).startedOn), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM habit_goals')?.n, 1);
  const listed = (await call('list_my_habits')).data.habits as { id: string; monthlySavingCents: number }[];
  assert.deepEqual(
    listed.map(item => [item.id, item.monthlySavingCents]),
    [['cook-at-home', 12_000]],
  );
  // Saving it again updates it, and what was left out keeps its stored value.
  const updated = await call('save_my_habit', { id: 'cook-at-home', title: 'Cook at home', category: 'food' });
  assert.deepEqual(
    [updated.data.created, (updated.data.habit as { monthlySavingCents: number }).monthlySavingCents],
    [false, 12_000],
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM habit_goals')?.n, 1);

  // The plan now counts both: the habit on top of declared spending, and the rural transfer tax of the place.
  const after = planResult.parse(
    (await call('plan_home_savings', { me: true, municipalityCodes: [termens, balaguer] })).data,
  );
  const rural = after.plans.find(item => item.place.municipalityCode === termens);
  const city = after.plans.find(item => item.place.municipalityCode === balaguer);
  assert(rural && city);
  assert.deepEqual(
    after.habits?.map(effect => [effect.habitId, effect.counted, effect.reason, effect.countedMonthlyCents]),
    [['cook-at-home', true, 'counted', 12_000]],
  );
  assert((rural.monthsSavedByHabits ?? 0) > 0, 'the habit shortens the wait');
  assert((rural.monthsSavedByPlace ?? 0) > 0, 'the place shortens the wait');
  assert.equal(rural.benefits.find(benefit => benefit.policyId === 'itp_buy')?.counted, true);
  assert.equal(city.monthsSavedByPlace, 0);
  assert((rural.withPlaceBenefits?.months ?? 0) < (before.withPlaceBenefits?.months ?? 0));
  assert.equal(after.person.synthetic, false);
  // Aid that cannot be verified yet stays explained, not counted.
  const youth = rural.benefits.find(benefit => benefit.policyId === 'youth_purchase_small_town');
  assert.equal(youth?.counted, false);
});

test('a persona with confirmed facts and a habit shows what a place and a habit are worth', async () => {
  // The recipe handed to the fixtures: user-004's money, a buyer over 35, one schooled child, one habit.
  const persona = (born: string): PersonInput => ({
    id: 'demo-recipe',
    synthetic: true,
    householdSize: 3,
    born: { self: born, children: [{ birthDate: '2021-05-02', meetsItpSchooling: true, inDesignatedSchool: true }] },
    household: {
      primaryResidence: true,
      itpTransaction: true,
      satisfiesItpOccupancyRules: true,
      largeFamily: false,
      singleParent: false,
      disability65: false,
      firstRuralMove: true,
      ownsHomeInSpain: false,
      incomeWithinFiveIprem: true,
      filing: 'joint',
      itpBuyerNetTaxBaseEur: 14_000,
      itpFamilyNetTaxBaseEur: 26_000,
      irpfNetTaxBaseEur: 26_000,
    },
    finances: { monthlyIncomeCents: 229_000, monthlyExpensesCents: 169_010, currentSavingsCents: 1_574_600 },
    home: { budgetCents: 10_800_000 },
    habits: [
      {
        id: 'cook-at-home',
        title: 'Cook at home on weekdays',
        category: 'food',
        monthlySavingCents: 12_000,
        status: 'active',
        startedOn: '2026-11-10',
      },
    ],
  });
  const { client, close } = await connect();
  try {
    const months = async (born: string) => {
      const response = await client.callTool({
        name: 'plan_home_savings',
        arguments: { person: persona(born), municipalityCodes: [termens, talarn, balaguer] },
      });
      assert(!response.isError, textOf(response));
      const plan = planResult.parse(response.structuredContent);
      return Object.fromEntries<(number | null | undefined)[]>(
        plan.plans.map(item => [
          item.place.municipalityCode,
          [
            item.baseline?.months,
            item.withHabits?.months,
            item.withPlaceBenefits?.months,
            item.monthsSavedByHabits,
            item.monthsSavedByPlace,
          ],
        ]),
      );
    };
    const older = await months('1986-03-14');
    for (const code of [termens, talarn]) {
      const [, , , byHabits, byPlace] = older[code];
      assert((byHabits ?? 0) > 0 && (byPlace ?? 0) > 0, code);
    }
    assert.deepEqual(older, {
      [termens]: [32, 27, 15, 5, 12],
      [talarn]: [32, 27, 17, 5, 10],
      [balaguer]: [32, 27, 27, 5, 0],
    });
    // A buyer of 29 already pays 5% anywhere, so a rural place is credited with less, never with nothing.
    const younger = await months('1997-03-14');
    assert.deepEqual(younger[termens], [23, 19, 15, 4, 4]);
    assert.deepEqual(younger[balaguer], [23, 19, 19, 4, 0]);
  } finally {
    await close();
  }
});

test('the voice link is the configured page, else the product’s own voice page, else none', async () => {
  assert.equal(voiceUrlConfig({}), null);
  // The own voice page is linked only when it is open to visitors.
  assert.equal(voiceUrlConfig({ PUBLIC_ORIGIN: 'https://www.relo.cat' }), null);
  assert.equal(
    voiceUrlConfig({ PUBLIC_ORIGIN: 'https://www.relo.cat', INTERVIEWER_PUBLIC_AI: 'on' }),
    'https://www.relo.cat/interview/',
  );
  assert.equal(
    voiceUrlConfig({ PUBLIC_ORIGIN: 'https://www.relo.cat/', RELOCAT_VOICE_URL: '', INTERVIEWER_PUBLIC_AI: 'on' }),
    'https://www.relo.cat/interview/',
  );
  assert.equal(
    voiceUrlConfig({ PUBLIC_ORIGIN: 'https://www.relo.cat', RELOCAT_VOICE_URL: 'https://voice.example/talk' }),
    'https://voice.example/talk',
  );
  // An explicit link that is not a plain https page is ignored, and the product's own page is used.
  for (const bad of [
    'http://voice.example/',
    'https://user:pw@voice.example/',
    'https://voice.example/?t=1',
    'nonsense',
  ])
    assert.equal(
      voiceUrlConfig({ PUBLIC_ORIGIN: 'https://www.relo.cat', RELOCAT_VOICE_URL: bad, INTERVIEWER_PUBLIC_AI: 'on' }),
      'https://www.relo.cat/interview/',
      bad,
    );
  assert.equal(voiceUrlConfig({ PUBLIC_ORIGIN: 'not a url' }), null);

  // The card and `voiceUrl` point at that page.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  for (const voiceUrl of ['https://www.relo.cat/interview/', null]) {
    const server = new McpServer({ name: 'voice-test', version: '1' });
    registerInterviewerTools(server, { voiceUrl });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'voice-test', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const start = await client.callTool({ name: 'start_homebuying_interview', arguments: { locale: 'ca' } });
      const data = start.structuredContent as { voiceUrl: string | null; voiceSetup: string };
      assert.equal(data.voiceUrl, voiceUrl);
      assert.match(data.voiceSetup, /«Fes servir ReloCat per començar la meva entrevista de compra d’habitatge\.»/);
      const card = (await client.readResource({ uri: 'ui://relocat/start-talking.html' })).contents[0];
      assert('text' in card);
      assert.equal(card.text.includes('href="https://www.relo.cat/interview/"'), voiceUrl !== null);
      const redirect = (card._meta as Record<string, { redirect_domains?: string[] }> | undefined)?.[
        'openai/widgetCSP'
      ];
      assert.deepEqual(redirect?.redirect_domains, voiceUrl ? ['https://www.relo.cat'] : undefined);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  }
});
