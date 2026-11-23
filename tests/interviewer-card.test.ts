import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { card as cardCatalog } from '../apps/interviewer/card.messages.ts';
import type { HostApp } from '../apps/interviewer/card-host.ts';
import {
  cardFailure,
  cardVoiceContext,
  cardVoiceTools,
  hostAccess,
  hostCallTool,
  notSavedNotice,
  sendToChat,
  workspaceRequest,
} from '../apps/interviewer/card-host.ts';
import { embeddedInterviewCard, loadInterviewCard } from '../apps/interviewer/card-page.ts';
import type { ToolAnswer } from '../apps/interviewer/facts.ts';
import { interview as pageCatalog } from '../apps/interviewer/messages.ts';
import type { VoiceEnd, VoicePhase, VoicePlatform } from '../apps/interviewer/realtime.ts';
import { startVoiceCall } from '../apps/interviewer/realtime.ts';
import { createInterviewerHandler } from '../apps/interviewer/server.ts';
import { createInterview, emptyJourney } from '../apps/interviewer/session.ts';
import type { VoiceContext } from '../apps/interviewer/voice.ts';
import { sessionUpdate, voiceInstructions, voiceTools } from '../apps/interviewer/voice.ts';
import { registerInterviewerTools } from '../apps/mcp-server/interview-tools.ts';
import type { Locale } from '../packages/i18n/locales.ts';
import { startApp } from './support/app.ts';

/**
 * The interview card embedded in a chat, without a network and without OpenAI: its document, its
 * handshake with a fake host, the voice call against a fake browser, the ReloCat tools through a
 * fake `callServerTool`, and how the MCP server and the main server hand it out.
 */

const day = '2026-11-23';
const relocat = 'https://www.relo.cat';
const chatHost = 'https://web-sandbox.oaiusercontent.com';
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ------------------------------------------------------------- the document

