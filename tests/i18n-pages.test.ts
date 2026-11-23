import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cashFlow } from '../apps/mcp-server/cash-flow.messages.ts';
import { loadCashFlowCard } from '../apps/mcp-server/cash-flow.ts';
import { cashFlowView } from '../apps/mcp-server/cash-flow-view.ts';
import { connect } from '../apps/mcp-server/connect.messages.ts';
import { connectScript } from '../apps/mcp-server/connect-agents.messages.ts';
import { connectPage, handleConnectPage } from '../apps/mcp-server/connect-page.ts';
import { createMcpServer } from '../apps/mcp-server/tools.ts';
import { explorer } from '../apps/mcp-server/town-explorer.messages.ts';
import { loadTownExplorerPage } from '../apps/mcp-server/town-explorer.ts';
import { voiceCard } from '../apps/mcp-server/voice-card.messages.ts';
import { renderVoiceCard } from '../apps/mcp-server/voice-card.ts';
import { readLocalizedTool } from '../apps/mcp-server/widget-i18n.ts';
import { chooseLocale } from '../packages/i18n/browser.ts';
import { createFormat } from '../packages/i18n/format.ts';
import { type Locale, localeNames, locales } from '../packages/i18n/locales.ts';
import { translator } from '../packages/i18n/messages.ts';
import { loadData } from '../packages/places/data.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** What the homepage's script was given to say: the JSON written into the page. */
function scriptMessages(html: string) {
  const json = /const messages = (\{.*\});/.exec(html)?.[1];
  assert(json, 'the page carries its script messages');
  return JSON.parse(json) as Record<string, string>;
}

// ------------------------------------------------------------------ /connect

