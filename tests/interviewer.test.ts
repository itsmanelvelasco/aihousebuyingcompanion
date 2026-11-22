import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createInterviewerHandler, type InterviewerOptions, interviewerEnv } from '../apps/interviewer/server.ts';

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