test('the card is a whole document sized by its content, with its bundle, art and voice address inlined', () => {
  const page = loadInterviewCard({ origin: `${relocat}/` });
  assert(page, 'run `npm run build` first');
  assert.match(
    page,
    /^<!doctype html>\s*<html data-voice-endpoint="https:\/\/www\.relo\.cat\/interview\/voice" lang="en">/,
  );
  assert.match(page, /<body>[\s\S]*<\/body>\s*<\/html>\s*$/);
  // The content sets the height: nothing is sized to the window.
  assert.doesNotMatch(page, /100dvh|100svh|100vh|min-height: 100/);
  const bundle = read('apps/interviewer/dist/card.js').replace(/<\/script/gi, '<\\/script');
  assert.ok(page.includes(`<script>${bundle}</script>`), 'the bundled script is inlined');
  assert.doesNotMatch(page, /<script src=|<link rel="stylesheet"|<!-- WIDGET -->|\/\* THEME \*\/|\/\* ART \*\//);
  assert.match(page, /--rc-art-step-profile: url\("data:image\//);
  assert.match(page, /@font-face\{font-family:"Montserrat"/);

  const template = read('apps/interviewer/card.html');
  // Every text of the template is a catalog entry, written in English until the script runs.
  for (const [, key, text] of template.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]+)</g))
    assert.equal(text, cardCatalog.en[key as keyof typeof cardCatalog.en], key);
  for (const [, key, text] of template.matchAll(/data-say="([^"]+)"[^>]*>([^<]+)</g))
    assert.equal(text, pageCatalog.en[key as keyof typeof pageCatalog.en], key);
  assert.match(
    template,
    /<button id="start" type="button" class="rc-btn rc-btn--gold" data-say="start">Start talking</,
  );
  assert.equal(template.match(/rc-btn--gold/g)?.length, 1, 'one primary button');
  assert.match(template, /<button id="continue"[^>]*data-i18n="continueInChat">Continue in the chat instead</);
  assert.match(
    template,
    /class="rc-lang" id="languages"[^>]*>(<button type="button" data-lang="(en|ca|es)"[^>]*>[^<]+<\/button>){3}/,
  );
  assert.match(template, /<p id="last-question" aria-live="polite" hidden>/);
  assert.match(template, /<audio id="audio" autoplay>/);
  // Nothing opens another window, and the card links nowhere.
  assert.doesNotMatch(template, /target="_blank"|<a /);
  // Hover styles only where there is a pointer that hovers.
  assert.doesNotMatch(template.replace(/@media \(hover: hover\) \{[\s\S]*?\n {2}\}/g, ''), /:hover/);
  // The handshake is `App`'s: the card posts no message of its own.
  for (const path of ['apps/interviewer/card.ts', 'apps/interviewer/card-host.ts', 'apps/interviewer/card.html'])
    assert.doesNotMatch(read(path), /ui\/initialize|ui\/notifications|postMessage/, path);
  assert.match(read('apps/interviewer/card.ts'), /new App\(/);
  // No cookie exists in the card: it calls no `/api` route and no `/mcp` endpoint itself.
  assert.doesNotMatch(
    read('apps/interviewer/card.ts') + read('apps/interviewer/card-host.ts'),
    /\/api\/|\/mcp|toolCaller/,
  );
});

test('the catalogs say what the card says in Catalan and Spanish', () => {
  assert.equal(pageCatalog.ca.start, 'Comença a parlar');
  assert.equal(pageCatalog.es.start, 'Empieza a hablar');
  assert.equal(cardCatalog.ca.continueInChat, 'Continua al xat');
  assert.equal(cardCatalog.es.continueInChat, 'Sigue en el chat');
  for (const locale of ['en', 'ca', 'es'] as const) {
    // Not saved, and how to save: connect ReloCat in the chat host.
    assert.match(cardCatalog[locale].notSaved, /ReloCat.*ChatGPT/);
    // Every failure names a way forward: typing, or the chat.
    for (const key of [
      'micRefused',
      'micUnavailable',
      'voiceRefused',
      'voiceBusy',
      'voiceOff',
      'voiceNetwork',
    ] as const)
      assert.match(cardCatalog[locale][key], /chat|xat/, `${locale}.${key}`);
  }
  assert.equal(workspaceRequest([], 'en'), 'Use ReloCat to show my workspace.');
  assert.equal(
    workspaceRequest(['Talarn', 'Lleida'], 'es'),
    'Usa ReloCat para mostrar mi espacio de trabajo para Talarn y Lleida.',
  );
  assert.equal(
    workspaceRequest(['Talarn', 'Lleida', 'Tremp'], 'ca'),
    'Fes servir ReloCat per mostrar el meu espai de treball per a Talarn, Lleida i Tremp.',
  );
});

// ------------------------------------------------- what the session is given

const context = (locale: Locale, access: VoiceContext['access'] = 'signed_out'): VoiceContext => ({
  surface: 'card',
  locale,
  access,
  cash: null,
  statementCurrency: 'EUR',
  bankSource: null,
  cashGuidance: '',
  answeredIds: ['monthlyIncome'],
  places: ['Talarn'],
  nextQuestion: { id: 'monthlyExpenses', question: '¿Cuánto gastas al mes?' },
});

test('in the card the session has no bank panel, and the workspace is asked for in the chat', () => {
  const names = (surface?: 'page' | 'card') => voiceTools(surface).map(tool => tool.name);
  assert.deepEqual(names('card'), [
    'save_interview_answers',
    'save_place',
    'show_plan',
    'open_workspace',
    'save_to_profile',
  ]);
  // The page keeps its six, and the functions the two share are the same ones.
  assert.deepEqual(names(), [...names('card'), 'show_interview_panel']);
  assert.deepEqual(names('page'), names());
  const [save, place, plan, workspace] = voiceTools('card');
  assert.deepEqual([save, place, plan], voiceTools().slice(0, 3));
  assert.match(workspace.description, /in the chat this card is shown in/);
  assert.doesNotMatch(workspace.description, /browser|link/);

  const update = sessionUpdate(context('es'));
  assert.deepEqual(
    update.session.tools.map(tool => tool.name),
    names('card'),
  );
  assert.deepEqual(update.session.audio.input.transcription, { model: 'gpt-4o-mini-transcribe', language: 'es' });
  assert.equal(update.session.instructions, voiceInstructions(context('es')));
});

test('the card’s instructions are English, carry the language line and name the card’s own labels', () => {
  const spanish = voiceInstructions(context('es'));
  assert.match(spanish, /^You are ReloCat’s warm, practical voice interviewer/);
  assert.match(spanish, /Speak with the person in Spanish \(Castellano\)/);
  assert.match(spanish, /inside a small ReloCat card in a chat/);
  // The labels are the ones on screen, in the language shown.
  for (const label of [
    'Silencia el micrófono',
    'Termina la conversación',
    'Escribe una respuesta',
    'Abre el espacio de trabajo',
  ])
    assert(spanish.includes(`“${label}”`), label);
  for (const english of ['“Mute mic”', '“Open the workspace”', '“Type a reply”']) assert(!spanish.includes(english));
  assert.match(
    voiceInstructions(context('ca')),
    /Speak with the person in Catalan \(Català\)[\s\S]*“Silencia el micròfon”/,
  );
  assert.match(voiceInstructions(context('en')), /Speak in the user's language[\s\S]*“Mute mic”/);
  // Nothing of the page that the card does not have.
  for (const absent of [
    'show_interview_panel',
    'Añade datos bancarios',
    'Sube un CSV',
    'Inicia sesión',
    'on this device',
  ])
    assert(!spanish.includes(absent), absent);
  assert.match(spanish, /There is no bank panel in this card/);
  // The same rules as the page: one question, confirmed answers, unknown is never zero, the plan is the planner's.
  assert.match(spanish, /Ask one question, then stop and listen\./);
  assert.match(spanish, /save null, never zero, never a\s+guess/);
  assert.match(spanish, /Report only timelines and amounts from show_plan; never\s+compute or estimate one yourself/);
  assert.match(spanish, /call open_workspace: it asks ReloCat in the chat to show the\s+workspace/);
  assert.match(spanish, /do not imply mortgage approval or guaranteed aid/);
  // Where answers go, by who is connected.
  assert.match(spanish, /has not connected their ReloCat account in this chat: answers stay in this card/);
  assert.match(voiceInstructions(context('es', 'signed_in')), /goes to their ReloCat profile at once/);
  assert.match(voiceInstructions(context('es', 'standalone')), /cannot reach the ReloCat tools/);
  // Ids of what is answered, never a value; the next question in the wording given.
  assert.match(spanish, /"answeredFactIds":\["monthlyIncome"\],"townsChosen":\["Talarn"\]/);
  assert.match(spanish, /¿Cuánto gastas al mes\?/);
  // The page's own instructions are untouched by the card.
  assert.match(voiceInstructions({ ...context('es'), surface: 'page' }), /call show_interview_panel/);
  assert.equal(
    voiceInstructions({ ...context('es'), surface: undefined }),
    voiceInstructions({ ...context('es'), surface: 'page' }),
  );
});

// ----------------------------------------------- the tools, through the host

const towns = [
  { code: '252154', name: 'Talarn', comarca: 'Pallars Jussà' },
  { code: '251207', name: 'Lleida', comarca: 'Segrià' },
];
const signIn: ToolAnswer = {
  isError: true,
  content: [{ type: 'text', text: 'Sign in to ReloCat to use your own profile.' }],
  _meta: { 'mcp/www_authenticate': ['Bearer error="invalid_token"'] },
};

/** A chat host as the card sees it: `callServerTool` answers like the ReloCat MCP server does for this person. */
function fakeHost(options: { signedIn: boolean; serverTools?: boolean; throws?: boolean; sendRefused?: boolean }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const messages: string[] = [];
  let saves = 0;
  const app: HostApp = {
    getHostCapabilities: () => (options.serverTools === false ? {} : { serverTools: {} }),
    async callServerTool({ name, arguments: args }) {
      calls.push({ name, args });
      if (options.throws) throw new Error('The host refused the call');
      const personal = args.me === true;
      switch (name) {
        case 'start_homebuying_interview':
          return { structuredContent: { signedIn: options.signedIn, voiceInCard: true } };
        case 'show_workspace':
          // Only the model may call it: a host refuses the card.
          return { isError: true, content: [{ type: 'text', text: 'Tool not visible to apps.' }] };
        case 'list_catalonia_municipalities':
          return { structuredContent: { municipalities: towns } };
        case 'get_next_questions':
          return personal && !options.signedIn ? signIn : { structuredContent: { nextQuestions: [] } };
        case 'save_my_inputs':
          return options.signedIn ? { structuredContent: { saved: true, inputId: `in-${++saves}` } } : signIn;
        case 'plan_home_savings':
          return personal && !options.signedIn ? signIn : { isError: true, content: [] };
        default:
          return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
      }
    },
    async sendMessage({ content }) {
      messages.push(content[0].text);
      return { isError: options.sendRefused };
    },
  };
  return { app, calls, messages, named: (name: string) => calls.filter(call => call.name === name) };
}

/** Where a save went, as the voice model is told. */
const where = (result: object) => result as { stored?: string; sayOnce?: string };

async function cardInterview(host: ReturnType<typeof fakeHost>, locale: Locale = 'es', connected = true) {
  const interview = createInterview({
    call: hostCallTool(host.app, () => connected),
    today: () => day,
    locale: () => locale,
    journey: emptyJourney(),
    access: hostAccess,
    notSavedNotice: notSavedNotice(() => locale),
  });
  await interview.start();
  return interview;
}

test('not connected in the chat: answers stay in the card and the person is told once how to save them', async () => {
  const host = fakeHost({ signedIn: false });
  const interview = await cardInterview(host);
  // Who is connected is asked of the tool that shows the card, never of a tool only the model may call.
  assert.deepEqual(host.calls, [{ name: 'start_homebuying_interview', args: {} }]);
  assert.equal(interview.access, 'signed_out');

  const first = await interview.saveSpoken({ monthlyIncome: 3100, monthlyExpenses: 2050 });
  assert.deepEqual(first.updated, ['monthlyIncome', 'monthlyExpenses']);
  assert.deepEqual([where(first).stored, where(first).sayOnce], ['device', cardCatalog.es.notSaved]);
  assert.match(String(where(first).sayOnce), /no se guardan\. Conecta ReloCat en ChatGPT para guardarlas\./);
  // Nothing personal was attempted, and the questions are asked for the answers of the card, sent inline.
  assert.equal(host.named('save_my_inputs').length, 0);
  const asked = host.named('get_next_questions').at(-1);
  assert.equal(asked?.args.me, undefined);
  assert.equal(
    (asked?.args.person as { finances: { monthlyIncomeCents: number } } | undefined)?.finances.monthlyIncomeCents,
    310_000,
  );
  assert.equal(asked?.args.locale, 'es');
  // Said once.
  const second = await interview.saveSpoken({ purchaseSavings: 20_000 });
  assert.deepEqual([where(second).stored, where(second).sayOnce], ['device', undefined]);
  assert.deepEqual(interview.journey.unsaved, ['monthlyIncome', 'monthlyExpenses', 'purchaseSavings']);
  // The towns come through the host too: an exact match, confirmed.
  assert.equal((await interview.savePlaceSpoken({ name: 'talarn' })).saved, false);
  assert.equal((await interview.savePlaceSpoken({ name: 'Talarn', confirmed: true })).saved, true);
  assert.equal((await cardVoiceContext(interview, 'es', day)).surface, 'card');
  assert.deepEqual((await cardVoiceContext(interview, 'es', day)).places, ['Talarn']);
});

test('connected in the chat: each confirmed answer is saved through the host with the person’s own connection', async () => {
  const host = fakeHost({ signedIn: true });
  const interview = await cardInterview(host, 'ca');
  assert.equal(interview.access, 'signed_in');
  const saved = await interview.saveSpoken({ monthlyIncome: 3100 });
  assert.deepEqual([where(saved).stored, where(saved).sayOnce], ['profile', undefined]);
  const [write] = host.named('save_my_inputs');
  assert.deepEqual(write.args, {
    data: { finance: { monthlyIncomeCents: 310_000 } },
    confirmed: true,
    source: 'interview',
  });
  // No tool is given a user id: the host's connection is the identity.
  for (const call of host.calls) assert(!('userId' in call.args), call.name);
  assert.equal(host.named('get_next_questions').at(-1)?.args.me, true);
  assert.deepEqual(interview.journey.unsaved, []);
});

test('the connection ended mid-interview: the sign-in answer of a personal tool means "not connected"', async () => {
  const host = fakeHost({ signedIn: true });
  const interview = await cardInterview(host);
  // The host now answers every personal tool with the sign-in result.
  const original = host.app.callServerTool;
  host.app.callServerTool = async params =>
    params.name === 'save_my_inputs' || params.arguments.me === true ? signIn : original(params);
  const saved = await interview.saveSpoken({ monthlyIncome: 3100 });
  assert.equal(where(saved).stored, 'device');
  assert.equal(interview.access, 'signed_out');
  assert.deepEqual(interview.journey.unsaved, ['monthlyIncome']);
  // From then on the answers go inline, and nothing personal is asked for.
  await interview.nextQuestion();
  assert.equal(host.named('get_next_questions').at(-1)?.args.me, undefined);
});

test('a host without tool calls: voice still works and the answers stay in the card', async () => {
  for (const host of [fakeHost({ signedIn: true, serverTools: false }), fakeHost({ signedIn: true, throws: true })]) {
    const interview = await cardInterview(host);
    assert.equal(interview.access, 'standalone');
    const saved = await interview.saveSpoken({ monthlyIncome: 3100 });
    assert.deepEqual([where(saved).stored, where(saved).sayOnce], ['device', cardCatalog.es.noTools]);
    // The shared questions are asked in their own order, and there is no plan to invent.
    assert.equal((saved.nextQuestion as { id: string }).id, 'monthlyExpenses');
    assert.deepEqual(await interview.plan(), { status: 'standalone' });
    assert.equal((await interview.planSpoken()).shown, false);
  }
  // Before the handshake finishes, and outside a host, nothing is called at all.
  const early = fakeHost({ signedIn: true });
  assert.equal((await cardInterview(early, 'es', false)).access, 'standalone');
  assert.equal(early.calls.length, 0);
  assert.equal(await hostCallTool(null, () => true)('plan_home_savings', {}), null);
});

test('show_plan and open_workspace are answered in the card and in the chat, never with a URL', async () => {
  const host = fakeHost({ signedIn: false });
  const interview = await cardInterview(host);
  await interview.savePlaceSpoken({ name: 'Talarn', confirmed: true });
  let shown = 0;
  const asked: boolean[] = [];
  const run = (sent: boolean) =>
    cardVoiceTools({
      interview,
      showPlan: () => {
        shown++;
        return interview.plan();
      },
      askForWorkspace: async () => {
        asked.push(sent);
        return sent;
      },
    });
  // The planner could not answer: the model is told so and never works out a timeline itself.
  const plan = await run(true)('show_plan', {});
  assert.deepEqual([shown, plan.shown], [1, false]);
  assert.match(String(plan.reason), /never work out a timeline yourself/);
  assert(!('workspaceLink' in plan));
  const opened = await run(true)('open_workspace', {});
  assert.deepEqual(opened, { opened: true, where: 'asked for in the chat', towns: ['Talarn'] });
  const refused = await run(false)('open_workspace', {});
  assert.deepEqual([refused.opened, refused.buttonInCard], [false, true]);
  assert.deepEqual(asked, [true, false]);
  assert.deepEqual(await run(true)('show_interview_panel', { panel: 'demo_bank' }), {
    error: 'This is not available in the card.',
  });
  const saved = await run(true)('save_interview_answers', { monthlyIncome: 3100 });
  assert.deepEqual(saved.updated, ['monthlyIncome']);

  // A message into the chat: ChatGPT's bridge first, then the MCP Apps request, else the sentence to type.
  const prompts: string[] = [];
  const openai = { sendFollowUpMessage: async ({ prompt }: { prompt: string }) => void prompts.push(prompt) };
  assert.equal(await sendToChat({ openai, app: host.app }, 'hola'), true);
  assert.deepEqual([prompts, host.messages], [['hola'], []]);
  assert.equal(await sendToChat({ app: host.app }, 'hola'), true);
  assert.deepEqual(host.messages, ['hola']);
  assert.equal(await sendToChat({ app: fakeHost({ signedIn: false, sendRefused: true }).app }, 'hola'), false);
  assert.equal(await sendToChat({ app: null }, 'hola'), false);
  const broken = { sendFollowUpMessage: () => Promise.reject(new Error('refused')) };
  assert.equal(await sendToChat({ openai: broken, app: null }, 'hola'), false);
});

// ------------------------------------------------------------ the voice call

type Sent = { type: string; [key: string]: unknown };
/** A browser for the call: a microphone, a peer connection whose data channel the test drives, and `fetch`. */
function fakeBrowser(options: { microphone?: Error; answer?: () => Response | Promise<Response> } = {}) {
  const track = { enabled: true, stopped: false, stop: () => void (track.stopped = true) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = {
    sent: [] as Sent[],
    onopen: undefined as undefined | (() => unknown),
    onclose: undefined as undefined | (() => unknown),
    onmessage: undefined as undefined | ((event: { data: string }) => unknown),
    send: (text: string) => void channel.sent.push(JSON.parse(text) as Sent),
  };
  const peer = {
    connectionState: 'new',
    closed: false,
    tracks: [] as unknown[],
    transceivers: [] as unknown[],
    remote: undefined as undefined | { type: string; sdp: string },
    ontrack: undefined as undefined | ((event: { streams: unknown[] }) => void),
    onconnectionstatechange: undefined as undefined | (() => void),
    addTrack: (added: unknown) => void peer.tracks.push(added),
    addTransceiver: (kind: string, init: unknown) => void peer.transceivers.push([kind, init]),
    createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'v=0 offer' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async (description: { type: string; sdp: string }) => void (peer.remote = description),
    close: () => void (peer.closed = true),
  };
  const requests: { url: string; init: RequestInit }[] = [];
  let asked = 0;
  const platform = {
    getUserMedia: async () => {
      asked++;
      if (options.microphone) throw options.microphone;
      return stream;
    },
    createPeer: () => peer,
    fetch: async (url: unknown, init: RequestInit = {}) => {
      requests.push({ url: String(url), init });
      return options.answer ? options.answer() : new Response('v=0 answer');
    },
  } as unknown as VoicePlatform;
  const receive = async (event: Record<string, unknown>) => {
    await channel.onmessage?.({ data: JSON.stringify(event) });
    await settle(5);
  };
  return { platform, peer, channel, track, requests, receive, microphoneAsked: () => asked };
}

/** A call wired to a fake browser, recording everything it tells its surface. */
function fakeCall(
  browser: ReturnType<typeof fakeBrowser>,
  overrides: Partial<Parameters<typeof startVoiceCall>[0]> = {},
) {
  const seen = {
    phases: [] as VoicePhase[],
    captions: [] as string[],
    canSend: [] as boolean[],
    ends: [] as VoiceEnd[],
    tools: [] as [string, Record<string, unknown>][],
    greeted: 0,
    streams: 0,
  };
  const call = startVoiceCall({
    endpoint: `${relocat}/interview/voice`,
    context: async () => context('es'),
    runTool: async (name, args) => {
      seen.tools.push([name, args]);
      return { stored: 'device', nextQuestion: null };
    },
    onPhase: phase => void seen.phases.push(phase),
    onGreeted: () => void seen.greeted++,
    onCaption: text => void seen.captions.push(text),
    onCanSend: allowed => void seen.canSend.push(allowed),
    onRemoteStream: () => void seen.streams++,
    onEnd: reason => void seen.ends.push(reason),
    platform: browser.platform,
    ...overrides,
  });
  return { call, seen };
}

test('a conversation: the offer goes to ReloCat, the session gets the card’s functions, and turns are taken', async () => {
  const browser = fakeBrowser();
  const { call, seen } = fakeCall(browser);
  assert.deepEqual(seen.phases, ['connecting']);
  await settle();
  // The microphone, then one request: the SDP offer to ReloCat's own route, by its absolute address. No key, no cookie.
  assert.equal(browser.microphoneAsked(), 1);
  assert.equal(browser.peer.tracks.length, 1);
  assert.equal(browser.requests.length, 1);
  const [{ url, init }] = browser.requests;
  assert.equal(url, 'https://www.relo.cat/interview/voice');
  assert.deepEqual([init.method, init.body], ['POST', 'v=0 offer']);
  assert.deepEqual(init.headers, { 'Content-Type': 'application/sdp' });
  assert.equal(init.credentials, undefined);
  assert.deepEqual(browser.peer.remote, { type: 'answer', sdp: 'v=0 answer' });

  // The data channel opens: the functions and the instructions of `voice.ts`, for the card.
  await browser.channel.onopen?.();
  assert.equal(call.configured, true);
  assert.deepEqual(browser.channel.sent, [sessionUpdate(context('es'))]);
  assert.equal(call.sayTyped('antes de tiempo'), false);

  // The service accepts them: the greeting is requested, once.
  await browser.receive({ type: 'session.updated' });
  assert.deepEqual([seen.greeted, call.greeted], [1, true]);
  assert.deepEqual(browser.channel.sent.at(-1), { type: 'response.create' });
  assert.equal(seen.phases.at(-1), 'thinking');
  await browser.receive({ type: 'response.created' });
  await browser.receive({ type: 'output_audio_buffer.started' });
  assert.equal(seen.phases.at(-1), 'speaking');
  await browser.receive({ type: 'response.output_audio_transcript.done', transcript: '¿Cuánto ingresas al mes?' });
  assert.deepEqual(seen.captions, ['¿Cuánto ingresas al mes?']);
  await browser.receive({ type: 'response.done' });
  await browser.receive({ type: 'output_audio_buffer.stopped' });
  assert.equal(seen.phases.at(-1), 'listening');
  assert.equal(seen.canSend.at(-1), true);
  browser.peer.ontrack?.({ streams: [{}] });
  assert.equal(seen.streams, 1);

  // The person speaks; the model calls a function; its result goes back and a spoken reply is requested.
  await browser.receive({ type: 'input_audio_buffer.speech_started' });
  assert.deepEqual([seen.phases.at(-1), seen.canSend.at(-1)], ['hearing', false]);
  await browser.receive({ type: 'input_audio_buffer.speech_stopped' });
  await browser.receive({ type: 'response.created' });
  const before = browser.channel.sent.length;
  await browser.receive({
    type: 'response.function_call_arguments.done',
    name: 'save_interview_answers',
    arguments: '{"monthlyIncome":3100}',
    call_id: 'call_1',
  });
  assert.deepEqual(seen.tools, [['save_interview_answers', { monthlyIncome: 3100 }]]);
  assert.deepEqual(browser.channel.sent.slice(before), [
    {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_1', output: '{"stored":"device","nextQuestion":null}' },
    },
  ]);
  await browser.receive({ type: 'response.done' });
  assert.deepEqual(browser.channel.sent.at(-1), { type: 'response.create' });
  // A function the session was never given is not run, and arguments that are not an object are a failure.
  await browser.receive({
    type: 'response.function_call_arguments.done',
    name: 'delete_everything',
    arguments: '{}',
    call_id: 'x',
  });
  assert.equal(seen.tools.length, 1);
  await browser.receive({
    type: 'response.function_call_arguments.done',
    name: 'show_plan',
    arguments: '[]',
    call_id: 'call_2',
  });
  assert.match(
    String((browser.channel.sent.at(-1) as { item?: { output?: string } }).item?.output),
    /could not be completed/,
  );
  await browser.receive({ type: 'response.done' });
  await browser.receive({ type: 'response.done' });

  // A typed reply goes through the same session, between turns only.
  assert.equal(seen.canSend.at(-1), true);
  assert.equal(call.sayTyped('Gasto 2050'), true);
  assert.deepEqual(browser.channel.sent.slice(-2), [
    {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Gasto 2050' }] },
    },
    { type: 'response.create' },
  ]);
  assert.equal(call.sayTyped('otra vez'), false);
  await browser.receive({ type: 'response.done' });

  // Mute stops the microphone track, not the conversation.
  assert.equal(call.setMuted(true), true);
  assert.deepEqual([browser.track.enabled, call.muted, seen.phases.at(-1)], [false, true, 'muted']);
  call.setMuted(false);
  assert.equal(browser.track.enabled, true);

  // A change of language is told to the session, and its settings follow.
  const sentBefore = browser.channel.sent.length;
  await call.changeLanguage('es');
  const [note, update] = browser.channel.sent.slice(sentBefore);
  assert.match(JSON.stringify(note), /changed the page language to Spanish/);
  assert.equal(update.type, 'session.update');

  // Stop: the peer and the microphone are released, and nothing is reported as a failure.
  call.close();
  assert.deepEqual([browser.peer.closed, browser.track.stopped, seen.ends], [true, true, []]);
  await browser.channel.onclose?.();
  assert.deepEqual(seen.ends, []);
  assert.equal(call.sayTyped('tarde'), false);
});

test('settings the service refuses are sent once more without transcription; a later error ends the call', async () => {
  const browser = fakeBrowser();
  const { call, seen } = fakeCall(browser);
  await settle();
  await browser.channel.onopen?.();
  await browser.receive({ type: 'error' });
  assert.deepEqual(browser.channel.sent.at(-1), sessionUpdate(context('es'), { transcription: false }));
  assert.deepEqual(seen.ends, []);
  await browser.receive({ type: 'session.updated' });
  assert.equal(call.greeted, true);
  await browser.receive({ type: 'error' });
  assert.deepEqual(seen.ends, [{ kind: 'error' }]);
  assert.equal(browser.peer.closed, true);
  // Something that is not an event of the protocol is ignored.
  await browser.channel.onmessage?.({ data: 'not json' });
});

test('every way voice can fail is told apart, and each has its sentence and its way forward', async () => {
  const failure = async (browser: ReturnType<typeof fakeBrowser>) => {
    const { seen } = fakeCall(browser);
    await settle();
    assert.equal(seen.ends.length, 1);
    assert.equal(browser.peer.closed, true);
    return seen.ends[0];
  };
  const named = (name: string) => Object.assign(new Error(`${name} raised`), { name });

  // The microphone is refused, or there is none: the conversation can still run with typed replies.
  const refused = await failure(fakeBrowser({ microphone: named('NotAllowedError') }));
  assert.deepEqual(refused, {
    kind: 'not_started',
    stage: 'microphone',
    status: 0,
    message: 'NotAllowedError raised',
    name: 'NotAllowedError',
  });
  assert.deepEqual(cardFailure(refused), { key: 'micRefused', offerTyping: true });
  const missing = await failure(fakeBrowser({ microphone: named('NotFoundError') }));
  assert.deepEqual(cardFailure(missing), { key: 'micUnavailable', offerTyping: true });

  // `/voice` refuses: the origin is not allowed, the limit is reached, there is no key.
  const status = (code: number, body = JSON.stringify({ error: 'Refused.' })) =>
    failure(fakeBrowser({ answer: () => new Response(body, { status: code }) }));
  const forbidden = await status(403);
  assert.deepEqual(forbidden, { kind: 'not_started', stage: 'service', status: 403, message: 'Refused.', name: '' });
  assert.deepEqual(cardFailure(forbidden), { key: 'voiceRefused', offerTyping: false });
  assert.deepEqual(cardFailure(await status(429)), { key: 'voiceBusy', offerTyping: false });
  assert.deepEqual(cardFailure(await status(503)), { key: 'voiceOff', offerTyping: false });
  assert.deepEqual(cardFailure(await status(502)), { key: 'voiceNetwork', offerTyping: false });
  // A refusal that is not JSON is a refusal all the same.
  assert.deepEqual(cardFailure(await status(403, '<html>proxy</html>')), { key: 'voiceRefused', offerTyping: false });
  // The network fails, as it does when a preflight is refused.
  const network = await failure(
    fakeBrowser({
      answer: () => {
        throw new TypeError('Failed to fetch');
      },
    }),
  );
  assert.deepEqual([network.kind, cardFailure(network).key], ['not_started', 'voiceNetwork']);
  // Cut off after it started.
  for (const kind of ['timeout', 'failed', 'disconnected', 'error'] as const)
    assert.deepEqual(cardFailure({ kind }), { key: 'voiceDropped', offerTyping: false });

  const dropped = fakeBrowser();
  const live = fakeCall(dropped);
  await settle();
  await dropped.channel.onclose?.();
  assert.deepEqual(live.seen.ends, [{ kind: 'disconnected' }]);
  const stalled = fakeBrowser();
  const slow = fakeCall(stalled, { timeoutMs: 30 });
  await settle(60);
  assert.deepEqual(slow.seen.ends, [{ kind: 'timeout' }]);
  const failed = fakeBrowser();
  const lost = fakeCall(failed);
  await settle();
  failed.peer.connectionState = 'failed';
  failed.peer.onconnectionstatechange?.();
  assert.deepEqual(lost.seen.ends, [{ kind: 'failed' }]);
});

test('without a microphone the assistant still speaks and the person types', async () => {
  const browser = fakeBrowser({ microphone: new Error('never asked') });
  const { call, seen } = fakeCall(browser, { microphone: false });
  await settle();
  assert.equal(browser.microphoneAsked(), 0);
  assert.deepEqual(browser.peer.transceivers, [['audio', { direction: 'recvonly' }]]);
  assert.equal(browser.requests.length, 1);
  await browser.channel.onopen?.();
  await browser.receive({ type: 'session.updated' });
  await browser.receive({ type: 'response.done' });
  assert.equal(call.sayTyped('Ingreso 3100'), true);
  // There is nothing to mute.
  assert.equal(call.setMuted(true), false);
  assert.deepEqual(seen.ends, []);
  call.close();
});

// ------------------------------------------------- the bundle, in a fake host

/** A value made by the bundle, which runs in a context of its own, as plain data of this one. */
const plain = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;

type FakeNode = {
  id: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  className: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, (event: unknown) => unknown>;
  [key: string]: unknown;
};

/**
 * The built card run as a chat host runs it: in a frame whose parent answers the MCP Apps handshake
 * and the card's requests. The nodes are the ones `card.html` declares, so the script and the
 * template are checked against each other.
 */
async function runCard(
  options: {
    hostLocale?: string;
    openai?: Record<string, unknown>;
    serverTools?: boolean;
    signedIn?: boolean;
    microphone?: Error;
    voice?: () => Response;
  } = {},
) {
  const file = new URL('../apps/interviewer/dist/card.js', import.meta.url);
  assert.ok(existsSync(file), 'run `npm run build` first');
  const make = (id = ''): FakeNode => {
    const element: FakeNode = {
      id,
      textContent: '',
      hidden: false,
      disabled: false,
      value: '',
      className: '',
      dataset: {},
      attributes: {},
      children: [],
      listeners: {},
      setAttribute: (name: string, value: string) => void (element.attributes[name] = value),
      removeAttribute: (name: string) => void delete element.attributes[name],
      addEventListener: (type: string, listener: (event: unknown) => unknown) =>
        void (element.listeners[type] = listener),
      append: (...nodes: FakeNode[]) => void element.children.push(...nodes),
      replaceChildren: (...nodes: FakeNode[]) => void (element.children = nodes),
      querySelectorAll: (selector: string) => (selector === 'button' ? element.children : []),
      closest: () => element,
      focus: () => {},
      play: () => Promise.resolve(),
    };
    return element;
  };
  // The elements of the template, by id and by catalog key.
  const template = read('apps/interviewer/card.html').split('<body>')[1];
  const byId = new Map<string, FakeNode>();
  const marked = { i18n: [] as FakeNode[], say: [] as FakeNode[] };
  for (const [, attributes, text] of template.matchAll(/<\w+((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>([^<]*)/g)) {
    const attribute = (name: string) => attributes.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    const id = attribute('id');
    const element = make(id);
    element.textContent = text;
    element.hidden = /\shidden(\s|$)/.test(attributes);
    if (id) byId.set(id, element);
    const [i18n, say, lang] = [attribute('data-i18n'), attribute('data-say'), attribute('data-lang')];
    if (i18n) marked.i18n.push(Object.assign(element, { dataset: { i18n } }));
    if (say) marked.say.push(Object.assign(element, { dataset: { say } }));
    if (lang) byId.get('languages')?.children.push(Object.assign(element, { dataset: { lang } }));
  }
  const sent: { id?: number; method?: string; params?: Record<string, unknown> }[] = [];
  const listeners: ((event: unknown) => void)[] = [];
  const parent = { postMessage: (message: (typeof sent)[number]) => void sent.push(message) };
  const size = { width: 360, height: 420 };
  const documentElement = {
    lang: 'en',
    style: {},
    dataset: { voiceEndpoint: `${relocat}/interview/voice` },
    scrollWidth: size.width,
    scrollHeight: size.height,
    getBoundingClientRect: () => size,
  };
  const document = {
    title: '',
    documentElement,
    body: make(),
    getElementById: (id: string) => {
      const element = byId.get(id);
      assert(element, `card.html has no #${id}`);
      return element;
    },
    createElement: () => make(),
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === '[data-i18n]' ? marked.i18n : selector === '[data-say]' ? marked.say : [],
  };
  const browser = fakeBrowser({ microphone: options.microphone, answer: options.voice });
  const peerConstructor = function construct() {
    return browser.peer;
  };
  const window: Record<string, unknown> = {
    parent,
    openai: options.openai,
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (type === 'message') listeners.push(listener);
    },
    removeEventListener() {},
  };
  window.window = window;
  vm.runInNewContext(readFileSync(file, 'utf8'), {
    window,
    document,
    location: { search: '' },
    navigator: { languages: ['en-GB'], mediaDevices: { getUserMedia: browser.platform.getUserMedia } },
    // The card asks for a peer with `new`; it gets the one the test drives.
    RTCPeerConnection: peerConstructor,
    fetch: browser.platform.fetch,
    localStorage: { getItem: () => null, setItem: () => {} },
    console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
    getComputedStyle: () => ({}),
    setTimeout,
    clearTimeout,
    AbortController,
    Promise,
    Response,
    URLSearchParams,
    URL,
    Intl,
    Date,
    JSON,
  });
  const deliver = async (data: Record<string, unknown>) => {
    for (const listener of listeners) listener({ source: parent, data: { jsonrpc: '2.0', ...data } });
    await settle();
  };
  /** The host answers every request the card has made and that is still open. */
  const answered = new Set<number>();
  const toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
  const chat: string[] = [];
  const serve = async () => {
    for (let round = 0; round < 12; round++) {
      const open = sent.filter(message => message.id !== undefined && message.method && !answered.has(message.id));
      if (!open.length) break;
      for (const message of open) {
        answered.add(message.id as number);
        if (message.method === 'ui/initialize')
          await deliver({
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion,
              hostInfo: { name: 'test-host', version: '1.0.0' },
              hostCapabilities: options.serverTools === false ? {} : { serverTools: {} },
              hostContext: options.hostLocale ? { locale: options.hostLocale } : {},
            },
          });
        else if (message.method === 'tools/call') {
          const call = message.params as { name: string; arguments: Record<string, unknown> };
          toolCalls.push({ name: call.name, arguments: call.arguments });
          const structuredContent =
            call.name === 'start_homebuying_interview'
              ? { signedIn: options.signedIn ?? false }
              : call.name === 'list_catalonia_municipalities'
                ? { municipalities: towns }
                : call.name === 'get_next_questions'
                  ? { nextQuestions: [] }
                  : undefined;
          await deliver({
            id: message.id,
            result: structuredContent
              ? { content: [], structuredContent }
              : { isError: true, content: [{ type: 'text', text: 'Unavailable.' }] },
          });
        } else if (message.method === 'ui/message') {
          chat.push((message.params as { content: { text: string }[] }).content[0].text);
          await deliver({ id: message.id, result: {} });
        } else await deliver({ id: message.id, result: {} });
      }
    }
  };
  await settle();
  const node = (id: string) => document.getElementById(id);
  const click = async (id: string, target?: FakeNode) => {
    // The handler may wait for its host (a message into the chat): the host answers while it runs.
    const handled = Promise.resolve(node(id).listeners.click?.({ target: target ?? node(id), preventDefault() {} }));
    await settle();
    await serve();
    await handled;
    await settle();
    await serve();
  };

  return {
    sent,
    serve,
    node,
    click,
    browser,
    toolCalls,
    chat,
    document,
    marked,
    text: (id: string) => node(id).textContent,
  };
}

test('the card finishes the host handshake at once and shows the host’s language', async () => {
  const card = await runCard({ hostLocale: 'ca-ES' });
  // The first thing it does, before anything else, is ask to be initialised.
  assert.deepEqual(
    card.sent.map(message => message.method),
    ['ui/initialize'],
  );
  // English until the host says otherwise: the template's own text.
  assert.equal(card.text('start'), 'Start talking');
  await card.serve();
  assert.equal(card.sent[1]?.method, 'ui/notifications/initialized');
  // Who is connected is asked through the host, of the tool that shows the card.
  assert.deepEqual(plain(card.toolCalls), [{ name: 'start_homebuying_interview', arguments: {} }]);

  assert.equal(card.document.documentElement.lang, 'ca');
  assert.equal(card.document.title, cardCatalog.ca.title);
  for (const element of card.marked.i18n)
    assert.equal(element.textContent, cardCatalog.ca[element.dataset.i18n as keyof typeof cardCatalog.ca]);
  for (const element of card.marked.say)
    assert.equal(element.textContent, pageCatalog.ca[element.dataset.say as keyof typeof pageCatalog.ca]);
  assert.equal(card.text('start'), 'Comença a parlar');
  assert.equal(card.text('continue'), 'Continua al xat');
  assert.equal(card.text('voice-status'), cardCatalog.ca.ready);
  assert.equal(card.node('languages').attributes['aria-label'], 'Idioma');
  assert.deepEqual(
    card.node('languages').children.map(button => [button.dataset.lang, button.attributes['aria-pressed']]),
    [
      ['en', 'false'],
      ['ca', 'true'],
      ['es', 'false'],
    ],
  );
  // The trail of seven checkpoints, from the first one.
  assert.equal(card.node('trail').hidden, false);
  assert.equal(card.text('trail-title'), 'Sobre tu');
  assert.equal(
    card.text('trail-count'),
    pageCatalog.ca['trail.count'].replace('{reached}', '0').replace('{total}', '7'),
  );
  assert.equal(card.node('trail-steps').children.length, 7);
  // Idle: one way to start, nothing of a live conversation.
  for (const [id, hidden] of Object.entries({ start: false, stop: true, mute: true, 'typed-answer': true, plan: true }))
    assert.equal(card.node(id).hidden, hidden, id);

  // The switcher: Spanish, chosen here, wins over the host from then on.
  await card.click('languages', card.node('languages').children[2]);
  assert.equal(card.document.documentElement.lang, 'es');
  assert.equal(card.text('start'), 'Empieza a hablar');
  assert.equal(card.text('continue'), 'Sigue en el chat');
  assert.equal(card.text('voice-status'), cardCatalog.es.ready);
  assert.equal(card.text('trail-title'), 'Sobre ti');
});

test('Start talking runs the conversation in the card: microphone, offer to ReloCat, captions, typed reply, stop', async () => {
  const card = await runCard({ hostLocale: 'es' });
  await card.serve();
  await card.click('start');
  const { browser } = card;
  assert.equal(browser.microphoneAsked(), 1);
  assert.deepEqual(
    browser.requests.map(request => [request.url, request.init.method, request.init.body]),
    [['https://www.relo.cat/interview/voice', 'POST', 'v=0 offer']],
  );
  assert.equal(card.node('card').dataset.voice, 'connecting');
  assert.equal(card.text('voice-status'), pageCatalog.es.connectingMic);
  assert.deepEqual([card.node('start').hidden, card.node('stop').hidden], [true, false]);

  // The channel opens: the session is given the card's functions and instructions, in Spanish.
  void browser.channel.onopen?.();
  await settle();
  await card.serve();
  await settle();
  const update = browser.channel.sent[0] as unknown as ReturnType<typeof sessionUpdate>;
  assert.equal(update.type, 'session.update');
  assert.deepEqual(
    update.session.tools.map(tool => tool.name),
    voiceTools('card').map(tool => tool.name),
  );
  assert.match(update.session.instructions, /Speak with the person in Spanish/);
  assert.match(update.session.instructions, /has not connected their ReloCat account in this chat/);
  assert.deepEqual(update.session.audio.input.transcription, { model: 'gpt-4o-mini-transcribe', language: 'es' });

  await browser.receive({ type: 'session.updated' });
  await browser.receive({ type: 'output_audio_buffer.started' });
  assert.equal(card.text('voice-status'), pageCatalog.es.speaking);
  // Live: mute, the typed reply and stop; the caption is on without asking.
  for (const id of ['mute', 'typed-answer', 'stop']) assert.equal(card.node(id).hidden, false, id);
  assert.equal(card.text('mute'), pageCatalog.es.mute);
  await browser.receive({ type: 'response.output_audio_transcript.done', transcript: '¿Cuánto ingresas al mes?' });
  assert.deepEqual(
    [card.text('last-question'), card.node('last-question').hidden],
    ['¿Cuánto ingresas al mes?', false],
  );
  // Not connected: said in the card too.
  assert.equal(card.text('notice'), cardCatalog.es.notSaved);
  await browser.receive({ type: 'response.done' });
  await browser.receive({ type: 'output_audio_buffer.stopped' });
  assert.equal(card.text('voice-status'), pageCatalog.es.listening);
  assert.equal(card.node('send-answer').disabled, false);

  // An answer by voice is kept in the card; the trail moves.
  void browser.receive({
    type: 'response.function_call_arguments.done',
    name: 'save_interview_answers',
    arguments: '{"monthlyIncome":3100}',
    call_id: 'call_1',
  });
  await settle();
  await card.serve();
  await settle();
  const output = browser.channel.sent.find(
    event => (event.item as { call_id?: string } | undefined)?.call_id === 'call_1',
  );
  const result = JSON.parse((output?.item as { output: string } | undefined)?.output ?? '{}') as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    [result.updated, result.stored, result.sayOnce],
    [['monthlyIncome'], 'device', cardCatalog.es.notSaved],
  );
  assert.equal(card.text('trail-title'), 'Tu dinero');
  await browser.receive({ type: 'response.done' });
  await browser.receive({ type: 'response.done' });

  // A typed reply goes through the same session.
  card.node('answer').value = '  Gasto 2050  ';
  await card.node('typed-answer').listeners.submit?.({ preventDefault() {} });
  assert.deepEqual(plain(browser.channel.sent.at(-2)), {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Gasto 2050' }] },
  });
  assert.equal(card.node('answer').value, '');

  // The workspace is asked for in the chat, with the towns of the plan; no window is opened.
  await browser.receive({ type: 'response.done' });
  void browser.receive({
    type: 'response.function_call_arguments.done',
    name: 'open_workspace',
    arguments: '{}',
    call_id: 'call_2',
  });
  await settle();
  await card.serve();
  await settle();
  assert.deepEqual(card.chat, ['Usa ReloCat para mostrar mi espacio de trabajo.']);
  assert.equal(card.text('workspace-status'), cardCatalog.es.workspaceSent);
  assert.equal(card.node('plan').hidden, false);

  await card.click('stop');
  assert.deepEqual([browser.peer.closed, browser.track.stopped], [true, true]);
  assert.equal(card.node('card').dataset.voice, 'idle');
  assert.equal(card.text('voice-status'), cardCatalog.es.ended);
  for (const [id, hidden] of Object.entries({ start: false, stop: true, mute: true, 'typed-answer': true }))
    assert.equal(card.node(id).hidden, hidden, id);
  // The plan the trail follows is read through the host as well; the answers went inline, never as a user id.
  await settle(250);
  await card.serve();
  const planned = card.toolCalls.find(call => call.name === 'plan_home_savings');
  assert.equal(
    (planned?.arguments.person as { finances: { monthlyIncomeCents: number } } | undefined)?.finances
      .monthlyIncomeCents,
    310_000,
  );
  for (const call of card.toolCalls) assert(!('userId' in call.arguments), call.name);
});

test('a refused microphone, a refused origin and a host without tools each leave a way forward', async () => {
  // The microphone is refused: say so, offer typed replies and the chat.
  const refused = await runCard({
    hostLocale: 'es',
    microphone: Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
  });
  await refused.serve();
  await refused.click('start');
  assert.equal(refused.text('voice-status'), cardCatalog.es.micRefused);
  assert.equal(refused.node('card').dataset.voice, 'idle');
  assert.deepEqual(
    [refused.node('start').hidden, refused.node('type-instead').hidden, refused.node('continue').hidden],
    [false, false, false],
  );
  assert.equal(refused.browser.requests.length, 0);
  // "Answer by typing" starts the conversation without asking for the microphone again.
  await refused.click('type-instead');
  assert.equal(refused.browser.microphoneAsked(), 1);
  assert.deepEqual(plain(refused.browser.peer.transceivers), [['audio', { direction: 'recvonly' }]]);
  assert.equal(refused.browser.requests.length, 1);
  assert.equal(refused.text('voice-status'), cardCatalog.es.typing);
  await refused.click('stop');

  // `/voice` refuses this origin (403), the hourly limit (429), no key (503): each says which, in the person's language.
  for (const [status, key] of [
    [403, 'voiceRefused'],
    [429, 'voiceBusy'],
    [503, 'voiceOff'],
  ] as const) {
    const card = await runCard({
      hostLocale: 'ca',
      voice: () => new Response(JSON.stringify({ error: 'Refused.' }), { status }),
    });
    await card.serve();
    await card.click('start');
    assert.equal(card.text('voice-status'), cardCatalog.ca[key], key);
    assert.deepEqual([card.node('start').hidden, card.node('type-instead').hidden], [false, true]);
    assert.deepEqual([card.browser.peer.closed, card.browser.track.stopped], [true, true]);
  }

  // "Continue in the chat instead": ChatGPT's bridge when it is there, else the MCP Apps message, else the sentence.
  const prompts: string[] = [];
  const chatgpt = await runCard({
    hostLocale: 'es',
    openai: { sendFollowUpMessage: ({ prompt }: { prompt: string }) => void prompts.push(prompt) },
  });
  await chatgpt.serve();
  await chatgpt.click('continue');
  assert.deepEqual(prompts, [cardCatalog.es.startMessage]);
  assert.deepEqual([chatgpt.text('chat-status'), chatgpt.node('continue').disabled], [cardCatalog.es.sent, true]);
  assert.deepEqual(chatgpt.chat, []);
  const standard = await runCard({ hostLocale: 'ca' });
  await standard.serve();
  await standard.click('continue');
  assert.deepEqual(standard.chat, [cardCatalog.ca.startMessage]);
  assert.equal(standard.text('chat-status'), cardCatalog.ca.sent);

  // A host that offers no tool calls: no call is attempted, and the conversation still starts.
  const bare = await runCard({ hostLocale: 'es', serverTools: false });
  await bare.serve();
  assert.equal(bare.toolCalls.length, 0);
  await bare.click('start');
  assert.equal(bare.browser.requests.length, 1);
  void bare.browser.channel.onopen?.();
  await settle();
  const update = bare.browser.channel.sent[0] as unknown as ReturnType<typeof sessionUpdate>;
  assert.match(update.session.instructions, /This card cannot reach the ReloCat tools/);
  await bare.browser.receive({ type: 'session.updated' });
  assert.equal(bare.text('notice'), cardCatalog.es.noTools);
  await bare.click('stop');
});

// ------------------------------------------- handed out by the MCP server

async function startTalkingResource(options: Parameters<typeof registerInterviewerTools>[1]) {
  const server = new McpServer({ name: 'card-test', version: '1' });
  registerInterviewerTools(server, options);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'card-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const resource = (await client.readResource({ uri: 'ui://relocat/start-talking.html' })).contents[0];
    assert('text' in resource);
    const start = await client.callTool({ name: 'start_homebuying_interview', arguments: {} });
    const tool = (await client.listTools()).tools.find(entry => entry.name === 'start_homebuying_interview');
    return {
      text: resource.text,
      mimeType: resource.mimeType,
      meta: resource._meta as {
        ui: {
          csp: { connectDomains: string[]; resourceDomains: string[] };
          permissions: unknown;
          prefersBorder: boolean;
        };
        'openai/widgetCSP'?: { connect_domains?: string[]; resource_domains?: string[]; redirect_domains?: string[] };
      },
      started: start.structuredContent as { voiceInCard: boolean; signedIn: boolean },
      description: tool?.description ?? '',
      toolMeta: tool?._meta,
    };
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

test('the MCP server hands out the embedded card with the microphone and a way to reach ReloCat', async () => {
  const page = loadInterviewCard({ origin: relocat });
  assert(page);
  const embedded = await startTalkingResource({ voiceUrl: null, interviewCard: { page, origin: relocat } });
  assert.equal(embedded.text, page);
  assert.equal(embedded.mimeType, 'text/html;profile=mcp-app');
  // The card may connect to ReloCat's own origin and nowhere else, in both forms a host reads.
  assert.deepEqual(embedded.meta.ui.csp, { connectDomains: [relocat], resourceDomains: [] });
  assert.deepEqual(embedded.meta['openai/widgetCSP'], { connect_domains: [relocat], resource_domains: [] });
  assert.deepEqual(embedded.meta.ui.permissions, { microphone: {} });
  assert.equal(embedded.meta.ui.prefersBorder, true);
  assert.deepEqual(embedded.toolMeta?.ui, { resourceUri: 'ui://relocat/start-talking.html' });
  assert.equal(embedded.started.voiceInCard, true);
  assert.match(
    embedded.description,
    /When voiceInCard is true, the card shown with this result holds the voice interview/,
  );

  // Without it: the simple card, whose main button continues in the chat. It connects nowhere.
  for (const voiceUrl of [null, 'https://www.relo.cat/interview/']) {
    const simple = await startTalkingResource({ voiceUrl });
    assert.match(simple.text, /class="rc-btn rc-btn--gold start-here"/);
    assert.doesNotMatch(simple.text, /data-voice-endpoint|RTCPeerConnection|getUserMedia/);
    assert.deepEqual(simple.meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.equal(simple.meta['openai/widgetCSP']?.connect_domains, undefined);
    assert.deepEqual(simple.meta.ui.permissions, { microphone: {} });
    assert.equal(simple.started.voiceInCard, false);
    assert.doesNotMatch(simple.description, /voiceInCard/);
  }
  // The probe that checked the microphone in ChatGPT is gone from the simple card.
  assert.doesNotMatch(read('apps/mcp-server/voice-card-widget.ts'), /PROBE|mic-probe|featurePolicy/);
  assert.doesNotMatch(read('apps/mcp-server/dist/voice-card.js'), /mic-probe/);
});

test('the embedded card is built only when voice can answer a card in a chat', () => {
  const ready = {
    publicOrigin: `${relocat}/`,
    apiKey: 'fake-test-key',
    publicAi: true,
    embedOrigins: ['.oaiusercontent.com'],
  };
  const card = embeddedInterviewCard(ready);
  assert.equal(card?.origin, relocat);
  assert.equal(card?.page, loadInterviewCard({ origin: relocat }));
  // Any one missing: no key, voice closed to visitors, no public origin, no embedding origin.
  for (const missing of [
    { apiKey: undefined },
    { apiKey: '' },
    { publicAi: false },
    { publicOrigin: null },
    { embedOrigins: [] },
    { embedOrigins: undefined },
  ])
    assert.equal(embeddedInterviewCard({ ...ready, ...missing }), undefined, JSON.stringify(missing));
});

/** Read a resource of the main server over `/mcp`, as a chat host does. */
async function readStartTalking(origin: string) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'ui://relocat/start-talking.html' },
    }),
  });
  const body = (await response.json()) as {
    result: { contents: { text: string; _meta: { ui: { csp: { connectDomains: string[] } } } }[] };
  };
  return body.result.contents[0];
}