test('the homepage is written in English, Catalan and Spanish', () => {
  const english = connectPage();
  assert.equal(english, connectPage('en'));
  assert.match(english, /<html lang="en">/);
  // English reads exactly as it did before the page had other languages.
  for (const text of [
    '<title>ReloCat · Find your place in Catalonia</title>',
    '<h1 id="hero-title">Find your place <span>in Catalonia</span></h1>',
    '<p>Compare towns, school journeys and housing support before you decide where to move.</p>',
    '<a class="nav-link" href="/preview">Town demo</a>',
    '<dt>Find towns that fit</dt>',
    'Agents connect to <code>/mcp</code>. Town, school, transport and incentive tools need no sign-in.',
    '<a class="rc-wordmark" href="/connect" aria-label="ReloCat home">',
  ])
    assert.ok(english.includes(text), text);

  const catalan = connectPage('ca');
  assert.match(catalan, /<html lang="ca">/);
  assert.ok(catalan.includes('<h1 id="hero-title">Troba el <br>teu lloc <span>a Catalunya</span></h1>'));
  assert.ok(catalan.includes('<title>ReloCat · Troba el teu lloc a Catalunya</title>'));
  // The town demo picks its language in the browser, so the link carries the one chosen here.
  assert.ok(catalan.includes('href="/preview?lang=ca"'));
  assert.ok(!catalan.includes('href="/preview"'));

  const spanish = connectPage('es');
  assert.match(spanish, /<html lang="es">/);
  assert.ok(spanish.includes('<h1 id="hero-title">Encuentra <br>tu lugar <span>en Cataluña</span></h1>'));
  assert.ok(spanish.includes('¿Qué preguntarías?'));

  for (const locale of locales) {
    const page = connectPage(locale);
    assert.doesNotMatch(page, /\{\{(?!mcp-endpoint)|<!-- (LANGUAGES|ALTERNATES) -->/, `${locale}: no placeholder left`);
    // One address per language for search engines, and a switcher that marks the language shown.
    for (const other of locales)
      assert.ok(
        page.includes(`<link rel="alternate" hreflang="${other}" href="https://www.relo.cat/connect?lang=${other}">`),
      );
    assert.ok(page.includes('<link rel="alternate" hreflang="x-default" href="https://www.relo.cat/connect">'));
    assert.ok(
      page.includes(
        `<a href="/connect?lang=${locale}" lang="${locale}" hreflang="${locale}" aria-current="true">${localeNames[locale]}</a>`,
      ),
    );
    // Product, place and tool names are not translated.
    assert.match(page, /ReloCat/);
    assert.match(scriptMessages(page).prompt2, /Calaf, Juncosa .* Ulldemolins/);
    assert.match(scriptMessages(page).otherStep3, /get_town_profile .* recommend_towns/);
  }
});

test('the homepage script speaks the language of the page', () => {
  const english = scriptMessages(connectPage('en'));
  assert.deepEqual(english, { ...connectScript.en });
  assert.equal(english.copied, 'Copied.');
  assert.equal(
    english.prompt1,
    'Use ReloCat to find towns where I could rent for €700 a month and reach a primary school without a car. Explain the trade-offs.',
  );
  const catalan = scriptMessages(connectPage('ca'));
  assert.equal(catalan.copyQuestion, 'Copia la pregunta');
  assert.match(catalan.prompt1, /^Fes servir ReloCat per trobar pobles on pugui llogar per 700 € al mes/);
  const spanish = scriptMessages(connectPage('es'));
  assert.equal(spanish.copied, 'Copiado.');
  assert.match(spanish.prompt1, /^Usa ReloCat para encontrar pueblos donde pueda alquilar por 700 € al mes/);
  // The script reads an agent's steps in key order: every language keeps the English order.
  for (const messages of [catalan, spanish]) assert.deepEqual(Object.keys(messages), Object.keys(connectScript.en));
  // Every agent the script lists has a kind, an introduction and at least two steps.
  const ids = [...connect_agent_ids(read('apps/mcp-server/connect.html'))];
  assert.equal(ids.length, 9);
  for (const id of ids)
    for (const key of [`${id}Kind`, `${id}Intro`, `${id}Step1`, `${id}Step2`]) assert.ok(key in english, key);
});

function* connect_agent_ids(template: string) {
  for (const match of template.matchAll(/^ {8}id: '(\w+)',$/gm)) yield match[1];
}

function request(url: string, headers: Record<string, string> = {}) {
  const sent: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
  const response = {
    writeHead(status: number, values: Record<string, string>) {
      sent.status = status;
      sent.headers = values;
      return response;
    },
    end(body?: string) {
      sent.body = body;
    },
  };
  const handled = handleConnectPage(
    { method: 'GET', url, headers: { host: 'localhost:8787', ...headers } } as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    null,
  );
  assert.equal(handled, true);
  return sent;
}

test('the homepage answers in the language asked for and remembers a choice', () => {
  const plain = request('/connect');
  assert.equal(plain.headers['Content-Language'], 'en');
  assert.equal(plain.headers.Vary, 'Accept-Language, Cookie');
  assert.equal(plain.headers['Set-Cookie'], undefined);
  assert.match(plain.body ?? '', /<html lang="en">/);
  assert.ok(plain.body?.includes('value="http://localhost:8787/mcp"'));

  const browser = request('/connect', { 'accept-language': 'ca-ES,ca;q=0.9,en;q=0.5' });
  assert.equal(browser.headers['Content-Language'], 'ca');
  assert.equal(browser.headers['Set-Cookie'], undefined);
  assert.match(browser.body ?? '', /<html lang="ca">/);

  // The switcher's link: the choice is stored, and wins over the browser's language from then on.
  const chosen = request('/connect?lang=es', { 'accept-language': 'ca' });
  assert.equal(chosen.headers['Content-Language'], 'es');
  assert.match(chosen.headers['Set-Cookie'], /^rc_lang=es; Path=\/; Max-Age=\d+; SameSite=Lax$/);
  const returning = request('/connect', { 'accept-language': 'ca', cookie: 'rc_session=x; rc_lang=es' });
  assert.equal(returning.headers['Content-Language'], 'es');
  assert.match(returning.body ?? '', /Encuentra tu lugar/);

  // A language ReloCat is not written in gets English.
  assert.equal(request('/connect?lang=fr', { 'accept-language': 'de' }).headers['Content-Language'], 'en');
});

// ------------------------------------------------------------- Town Explorer

test('the Town Explorer template and script take every text from the catalog', () => {
  const template = read('apps/mcp-server/town-explorer.html');
  const keys = new Set(Object.keys(explorer.en));
  const english = translator(explorer, 'en');
  let marked = 0;
  for (const [, key, text] of template.matchAll(/data-i18n="(\w+)"[^>]*>([^<]*)</g)) {
    assert.ok(keys.has(key), `unknown key ${key}`);
    // The template is written in English: what it says before the script runs is the catalog's text.
    assert.equal(text, english(key as keyof typeof explorer.en), key);
    marked++;
  }
  for (const [tag, pairs] of template.matchAll(/<[^>]*data-i18n-attr="([^"]+)"[^>]*>/g))
    for (const pair of pairs.split(';')) {
      const [attribute, key] = pair.split(':').map(part => part.trim());
      assert.ok(keys.has(key), `unknown key ${key}`);
      assert.ok(tag.includes(`${attribute}="${english(key as keyof typeof explorer.en)}"`), `${attribute} of ${key}`);
      marked++;
    }
  assert.ok(marked >= 15, 'the static text is marked');
  assert.match(template, /<div class="rc-lang" id="languages"><\/div>/);

  const page = loadTownExplorerPage();
  assert(page, 'run `npm run build` first');
  assert.match(page, /<html lang="en">/);
  assert.ok(page.includes('<h1 data-i18n="heroTitle">Find your town</h1>'));
  // Without a script nothing can pick a language: that one sentence is there in all three.
  for (const locale of locales) assert.ok(page.includes(`<p lang="${locale}">${explorer[locale].noscript}</p>`));
  // The bundle carries the three languages and asks the tools for the language shown.
  for (const text of ['Find your town', 'Troba el teu poble', 'Encuentra tu pueblo', 'Desconegut', 'Desconocido'])
    assert.ok(page.includes(text), text);
  const source = read('apps/mcp-server/town-explorer-widget.ts');
  assert.match(
    source,
    /localizedTools = new Set\(\['recommend_towns', 'recommend_towns_for_profile', 'get_town_profile'\]\)/,
  );
  assert.doesNotMatch(source, /Intl\.(NumberFormat|DateTimeFormat)/, 'numbers and dates go through createFormat');

  // Unknown is a word in each language, the same one the formatters use.
  for (const locale of locales) {
    const t = translator(explorer, locale);
    assert.equal(t('callUnknown'), createFormat(locale).unknown);
    assert.notEqual(t('unavailable'), '0');
  }
  assert.equal(translator(explorer, 'en')('countTowns', { count: 1 }), '1 town');
  assert.equal(translator(explorer, 'ca')('countTowns', { count: 3 }), '3 pobles');
  assert.equal(translator(explorer, 'es')('countTowns', { count: 1 }), '1 pueblo');
  assert.equal(
    translator(explorer, 'ca')('highlightResaleComarca', { amount: createFormat('ca').euros(185_000) }),
    '1.850 €/m² · Mitjana comarcal de segona mà',
  );
});

test('the Town Explorer asks tools for its language and survives a server that refuses it', async () => {
  const calls: Record<string, unknown>[] = [];
  const answer = { structuredContent: { ok: true } };
  const accepting = async (_name: string, args: Record<string, unknown>) => {
    calls.push(args);
    return answer;
  };
  assert.deepEqual(await readLocalizedTool(accepting, 'get_town_profile', { municipalityCode: '080312' }, 'ca'), {
    ok: true,
  });
  assert.deepEqual([...calls], [{ municipalityCode: '080312', locale: 'ca' }]);

  // A tool that takes no locale is called as before.
  calls.length = 0;
  await readLocalizedTool(accepting, 'list_catalonia_municipalities', {}, null);
  assert.deepEqual([...calls], [{}]);

  // A strict schema from before the argument existed: an error result, or a rejected call.
  for (const refuse of [async () => ({ isError: true }), async () => Promise.reject(new Error('Invalid arguments'))]) {
    calls.length = 0;
    const strict = async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return 'locale' in args ? refuse() : answer;
    };
    assert.deepEqual(await readLocalizedTool(strict, 'recommend_towns', { limit: 3 }, 'es'), { ok: true });
    assert.deepEqual([...calls], [{ limit: 3, locale: 'es' }, { limit: 3 }]);
  }
  await assert.rejects(readLocalizedTool(async () => ({ isError: true }), 'recommend_towns', {}, 'es'));
});

// ---------------------------------------------------------------- voice card

test('the voice card is a whole document that takes its height from its content', () => {
  for (const card of [renderVoiceCard(null), renderVoiceCard('https://www.relo.cat/interview/')]) {
    assert.match(card, /<html lang="en">\s*<head>[\s\S]*<\/head>\s*<body>[\s\S]*<\/body>\s*<\/html>$/);
    assert.doesNotMatch(card, /100dvh/);
    assert.doesNotMatch(card, /min-height: 100/);
    // The host handshake and the resizing come from the bundled script, as in the other widgets.
    const bundle = new URL('../apps/mcp-server/dist/voice-card.js', import.meta.url);
    assert.ok(existsSync(bundle), 'run `npm run build` first');
    const script = readFileSync(bundle, 'utf8').replace(/<\/script/gi, '<\\/script');
    assert.ok(card.includes(`<script>${script}</script>`), 'the bundled script is inlined');
    assert.match(card, /<div class="rc-lang"><\/div>/);
    // English before the script runs, and the three languages in the script.
    for (const [, key, text] of card.matchAll(/data-i18n="(\w+)"[^>]*>([^<]*)</g))
      assert.equal(text, voiceCard.en[key as keyof typeof voiceCard.en], key);
    // (The bundle writes non-ASCII letters as escapes, so the fragments looked for are plain ASCII.)
    assert.ok(card.includes('La teva entrevista de compra d'));
    assert.ok(card.includes('Tu entrevista de compra de vivienda'));
    assert.equal(voiceCard.es.heading, 'Tu entrevista de compra de vivienda');
  }
  const launch = renderVoiceCard('https://www.relo.cat/interview/');
  // The interview starts in the chat the card is shown in: the main control is a button that sends the
  // opening message there. The own voice page is a secondary link, only when one is given.
  for (const card of [renderVoiceCard(null), launch]) {
    assert.match(card, /<button type="button" class="rc-btn rc-btn--gold start-here" data-i18n="startHere">/);
    assert.match(card, /sendFollowUpMessage/);
    assert.match(card, /<p id="start-help" class="help" hidden="" role="status" data-i18n="instructions">/);
    assert.doesNotMatch(card, /class="rc-btn[^"]*"[^>]*target="_blank"/, 'no button opens another tab');
  }
  assert.doesNotMatch(renderVoiceCard(null), /class="launch"/);
  assert.match(launch, /<a class="launch" href="https:\/\/www\.relo\.cat\/interview\/" target="_blank"/);
  assert.match(launch, /openExternal/);
});

// ------------------------------------------------------------ cash-flow card

type FakeNode = {
  id: string;
  textContent: string;
  hidden: boolean;
  lang: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  children: FakeNode[];
  click?: () => void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  append(...nodes: FakeNode[]): void;
  replaceChildren(...nodes: FakeNode[]): void;
};

/**
 * A built widget script run as ChatGPT runs it: in a frame whose parent answers the MCP Apps
 * handshake. Only the DOM calls the cards make exist. `sent` is what the script posted to its host.
 */
async function runWidget(
  bundle: string,
  options: { search?: string; stored?: string; languages?: string[]; marked?: string[] } = {},
) {
  const file = new URL(`../apps/mcp-server/dist/${bundle}`, import.meta.url);
  assert.ok(existsSync(file), 'run `npm run build` first');
  const node = (id = ''): FakeNode => ({
    id,
    textContent: '',
    hidden: false,
    lang: '',
    dataset: {},
    attributes: {},
    children: [],
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, listener) {
      if (type === 'click') this.click = listener;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
  });
  const nodes = new Map<string, FakeNode>();
  const named = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, node(id));
    return nodes.get(id) as FakeNode;
  };
  const marked = (options.marked ?? []).map(key => Object.assign(node(), { dataset: { i18n: key } }));
  const listeners: ((event: unknown) => void)[] = [];
  const sent: { id?: number; method?: string; params?: Record<string, unknown> }[] = [];
  const store = new Map<string, string>(options.stored ? [['relocat.lang', options.stored]] : []);
  const parent = { postMessage: (message: (typeof sent)[number]) => sent.push(message) };
  const size = { width: 320, height: 240 };
  const documentElement = {
    lang: 'en',
    style: {},
    scrollWidth: size.width,
    scrollHeight: size.height,
    getBoundingClientRect: () => size,
  };
  const document = {
    title: '',
    documentElement,
    body: node(),
    getElementById: named,
    createElement: () => node(),
    // The voice card looks its language switcher up by class; neither card needs another selector.
    querySelector: (selector: string) => (selector === '.rc-lang' ? named('languages') : null),
    querySelectorAll: (selector: string) => (selector === '[data-i18n]' ? marked : []),
  };
  const window: Record<string, unknown> = {
    parent,
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (type === 'message') listeners.push(listener);
    },
    removeEventListener() {},
  };
  window.window = window;
  vm.runInNewContext(readFileSync(file, 'utf8'), {
    window,
    document,
    location: { search: options.search ?? '' },
    navigator: { languages: options.languages ?? ['en-GB'] },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
    console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
    getComputedStyle: () => ({}),
    setTimeout,
    clearTimeout,
    URLSearchParams,
    URL,
    Intl,
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const send = async (data: Record<string, unknown>) => {
    for (const listener of listeners) listener({ source: parent, data: { jsonrpc: '2.0', ...data } });
    await settle();
  };
  await settle();
  const text = (id: string) => nodes.get(id)?.textContent;
  const rows = (id: string) => (nodes.get(id)?.children ?? []).map(row => row.children.map(cell => cell.textContent));
  return { document, sent, send, text, rows, store, languages: () => named('languages'), marked };
}

/** The host's side of the handshake: the answer to `ui/initialize`, or its refusal. */
async function answerInitialize(card: Awaited<ReturnType<typeof runWidget>>, hostLocale?: string, refuse = false) {
  const request = card.sent.find(message => message.method === 'ui/initialize');
  assert(request, 'the widget asks its host to initialise');
  await card.send(
    refuse
      ? { id: request.id, error: { code: -32000, message: 'refused' } }
      : {
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion,
            hostInfo: { name: 'test-host', version: '1.0.0' },
            hostCapabilities: {},
            hostContext: hostLocale ? { locale: hostLocale } : {},
          },
        },
  );
}

