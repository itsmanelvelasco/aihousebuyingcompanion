import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FactAnswers } from '../apps/interviewer/facts.ts';
import {
  answeredFacts,
  applySpokenFacts,
  coveredByInterview,
  factInstructions,
  factQuestionsToAsk,
  factToolParameters,
  profileAccess,
  profileData,
  saveToProfile,
  voiceFactContext,
} from '../apps/interviewer/facts.ts';
import { createInterviewerHandler, type InterviewerOptions, interviewerEnv } from '../apps/interviewer/server.ts';
import { registerInterviewerTools } from '../apps/mcp-server/interview-tools.ts';
import { inputSchema } from '../packages/contracts/inputs.ts';
import { planResult } from '../packages/contracts/planner.ts';
import { questions } from '../packages/model/questions.ts';
import { Browser, mcp, startApp } from './support/app.ts';

const prefix = '/interview';
const fakeKey = 'fake-test-key';
const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

type Call = { url: string; init: RequestInit };

/** Serve the handler on a free loopback port with a recording stand-in for OpenAI. */
async function serve(options: InterviewerOptions = {}, upstream: () => Response = () => new Response('{}')) {
  const calls: Call[] = [];
  const fetcher = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return upstream();
  }) as typeof fetch;
  const server = createServer(createInterviewerHandler({ prefix, fetcher, ...options }));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const local = `127.0.0.1:${port}`;

  /** A raw request, so tests control Host, Origin and proxy headers exactly as a remote client could. */
  function send(method: string, path: string, headers: Record<string, string> = {}, body = '') {
    return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text }));
      });
      request.on('error', reject);
      request.end(body);
    });
  }
  const localHeaders = (type: string) => ({ host: local, origin: `http://${local}`, 'content-type': type });
  const publicHeaders = (type: string, client: string) => ({
    host: 'www.relo.cat',
    origin: 'https://www.relo.cat',
    'content-type': type,
    'x-forwarded-for': client,
  });
  return { send, calls, local, localHeaders, publicHeaders };
}

const descriptors = JSON.stringify([
  { direction: 'out', description: 'corner bakery' },
  { direction: 'in', description: 'acme payroll' },
]);
const json = 'application/json';
const sdp = 'application/sdp';
const paid = [
  ['/classify', json, descriptors],
  ['/voice', sdp, 'v=0'],
] as const;