test('the main server serves the simple card by default and the embedded one when it is given, with voice reachable from the chat', async t => {
  // No embed configuration in the environment of a test: the simple card.
  const plainApp = await startApp();
  t.after(() => plainApp.close());
  const simple = await readStartTalking(plainApp.origin);
  assert.match(simple.text, /class="rc-btn rc-btn--gold start-here"/);
  assert.deepEqual(simple._meta.ui.csp.connectDomains, []);

  // The composition root hands the card to the MCP server, and mounts the voice route the card calls.
  const upstream: string[] = [];
  const page = loadInterviewCard({ origin: relocat });
  assert(page);
  const embedded = await startApp({
    interviewCard: { page, origin: relocat },
    interviewer: createInterviewerHandler({
      prefix: '/interview',
      apiKey: 'fake-test-key',
      publicAi: true,
      embedOrigins: [chatHost],
      log: () => {},
      fetcher: (async (url: unknown) => {
        upstream.push(String(url));
        return new Response('v=0 answer');
      }) as typeof fetch,
    }),
  });
  t.after(() => embedded.close());
  const card = await readStartTalking(embedded.origin);
  assert.equal(card.text, page);
  assert.deepEqual(card._meta.ui.csp.connectDomains, [relocat]);
  // The card's preflight and its offer pass every layer of the main server.
  const preflight = await fetch(`${embedded.origin}/interview/voice`, {
    method: 'OPTIONS',
    headers: {
      Origin: chatHost,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.deepEqual([preflight.status, preflight.headers.get('access-control-allow-origin')], [204, chatHost]);
  const answer = await fetch(`${embedded.origin}/interview/voice`, {
    method: 'POST',
    headers: { Origin: chatHost, 'Content-Type': 'application/sdp' },
    body: 'v=0 offer',
  });
  assert.deepEqual(
    [answer.status, answer.headers.get('access-control-allow-origin'), await answer.text()],
    [200, chatHost, 'v=0 answer'],
  );
  assert.deepEqual(upstream, ['https://api.openai.com/v1/realtime/calls']);
  const refused = await fetch(`${embedded.origin}/interview/voice`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/sdp' },
    body: 'v=0 offer',
  });
  assert.equal(refused.status, 403);
  assert.equal(upstream.length, 1);
  // `null` clears the card whatever the environment says.
  const cleared = await startApp({ interviewCard: null });
  t.after(() => cleared.close());
  assert.match((await readStartTalking(cleared.origin)).text, /start-here/);
});