test('every card completes the host handshake through App, with no hand-written one left', async () => {
  // ChatGPT refuses a widget that does not send `ui/notifications/initialized` after `ui/initialize`.
  for (const bundle of ['cash-flow.js', 'voice-card.js']) {
    const card = await runWidget(bundle);
    assert.deepEqual(
      card.sent.map(message => message.method),
      ['ui/initialize'],
      bundle,
    );
    await answerInitialize(card);
    assert.equal(card.sent[1]?.method, 'ui/notifications/initialized', bundle);
  }
  // One mechanism: no source of this server posts the handshake itself.
  for (const path of [
    'apps/mcp-server/cash-flow-widget.html',
    'apps/mcp-server/cash-flow-widget.ts',
    'apps/mcp-server/voice-card.ts',
    'apps/mcp-server/voice-card-widget.ts',
    'apps/mcp-server/town-explorer-widget.ts',
  ])
    assert.doesNotMatch(read(path), /ui\/initialize|ui\/notifications|postMessage/, path);
});

test('the cash-flow card is its template in English with the bundled script inlined', async () => {
  const template = read('apps/mcp-server/cash-flow-widget.html');
  assert.doesNotMatch(template, /<script/, 'the template carries no script and no copy of the catalog');
  const keys = [...template.matchAll(/data-i18n="(\w+)">([^<]*)</g)];
  assert.ok(keys.length >= 3);
  for (const [, key, text] of keys) assert.equal(text, cashFlow.en[key as keyof typeof cashFlow.en], key);
  assert.ok(template.includes(`<p id="coverage" role="status">${cashFlow.en.loading}</p>`));

  const page = loadCashFlowCard();
  const script = read('apps/mcp-server/dist/cash-flow.js').replace(/<\/script/gi, '<\\/script');
  assert.ok(page.includes(`<script>${script}</script>`), 'the bundled script is inlined');
  assert.doesNotMatch(page, /<!-- WIDGET -->|\/\* THEME \*\//);

  // What the MCP server hands ChatGPT is that document, not the bare template.
  const { snapshot, policies, travelEstimates } = loadData();
  const server = createMcpServer({ snapshot, policies, travelEstimates, listings: {} });
  const client = new Client({ name: 'relocat-tests', version: '1.0.0' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const served = (await client.readResource({ uri: 'ui://relocat/cash-flow.html' })).contents[0];
    assert('text' in served);
    // (Compared with `ok`: a failure should name the cause, not print two half-megabyte pages.)
    assert.ok(served.text === page, 'apps/mcp-server/interview-tools.ts must serve loadCashFlowCard()');
  } finally {
    await client.close();
    await server.close();
  }
});

test('the cash-flow card says amounts, the unknown state and its failure in each language', () => {
  const summary = {
    observedMonths: ['2026-08', '2026-09', '2026-10'],
    monthlyExpenses: { Rent: 950, 'Eating out': 120.5, Farmàcia: 31 },
    estimatedMonthlySalary: 2900,
    monthlyCostOfLiving: 2026.5,
    monthlyNetCashFlow: null,
  };
  const plain = (text: string) => text.replace(/[  ]/g, ' ');
  const expected: Record<Locale, { coverage: string; one: string; net: string[]; rent: string[]; failed: string }> = {
    en: {
      coverage: '3 months of fictional transactions',
      one: '1 month of fictional transactions',
      net: ['Net cash flow', 'Unidentified'],
      rent: ['Housing (rent)', '€950.00'],
      failed: 'Cash flow preview is unavailable.',
    },
    ca: {
      coverage: '3 mesos de moviments ficticis',
      one: '1 mes de moviments ficticis',
      net: ['Flux de caixa net', 'Sense identificar'],
      rent: ['Habitatge (lloguer)', '950,00 €'],
      failed: 'La previsualització del flux de caixa no està disponible.',
    },
    es: {
      coverage: '3 meses de movimientos ficticios',
      one: '1 mes de movimientos ficticios',
      net: ['Flujo de caja neto', 'Sin identificar'],
      rent: ['Vivienda (alquiler)', '950,00 €'],
      failed: 'La vista previa del flujo de caja no está disponible.',
    },
  };
  for (const locale of locales) {
    const waiting = cashFlowView(null, locale);
    assert.deepEqual(
      [waiting.title, waiting.coverage, waiting.totals, waiting.expenses],
      [cashFlow[locale].title, cashFlow[locale].loading, null, null],
    );
    assert.equal(cashFlowView(null, locale, true).coverage, expected[locale].failed);
    const view = cashFlowView(summary, locale);
    assert.equal(view.coverage, expected[locale].coverage);
    assert.deepEqual(view.totals?.[2], expected[locale].net);
    assert.deepEqual(view.expenses?.[0].map(plain), expected[locale].rent);
    // The amounts are the shared formatter's; a category the statement names is shown as received.
    assert.equal(view.totals?.[1][1], createFormat(locale).money(2026.5, 'EUR'));
    assert.equal(view.expenses?.[2][0], 'Farmàcia');
    assert.equal(cashFlowView({ ...summary, observedMonths: ['2026-08'] }, locale).coverage, expected[locale].one);
  }
});

test('the cash-flow card picks its language as the other widgets do and shows a tool result', async () => {
  const marked = [...read('apps/mcp-server/cash-flow-widget.html').matchAll(/data-i18n="(\w+)"/g)].map(
    ([, key]) => key,
  );
  // The decision is `browserLocale`: the address, the stored choice, the host, the browser.
  const cases: { search?: string; stored?: string; host?: string; languages?: string[] }[] = [
    {},
    { languages: ['fr-FR', 'es-ES', 'ca'] },
    { host: 'ca-ES', languages: ['es'] },
    { stored: 'es', host: 'ca', languages: ['en'] },
    { search: '?lang=ca', stored: 'es', host: 'en-US' },
    { search: '?lang=fr', host: 'pt-BR', languages: ['de'] },
    { stored: 'constructor', host: 'ES_es' },
  ];
  for (const reader of cases) {
    const card = await runWidget('cash-flow.js', { ...reader, marked });
    await answerInitialize(card, reader.host);
    const expected = chooseLocale({ ...reader, hostLocale: reader.host, documentLang: 'en' });
    assert.equal(card.document.documentElement.lang, expected, JSON.stringify(reader));
    assert.equal(card.document.title, cashFlow[expected].title);
    assert.equal(card.text('coverage'), cashFlow[expected].loading);
    assert.deepEqual(
      card.marked.map(element => element.textContent),
      marked.map(key => cashFlow[expected][key as keyof typeof cashFlow.en]),
    );
  }

  const card = await runWidget('cash-flow.js', { search: '?lang=ca', marked });
  await answerInitialize(card);
  await card.send({
    method: 'ui/notifications/tool-result',
    params: {
      content: [],
      structuredContent: {
        observedMonths: ['2026-08', '2026-09'],
        monthlyExpenses: { Rent: 950 },
        monthlyNetCashFlow: 873.5,
      },
    },
  });
  assert.equal(card.text('coverage'), '2 mesos de moviments ficticis');
  assert.deepEqual(card.rows('totals')[0], ['Sou estimat', 'Sense identificar']);
  assert.equal(card.rows('expenses')[0][0], 'Habitatge (lloguer)');
  assert.equal(card.document.getElementById('breakdown').hidden, false);
  await card.send({ method: 'ui/notifications/host-context-changed', params: { locale: 'es-ES' } });
  assert.equal(card.document.documentElement.lang, 'ca', 'the address still decides');

  // The switcher: a click shows the language at once, marks it and stores it.
  const buttons = card.languages().children;
  assert.deepEqual(
    buttons.map(button => button.textContent),
    locales.map(locale => localeNames[locale]),
  );
  assert.deepEqual(
    buttons.map(button => button.attributes['aria-pressed']),
    ['false', 'true', 'false'],
  );
  buttons[2].click?.();
  assert.equal(card.document.documentElement.lang, 'es');
  assert.equal(card.text('coverage'), '2 meses de movimientos ficticios');
  assert.equal(card.store.get('relocat.lang'), 'es');
  assert.deepEqual(
    buttons.map(button => button.attributes['aria-pressed']),
    ['false', 'false', 'true'],
  );
  assert.equal(card.languages().attributes['aria-label'], 'Idioma');

  // A host that refuses the handshake: the card says so in the person's language.
  const broken = await runWidget('cash-flow.js', { stored: 'es', marked });
  await answerInitialize(broken, undefined, true);
  assert.equal(broken.text('coverage'), cashFlow.es.unavailable);
});

test('the homepage catalog has no markup outside the three keys written as HTML', () => {
  const html = new Set(['heroTitle', 'selfHostText', 'localSetupText', 'listingSetupText']);
  const template = read('apps/mcp-server/connect.html');
  for (const locale of locales)
    for (const [key, message] of Object.entries(connect[locale])) {
      assert.equal(/[<>]/.test(message), html.has(key), `${locale}.${key}`);
      assert.ok(template.includes(html.has(key) ? `{{t-html:${key}}}` : `{{t:${key}}}`), `${key} is used by the page`);
    }
});