test('the page, its bundle and the demo statement are served under the prefix with relative URLs', async () => {
  const { send } = await serve();
  const redirect = await send('GET', '/interview?x=1');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/interview/?x=1');

  // A public host gets the page too: only the paid routes are restricted.
  const page = await send('GET', '/interview/', { host: 'www.relo.cat' });
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.match(page.text, /<script src="app\.js"><\/script>/);
  assert.doesNotMatch(page.text, /(src|href)="\//);

  const bundle = await send('GET', '/interview/app.js');
  assert.equal(bundle.status, 200);
  assert.match(String(bundle.headers['content-type']), /text\/javascript/);
  assert.match(bundle.text, /fetch\("scenario"/);
  assert.doesNotMatch(bundle.text, /fetch\(\s*["'`]\//);

  const csv = await send('GET', '/interview/demo.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^date,description,amount/);

  for (const path of ['/', '/app.js', '/interviewer/', '/interview/missing', '/interview/../package.json']) {
    assert.equal((await send('GET', path)).status, 404, path);
  }
});

test('/scenario is public and returns the shared savings timeline', async () => {
  const { send, calls } = await serve();
  const headers = { host: 'www.relo.cat', 'content-type': json };
  const input = { target: 30000, saved: 6000, monthly: 600, currency: 'EUR' };
  const result = await send('POST', '/interview/scenario', headers, JSON.stringify(input));
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { currency: 'EUR', remaining: 24000, baselineMonths: 40, suggestions: [] });

  const stalled = await send('POST', '/interview/scenario', headers, JSON.stringify({ ...input, monthly: 0 }));
  assert.equal(JSON.parse(stalled.text).baselineMonths, null);

  const demo = await send('POST', '/interview/scenario', headers, JSON.stringify({ ...input, useDemoBank: true }));
  assert.equal(JSON.parse(demo.text).baselineMonths, 40);

  assert.equal((await send('POST', '/interview/scenario', headers, '{"target":0}')).status, 400);
  assert.equal((await send('POST', '/interview/scenario', { host: 'www.relo.cat' }, '{}')).status, 415);
  const large = JSON.stringify({ ...input, padding: 'x'.repeat(3000) });
  assert.equal((await send('POST', '/interview/scenario', headers, large)).status, 413);
  assert.equal(calls.length, 0);
});

test('paid routes are refused for non-local requests unless public AI is switched on', async () => {
  const { send, calls, local, localHeaders, publicHeaders } = await serve({ apiKey: fakeKey });
  for (const [route, type, body] of paid) {
    const refused: Record<string, string>[] = [
      // A visitor on the public site, exactly as a browser there would send it.
      { host: 'www.relo.cat', origin: 'https://www.relo.cat', 'content-type': type },
      publicHeaders(type, '203.0.113.9'),
      // A tunnel that rewrites Host to the local address still reveals itself through proxy headers.
      { ...localHeaders(type), 'x-forwarded-for': '203.0.113.9' },
      { ...localHeaders(type), 'cf-connecting-ip': '203.0.113.9' },
      // A local name on another port is not this listener.
      { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', 'content-type': type },
      { host: `evil.example:${local.split(':')[1]}`, origin: `http://${local}`, 'content-type': type },
    ];
    for (const headers of refused) {
      const result = await send('POST', `/interview${route}`, headers, body);
      assert.equal(result.status, 403, `${route} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(calls.length, 0);
});

test('paid routes are refused cross-origin in both modes', async () => {
  for (const publicAi of [false, true]) {
    const { send, calls, local, localHeaders } = await serve({ apiKey: fakeKey, publicAi });
    for (const [route, type, body] of paid) {
      const base = localHeaders(type);
      const refused: Record<string, string>[] = [
        { ...base, origin: 'https://evil.example' },
        { ...base, origin: `http://localhost.evil.example:${local.split(':')[1]}` },
        { ...base, origin: 'null' },
        { host: local, 'content-type': type },
        { host: 'www.relo.cat', origin: 'https://evil.example', 'content-type': type },
        { host: 'www.relo.cat', 'content-type': type },
      ];
      if (publicAi) refused.push({ ...base, 'sec-fetch-site': 'cross-site' });
      for (const headers of refused) {
        const result = await send('POST', `/interview${route}`, headers, body);
        assert.equal(result.status, 403, `${publicAi} ${route} ${JSON.stringify(headers)}`);
      }
    }
    assert.equal(calls.length, 0);
  }
});

test('paid routes answer 503 without a key, locally and in public mode', async () => {
  for (const publicAi of [false, true]) {
    const { send, calls, localHeaders } = await serve({ publicAi });
    for (const [route, type, body] of paid) {
      const result = await send('POST', `/interview${route}`, localHeaders(type), body);
      assert.equal(result.status, 503, route);
    }
    assert.equal(calls.length, 0);
  }
});

test('a local same-origin request reaches OpenAI through the injected fetch and never sees the key', async () => {
  const answers = [
    { type: 'choice', name: 'transaction_0', choice: 'Eating out', confidence: 0.9 },
    { type: 'choice', name: 'transaction_1', choice: 'Payroll', confidence: 0.4 },
  ];
  const classify = await serve({ apiKey: fakeKey }, () => Response.json({ answers }));
  const result = await classify.send('POST', '/interview/classify', classify.localHeaders(json), descriptors);
  assert.equal(result.status, 200);
  // The low-confidence answer falls back to the page's local rules.
  assert.deepEqual(JSON.parse(result.text), { categories: ['Eating out', null] });
  assert.equal(classify.calls.length, 1);
  assert.equal(classify.calls[0].url, 'https://api.openai.com/v1/decisions');
  assert.equal(new Headers(classify.calls[0].init.headers).get('authorization'), `Bearer ${fakeKey}`);
  assert.doesNotMatch(result.text, new RegExp(fakeKey));

  const voice = await serve({ apiKey: fakeKey }, () => new Response('v=0 answer'));
  const answer = await voice.send('POST', '/interview/voice', voice.localHeaders(sdp), 'v=0 offer');
  assert.equal(answer.status, 200);
  assert.equal(answer.text, 'v=0 answer');
  assert.match(String(answer.headers['content-type']), /application\/sdp/);
  assert.equal(voice.calls[0].url, 'https://api.openai.com/v1/realtime/calls');
  assert.equal((voice.calls[0].init.body as FormData).get('sdp'), 'v=0 offer');

  const rejected = await serve({ apiKey: fakeKey }, () => new Response(`bad key ${fakeKey}`, { status: 401 }));
  for (const [route, type, body] of paid) {
    const failure = await rejected.send('POST', `/interview${route}`, rejected.localHeaders(type), body);
    assert.equal(failure.status, 502, route);
    assert.doesNotMatch(failure.text, new RegExp(fakeKey));
  }

  const broken = await serve({ apiKey: fakeKey }, () => {
    throw new Error(`network down ${fakeKey}`);
  });
  const failure = await broken.send('POST', '/interview/voice', broken.localHeaders(sdp), 'v=0');
  assert.equal(failure.status, 502);
  assert.doesNotMatch(failure.text, new RegExp(fakeKey));
});

test('public AI is same-origin, limited per client and capped across clients', async () => {
  let time = 1_000_000;
  const options = { apiKey: fakeKey, publicAi: true, aiRequestsPerHour: 2, now: () => time };
  const { send, calls, publicHeaders } = await serve(options, () => new Response('v=0 answer'));
  const voice = (client: string) => send('POST', '/interview/voice', publicHeaders(sdp, client), 'v=0');

  assert.equal((await voice('203.0.113.1')).status, 200);
  assert.equal((await voice('203.0.113.1')).status, 200);
  const limited = await voice('203.0.113.1');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '3600');
  // Both paid routes share one allowance, and a spoofed leading address does not buy a new one.
  const classify = await send('POST', '/interview/classify', publicHeaders(json, '203.0.113.1'), descriptors);
  assert.equal(classify.status, 429);
  assert.equal((await voice('198.51.100.7, 203.0.113.1')).status, 429);
  // Nor does a CF-Connecting-IP header the client wrote itself: it is not the configured header.
  const forged = { ...publicHeaders(sdp, '203.0.113.1'), 'cf-connecting-ip': '198.51.100.99' };
  assert.equal((await send('POST', '/interview/voice', forged, 'v=0')).status, 429);
  assert.equal(calls.length, 2);

  assert.equal((await voice('203.0.113.2')).status, 200);
  time += 3_600_000;
  assert.equal((await voice('203.0.113.1')).status, 200);

  // Ten times the per-client allowance is the ceiling for everyone together.
  const shared = await serve({ ...options, aiRequestsPerHour: 1 }, () => new Response('v=0 answer'));
  const statuses: number[] = [];
  for (let client = 1; client <= 11; client++) {
    const headers = shared.publicHeaders(sdp, `198.51.100.${client}`);
    statuses.push((await shared.send('POST', '/interview/voice', headers, 'v=0')).status);
  }
  assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
  assert.equal(shared.calls.length, 10);
});

test('body limits hold before anything is sent upstream', async () => {
  for (const publicAi of [false, true]) {
    const { send, calls, localHeaders } = await serve({ apiKey: fakeKey, publicAi });
    const one = { direction: 'out', description: 'corner bakery' };
    const cases: [route: string, type: string, body: string, status: number][] = [
      ['/classify', json, JSON.stringify(Array(81).fill(one)), 400],
      ['/classify', json, JSON.stringify([{ ...one, description: 'a'.repeat(101) }]), 400],
      ['/classify', json, JSON.stringify([{ ...one, description: 'IBAN ES12 3456' }]), 400],
      ['/classify', json, JSON.stringify([{ ...one, description: 'a'.repeat(20_001) }]), 413],
      ['/classify', 'text/plain', descriptors, 415],
      ['/voice', sdp, 'v'.repeat(65_537), 413],
      ['/voice', json, 'v=0', 415],
    ];
    for (const [route, type, body, status] of cases) {
      const result = await send('POST', `/interview${route}`, localHeaders(type), body);
      assert.equal(result.status, status, `${route} ${type} ${body.length}`);
    }
    assert.equal(calls.length, 0);
  }
});

test('environment options keep public AI off unless it is switched on explicitly', () => {
  assert.deepEqual(interviewerEnv({}), {
    apiKey: undefined,
    publicAi: false,
    aiRequestsPerHour: 20,
    models: interviewerEnv({}).models,
  });
  assert.equal(interviewerEnv({ INTERVIEWER_PUBLIC_AI: 'yes please' }).publicAi, false);
  assert.equal(interviewerEnv({ INTERVIEWER_PUBLIC_AI: 'on', OPENAI_API_KEY: '' }).publicAi, true);
  assert.equal(interviewerEnv({ OPENAI_API_KEY: '' }).apiKey, undefined);
  assert.equal(interviewerEnv({ INTERVIEWER_AI_REQUESTS_PER_HOUR: '5' }).aiRequestsPerHour, 5);
});

test('a statement of a single day is never presented as a monthly figure, by the tool or by the interview', async () => {
  const server = new McpServer({ name: 'interview-test', version: '1' });
  registerInterviewerTools(server);
  const client = new Client({ name: 'test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  type Block = { type: string; text: string };
  const summarize = async (rows: string[]) => {
    const result = await client.callTool({
      name: 'summarize_bank_csv',
      arguments: { csv: ['date,description,amount', ...rows].join('\n') },
    });
    assert(!result.isError, JSON.stringify(result.content));
    return { content: result.content as Block[], data: result.structuredContent as Record<string, unknown> };
  };
  try {
    // One day of movements. The output passes the tool's own schema with every monthly figure null.
    const day = await summarize(['2026-10-28,Salary,2000', '2026-10-28,Mercadona,-45']);
    assert.deepEqual(
      [day.data.averageBasis, day.data.coveredDays, day.data.monthlyCostOfLiving, day.data.estimatedMonthlySalary],
      ['period_too_short', 1, null, null],
    );
    assert.deepEqual(day.data.periodTotals, { inflows: 2000, outflows: 45, net: 1955 });
    // The first thing the model reads is that the period is too short and that it must ask for more.
    assert.match(day.content[0].text, /^The statement covers only a single day \(2026-10-28\), which is too short/);
    assert.match(day.content[0].text, /Do not present any amount as monthly income, spending or an average/);
    assert.match(day.content[0].text, /ask for a statement covering at least one complete calendar month/);
    assert.equal(JSON.parse(day.content[1].text).averageBasis, 'period_too_short');
    // Partial months: a caution. Complete months: no caution, just the figures.
    const partial = await summarize(['2026-10-15,Salary,2000', '2026-11-20,Rent,-900']);
    assert.match(partial.content[0].text, /rough indication, not a monthly average/);
    const complete = await summarize([
      '2026-08-31,Coffee,-3',
      '2026-09-01,Salary,2000',
      '2026-09-15,Rent,-900',
      '2026-10-01,Coffee,-3',
    ]);
    assert.equal(complete.content.length, 1);
    assert.deepEqual([complete.data.averageBasis, complete.data.monthlyCostOfLiving], ['complete_months', 900]);
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'summarize_bank_csv');
    assert.match(tool?.description ?? '', /period_too_short.*say the period is too short for a monthly figure/);
  } finally {
    await client.close();
    await server.close();
  }
  // The interview page takes its questions and the note for the voice model from the same rule, and
  // no longer builds a sentence around the raw figure.
  const page = await readFile(new URL('../apps/interviewer/app.ts', import.meta.url), 'utf8');
  assert.match(page, /cashFlowStatements\(state\.cash, money\)\.salaryQuestion/);
  assert.match(page, /cashFlowStatements\(state\.cash, money\)\.spendingQuestion/);
  assert.match(page, /cashFlowStatements\(state\.cash, money\)\.guidance/);
  assert.doesNotMatch(page, /Average spending was/);
  assert.match(page, /period_too_short[^`]*say the period is too short for a monthly figure/);
});

// ------------------------------------------------------------ plan facts

const day = '2026-11-22';

test('the guided interview asks the shared question set after the money questions, in its order', () => {
  const ids = (answers: FactAnswers) => factQuestionsToAsk(answers, day).map(question => question.id);
  // The interview already asked how much is set aside, so that figure is not asked twice.
  assert.deepEqual(coveredByInterview, ['purchaseSavings']);
  assert.deepEqual(ids({}).slice(0, 5), [
    'monthlyIncome',
    'monthlyExpenses',
    'homeBudget',
    'floorArea',
    'primaryResidence',
  ]);
  assert(!ids({}).includes('purchaseSavings'));
  // The same applicability as everywhere else: no schooling question without a child of that age.
  assert(!ids({}).includes('childrenItpSchooling'));
  assert(!ids({ children: [] }).includes('childrenIrpfSchooling'));
  assert(ids({ children: [{ birthDate: '2019-04-02' }] }).includes('childrenItpSchooling'));
  assert(!ids({ homeBudget: 15_000_000 }).includes('floorArea'));
  // An answer, "I don't know" included, is not asked again.
  assert(!ids({ itpBuyerNetTaxBase: null, primaryResidence: true }).includes('itpBuyerNetTaxBase'));
  assert.deepEqual(answeredFacts({ itpBuyerNetTaxBase: null, birthDate: '1994-03-02', depositRate: 0.2 }, day), [
    ['Date of birth', 'Born 1994-03-02: 32 on 2026-11-22'],
    ['Your own tax base', 'I don’t know'],
    ['Deposit', '20%'],
  ]);
});

test('spoken answers are captured into the same typed state, validated, and “I don’t know” stays null', () => {
  const parameters = factToolParameters() as {
    properties: Record<string, { type: unknown; enum?: unknown[]; description: string }>;
    additionalProperties: boolean;
  };
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(
    Object.keys(parameters.properties),
    questions.filter(question => question.id !== 'purchaseSavings').map(question => question.id),
  );
  assert.deepEqual(parameters.properties.disability65.type, ['boolean', 'null']);
  assert.deepEqual(parameters.properties.itpBuyerNetTaxBase.type, ['number', 'null']);
  assert.equal(parameters.properties.birthDate.type, 'string');
  assert.deepEqual(parameters.properties.filing.enum, ['individual', 'joint', null]);
  assert.match(parameters.properties.itpBuyerNetTaxBase.description, /Send null when the person says they do not know/);

  const first = applySpokenFacts(
    {
      monthlyIncome: 3200.5, // euros as spoken, kept as cents
      depositRate: 25, // a percentage as spoken, kept as a share
      birthDate: '1994-03-02',
      children: [{ birthDate: '2019-04-02' }],
      childrenItpSchooling: [null],
      itpBuyerNetTaxBase: null,
      itpFamilyNetTaxBase: 28000, // a tax base stays in euros
      disability65: false,
      filing: 'joint',
    },
    {},
    day,
  );
  assert.deepEqual(first.rejected, []);
  assert.deepEqual(first.answers, {
    monthlyIncome: 320_050,
    depositRate: 0.25,
    birthDate: '1994-03-02',
    children: [{ birthDate: '2019-04-02' }],
    childrenItpSchooling: [null],
    itpBuyerNetTaxBase: null,
    itpFamilyNetTaxBase: 28_000,
    disability65: false,
    filing: 'joint',
  });
  // What fails validation is left out and reported, so the model asks again; nothing is guessed.
  const second = applySpokenFacts(
    {
      birthDate: 'March 1994',
      monthlyExpenses: null,
      childrenIrpfSchooling: [true, true],
      shoeSize: 43,
      primaryResidence: true,
    },
    first.answers,
    day,
  );
  assert.deepEqual(second.updated, ['primaryResidence']);
  assert.deepEqual(
    second.rejected.map(item => item.id),
    ['monthlyExpenses', 'birthDate', 'childrenIrpfSchooling', 'shoeSize'],
  );
  assert.equal(second.answers.birthDate, '1994-03-02', 'a rejected value never overwrites an answer');
  assert.equal('monthlyExpenses' in second.answers, false, 'spending cannot be unknown, and is not stored as zero');
  // A schooling answer without a child to answer it for is refused.
  assert.match(
    applySpokenFacts({ childrenItpSchooling: [true] }, {}, day).rejected[0].reason,
    /no child aged 16 or younger/,
  );
  // The amount already saved is the interview's own question; the voice tool cannot write it as a fact.
  assert.deepEqual(applySpokenFacts({ purchaseSavings: 5000 }, {}, day).updated, []);
});

test('the voice session is told which facts are answered and what to ask next, never the answers', () => {
  const answers: FactAnswers = {
    monthlyIncome: 320_000,
    monthlyExpenses: 230_000,
    homeBudget: 15_000_000,
    disability65: true,
    itpBuyerNetTaxBase: 21_500,
    itpFamilyNetTaxBase: 47_250,
    largeFamily: true,
    birthDate: '1994-03-02',
  };
  const context = voiceFactContext(answers, day);
  assert.deepEqual(context.answeredFactIds, [
    'monthlyIncome',
    'monthlyExpenses',
    'homeBudget',
    'birthDate',
    'largeFamily',
    'disability65',
    'itpBuyerNetTaxBase',
    'itpFamilyNetTaxBase',
  ]);
  assert.equal(context.nextFactQuestion?.id, 'primaryResidence');
  assert.match(context.nextFactQuestion?.why ?? '', /home you live in/);
  const sent = JSON.stringify(context);
  for (const value of ['21500', '47250', '1994-03-02', '15000000', '320000'])
    assert(!sent.includes(value), `${value} is not sent`);
  assert.doesNotMatch(sent, /"disability65":\s*true|"largeFamily":\s*true/);
  assert.equal(voiceFactContext({ ...answers, primaryResidence: true }, day).nextFactQuestion?.id, 'children');
  // The instructions lead the model: one question, the reason, confirmation before saving, null for unknown.
  assert.match(factInstructions, /one per turn/);
  assert.match(factInstructions, /save null, never zero, never a\s+guess/);
  assert.match(factInstructions, /only after the person confirms it/);
});

test('the page offers to save only through a relative link and a button that start hidden', async () => {
  const { send } = await serve();
  const page = (await send('GET', '/interview/')).text;
  // Hidden until the server says who is there: standalone, the answers stay on this device.
  assert.match(page, /<p id="profile-status" class="hint" role="status">These answers are only on this device\.<\/p>/);
  assert.match(page, /<button id="save-profile" class="rc-btn rc-btn--gold" hidden>/);
  assert.match(page, /<a id="profile-signin" class="rc-btn" href="\.\.\/login\?next=%2Finterview%2F" hidden>/);
  const script = (await send('GET', '/interview/app.js')).text;
  assert.match(script, /save_plan_facts/);
  assert.match(script, /save_my_inputs/);
});

test('the classification call never carries a tax base, a disability or any other plan fact', async () => {
  const { send, calls, localHeaders } = await serve(
    { apiKey: fakeKey },
    () =>
      new Response(
        JSON.stringify({ answers: [{ type: 'choice', name: 'transaction_0', choice: 'Groceries', confidence: 0.9 }] }),
      ),
  );
  const body = JSON.stringify([
    {
      direction: 'out',
      description: 'corner bakery',
      itpBuyerNetTaxBaseEur: 21500,
      disability65: true,
      birthDate: '1994-03-02',
    },
  ]);
  const response = await send('POST', '/interview/classify', localHeaders(json), body);
  assert.equal(response.status, 200);
  const upstream = String(calls[0].init.body);
  assert.match(upstream, /corner bakery/);
  assert.doesNotMatch(upstream, /21500|disability|1994-03-02|TaxBase/);
});

test('saving to the profile is one same-origin save_my_inputs call with the session cookie and nothing else', async () => {
  const answers: FactAnswers = {
    monthlyIncome: 320_000,
    birthDate: '1994-03-02',
    children: [{ birthDate: '2019-04-02' }],
    childrenItpSchooling: [true],
    childrenIrpfSchooling: [null],
    itpBuyerNetTaxBase: null,
    disability65: false,
    depositRate: 0.25,
  };
  const data = profileData(answers, { currency: 'EUR', saved: 10_000, target: 30_000.5, householdSize: 3 }, day);
  assert.deepEqual(data, {
    finance: { currentSavingsCents: 1_000_000, targetCashCents: 3_000_050, monthlyIncomeCents: 320_000 },
    eligibility: {
      birthDate: '1994-03-02',
      children: [{ birthDate: '2019-04-02', meetsItpSchooling: true, inDesignatedSchool: null }],
      disability65: false,
      itpBuyerNetTaxBaseEur: null,
    },
    housing: { depositRate: 0.25 },
    household: { size: 3 },
  });
  // The record is valid for the profile as it is.
  inputSchema.parse({
    id: 'i',
    source: 'interview',
    observedAt: '2026-11-22T10:00:00Z',
    confirmed: true,
    synthetic: false,
    data,
  });
  // Savings in another currency are not converted and not saved; with nothing answered there is nothing to save.
  assert.deepEqual(profileData({ birthDate: '1994-03-02' }, { currency: 'USD', saved: 10_000 }, day), {
    eligibility: { birthDate: '1994-03-02' },
  });
  assert.equal(profileData({}, { currency: 'USD', saved: 10_000 }, day), null);

  type Sent = { url: string; init: RequestInit };
  const record = (answer: () => Response) => {
    const sent: Sent[] = [];
    const fetcher = (async (url: unknown, init: RequestInit = {}) => {
      sent.push({ url: String(url), init });
      return answer();
    }) as typeof fetch;
    return { sent, fetcher };
  };
  const rpc = (result: unknown, status = 200) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const ok = record(() => rpc({ structuredContent: { saved: true, inputId: 'mcp-1', inputCount: 1 } }));
  assert.deepEqual(await saveToProfile(data, ok.fetcher, 'https://www.relo.cat/mcp'), {
    saved: true,
    inputId: 'mcp-1',
  });
  assert.equal(ok.sent.length, 1);
  assert.equal(ok.sent[0].url, 'https://www.relo.cat/mcp');
  assert.deepEqual([ok.sent[0].init.method, ok.sent[0].init.credentials], ['POST', 'same-origin']);
  assert.deepEqual(Object.keys(ok.sent[0].init.headers as object).sort(), ['Accept', 'Content-Type']);
  assert.deepEqual(JSON.parse(String(ok.sent[0].init.body)), {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'save_my_inputs', arguments: { data, confirmed: true, source: 'interview' } },
  });

  // Signed out: the tool's own answer says so. Standalone: there is no such endpoint. Neither loses the answers.
  const signedOut = record(() =>
    rpc(
      { isError: true, content: [{ type: 'text', text: 'Sign in' }], _meta: { 'mcp/www_authenticate': ['Bearer'] } },
      401,
    ),
  );
  const refused = await saveToProfile(data, signedOut.fetcher, '/mcp');
  assert.deepEqual([refused.saved, refused.saved ? '' : refused.reason], [false, 'signed_out']);
  const alone = record(() => new Response('Not found', { status: 404 }));
  const nowhere = await saveToProfile(data, alone.fetcher, '/mcp');
  assert.deepEqual([nowhere.saved, nowhere.saved ? '' : nowhere.reason], [false, 'unavailable']);
  assert.match(nowhere.saved ? '' : nowhere.message, /stay on this device/);
  const empty = record(() => rpc({}));
  assert.deepEqual((await saveToProfile(null, empty.fetcher, '/mcp')).saved, false);
  assert.equal(empty.sent.length, 0, 'nothing to save sends nothing');
  const down = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  assert.equal((await saveToProfile(data, down, '/mcp')).saved, false);

  // Where the page runs decides what it offers.
  assert.equal(await profileAccess(alone.fetcher, '/mcp'), 'standalone');
  assert.equal(
    await profileAccess(record(() => rpc({ structuredContent: { signedIn: false } })).fetcher, '/mcp'),
    'signed_out',
  );
  const asking = record(() => rpc({ structuredContent: { signedIn: true } }));
  assert.equal(await profileAccess(asking.fetcher, '/mcp'), 'signed_in');
  assert.equal(JSON.parse(String(asking.sent[0].init.body)).params.name, 'show_workspace', 'it reads no personal data');
});

test('on the main server, the interview answers of a signed-in person reach their profile and their plan', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin, db } = server;
  const endpoint = `${origin}/mcp`;
  const browser = new Browser(origin);
  // A page's fetch on that origin: the cookie jar of the browser, as `credentials: 'same-origin'` sends it.
  const pageFetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    assert.equal(init.credentials, 'same-origin');
    const session = browser.cookies.get('rc_session');
    return fetch(input, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Origin: origin,
        ...(session ? { Cookie: `rc_session=${session}` } : {}),
      },
    });
  }) as typeof fetch;
  const answers: FactAnswers = {
    monthlyIncome: 320_000,
    monthlyExpenses: 230_000,
    floorArea: 90,
    primaryResidence: true,
    children: [{ birthDate: `${new Date().getUTCFullYear() - 7}-01-15` }],
    itpTransaction: true,
    itpOccupancy: true,
    childrenItpSchooling: [true],
    itpFamilyNetTaxBase: 28_000,
    itpBuyerNetTaxBase: null,
  };
  const today = new Date().toISOString().slice(0, 10);
  const data = profileData(answers, { currency: 'EUR', saved: 10_000 }, today);

  // Signed out: the page is told so, and a save stores nothing.
  assert.equal(await profileAccess(pageFetch, endpoint), 'signed_out');
  const refused = await saveToProfile(data, pageFetch, endpoint);
  assert.deepEqual([refused.saved, refused.saved ? '' : refused.reason], [false, 'signed_out']);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM input_records')?.n, 0);

  await browser.signUp('ada@example.com');
  assert.equal(await profileAccess(pageFetch, endpoint), 'signed_in');
  const saved = await saveToProfile(data, pageFetch, endpoint);
  assert.equal(saved.saved, true);
  const rows = db.all<{ source: string; confirmed: number; synthetic: number; data: string }>(
    'SELECT source, confirmed, synthetic, data FROM input_records',
  );
  assert.deepEqual(
    rows.map(row => [row.source, row.confirmed, row.synthetic]),
    [['interview', 1, 0]],
  );
  assert.equal(JSON.parse(rows[0].data).eligibility.itpBuyerNetTaxBaseEur, null, 'an unknown is stored as null');
  // The plan of that person now counts the rural rate from those answers.
  const cookie = { Cookie: `rc_session=${browser.cookies.get('rc_session')}`, Origin: origin };
  const plan = planResult.parse(
    (await mcp(origin, 'plan_home_savings', { me: true, municipalityCodes: ['252154'] }, cookie)).result
      ?.structuredContent,
  );
  const rate = plan.plans[0].benefits.find(benefit => benefit.policyId === 'itp_buy');
  assert.deepEqual([rate?.eligibilityStatus, rate?.counted], ['eligible', true]);
  assert.equal(plan.knownFacts?.find(fact => fact.id === 'children')?.source, 'interview');
});
