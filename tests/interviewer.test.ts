import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { cashQuestions, moneyIn, statementNote } from '../apps/interviewer/cash.ts';
import type { FactAnswers } from '../apps/interviewer/facts.ts';
import {
  answeredFacts,
  applySpokenFacts,
  factInstructions,
  factQuestionsToAsk,
  factToolParameters,
  profileAccess,
  profileData,
  saveToProfile,
  toolCaller,
  voiceFactContext,
  voiceLanguageChange,
  voiceLanguageInstruction,
} from '../apps/interviewer/facts.ts';
import { interview } from '../apps/interviewer/messages.ts';
import { createInterviewerHandler, type InterviewerOptions, interviewerEnv } from '../apps/interviewer/server.ts';
import { createInterview, emptyJourney } from '../apps/interviewer/session.ts';
import { voiceInstructions } from '../apps/interviewer/voice.ts';
import { registerInterviewerTools } from '../apps/mcp-server/interview-tools.ts';
import { inputSchema } from '../packages/contracts/inputs.ts';
import { planResult } from '../packages/contracts/planner.ts';
import { cashFlowStatements, expenseCategories, summarizeCsv } from '../packages/finance/csv.ts';
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
  assert.match(bundle.text, /fetch\("classify"/);
  // The page's plan is plan_home_savings over /mcp: it no longer asks the what-if route for a timeline.
  assert.doesNotMatch(bundle.text, /fetch\("scenario"/);
  assert.match(bundle.text, /plan_home_savings/);
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

// ------------------------------------------------- the card embedded in a chat

const chatHost = 'https://web-sandbox.oaiusercontent.com';
/** A request as a browser sends it from a page of another site, through the public host. */
const embedHeaders = (origin: string, client = '203.0.113.9') => ({
  host: 'www.relo.cat',
  origin,
  'content-type': sdp,
  'sec-fetch-site': 'cross-site',
  'x-forwarded-for': client,
});

test('/voice answers a card on an allowed embedding origin, and only /voice', async () => {
  const logged: string[] = [];
  const options = {
    apiKey: fakeKey,
    publicAi: true,
    publicOrigin: 'https://www.relo.cat',
    embedOrigins: [chatHost],
    log: (message: string) => void logged.push(message),
  };
  const { send, calls } = await serve(options, () => new Response('v=0 answer'));

  // The preflight of `Content-Type: application/sdp`: answered, with nothing sent upstream.
  const preflight = await send('OPTIONS', '/interview/voice', {
    host: 'www.relo.cat',
    origin: chatHost,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], chatHost);
  assert.equal(preflight.headers['access-control-allow-methods'], 'POST');
  assert.match(String(preflight.headers['access-control-allow-headers']), /content-type/i);
  // No cookie is read by the route, and none is allowed.
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  assert.equal(calls.length, 0);

  const answer = await send('POST', '/interview/voice', embedHeaders(chatHost), 'v=0 offer');
  assert.equal(answer.status, 200);
  assert.equal(answer.text, 'v=0 answer');
  assert.equal(answer.headers['access-control-allow-origin'], chatHost);
  assert.match(String(answer.headers.vary), /Origin/);
  assert.equal(answer.headers['access-control-allow-credentials'], undefined);
  assert.equal(calls.length, 1);
  assert.equal((calls[0].init.body as FormData).get('sdp'), 'v=0 offer');
  assert.doesNotMatch(answer.text + JSON.stringify(answer.headers), new RegExp(fakeKey));

  // Another site is refused with a JSON error its page can read, and the operator is told once which origin it was.
  for (const origin of ['https://evil.example', 'https://oaiusercontent.com.evil.example', 'null']) {
    const refused = await send('POST', '/interview/voice', embedHeaders(origin), 'v=0 offer');
    assert.equal(refused.status, 403, origin);
    assert.match(JSON.parse(refused.text).error, /INTERVIEWER_EMBED_ORIGINS/);
    assert.equal(refused.headers['access-control-allow-origin'], origin);
  }
  await send('POST', '/interview/voice', embedHeaders('https://evil.example'), 'v=0 offer');
  assert.equal(calls.length, 1);
  assert.equal(logged.length, 3);
  assert.match(logged[0], /origin "https:\/\/evil\.example".*INTERVIEWER_EMBED_ORIGINS/);

  // Categorization is not embeddable: the allowed origin is another site there, as before.
  const classify = await send(
    'POST',
    '/interview/classify',
    { ...embedHeaders(chatHost), 'content-type': json },
    descriptors,
  );
  assert.equal(classify.status, 403);
  assert.equal(classify.headers['access-control-allow-origin'], undefined);
  assert.equal((await send('OPTIONS', '/interview/classify', { host: 'www.relo.cat', origin: chatHost })).status, 404);

  // The page itself is unchanged: same-origin passes, and a same-origin request marked cross-site does not.
  const own = { host: 'www.relo.cat', origin: 'https://www.relo.cat', 'content-type': sdp };
  const page = await send('POST', '/interview/voice', own, 'v=0');
  assert.equal(page.status, 200);
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  assert.equal((await send('POST', '/interview/voice', { ...own, 'sec-fetch-site': 'cross-site' }, 'v=0')).status, 403);
  assert.equal(
    (await send('POST', '/interview/voice', { host: 'www.relo.cat', 'content-type': sdp }, 'v=0')).status,
    403,
  );
});

test('embedding origins are exact origins, host suffixes or any origin, and nothing without public voice', async () => {
  const post = async (options: InterviewerOptions, origin: string) => {
    const { send } = await serve({ apiKey: fakeKey, log: () => {}, ...options }, () => new Response('v=0 answer'));
    return (await send('POST', '/interview/voice', embedHeaders(origin), 'v=0')).status;
  };
  // A suffix covers the hosts under it, over https only, and not a host that merely ends with the same letters.
  const suffix = { publicAi: true, embedOrigins: ['.oaiusercontent.com'] };
  assert.equal(await post(suffix, 'https://abc123.web-sandbox.oaiusercontent.com'), 200);
  assert.equal(await post(suffix, 'http://abc123.oaiusercontent.com'), 403);
  assert.equal(await post(suffix, 'https://oaiusercontent.com'), 403);
  assert.equal(await post(suffix, 'https://evil-oaiusercontent.com'), 403);
  assert.equal(await post(suffix, 'https://x.oaiusercontent.com.evil.example'), 403);
  // `*` is any origin, the one a sandboxed frame states included.
  const any = { publicAi: true, embedOrigins: ['*'] };
  assert.equal(await post(any, 'https://anything.example'), 200);
  assert.equal(await post(any, 'null'), 200);
  // Empty, the default: nothing changes, and there is no preflight to answer.
  assert.equal(await post({ publicAi: true }, chatHost), 403);
  assert.equal(await post({ publicAi: true, embedOrigins: [] }, chatHost), 403);
  const closed = await serve({ apiKey: fakeKey, publicAi: true });
  const preflight = await closed.send('OPTIONS', '/interview/voice', { host: 'www.relo.cat', origin: chatHost });
  assert.equal(preflight.status, 404);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  // Without public voice the list does nothing: voice stays on the operator's own machine.
  assert.equal(await post({ publicAi: false, embedOrigins: ['*'] }, chatHost), 403);
  const local = await serve({ apiKey: fakeKey, embedOrigins: ['*'] });
  assert.equal((await local.send('OPTIONS', '/interview/voice', { host: local.local, origin: chatHost })).status, 404);
  // No key: the card is told so, in an answer it can read.
  const keyless = await serve({ publicAi: true, embedOrigins: [chatHost] });
  const off = await keyless.send('POST', '/interview/voice', embedHeaders(chatHost), 'v=0');
  assert.deepEqual([off.status, off.headers['access-control-allow-origin']], [503, chatHost]);

  // The variable: origins are normalised, and an entry that is none of the three forms fails at start.
  assert.deepEqual(interviewerEnv({}).embedOrigins, []);
  assert.deepEqual(
    interviewerEnv({ INTERVIEWER_EMBED_ORIGINS: ' https://Chat.Example/ , .OAIusercontent.com,*, null' }).embedOrigins,
    ['https://chat.example', '.oaiusercontent.com', '*', 'null'],
  );
  for (const bad of ['oaiusercontent.com', 'https://chat.example/path', 'ftp://chat.example', '.', '*.example.com'])
    assert.throws(() => interviewerEnv({ INTERVIEWER_EMBED_ORIGINS: bad }), /INTERVIEWER_EMBED_ORIGINS/, bad);
});

test('an embedded card spends from the same hourly allowance as the page', async () => {
  let time = 1_000_000;
  const options = {
    apiKey: fakeKey,
    publicAi: true,
    aiRequestsPerHour: 2,
    embedOrigins: [chatHost],
    now: () => time,
    log: () => {},
  };
  const { send, calls, publicHeaders } = await serve(options, () => new Response('v=0 answer'));
  const card = (client: string) => send('POST', '/interview/voice', embedHeaders(chatHost, client), 'v=0');
  assert.equal((await card('203.0.113.1')).status, 200);
  // The page and the card of one visitor share one allowance.
  assert.equal((await send('POST', '/interview/voice', publicHeaders(sdp, '203.0.113.1'), 'v=0')).status, 200);
  const limited = await card('203.0.113.1');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '3600');
  // The card can read why.
  assert.equal(limited.headers['access-control-allow-origin'], chatHost);
  assert.equal(calls.length, 2);
  // A preflight spends nothing, and a refused origin does not use up anybody's allowance.
  for (let attempt = 0; attempt < 5; attempt++) {
    await send('OPTIONS', '/interview/voice', {
      host: 'www.relo.cat',
      origin: chatHost,
      'x-forwarded-for': '203.0.113.2',
    });
    await send('POST', '/interview/voice', embedHeaders('https://evil.example', '203.0.113.2'), 'v=0');
  }
  assert.equal((await card('203.0.113.2')).status, 200);
  time += 3_600_000;
  assert.equal((await card('203.0.113.1')).status, 200);

  // Ten times the per-client allowance is the ceiling for everyone together, cards included.
  const shared = await serve({ ...options, aiRequestsPerHour: 1 }, () => new Response('v=0 answer'));
  const statuses: number[] = [];
  for (let client = 1; client <= 11; client++)
    statuses.push(
      (await shared.send('POST', '/interview/voice', embedHeaders(chatHost, `198.51.100.${client}`), 'v=0')).status,
    );
  assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
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
    embedOrigins: [],
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
  const said = voiceInstructions({
    locale: 'en',
    access: 'standalone',
    cash: null,
    statementCurrency: 'EUR',
    bankSource: null,
    cashGuidance: '',
    answeredIds: [],
    places: [],
    nextQuestion: null,
  });
  assert.match(said, /period_too_short[^`]*say the period is too short for a monthly figure/);
});

// ------------------------------------------------------------ plan facts

const day = '2026-11-22';

test('without a planner to rank them, the interview asks the shared question set in its own order', () => {
  const ids = (answers: FactAnswers) => factQuestionsToAsk(answers, day).map(question => question.id);
  // One question set: income, spending and savings are the shared questions, each asked once.
  assert.deepEqual(ids({}).slice(0, 5), [
    'monthlyIncome',
    'monthlyExpenses',
    'purchaseSavings',
    'homeBudget',
    'floorArea',
  ]);
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
    questions.map(question => question.id),
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
  // The amount already saved is a shared question like the others: euros as spoken, kept as cents.
  assert.deepEqual(applySpokenFacts({ purchaseSavings: 5000 }, {}, day).answers, { purchaseSavings: 500_000 });
});

test('the voice session is told which facts are answered and what to ask next, never the answers', () => {
  const answers: FactAnswers = {
    monthlyIncome: 320_000,
    monthlyExpenses: 230_000,
    purchaseSavings: 1_875_000,
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
    'purchaseSavings',
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
  for (const value of ['21500', '47250', '1994-03-02', '15000000', '320000', '1875000'])
    assert(!sent.includes(value), `${value} is not sent`);
  assert.doesNotMatch(sent, /"disability65":\s*true|"largeFamily":\s*true/);
  assert.equal(voiceFactContext({ ...answers, primaryResidence: true }, day).nextFactQuestion?.id, 'children');
  // The instructions lead the model: one question, the reason, confirmation before saving, null for unknown.
  assert.match(factInstructions, /one per turn/);
  assert.match(factInstructions, /save null, never zero, never a\s+guess/);
  // A plain figure is saved at once; a household or tax fact still needs a yes. The why is said only on request.
  assert.match(factInstructions, /saved only after the person says yes/);
  assert.match(factInstructions, /otherwise do not say them/);
});

test('the page offers to save only through a relative link and a button that start hidden', async () => {
  const { send } = await serve();
  const page = (await send('GET', '/interview/')).text;
  // Hidden until the server says who is there: standalone, the answers stay on this device.
  assert.match(page, /<p id="profile-status" class="hint" role="status">These answers are only on this device\.<\/p>/);
  assert.match(page, /<button id="save-profile" class="rc-btn rc-btn--gold" hidden>/);
  assert.match(page, /<a id="profile-signin" class="rc-btn" href="\.\.\/login\?next=%2Finterview%2F" hidden>/);
  const script = (await send('GET', '/interview/app.js')).text;
  assert.match(script, /save_interview_answers/);
  assert.doesNotMatch(script, /save_plan_facts/);
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
    purchaseSavings: 1_000_000,
  };
  const data = profileData(
    answers,
    { targetCashCents: 3_000_050, householdSize: 3, selectedMunicipalityCode: '252154' },
    day,
  );
  assert.deepEqual(data, {
    finance: { monthlyIncomeCents: 320_000, currentSavingsCents: 1_000_000, targetCashCents: 3_000_050 },
    eligibility: {
      birthDate: '1994-03-02',
      children: [{ birthDate: '2019-04-02', meetsItpSchooling: true, inDesignatedSchool: null }],
      disability65: false,
      itpBuyerNetTaxBaseEur: null,
    },
    housing: { depositRate: 0.25 },
    household: { size: 3 },
    location: { selectedMunicipalityCode: '252154' },
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
  // Only what was answered is written; with nothing answered there is nothing to save.
  assert.deepEqual(profileData({ birthDate: '1994-03-02' }, {}, day), {
    eligibility: { birthDate: '1994-03-02' },
  });
  assert.equal(profileData({}, {}, day), null);

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
    purchaseSavings: 1_000_000,
  };
  const today = new Date().toISOString().slice(0, 10);
  const data = profileData(answers, {}, today);

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

  // The same page, by voice: a confirmed answer goes to the profile with no click, a town is chosen only on
  // an exact match, and the plan shown is the planner's.
  const interview = createInterview({
    call: toolCaller(pageFetch, endpoint),
    today: () => today,
    locale: () => 'es',
    journey: emptyJourney(),
  });
  assert.equal((await interview.start()).access, 'signed_in');
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM input_records')?.n ?? 0;
  const spoken = await interview.saveSpoken({ monthlyIncome: 3100, monthlyExpenses: 2050 });
  assert.deepEqual(
    [spoken.updated, 'stored' in spoken && spoken.stored],
    [['monthlyIncome', 'monthlyExpenses'], 'profile'],
  );
  const latest = db.all<{ source: string; confirmed: number; data: string }>(
    'SELECT source, confirmed, data FROM input_records ORDER BY rowid',
  );
  assert.equal(latest.length, before + 1);
  assert.deepEqual(
    [latest.at(-1)?.source, latest.at(-1)?.confirmed, JSON.parse(latest.at(-1)?.data ?? '{}')],
    ['interview', 1, { finance: { monthlyIncomeCents: 310_000, monthlyExpensesCents: 205_000 } }],
  );
  assert.deepEqual(interview.journey.unsaved, []);
  const towns = (await interview.pilotTowns()) ?? [];
  const town = towns.find(item => item.code === '252154');
  assert(town, 'the pilot lists the town');
  const near = await interview.savePlace(town.name.slice(0, -1), true);
  assert.deepEqual([near.saved, near.saved ? '' : near.reason], [false, 'no_exact_match']);
  const chosen = await interview.savePlace(town.name.toUpperCase(), true);
  assert.deepEqual([chosen.saved, chosen.saved && chosen.stored], [true, 'profile']);
  assert.equal(
    JSON.parse(db.all<{ data: string }>('SELECT data FROM input_records ORDER BY rowid').at(-1)?.data ?? '{}').location
      .selectedMunicipalityCode,
    '252154',
  );
  const shown = await interview.plan();
  assert.equal(shown.status, 'ok');
  if (shown.status === 'ok') {
    assert.equal(shown.result.plans[0].place.municipalityCode, '252154');
    assert.equal(shown.result.person.finances.monthlyIncomeCents, 310_000, 'the plan reads the answer just saved');
  }
  assert.equal(interview.workspaceUrl(), '../workspace?towns=252154&lang=es');
  // The next question comes from the planner, worded in the language of the page.
  const next = await interview.nextQuestion();
  assert(next && next.id !== 'monthlyIncome' && next.id !== 'monthlyExpenses');
});

// ------------------------------------------------------------ languages

test('the voice session speaks the language chosen on the page, with its instructions still in English', async () => {
  // With no language chosen the line is the one the session always had: the model follows the person.
  assert.equal(voiceLanguageInstruction(), "Speak in the user's language and keep each spoken turn short.");
  assert.equal(voiceLanguageInstruction('en'), voiceLanguageInstruction());
  assert.match(voiceLanguageInstruction('ca'), /^Speak with the person in Catalan \(Català\)/);
  assert.match(voiceLanguageInstruction('es'), /^Speak with the person in Spanish \(Castellano\)/);
  for (const locale of ['ca', 'es'] as const) {
    const said = voiceLanguageInstruction(locale);
    // "I don't know" is still an answer, and what is saved does not change with the language.
    assert.match(said, /“I don’t know” said in (Catalan|Spanish)/);
    assert.match(said, /Tool arguments and saved values keep their defined formats/);
    assert.match(said, /Keep each spoken turn short\.$/);
    assert.match(voiceLanguageChange(locale), /From now on speak with them in (Catalan|Spanish)/);
  }
  // The page builds the session instructions around that line and tells a live session about a change.
  const page = await readFile(new URL('../apps/interviewer/app.ts', import.meta.url), 'utf8');
  const voice = await readFile(new URL('../apps/interviewer/voice.ts', import.meta.url), 'utf8');
  assert.match(voice, /\$\{voiceLanguageInstruction\(context\.locale\)\}\n\$\{turns\}/);
  assert.match(voice, /ask one question per turn, then stop and listen\./);
  assert.match(page, /connection\?\.changeLanguage\(chosen\)/);
  const call = await readFile(new URL('../apps/interviewer/realtime.ts', import.meta.url), 'utf8');
  assert.match(call, /voiceLanguageChange\(chosen\)/);
  // The next question reaches the model in the reviewed wording of that language; ids and values do not change.
  const answers: FactAnswers = { monthlyIncome: 320_000, itpBuyerNetTaxBase: null };
  const english = voiceFactContext(answers, day);
  const catalan = voiceFactContext(answers, day, 'ca');
  const spanish = voiceFactContext(answers, day, 'es');
  assert.deepEqual(catalan.answeredFactIds, english.answeredFactIds);
  assert.equal(catalan.nextFactQuestion?.id, english.nextFactQuestion?.id);
  assert.notEqual(catalan.nextFactQuestion?.question, english.nextFactQuestion?.question);
  assert.match(spanish.nextFactQuestion?.question ?? '', /^¿/);
  assert(!JSON.stringify(catalan).includes('320000'));
  // The tool the model calls is the same in every language: English descriptions, the same properties.
  assert.match(JSON.stringify(factToolParameters()), /Send null when the person says they do not know/);
});

test('the review list and the save messages are in the page language, with “I don’t know” kept as unknown', () => {
  const answers: FactAnswers = { itpBuyerNetTaxBase: null, depositRate: 0.2, largeFamily: true };
  assert.deepEqual(answeredFacts(answers, day), answeredFacts(answers, day, 'en'));
  const unknown = (locale: 'en' | 'ca' | 'es') =>
    answeredFacts(answers, day, locale).find(([, value]) => /know|sé/.test(value));
  assert.deepEqual(unknown('en'), ['Your own tax base', 'I don’t know']);
  assert.deepEqual(unknown('ca'), ['La teva base imposable', 'No ho sé']);
  assert.deepEqual(unknown('es'), ['Tu base imponible', 'No lo sé']);
  // What is stored is the same whatever the language: ids and typed values.
  assert.deepEqual(profileData(answers, {}, day), profileData(answers, {}, day));
  for (const locale of ['ca', 'es'] as const)
    assert.equal(answeredFacts(answers, day, locale).length, answeredFacts(answers, day).length);
});

test('saving reports in the page language and English stays as it was', async () => {
  const nothing = (locale?: 'en' | 'ca' | 'es') => saveToProfile(null, fetch, 'http://127.0.0.1:1/mcp', locale);
  assert.deepEqual(await nothing(), { saved: false, reason: 'nothing', message: 'There are no answers to save yet.' });
  assert.equal(((await nothing('ca')) as { message: string }).message, 'Encara no hi ha respostes per desar.');
  assert.equal(((await nothing('es')) as { message: string }).message, 'Aún no hay respuestas que guardar.');
  const offline = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const data = { finance: { currentSavingsCents: 1 } };
  assert.equal(
    ((await saveToProfile(data, offline, 'http://x/mcp')) as { message: string }).message,
    'This page is not connected to a ReloCat account, so the answers stay on this device.',
  );
  assert.match(
    ((await saveToProfile(data, offline, 'http://x/mcp', 'ca')) as { message: string }).message,
    /no està connectada a un compte de ReloCat/,
  );
});

test('the guided pay and spending questions follow the shared statement rule in every language', () => {
  const money = moneyIn('en', 'EUR');
  const cases = [
    { averageBasis: 'period_too_short', coveredDays: 1, coveredFrom: '2026-10-28', coveredTo: '2026-10-28' },
    { averageBasis: 'period_too_short', coveredDays: 9, coveredFrom: '2026-10-20', coveredTo: '2026-10-28' },
    { averageBasis: 'period_too_short', coveredDays: 1 },
    { averageBasis: 'partial_months_only', coveredDays: 40, coveredFrom: '2026-09-15', coveredTo: '2026-10-24' },
    { averageBasis: 'complete_months', coveredDays: 61, coveredFrom: '2026-08-01', coveredTo: '2026-09-30' },
    {},
  ] as const;
  for (const basis of cases)
    for (const figures of [
      { estimatedMonthlySalary: 2850, monthlyCostOfLiving: 1976.5 },
      { estimatedMonthlySalary: null, monthlyCostOfLiving: null },
    ]) {
      const summary = { ...figures, ...basis } as Parameters<typeof cashFlowStatements>[0];
      const rule = cashFlowStatements(summary, money);
      // English is the rule's own wording, word for word.
      assert.deepEqual(cashQuestions(summary, money), {
        salaryQuestion: rule.salaryQuestion,
        spendingQuestion: rule.spendingQuestion,
      });
    }
  const tooShort = { estimatedMonthlySalary: null, monthlyCostOfLiving: null, ...cases[0] };
  const catalan = cashQuestions(tooShort, moneyIn('ca', 'EUR'), 'ca');
  assert.match(catalan.salaryQuestion, /només cobreix un sol dia \(28 d’oct\.? (de )?2026\), i és massa curt/);
  assert.doesNotMatch(catalan.spendingQuestion, /mitjana|€/);
  const rough = { estimatedMonthlySalary: 2850, monthlyCostOfLiving: 1976.5, ...cases[3] };
  assert.match(
    cashQuestions(rough, moneyIn('es', 'EUR'), 'es').spendingQuestion,
    /indicación aproximada, no una media mensual: unos 1976,50\s€ de gasto al mes/,
  );
  // No statement at all: the plain questions.
  assert.equal(cashQuestions(cases[5] as never, money, 'ca').salaryQuestion, 'Quin és el teu sou net habitual al mes?');
  // A statement in another currency keeps its currency, written as the language writes it.
  assert.equal(moneyIn('en', 'EUR')(1234.5), '€1,234.50');
  assert.match(moneyIn('es', 'USD')(1234.5), /1234,50\sUS\$/);
});

test('the statement line keeps the stored English note and writes the same facts in the other languages', () => {
  const short = summarizeCsv(
    ['date,description,amount', '2026-10-28,Salary,2000', '2026-10-28,Mercadona,-45'].join('\n'),
  );
  assert.equal(
    statementNote(short),
    `2 transactions across 1 observed month. 0 identified internal transfers excluded. ${short.averagingNote}`,
  );
  const catalan = statementNote(short, 'ca');
  assert.match(catalan, /^2 moviments en 1 mes observat\. S’han exclòs 0 transferències internes identificades\./);
  assert.match(catalan, /1 dia\. És massa curt per a una xifra mensual, així que no se’n dona cap\./);
  const full = summarizeCsv(
    ['date,description,amount', '2026-08-31,Coffee,-3', '2026-09-01,Salary,2000', '2026-10-01,Coffee,-3'].join('\n'),
  );
  assert.match(statementNote(full, 'es'), /Las cifras mensuales son medias de 1 mes completo: 2026-09\./);
  assert.match(statementNote(full, 'es'), /Quedan fuera por parciales: 2026-08, 2026-10/);
  // A summary stored before the note existed still gets a line, never "undefined".
  const { averagingNote: _, ...old } = full;
  assert.doesNotMatch(statementNote(old), /undefined/);
});

test('the interview page carries a language switcher, and every key its template or script names is in the catalog', async () => {
  const template = await readFile(new URL('../apps/interviewer/index.html', import.meta.url), 'utf8');
  assert.match(
    template,
    /class="rc-lang" id="languages"[^>]*>(<button type="button" data-lang="(en|ca|es)"[^>]*>[^<]+<\/button>){3}/,
  );
  const keys = [...template.matchAll(/data-i18n(?:-aria-label)?="([^"]+)"/g)].map(match => match[1]);
  assert.ok(keys.length >= 30);
  for (const key of keys) assert.ok(key in interview.en, key);
  for (const [, key, text] of template.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]+)</g))
    assert.equal(text, interview.en[key as keyof typeof interview.en], key);
  // The classifier's categories are ids: each has a label, and the ids themselves are unchanged.
  for (const category of expenseCategories) assert.ok(`category.${category}` in interview.en, category);
  assert.equal(interview.ca['category.Rent'], 'Habitatge (lloguer)');
  assert.ok(expenseCategories.includes('Rent'));
  // The demo bank stays labelled as fictional, and unknown stays a word.
  assert.match(interview.ca.demoBankHint, /moviments ficticis/);
  assert.match(interview.es.demoBankHint, /movimientos ficticios/);
  assert.deepEqual(
    [interview.en.dontKnow, interview.ca.dontKnow, interview.es.dontKnow],
    ['I don’t know', 'No ho sé', 'No lo sé'],
  );
});
