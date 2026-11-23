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
  answerControls,
  cardFailure,
  cardTopics,
  cardVoiceContext,
  cardVoiceTools,
  hostAccess,
  hostCallTool,
  notSavedNotice,
  planSummary,
  sendToChat,
  shownQuestion,
  topicValues,
  typedNumber,
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
import { sessionUpdate, turnDetection, voiceInstructions, voiceTools } from '../apps/interviewer/voice.ts';
import { registerInterviewerTools } from '../apps/mcp-server/interview-tools.ts';
import { planResult } from '../packages/contracts/planner.ts';
import { createFormat } from '../packages/i18n/format.ts';
import type { Locale } from '../packages/i18n/locales.ts';
import { blankPerson, questionById } from '../packages/model/questions.ts';
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
  assert.doesNotMatch(
    page,
    /<script src=|<link rel="stylesheet"|<!-- WIDGET -->|\/\* THEME \*\/|\/\* ART \*\/|<!-- ICON/,
  );
  assert.match(page, /--rc-art-step-profile: url\("data:image\//);
  assert.match(page, /@font-face\{font-family:"Montserrat"/);

  const template = read('apps/interviewer/card.html');
  // Every text of the template is a catalog entry, written in English until the script runs.
  const english = cardCatalog.en as Record<string, string>;
  for (const [, key, text] of template.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]+)</g))
    assert.equal(text, english[key], key);
  // A control that is an icon is named from the catalog, for assistive tech and on hover.
  for (const [tag, key] of template.matchAll(/<\w+[^>]*data-i18n-label="([^"]+)"[^>]*>/g))
    assert(tag.includes(`aria-label="${english[key]}"`), `${key} names its control`);
  for (const [tag] of template.matchAll(/<button[^>]*class="round[^"]*"[^>]*data-i18n-label[^>]*>/g))
    assert.match(tag, / title="[^"]+"/);
  assert.match(template, /data-i18n-placeholder="typeReply" placeholder="Type a reply"/);
  assert.match(template, /<label class="rc-sr-only" for="answer" data-i18n="typeReply">Type a reply<\/label>/);

  // The orb is the start button; there is no paragraph of introduction and no full-width text button.
  assert.match(
    template,
    /<button id="orb" type="button" class="orb" data-i18n-label="start" aria-label="Start talking"/,
  );
  assert.match(template, /<h1 id="title" data-i18n="heading">Your interview<\/h1>/);
  assert.doesNotMatch(template, /class="intro"|rc-btn--gold|rc-btn--block|id="start"|id="mute"/);
  assert.equal(template.match(/class="rc-btn/g)?.length, 1, 'one text button: the workspace, in the plan summary');
  assert.match(
    template,
    /<button id="continue" type="button" class="link" data-i18n="continueInChat">Continue in the chat</,
  );
  // The language switcher: three codes, each named in full.
  assert.match(
    template,
    /class="rc-lang" id="languages"[^>]*>(<button type="button" data-lang="(en|ca|es)" lang="\2" aria-label="[^"]+" title="[^"]+" aria-pressed="(true|false)">(EN|CA|ES)<\/button>){3}/,
  );
  // One question, announced; the controls are round icon buttons.
  assert.match(template, /<p id="question" aria-live="polite" hidden>/);
  for (const id of ['keyboard', 'done', 'stop'])
    assert.match(
      template,
      new RegExp(`<button id="${id}" type="button" class="round[^"]*"[^>]* aria-label="[^"]+"`),
      id,
    );
  assert.match(
    template,
    /<button id="trail" type="button" class="trail" aria-expanded="false" aria-controls="plan" hidden>/,
  );
  assert.match(template, /<input id="amount" type="text" inputmode="decimal"/);
  // Five things to tell, as chips with an icon and a word.
  assert.equal(template.match(/class="chip topic"/g)?.length, 5);
  assert.match(template, /<audio id="audio" autoplay>/);

  // Touch targets, a field that does not zoom a phone, press feedback, and a level that moves only transform and opacity.
  assert.match(template, /\.chip \{[^}]*min-height: var\(--rc-control\)/);
  assert.match(template, /\.round \{[^}]*width: var\(--rc-control\); height: var\(--rc-control\)/);
  assert.match(template, /\.field input \{[^}]*font-size: 1rem/);
  assert.match(template, /:active[^{]*\{ transform: scale\(0\.97\); \}/);
  assert.match(
    template,
    /\.stage::before \{[^}]*opacity: calc\(0\.16 \+ var\(--level\) \* 0\.3\); transform: scale\(calc\(1\.08 \+ var\(--level\) \* 0\.24\)\);/,
  );
  assert.equal(template.match(/var\(--level\)/g)?.length, 2, 'the level drives nothing else');
  assert.match(
    template,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.stage::before \{ opacity: 0\.2; transform: scale\(1\.12\); \}/,
  );
  // The question keeps its place: three lines are reserved.
  assert.match(template, /\.ask \{[^}]*min-height: calc\(var\(--question-line\) \* 3\)/);
  // What the text budget below takes from the stylesheet: what a live card hides.
  assert.match(template, /\[data-live="true"\] h1 \{ position: absolute;/);
  assert.match(template, /\[data-live="true"\] \.fine, \[data-live="true"\] #continue \{ display: none; \}/);

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

test('the catalog is words and short lines, in the three languages', () => {
  assert.deepEqual(
    (['en', 'ca', 'es'] as const).map(locale => cardCatalog[locale].tapToTalk),
    ['Tap to talk', 'Toca per parlar', 'Toca para hablar'],
  );
  assert.deepEqual(
    (['en', 'ca', 'es'] as const).map(locale => cardCatalog[locale].heading),
    ['Your interview', 'La teva entrevista', 'Tu entrevista'],
  );
  assert.deepEqual(
    (['en', 'ca', 'es'] as const).map(locale => [
      cardCatalog[locale].listening,
      cardCatalog[locale].speaking,
      cardCatalog[locale].muted,
    ]),
    [
      ['Listening', 'Speaking', 'Muted'],
      ['T’escolto', 'Parlant', 'En silenci'],
      ['Te escucho', 'Hablando', 'En silencio'],
    ],
  );
  assert.deepEqual(
    (['en', 'ca', 'es'] as const).map(locale => cardCatalog[locale].done),
    ['I’m done', 'Ja estic', 'He terminado'],
  );
  assert.equal(cardCatalog.en.voiceNote, 'Your voice is sent to OpenAI.');
  assert.equal(cardCatalog.en.notSaved, 'Not saved: connect ReloCat in ChatGPT.');
  assert.equal(cardCatalog.ca.continueInChat, 'Continua al xat');
  assert.equal(cardCatalog.es.continueInChat, 'Sigue en el chat');
  // What is read by a screen reader only, or sent into the chat, may be a sentence; nothing else is.
  const sentences = ['title', 'startMessage', 'typeIt', 'workspaceMessage', 'workspaceMessageNoTowns', 'topics'];
  const words = (text: string) => text.split(/\s+/).filter(word => /\p{L}/u.test(word)).length;
  for (const locale of ['en', 'ca', 'es'] as const) {
    for (const [key, text] of Object.entries(cardCatalog[locale])) {
      // The two plural lines are counted as they print ("1 aid counted"), not as they are written.
      if (sentences.includes(key) || key.startsWith('trailLabel') || key.startsWith('aid')) continue;
      // One line at 320 px: about forty characters of the smallest text.
      assert(text.length <= 42, `${locale}.${key} is one short line`);
      assert(words(text) <= 7, `${locale}.${key} is a few words`);
    }
    // Not saved, and how to save: connect ReloCat in the chat host.
    assert.match(cardCatalog[locale].notSaved, /ReloCat.*ChatGPT/);
    // A failure is one line; the way forward is the link and the button of the card, not more words.
    for (const key of [
      'micRefused',
      'micUnavailable',
      'voiceRefused',
      'voiceBusy',
      'voiceOff',
      'voiceNetwork',
    ] as const)
      assert(cardCatalog[locale][key].length <= 30, `${locale}.${key}`);
    for (const topic of cardTopics) assert(words(cardCatalog[locale][topic.label]) <= 2, `${locale}.${topic.label}`);
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

test('of a spoken turn the card shows the one line that asks, and offers to tap only what it knows how to answer', () => {
  // An acknowledgement or a notice before the question is heard, not shown.
  assert.deepEqual(shownQuestion('Vale, anotado. Sin guardar: conecta ReloCat en ChatGPT. ¿Cuánto gastas al mes?'), {
    text: '¿Cuánto gastas al mes?',
    asks: true,
  });
  // The last question of the turn; a dot inside a figure does not end a sentence.
  assert.equal(shownQuestion('Has dit 3.100 € al mes? I quant gastes?').text, 'I quant gastes?');
  assert.equal(shownQuestion('Did you say €3,100.50 a month?').text, 'Did you say €3,100.50 a month?');
  // A turn that asks nothing shows its last sentence, and no answer to tap goes with it.
  assert.deepEqual(shownQuestion('Tell me your income and your savings. I’m listening.'), {
    text: 'I’m listening.',
    asks: false,
  });
  assert.deepEqual(shownQuestion('  '), { text: '', asks: false });

  const controls = (answer: unknown, allowUnknown = false, locale: Locale = 'es') =>
    answerControls({ answer, allowUnknown } as Parameters<typeof answerControls>[0], locale);
  const labels = (found: ReturnType<typeof answerControls>) =>
    found?.kind === 'chips' ? found.options.map(option => option.label) : null;
  assert.deepEqual(labels(controls({ type: 'boolean' })), ['Sí', 'No']);
  assert.deepEqual(labels(controls({ type: 'boolean' }, true)), ['Sí', 'No', 'No lo sé']);
  assert.deepEqual(labels(controls({ type: 'boolean' }, true, 'ca')), ['Sí', 'No', 'No ho sé']);
  assert.deepEqual(labels(controls({ type: 'boolean' }, true, 'en')), ['Yes', 'No', 'I don’t know']);
  const choice = { type: 'choice', options: ['Individual', 'Conjunta'].map(label => ({ value: label, label })) };
  assert.deepEqual(labels(controls(choice)), ['Individual', 'Conjunta']);
  assert.deepEqual(controls({ type: 'money', storedAs: 'cents', min: 0, max: 1 }), {
    kind: 'number',
    unit: '€',
    unknown: null,
  });
  assert.deepEqual(controls({ type: 'number', unit: 'personas', min: 1, max: 30 }, true), {
    kind: 'number',
    unit: 'personas',
    unknown: 'No lo sé',
  });
  assert.deepEqual(controls({ type: 'percent', min: 0, max: 100 }), { kind: 'number', unit: '%', unknown: null });
  assert.deepEqual(controls({ type: 'place' }), { kind: 'text' });
  // A date or the children of the household are said or typed; no question known, nothing to tap.
  assert.equal(controls({ type: 'date', min: '1906-01-01', max: day }), null);
  assert.equal(answerControls(null, 'es'), null);
  // The compact field takes a figure, with a comma or a dot for the cents, and nothing else.
  assert.deepEqual(['3100', ' 24 000 ', '1250,5', '0.75'].map(typedNumber), ['3100', '24000', '1250,5', '0.75']);
  assert.deepEqual(['', 'tres mil', '-5', '1.2.3', '12,345'].map(typedNumber), [null, null, null, null, null]);
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
    'Ingresos',
    'Gastos',
    'Ahorros',
    'Hogar',
    'Lugar',
    'Escribe una respuesta',
    'He terminado',
    'Abre el espacio',
  ])
    assert(spanish.includes(`“${label}”`), label);
  for (const english of ['“Income”', '“Open workspace”', '“Type a reply”', '“I’m done”'])
    assert(!spanish.includes(english));
  assert.match(
    voiceInstructions(context('ca')),
    /Speak with the person in Catalan \(Català\)[\s\S]*“Ingressos”[\s\S]*“Ja estic”/,
  );
  assert.match(voiceInstructions(context('en')), /Speak in the user's language[\s\S]*“Income”[\s\S]*“I’m done”/);
  // A tapped or typed reply is a reply; a chip's name with a value corrects that figure.
  assert.match(spanish, /treat a tapped or typed reply like a spoken one/);
  assert.match(spanish, /\(“Ingresos: 3100 €”\) states or corrects that figure: save it at once/);
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
  // The same rules as the page: one question a turn after the opening, unknown is never zero, the plan is the planner's.
  assert.match(spanish, /ask one question per turn, then stop and listen\./);
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
  assert.match(voiceInstructions({ ...context('es'), surface: 'page' }), /call\s+show_interview_panel/);
  assert.equal(
    voiceInstructions({ ...context('es'), surface: undefined }),
    voiceInstructions({ ...context('es'), surface: 'page' }),
  );
});

test('the interview opens with a quick explanation, a free answer, and only what is missing asked after it', () => {
  const words = (text: string) => text.split(/\s+/).filter(word => /\p{L}/u.test(word)).length;
  for (const locale of ['en', 'ca', 'es'] as const) {
    const opening = pageCatalog[locale]['voice.opening'];
    // At most two short sentences, about twenty words, and it ends by saying it is listening.
    assert(words(opening) <= 20, `${locale}: ${words(opening)} words`);
    assert.equal(opening.match(/[.!?]/g)?.length, 2, `${locale}: two sentences`);
    assert.match(opening, /(I’m listening|T’escolto|Te escucho)\.$/);
    // The card and the page share it, word for word, in the language shown.
    for (const surface of ['card', 'page'] as const) {
      const said = voiceInstructions({ ...context(locale), surface, answeredIds: [], places: [] });
      assert(said.includes(`“${opening}” Then stop and listen.`), `${locale} ${surface}`);
      assert.match(said, /the first turn is not a question\. Say only this,\s+in the wording given and nothing more/);
      assert.match(said, /at most two short sentences, about twenty words/);
      // The free answer: pauses are the person's, and everything said is saved in one call, silently.
      assert.match(said, /never\s+interrupt, never prompt and never fill a silence/);
      assert.match(
        said,
        /When they finish, say nothing first\. Call save_interview_answers\s+ONCE with every figure they stated/,
      );
      assert.match(said, /call save_place with the name of a town they named/);
      // The honesty rules are the same as before.
      assert.match(said, /a figure they\s+did not mention is left out, never zero and never a guess/);
      assert.match(
        said,
        /a household or tax fact is never inferred from what they said\s+and is saved only after they say yes to it/,
      );
      assert.match(said, /a town is stored only on an exact match of the pilot and after a yes/);
      // Then only what is missing, in one short sentence, and the plan as soon as it can be computed.
      assert.match(
        said,
        /do not read it back\. Reply with at most one short\s+sentence that names only what is still missing/,
      );
      assert.match(said, /When nothing a timeline needs is missing, call\s+show_plan at once/);
      assert.match(said, /When some answers already exist, skip the opening/);
    }
  }
  // The five things asked for are the five chips of the card.
  assert.match(pageCatalog.en['voice.opening'], /income and spending, your savings, who will live there and where/);
  assert.deepEqual(
    cardTopics.map(topic => [topic.id, cardCatalog.es[topic.label]]),
    [
      ['monthlyIncome', 'Ingresos'],
      ['monthlyExpenses', 'Gastos'],
      ['purchaseSavings', 'Ahorros'],
      ['householdSize', 'Hogar'],
      ['place', 'Lugar'],
    ],
  );
  // One call for a free answer is what the function says too.
  assert.match(
    voiceTools('card')[0].description,
    /free answer at the start, call it ONCE with every figure they stated, and with nothing they did not say/,
  );

  // A thinking pause does not end the turn: semantic detection at its most patient. Refused, the session falls back
  // to the service's default detection together with the other optional settings.
  assert.deepEqual(sessionUpdate(context('es')).session.audio.input.turn_detection, {
    type: 'semantic_vad',
    eagerness: 'low',
    create_response: true,
    interrupt_response: true,
  });
  assert.deepEqual(sessionUpdate(context('es'), { transcription: false }).session.audio.input.turn_detection, {
    type: 'server_vad',
    create_response: true,
    interrupt_response: true,
  });
  assert.deepEqual(turnDetection(), sessionUpdate(context('ca')).session.audio.input.turn_detection);
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
  assert.match(String(where(first).sayOnce), /^Sin guardar: conecta ReloCat en ChatGPT\.$/);
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

test('“I’m done” ends the person’s turn at once, and the settings that wait for a pause fall back when refused', async () => {
  const browser = fakeBrowser();
  const streams: unknown[] = [];
  const { call, seen } = fakeCall(browser, { onLocalStream: stream => void streams.push(stream) });
  await settle();
  // The microphone is handed to the surface for its level meter; the call still owns it.
  assert.equal(streams.length, 1);
  await browser.channel.onopen?.();
  // The session is asked to wait for the person: semantic detection, low eagerness.
  const first = browser.channel.sent[0] as unknown as ReturnType<typeof sessionUpdate>;
  assert.deepEqual(first.session.audio.input.turn_detection, {
    type: 'semantic_vad',
    eagerness: 'low',
    create_response: true,
    interrupt_response: true,
  });
  // Not live yet: there is no turn to end.
  assert.equal(call.endTurn(), false);
  await browser.receive({ type: 'session.updated' });
  // ReloCat is answering: still nothing to end.
  assert.equal(call.endTurn(), false);
  await browser.receive({ type: 'response.done' });
  await browser.receive({ type: 'input_audio_buffer.speech_started' });
  assert.equal(seen.phases.at(-1), 'hearing');

  // Done, mid-sentence or in a pause: what was said is committed and the reply is requested, without waiting.
  const before = browser.channel.sent.length;
  assert.equal(call.endTurn(), true);
  assert.deepEqual(browser.channel.sent.slice(before), [
    { type: 'input_audio_buffer.commit' },
    { type: 'response.create' },
  ]);
  assert.deepEqual([seen.phases.at(-1), seen.canSend.at(-1)], ['thinking', false]);
  assert.equal(call.endTurn(), false, 'once per turn');
  // Nothing had been said since the last turn: the service refuses the commit, and the conversation goes on.
  await browser.receive({ type: 'error' });
  assert.deepEqual(seen.ends, []);
  await browser.receive({ type: 'response.done' });
  // Muted, there is no turn to end either.
  call.setMuted(true);
  assert.equal(call.endTurn(), false);
  call.setMuted(false);
  // Any other error still ends the call.
  await browser.receive({ type: 'error' });
  assert.deepEqual(seen.ends, [{ kind: 'error' }]);

  // The service refuses the first settings: they are sent once more as they were before, default detection included.
  const refused = fakeBrowser();
  const second = fakeCall(refused);
  await settle();
  await refused.channel.onopen?.();
  await refused.receive({ type: 'error' });
  const fallback = refused.channel.sent.at(-1) as unknown as ReturnType<typeof sessionUpdate>;
  assert.deepEqual(fallback.session.audio.input.turn_detection, {
    type: 'server_vad',
    create_response: true,
    interrupt_response: true,
  });
  assert.equal('transcription' in fallback.session.audio.input, false);
  assert.deepEqual(second.seen.ends, []);
  // Without a microphone there is no audio to commit.
  await refused.receive({ type: 'session.updated' });
  await refused.receive({ type: 'response.done' });
  assert.equal(second.call.endTurn(), true);
  second.call.close();
  const typing = fakeBrowser();
  const third = fakeCall(typing, { microphone: false });
  await settle();
  await typing.channel.onopen?.();
  await typing.receive({ type: 'session.updated' });
  await typing.receive({ type: 'response.done' });
  assert.equal(third.call.endTurn(), false);
  third.call.close();
});

// ------------------------------------------------- the bundle, in a fake host

/** A value made by the bundle, which runs in a context of its own, as plain data of this one. */
const plain = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;

type FakeNode = {
  tag: string;
  id: string;
  /** The node's own text; `textContent` adds its children's, and setting it removes them, as in a browser. */
  own: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  className: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  style: Record<string, string>;
  children: FakeNode[];
  parent: FakeNode | null;
  listeners: Record<string, (event: unknown) => unknown>;
  append: (...nodes: FakeNode[]) => void;
  [key: string]: unknown;
};

/** One question as `get_next_questions` ranks it; `required` puts it before the town and the household. */
const ranked = (id: string, question: string, answer: Record<string, unknown>, allowUnknown = false) => ({
  id,
  inputPath: `test.${id}`,
  label: id,
  question,
  why: 'Asked by the test.',
  help: null,
  sensitivity: null,
  answer,
  allowUnknown,
  state: 'missing',
  effect: {
    kind: 'required',
    months: null,
    upfrontCents: null,
    municipalityCode: null,
    placeName: null,
    policyIds: [],
    alsoNeeds: [],
    text: '',
  },
});

/** A plan as `plan_home_savings` returns it for the towns asked: 31 months, one aid counted, one to verify. */
function examplePlan(codes: string[], person: unknown = blankPerson()) {
  const benefit = {
    kind: 'upfront_cost_reduction',
    callStatus: 'open',
    sourceUrl: 'https://example.org/source',
    explanation: 'Explained by the planner.',
    scope: 'place',
  };
  return planResult.parse({
    person,
    asOf: day,
    nextQuestions: [],
    knownFacts: [],
    conflicts: [],
    habits: [],
    plans: codes.map(code => ({
      place: {
        municipalityCode: code,
        name: towns.find(town => town.code === code)?.name ?? code,
        comarca: 'Pallars Jussà',
        rural: 'rural',
        centre: { latitude: 42.18, longitude: 0.9 },
        indicators: {
          population: null,
          densityPerKm2: null,
          foreignPopulationPercent: null,
          resaleEurPerM2: null,
          rentEurPerMonth: null,
        },
        services: [],
        dataMissing: [],
      },
      status: 'estimated',
      purchasePriceCents: 12_000_000,
      priceBasis: 'budget',
      baseline: { upfrontCashCents: 3_840_000, monthlySavingsCents: 105_000, months: 37 },
      withHabits: { upfrontCashCents: 3_840_000, monthlySavingsCents: 105_000, months: 37 },
      withPlaceBenefits: { upfrontCashCents: 3_240_000, monthlySavingsCents: 105_000, months: 31 },
      monthsSaved: 6,
      monthsSavedByHabits: 0,
      monthsSavedByPlace: 6,
      benefits: [
        {
          ...benefit,
          policyId: 'itp_buy',
          title: 'Reduced transfer tax',
          amountCents: 600_000,
          eligibilityStatus: 'eligible',
          counted: true,
        },
        {
          ...benefit,
          policyId: 'itp_young_buyer',
          title: 'Reduced transfer tax for young buyers',
          amountCents: null,
          nominalAmountCents: 500_000,
          eligibilityStatus: 'needs_verification',
          counted: false,
        },
      ],
      assumptions: [],
      dataMissing: [],
    })),
    limitations: [],
  });
}

/**
 * The built card run as a chat host runs it: in a frame whose parent answers the MCP Apps handshake
 * and the card's requests. The nodes are the ones `card.html` declares, as a tree, so the script and
 * the template are checked against each other and the text a person would see can be read back.
 */
async function runCard(
  options: {
    hostLocale?: string;
    openai?: Record<string, unknown>;
    serverTools?: boolean;
    signedIn?: boolean;
    microphone?: Error;
    voice?: () => Response;
    /** What `get_next_questions` ranks now; read at every call. */
    questions?: () => unknown[];
    /** `plan_home_savings` answers with a plan for the towns asked. */
    plan?: boolean;
    /** The frame can measure sound: an `AudioContext` whose analysers the test reads. */
    sound?: boolean;
    reducedMotion?: boolean;
  } = {},
) {
  const file = new URL('../apps/interviewer/dist/card.js', import.meta.url);
  assert.ok(existsSync(file), 'run `npm run build` first');
  const all: FakeNode[] = [];
  const make = (tag = 'div', parent: FakeNode | null = null): FakeNode => {
    const element = {
      tag,
      id: '',
      own: '',
      hidden: false,
      disabled: false,
      value: '',
      className: '',
      dataset: {},
      attributes: {},
      children: [],
      parent,
      listeners: {},
      style: {},
      setAttribute: (name: string, value: string) => void (element.attributes[name] = value),
      getAttribute: (name: string) => element.attributes[name] ?? null,
      removeAttribute: (name: string) => void delete element.attributes[name],
      addEventListener: (type: string, listener: (event: unknown) => unknown) =>
        void (element.listeners[type] = listener),
      append: (...nodes: FakeNode[]) => {
        for (const child of nodes) child.parent = element;
        element.children.push(...nodes);
      },
      replaceChildren: (...nodes: FakeNode[]) => {
        for (const child of nodes) child.parent = element;
        element.children = nodes;
      },
      querySelectorAll: (selector: string) =>
        selector === 'button' ? all.filter(other => other.tag === 'button' && within(other, element)) : [],
      closest: () => {
        for (let at: FakeNode | null = element; at; at = at.parent)
          if (at.tag === 'button' && at.dataset.lang) return at;
        return null;
      },
      focus: () => void (focused = element),
      play: () => Promise.resolve(),
    } as unknown as FakeNode;
    element.style.setProperty = ((name: string, value: string) => void (element.style[name] = value)) as never;
    Object.defineProperty(element, 'textContent', {
      get: () => element.own + element.children.map(child => child.textContent).join(''),
      set: (text: string) => {
        element.own = text;
        element.children = [];
      },
    });
    all.push(element);
    return element;
  };
  const within = (element: FakeNode, ancestor: FakeNode) => {
    for (let at = element.parent; at; at = at.parent) if (at === ancestor) return true;
    return false;
  };
  let focused: FakeNode | null = null;

  // The elements of the template, as a tree.
  const body = make('body');
  const byId = new Map<string, FakeNode>();
  const stack = [body];
  const camel = (name: string) => name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
  const markup = read('apps/interviewer/card.html').split('<body>')[1].split('</body>')[0];
  for (const [, comment, closing, tag, attributes, text] of markup.matchAll(
    /<!--([\s\S]*?)-->|<\/(\w+)>|<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>|([^<]+)/g,
  )) {
    const top = stack[stack.length - 1];
    if (comment !== undefined) {
      if (comment.trim().startsWith('ICON:')) top.append(make('svg'));
    } else if (closing) stack.pop();
    else if (tag) {
      const element = make(tag);
      for (const [, name, value = ''] of attributes.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)) {
        if (name === 'id') element.id = value;
        else if (name === 'class') element.className = value;
        else if (name === 'hidden') element.hidden = true;
        else if (name === 'disabled') element.disabled = true;
        else if (name.startsWith('data-')) element.dataset[camel(name.slice(5))] = value;
        else element.attributes[name] = value;
      }
      if (element.id) byId.set(element.id, element);
      top.append(element);
      if (tag !== 'input') stack.push(element);
    } else if (text?.trim()) top.own += text.trim();
  }
  assert.equal(stack.length, 1, 'card.html closes every element it opens');

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
  const pageListeners: Record<string, () => void> = {};
  const document = {
    title: '',
    hidden: false,
    documentElement,
    body,
    getElementById: (id: string) => {
      const element = byId.get(id);
      assert(element, `card.html has no #${id}`);
      return element;
    },
    createElement: (tag: string) => make(tag),
    addEventListener: (type: string, listener: () => void) => void (pageListeners[type] = listener),
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      const key = {
        '[data-i18n]': 'i18n',
        '[data-i18n-label]': 'i18nLabel',
        '[data-i18n-placeholder]': 'i18nPlaceholder',
      }[selector];
      return key ? all.filter(element => key in element.dataset && within(element, body)) : [];
    },
  };
  const browser = fakeBrowser({ microphone: options.microphone, answer: options.voice });
  const peerConstructor = function construct() {
    return browser.peer;
  };
  /** The sound the frame measures: how many contexts and analysers exist, and how often a level was read. */
  const sound = { contexts: 0, closed: 0, analysers: 0, reads: 0, frames: 0, mediaQueries: [] as string[] };
  class FakeAudioContext {
    constructor() {
      sound.contexts++;
    }
    createAnalyser() {
      sound.analysers++;
      return {
        fftSize: 0,
        getByteTimeDomainData(samples: Uint8Array) {
          sound.reads++;
          samples.fill(200);
        },
      };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    close() {
      sound.closed++;
      return Promise.resolve();
    }
  }
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
    requestAnimationFrame: (run: () => void) => {
      sound.frames++;
      return setTimeout(run, 2);
    },
    cancelAnimationFrame: (frame: ReturnType<typeof setTimeout>) => clearTimeout(frame),
    matchMedia: (query: string) => {
      sound.mediaQueries.push(query);
      return { matches: options.reducedMotion === true && query === '(prefers-reduced-motion: reduce)' };
    },
    ...(options.sound ? { AudioContext: FakeAudioContext } : {}),
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
                  ? { nextQuestions: options.questions?.() ?? [] }
                  : call.name === 'plan_home_savings' && options.plan
                    ? examplePlan(call.arguments.municipalityCodes as string[], call.arguments.person)
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
  /** Press a control: one of the template by id, or a chip the card made. The host answers while the handler runs. */
  const click = async (target: string | FakeNode, eventTarget?: FakeNode) => {
    const element = typeof target === 'string' ? node(target) : target;
    const handled = Promise.resolve(element.listeners.click?.({ target: eventTarget ?? element, preventDefault() {} }));
    await settle();
    await serve();
    await handled;
    await settle();
    await serve();
  };
  const submit = async (id: string) => {
    await node(id).listeners.submit?.({ preventDefault() {} });
    await settle();
  };
  /** What the stylesheet hides: `hidden`, the screen-reader-only class, and what a live card leaves out. */
  const shown = (element: FakeNode): boolean => {
    for (let at: FakeNode | null = element; at; at = at.parent) {
      if (at.hidden || at.className.split(' ').includes('rc-sr-only') || at.tag === 'svg' || at.tag === 'audio')
        return false;
      if (node('card').dataset.live === 'true' && ['title', 'voice-note', 'continue'].includes(at.id)) return false;
    }
    return true;
  };
  /** The words a person reads on the card now, outside the parts that are not prose. */
  const prose = (outside: string[]) => {
    const skip = outside.map(node);
    return all
      .filter(element => element.own && within(element, body) && shown(element))
      .filter(element => !skip.some(part => part === element || within(element, part)))
      .flatMap(element => element.own.split(/\s+/))
      .filter(word => /\p{L}/u.test(word));
  };
  /** The spoken turns the card sent for the person: tapped, confirmed or typed. */
  const answers = () =>
    browser.channel.sent.flatMap(event => {
      const item = event.item as { role?: string; content?: { text: string }[] } | undefined;
      return item?.role === 'user' ? [item.content?.[0].text] : [];
    });
  /** Start talking and bring the conversation live. */
  const talk = async () => {
    await click('orb');
    void browser.channel.onopen?.();
    await settle();
    await serve();
    await settle();
    await browser.receive({ type: 'session.updated' });
    await serve();
  };
  /** ReloCat says something and its turn ends. */
  const says = async (transcript: string) => {
    await browser.receive({ type: 'response.created' });
    await browser.receive({ type: 'output_audio_buffer.started' });
    await browser.receive({ type: 'response.output_audio_transcript.done', transcript });
    await browser.receive({ type: 'response.done' });
    await browser.receive({ type: 'output_audio_buffer.stopped' });
  };
  /** The model calls functions in one reply; their results, as it reads them. */
  let callId = 0;
  const calls = async (...requests: [name: string, args: Record<string, unknown>][]) => {
    await browser.receive({ type: 'response.created' });
    const ids = requests.map(() => `call_${++callId}`);
    for (const [index, [name, args]] of requests.entries()) {
      void browser.receive({
        type: 'response.function_call_arguments.done',
        name,
        arguments: JSON.stringify(args),
        call_id: ids[index],
      });
      for (let round = 0; round < 4; round++) {
        await settle();
        await serve();
      }
    }
    await browser.receive({ type: 'response.done' });
    return ids.map(id => {
      const output = browser.channel.sent.find(
        event => (event.item as { call_id?: string } | undefined)?.call_id === id,
      );
      return JSON.parse((output?.item as { output: string } | undefined)?.output ?? '{}') as Record<string, unknown>;
    });
  };

  return {
    sent,
    serve,
    node,
    click,
    submit,
    prose,
    answers,
    talk,
    says,
    calls,
    browser,
    toolCalls,
    chat,
    document,
    sound,
    pageListeners,
    focused: () => focused,
    text: (id: string) => node(id).textContent,
    label: (id: string) => node(id).attributes['aria-label'],
    chips: () => node('choices').children,
    topic: (id: string) => [
      node(id).dataset.state,
      node(`${id}-value`).hidden ? null : node(`${id}-value`).textContent,
    ],
  };
}

/** The card's own words, outside the question, the chips, the plan summary, an open notice and the disclosure. */
const notProse = ['question', 'choices', 'figure', 'topics', 'plan', 'notice', 'voice-note'];

test('the card finishes the host handshake at once and shows the host’s language', async () => {
  const card = await runCard({ hostLocale: 'ca-ES' });
  // The first thing it does, before anything else, is ask to be initialised.
  assert.deepEqual(
    card.sent.map(message => message.method),
    ['ui/initialize'],
  );
  // English until the host says otherwise: the template's own text.
  assert.deepEqual([card.label('orb'), card.text('state')], ['Start talking', 'Tap to talk']);
  await card.serve();
  assert.equal(card.sent[1]?.method, 'ui/notifications/initialized');
  // Who is connected is asked through the host, of the tool that shows the card.
  assert.deepEqual(plain(card.toolCalls), [{ name: 'start_homebuying_interview', arguments: {} }]);

  assert.equal(card.document.documentElement.lang, 'ca');
  assert.equal(card.document.title, cardCatalog.ca.title);
  for (const element of card.document.querySelectorAll('[data-i18n]'))
    assert.equal(element.textContent, cardCatalog.ca[element.dataset.i18n as keyof typeof cardCatalog.ca]);
  for (const element of card.document.querySelectorAll('[data-i18n-label]')) {
    const name = cardCatalog.ca[element.dataset.i18nLabel as keyof typeof cardCatalog.ca];
    assert.deepEqual([element.attributes['aria-label'], element.attributes.title], [name, name], element.id);
  }
  assert.equal(card.node('answer').attributes.placeholder, 'Escriu una resposta');
  // Idle: the orb is the start button, with three words under it; no paragraph.
  assert.equal(card.node('orb').tag, 'button');
  assert.deepEqual([card.label('orb'), card.text('state')], ['Comença a parlar', 'Toca per parlar']);
  assert.deepEqual(
    [card.node('orb').attributes['aria-pressed'], card.node('orb').attributes['aria-disabled']],
    [undefined, undefined],
  );
  assert.equal(card.text('title'), 'La teva entrevista');
  assert.equal(card.text('voice-note'), 'La teva veu s’envia a OpenAI.');
  assert.equal(card.text('continue'), 'Continua al xat');
  assert.equal(card.label('languages'), 'Idioma');
  assert.deepEqual(
    card
      .node('languages')
      .children.map(button => [button.dataset.lang, button.textContent, button.attributes['aria-pressed']]),
    [
      ['en', 'EN', 'false'],
      ['ca', 'CA', 'true'],
      ['es', 'ES', 'false'],
    ],
  );
  // The trail in one row: seven segments, a count, and a name that says both and the checkpoint to work on.
  assert.equal(card.node('trail').hidden, false);
  assert.equal(card.text('trail-count'), '0/7');
  assert.equal(card.label('trail'), '0 de 7 punts assolits, actual: Sobre tu');
  assert.equal(card.node('trail-art').dataset.step, 'step-profile');
  assert.deepEqual(
    card.node('trail-steps').children.map(step => step.dataset.state),
    ['current', 'ahead', 'unknown', 'ahead', 'unknown', 'unknown', 'unknown'],
  );
  // Nothing of a live conversation.
  for (const id of [
    'controls',
    'topics',
    'question',
    'choices',
    'figure',
    'typed-answer',
    'plan',
    'notice',
    'type-instead',
  ])
    assert.equal(card.node(id).hidden, true, id);
  assert.deepEqual([card.node('card').dataset.voice, card.node('card').dataset.live], ['idle', 'false']);

  // The switcher: Spanish, chosen here, wins over the host from then on.
  await card.click('languages', card.node('languages').children[2]);
  assert.equal(card.document.documentElement.lang, 'es');
  assert.deepEqual([card.label('orb'), card.text('state')], ['Empieza a hablar', 'Toca para hablar']);
  assert.equal(card.text('continue'), 'Sigue en el chat');
  assert.equal(card.label('trail'), '0 de 7 puntos alcanzados, actual: Sobre ti');
});

test('the text budget: in every state and language the card reads in twelve words or fewer', async t => {
  const measured: Record<string, Record<string, number>> = {};
  for (const locale of ['en', 'ca', 'es'] as const) {
    const count: Record<string, number> = {};
    const card = await runCard({ hostLocale: locale });
    await card.serve();
    count.idle = card.prose(notProse).length;
    assert.deepEqual(
      card.prose(notProse).slice(0, cardCatalog[locale].heading.split(' ').length),
      cardCatalog[locale].heading.split(' '),
    );
    // The disclosure about the microphone is the one line kept besides: it is short too.
    assert.equal(card.prose([]).length - count.idle, cardCatalog[locale].voiceNote.split(' ').length);
    assert(cardCatalog[locale].voiceNote.split(' ').length <= 6);

    await card.click('orb');
    count.connecting = card.prose(notProse).length;
    void card.browser.channel.onopen?.();
    await settle();
    await card.serve();
    await card.browser.receive({ type: 'session.updated' });
    count.thinking = card.prose(notProse).length;
    await card.says('Tell me about your month. Are you listening?');
    count.listening = card.prose(notProse).length;
    assert.equal(card.node('question').hidden, false);
    assert.equal(card.node('topics').hidden, false);
    await card.browser.receive({ type: 'output_audio_buffer.started' });
    count.speaking = card.prose(notProse).length;
    await card.browser.receive({ type: 'output_audio_buffer.stopped' });
    await card.click('orb');
    count.muted = card.prose(notProse).length;
    await card.click('keyboard');
    count.typing = card.prose(notProse).length;
    // The trail opens the plan summary: it is not prose, and the rest does not grow.
    await card.click('trail');
    count.plan = card.prose(notProse).length;
    await card.click('stop');
    count.ended = card.prose(notProse).length;

    // A refused microphone: the way forward takes the place of the state line.
    const refused = await runCard({
      hostLocale: locale,
      microphone: Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    });
    await refused.serve();
    await refused.click('orb');
    count.refused = refused.prose(notProse).length;
    assert.equal(refused.node('notice').hidden, false);

    for (const [state, total] of Object.entries(count)) assert(total <= 12, `${locale} ${state}: ${total} words`);
    measured[locale] = count;
  }
  t.diagnostic(`words per state: ${JSON.stringify(measured)}`);
});

test('the orb starts the conversation, then mutes it; the state is a word; typed replies and stop are icons', async () => {
  const income = ranked('monthlyIncome', '¿Cuánto ingresas al mes?', {
    type: 'money',
    storedAs: 'cents',
    min: 0,
    max: 50_000_000,
  });
  const card = await runCard({ hostLocale: 'es', questions: () => [income] });
  await card.serve();
  await card.click('orb');
  const { browser } = card;
  assert.equal(browser.microphoneAsked(), 1);
  assert.deepEqual(
    browser.requests.map(request => [request.url, request.init.method, request.init.body]),
    [['https://www.relo.cat/interview/voice', 'POST', 'v=0 offer']],
  );
  // Connecting: a word, and an orb that cannot mute yet.
  assert.deepEqual([card.node('card').dataset.voice, card.node('card').dataset.live], ['connecting', 'true']);
  assert.deepEqual([card.text('state'), card.label('orb')], ['Conectando', 'Conectando']);
  assert.equal(card.node('orb').attributes['aria-disabled'], 'true');
  assert.deepEqual([card.node('controls').hidden, card.node('typed-answer').hidden], [false, true]);

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
  assert.equal(update.session.audio.input.turn_detection.type, 'semantic_vad');

  await browser.receive({ type: 'session.updated' });
  await browser.receive({ type: 'output_audio_buffer.started' });
  // Speaking: said in a word, and the orb is now the mute control.
  assert.deepEqual([card.node('card').dataset.voice, card.text('state')], ['speaking', 'Hablando']);
  assert.deepEqual(
    [card.label('orb'), card.node('orb').attributes['aria-pressed']],
    ['Silencia el micrófono', 'false'],
  );
  assert.equal(card.node('orb').attributes.title, 'Silencia el micrófono');
  assert.equal(card.node('orb').attributes['aria-disabled'], undefined);
  assert.equal(card.node('done').disabled, true, 'nothing to end while ReloCat speaks');
  // A turn with more than the question: only the question is shown, large, with no history.
  await browser.receive({
    type: 'response.output_audio_transcript.done',
    transcript: 'Hola. Cuéntame tus ingresos y gastos al mes. ¿Cuánto ingresas al mes?',
  });
  assert.deepEqual([card.text('question'), card.node('question').hidden], ['¿Cuánto ingresas al mes?', false]);
  // Not connected: one line, once.
  assert.deepEqual([card.text('notice-text'), card.node('notice').hidden], [cardCatalog.es.notSaved, false]);
  assert.equal(card.node('notice').dataset.long, 'false');
  await browser.receive({ type: 'response.done' });
  await browser.receive({ type: 'output_audio_buffer.stopped' });
  assert.deepEqual([card.node('card').dataset.voice, card.text('state')], ['listening', 'Te escucho']);
  assert.deepEqual([card.node('send-answer').disabled, card.node('done').disabled], [false, false]);

  // The orb mutes and unmutes: the name, the pressed state and the word all say it.
  await card.click('orb');
  assert.equal(browser.track.enabled, false);
  assert.deepEqual(
    [
      card.label('orb'),
      card.node('orb').attributes['aria-pressed'],
      card.text('state'),
      card.node('card').dataset.voice,
    ],
    ['Activa el micrófono', 'true', 'En silencio', 'muted'],
  );
  assert.equal(card.node('done').disabled, true);
  await card.click('orb');
  assert.equal(browser.track.enabled, true);
  assert.deepEqual(
    [card.label('orb'), card.node('orb').attributes['aria-pressed'], card.text('state')],
    ['Silencia el micrófono', 'false', 'Te escucho'],
  );

  // The notice is closed with its icon and does not come back.
  assert.equal(card.label('notice-close'), 'Cierra');
  await card.click('notice-close');
  assert.equal(card.node('notice').hidden, true);

  // An answer by voice is kept in the card; the trail and the chip of that figure move.
  const [saved] = await card.calls(['save_interview_answers', { monthlyIncome: 3100 }]);
  assert.deepEqual(
    [saved.updated, saved.stored, saved.sayOnce],
    [['monthlyIncome'], 'device', cardCatalog.es.notSaved],
  );
  assert.equal(card.node('trail-art').dataset.step, 'step-money');
  assert.equal(card.text('trail-count'), '1/7');
  assert.deepEqual(card.topic('topic-income'), ['filled', createFormat('es').eurosAuto(310_000)]);
  assert.equal(card.node('notice').hidden, true, 'said once');
  await browser.receive({ type: 'response.done' });

  // The keyboard button opens the one field for a typed reply; it goes through the same session.
  assert.deepEqual(
    [card.node('typed-answer').hidden, card.node('keyboard').attributes['aria-expanded']],
    [true, 'false'],
  );
  await card.click('keyboard');
  assert.deepEqual(
    [card.node('typed-answer').hidden, card.node('keyboard').attributes['aria-expanded']],
    [false, 'true'],
  );
  assert.equal(card.focused(), card.node('answer'));
  card.node('answer').value = '  Gasto 2050  ';
  await card.submit('typed-answer');
  assert.deepEqual(plain(browser.channel.sent.at(-2)), {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Gasto 2050' }] },
  });
  assert.equal(card.node('answer').value, '');
  await card.click('keyboard');
  assert.equal(card.node('typed-answer').hidden, true);

  // The workspace is asked for in the chat, with the towns of the plan; no window is opened.
  await browser.receive({ type: 'response.done' });
  await card.calls(['open_workspace', {}]);
  assert.deepEqual(card.chat, ['Usa ReloCat para mostrar mi espacio de trabajo.']);
  assert.equal(card.node('plan').hidden, false);

  // Stop: an icon named "end". The orb is the start button again and the card says the conversation ended.
  assert.equal(card.label('stop'), 'Termina la conversación');
  await card.click('stop');
  assert.deepEqual([browser.peer.closed, browser.track.stopped], [true, true]);
  assert.deepEqual([card.node('card').dataset.voice, card.node('card').dataset.live], ['idle', 'false']);
  assert.deepEqual([card.text('state'), card.label('orb')], ['Conversación terminada', 'Empieza a hablar']);
  assert.equal(card.node('orb').attributes['aria-pressed'], undefined);
  for (const id of ['controls', 'question', 'choices', 'figure', 'typed-answer'])
    assert.equal(card.node(id).hidden, true, id);
  // What was understood stays in sight.
  assert.equal(card.node('topics').hidden, false);
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

test('a closed question is answered by tapping: yes, no, I don’t know, an option or a figure', async () => {
  let next: unknown[] = [ranked('primaryResidence', '¿Será tu vivienda habitual?', { type: 'boolean' }, true)];
  const card = await runCard({ hostLocale: 'es', questions: () => next });
  await card.serve();
  await card.talk();
  const { browser } = card;
  const labels = () => card.chips().map(chip => chip.textContent);
  const states = () => card.chips().map(chip => [chip.disabled, chip.attributes['aria-pressed'] ?? 'false']);

  // ReloCat asks the question it was given, after a word of its own: the question, and its answers to tap.
  await browser.receive({ type: 'response.created' });
  await browser.receive({ type: 'output_audio_buffer.started' });
  await browser.receive({
    type: 'response.output_audio_transcript.done',
    transcript: 'Perfecto. ¿Será tu vivienda habitual?',
  });
  assert.equal(card.text('question'), '¿Será tu vivienda habitual?');
  assert.deepEqual([card.node('choices').hidden, card.node('figure').hidden], [false, true]);
  assert.deepEqual(labels(), ['Sí', 'No', 'No lo sé']);
  for (const chip of card.chips())
    assert.deepEqual([chip.tag, chip.className, chip.disabled], ['button', 'chip', false]);
  // Tapped while ReloCat is still speaking: the chips wait, and the answer goes out when the turn ends.
  await card.click(card.chips()[2]);
  assert.deepEqual(states(), [
    [true, 'false'],
    [true, 'false'],
    [true, 'true'],
  ]);
  assert.deepEqual(card.answers(), []);
  await browser.receive({ type: 'response.done' });
  await browser.receive({ type: 'output_audio_buffer.stopped' });
  assert.deepEqual(card.answers(), ['No lo sé']);
  // A second tap sends nothing.
  await card.click(card.chips()[0]);
  assert.deepEqual(card.answers(), ['No lo sé']);

  // The model saves it and is told the next question: a choice, with the options of the question set.
  next = [
    ranked('filing', '¿Cómo tributas en la renta?', {
      type: 'choice',
      options: [
        { value: 'individual', label: 'Individual' },
        { value: 'joint', label: 'Conjunta' },
      ],
    }),
  ];
  const [saved] = await card.calls(['save_interview_answers', { primaryResidence: null }]);
  assert.deepEqual(saved.updated, ['primaryResidence']);
  await card.says('¿Cómo tributas en la renta?');
  assert.deepEqual(labels(), ['Individual', 'Conjunta']);
  assert.deepEqual(states(), [
    [false, 'false'],
    [false, 'false'],
  ]);
  // Between turns it is sent at once, as the person's own turn.
  await card.click(card.chips()[1]);
  assert.deepEqual(card.answers(), ['No lo sé', 'Conjunta']);
  assert.deepEqual(plain(browser.channel.sent.slice(-2)), [
    {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Conjunta' }] },
    },
    { type: 'response.create' },
  ]);
  assert.deepEqual(states(), [
    [true, 'false'],
    [true, 'true'],
  ]);

  // A money question: a compact numeric field with its unit and a round confirm button.
  next = [
    ranked('homeBudget', '¿Qué precio puedes pagar?', { type: 'money', storedAs: 'cents', min: 1, max: 50_000_000 }),
  ];
  await card.calls(['save_interview_answers', {}]);
  await card.says('¿Qué precio puedes pagar?');
  assert.deepEqual([card.node('choices').hidden, card.node('figure').hidden], [true, false]);
  assert.deepEqual(
    [card.text('unit'), card.text('amount-label'), card.label('confirm')],
    ['€', '¿Qué precio puedes pagar?', 'Confirma'],
  );
  assert.equal(card.node('amount').attributes.inputmode, 'decimal');
  assert.deepEqual(
    [card.node('amount').disabled, card.node('confirm').disabled, card.node('unknown').hidden],
    [false, true, true],
  );
  card.node('amount').value = 'mucho';
  card.node('amount').listeners.input?.({});
  assert.equal(card.node('confirm').disabled, true);
  card.node('amount').value = '180000';
  card.node('amount').listeners.input?.({});
  assert.equal(card.node('confirm').disabled, false);
  await card.submit('number');
  assert.equal(card.answers().at(-1), '180000 €');
  assert.deepEqual([card.node('amount').disabled, card.node('confirm').disabled], [true, true]);
  await card.submit('number');
  assert.equal(card.answers().length, 3, 'sent once');

  // The model asks something of its own (it reads the figure back): the card cannot know how it is answered.
  await card.says('¿Has dicho 180.000 euros?');
  assert.equal(card.text('question'), '¿Has dicho 180.000 euros?');
  assert.deepEqual([card.node('choices').hidden, card.node('figure').hidden, card.chips().length], [true, true, 0]);
  // A figure that may be unknown offers that beside the field.
  next = [
    ranked(
      'itpBuyerNetTaxBase',
      '¿Cuál es tu base imponible?',
      { type: 'money', storedAs: 'eur', min: 0, max: 1 },
      true,
    ),
  ];
  await card.calls(['save_interview_answers', {}]);
  await card.says('¿Cuál es tu base imponible?');
  assert.deepEqual(
    [card.node('figure').hidden, card.node('unknown').hidden, card.text('unknown')],
    [false, false, 'No lo sé'],
  );
  assert.equal(card.node('amount').value, '');
  await card.click('unknown');
  assert.equal(card.answers().at(-1), 'No lo sé');
  assert.equal(card.node('unknown').disabled, true);
  // A turn that asks nothing shows its last sentence and nothing to tap.
  await card.says('Gracias. Eso es todo por ahora.');
  assert.equal(card.text('question'), 'Eso es todo por ahora.');
  assert.deepEqual([card.node('choices').hidden, card.node('figure').hidden], [true, true]);
  // Nothing left to ask: the planner hands no question, so a question of the model's own has nothing to tap.
  next = [];
  await card.calls(
    ['save_interview_answers', { householdSize: 2 }],
    ['save_place', { name: 'Talarn', confirmed: true }],
  );
  await card.says('¿Algo más que quieras contarme?');
  assert.equal(card.text('question'), '¿Algo más que quieras contarme?');
  assert.deepEqual(
    [card.node('choices').hidden, card.node('figure').hidden, card.node('typed-answer').hidden],
    [true, true, true],
  );
  await card.click('stop');
});

test('a free answer is saved in one call, shown as chips that fill in, and nothing that was not said is inferred', async () => {
  const card = await runCard({ hostLocale: 'es', plan: true });
  await card.serve();
  await card.talk();
  const { browser } = card;
  const money = createFormat('es').eurosAuto;
  const topics = () => ['income', 'spending', 'savings', 'household', 'place'].map(id => card.topic(`topic-${id}`));

  // The opening: two short sentences by voice; on the card, five chips with an icon and a word, all empty.
  await card.says(pageCatalog.es['voice.opening']);
  // It asks nothing: no line is repeated under the orb, whose word already says it is listening.
  assert.deepEqual([card.node('question').hidden, card.text('state')], [true, 'Te escucho']);
  assert.deepEqual(
    [card.node('choices').hidden, card.node('figure').hidden, card.node('typed-answer').hidden],
    [true, true, true],
  );
  assert.deepEqual([card.node('topics').hidden, card.label('topics')], [false, 'Lo que has dicho a ReloCat']);
  assert.deepEqual(
    ['income', 'spending', 'savings', 'household', 'place'].map(id => card.node(`topic-${id}`).children[1].textContent),
    ['Ingresos', 'Gastos', 'Ahorros', 'Hogar', 'Lugar'],
  );
  assert.deepEqual(topics(), Array(5).fill(['empty', null]));
  for (const id of ['income', 'spending', 'savings', 'household', 'place'])
    assert.equal(card.node(`topic-${id}`).children[0].tag, 'svg', `${id} has an icon`);

  // The person talks freely, pauses included, and presses Done instead of waiting for the silence.
  await browser.receive({ type: 'input_audio_buffer.speech_started' });
  assert.deepEqual([card.label('done'), card.node('done').disabled], ['He terminado', false]);
  const before = browser.channel.sent.length;
  await card.click('done');
  assert.deepEqual(plain(browser.channel.sent.slice(before)), [
    { type: 'input_audio_buffer.commit' },
    { type: 'response.create' },
  ]);
  assert.equal(card.node('done').disabled, true);

  // “Gano 3100, gasto 2050, tengo 24000 ahorrados, somos dos y me gustaría Talarn”: one save with every figure,
  // and the town looked up by name. The model said nothing first.
  const [saved, place] = await card.calls(
    [
      'save_interview_answers',
      { monthlyIncome: 3100, monthlyExpenses: 2050, purchaseSavings: 24000, householdSize: 2 },
    ],
    ['save_place', { name: 'Talarn' }],
  );
  assert.deepEqual(saved.updated, ['monthlyIncome', 'monthlyExpenses', 'purchaseSavings', 'householdSize']);
  assert.deepEqual([saved.rejected, saved.stored], [[], 'device']);
  // The town is an exact match of the pilot, proposed and not stored: it waits for a yes.
  assert.deepEqual(
    [place.saved, place.reason, place.match],
    [false, 'needs_confirmation', { code: '252154', name: 'Talarn', comarca: 'Pallars Jussà' }],
  );
  // What was understood, as chips: each figure formatted for the language, the town with a yes and a no.
  assert.deepEqual(topics(), [
    ['filled', money(310_000)],
    ['filled', money(205_000)],
    ['filled', money(2_400_000)],
    ['filled', '2'],
    ['asks', 'Talarn'],
  ]);
  assert.deepEqual([card.node('place-yes').hidden, card.node('place-no').hidden], [false, false]);
  assert.deepEqual([card.label('place-yes'), card.label('place-no')], ['Sí, Talarn', 'Talarn no']);
  // The figures are cents in the plan the card asks for, and no town is in it yet.
  await settle(250);
  await card.serve();
  const planned = card.toolCalls.findLast(call => call.name === 'plan_home_savings');
  const person = planned?.arguments.person as { householdSize: number; finances: Record<string, number | null> };
  assert.deepEqual(
    [
      person.finances.monthlyIncomeCents,
      person.finances.monthlyExpensesCents,
      person.finances.currentSavingsCents,
      person.householdSize,
    ],
    [310_000, 205_000, 2_400_000, 2],
  );
  assert.deepEqual(plain(planned?.arguments.municipalityCodes), []);

  // The follow-up names only what is missing; the card shows its question and the same yes and no under it.
  await card.says('Solo falta el lugar. ¿Te refieres a Talarn, en el Pallars Jussà?');
  assert.equal(card.text('question'), '¿Te refieres a Talarn, en el Pallars Jussà?');
  assert.deepEqual(
    card.chips().map(chip => chip.textContent),
    ['Sí', 'No'],
  );
  await card.click('place-yes');
  assert.equal(card.answers().at(-1), 'Sí, Talarn.');
  assert.deepEqual([card.node('place-yes').hidden, card.node('place-no').hidden], [true, true]);
  for (const chip of card.chips()) assert.equal(chip.disabled, true);
  const [confirmed] = await card.calls(['save_place', { name: 'Talarn', confirmed: true }]);
  assert.deepEqual([confirmed.saved, confirmed.places], [true, ['Talarn']]);
  assert.deepEqual(card.topic('topic-place'), ['filled', 'Talarn']);

  // A filled chip is tapped to correct it: the card asks for that one figure in a compact field.
  await card.says('¿Cuántos metros buscas?');
  await card.click('topic-income');
  assert.equal(card.node('topic-income').attributes['aria-pressed'], 'true');
  assert.equal(card.text('question'), questionById('monthlyIncome', 'es').question);
  assert.deepEqual([card.node('figure').hidden, card.text('unit'), card.node('amount').disabled], [false, '€', false]);
  card.node('amount').value = '3200';
  card.node('amount').listeners.input?.({});
  await card.submit('number');
  // It says which figure it is, so the model saves it where it belongs.
  assert.equal(card.answers().at(-1), 'Ingresos: 3200 €');
  assert.equal(card.node('topic-income').attributes['aria-pressed'], 'false');
  await card.calls(['save_interview_answers', { monthlyIncome: 3200 }]);
  assert.deepEqual(card.topic('topic-income'), ['filled', money(320_000)]);
  // Tapped twice, a chip opens and closes, and the conversation's own question is back.
  await card.says('¿Cuántos metros buscas?');
  await card.click('topic-household');
  assert.deepEqual([card.text('unit'), card.node('figure').hidden], ['personas', false]);
  await card.click('topic-household');
  assert.deepEqual([card.text('question'), card.node('figure').hidden], ['¿Cuántos metros buscas?', true]);

  // The trail is a button: it asks the planner for the plan and opens its summary.
  await settle(250);
  await card.serve();
  const plans = card.toolCalls.filter(call => call.name === 'plan_home_savings').length;
  assert.deepEqual([card.node('plan').hidden, card.node('trail').attributes['aria-expanded']], [true, 'false']);
  await card.click('trail');
  assert.equal(card.toolCalls.filter(call => call.name === 'plan_home_savings').length, plans + 1);
  assert.deepEqual(plain(card.toolCalls.at(-1)?.arguments.municipalityCodes), ['252154']);
  assert.deepEqual([card.node('plan').hidden, card.node('trail').attributes['aria-expanded']], [false, 'true']);
  // One figure, where, one line about aid, one button.
  assert.deepEqual(
    [card.text('plan-figure'), card.text('plan-label'), card.text('plan-aid'), card.text('workspace')],
    [createFormat('es').duration(31), 'Talarn · estimación', '1 ayuda contada', 'Abre el espacio'],
  );
  await card.click('workspace');
  assert.deepEqual(card.chat, ['Usa ReloCat para mostrar mi espacio de trabajo para Talarn.']);
  assert.equal(card.text('workspace'), 'Pedido en el chat');
  await card.click('trail');
  assert.deepEqual([card.node('plan').hidden, card.node('trail').attributes['aria-expanded']], [true, 'false']);
  // Ended: the plan there is stays in sight, with what was understood.
  await card.click('stop');
  assert.deepEqual(
    [card.node('plan').hidden, card.node('topics').hidden, card.text('state')],
    [false, false, 'Conversación terminada'],
  );

  // Only income and spending were said: the other chips stay empty, and nothing else is in what the card keeps.
  const partial = await runCard({ hostLocale: 'ca' });
  await partial.serve();
  await partial.talk();
  await partial.says(pageCatalog.ca['voice.opening']);
  const [some] = await partial.calls(['save_interview_answers', { monthlyIncome: 3100, monthlyExpenses: 2050 }]);
  assert.deepEqual(some.updated, ['monthlyIncome', 'monthlyExpenses']);
  const catalan = createFormat('ca').eurosAuto;
  assert.deepEqual(
    ['income', 'spending', 'savings', 'household', 'place'].map(id => partial.topic(`topic-${id}`)),
    [
      ['filled', catalan(310_000)],
      ['filled', catalan(205_000)],
      ['empty', null],
      ['empty', null],
      ['empty', null],
    ],
  );
  await settle(250);
  await partial.serve();
  const sentPerson = partial.toolCalls.findLast(call => call.name === 'plan_home_savings')?.arguments.person as {
    householdSize: number | null;
    finances: Record<string, number | null>;
  };
  // Unknown stays unknown: not zero, not a household of one.
  assert.deepEqual([sentPerson.finances.currentSavingsCents, sentPerson.householdSize], [null, null]);
  assert.deepEqual(
    plain(partial.toolCalls.findLast(call => call.name === 'plan_home_savings')?.arguments.municipalityCodes),
    [],
  );
  assert.deepEqual([partial.node('place-yes').hidden, partial.node('place-no').hidden], [true, true]);

  // An empty chip asks for its item: a figure in the compact field, the town by name in the reply field.
  await partial.says('Quants estalvis tens per a la compra?');
  await partial.click('topic-savings');
  assert.equal(partial.text('question'), questionById('purchaseSavings', 'ca').question);
  assert.deepEqual([partial.node('figure').hidden, partial.text('unit')], [false, '€']);
  partial.node('amount').value = '24000';
  await partial.submit('number');
  assert.equal(partial.answers().at(-1), 'Estalvis: 24000 €');
  await partial.says('I on t’agradaria viure?');
  await partial.click('topic-place');
  assert.deepEqual([partial.node('typed-answer').hidden, partial.node('figure').hidden], [false, true]);
  assert.equal(partial.focused(), partial.node('answer'));
  partial.node('answer').value = 'Lleida';
  await partial.submit('typed-answer');
  assert.equal(partial.answers().at(-1), 'Lloc: Lleida');
  // A name that is not exactly a town of the pilot stores nothing; the similar names are offered to tap.
  const [unknownTown] = await partial.calls(['save_place', { name: 'Lle' }]);
  assert.deepEqual([unknownTown.saved, unknownTown.reason], [false, 'no_exact_match']);
  await partial.says('No el trobo. Vols dir Lleida?');
  assert.deepEqual(
    partial.chips().map(chip => chip.textContent),
    ['Lleida'],
  );
  assert.deepEqual(partial.topic('topic-place'), ['empty', null]);
  await partial.click('stop');
});

test('the plan summary is one figure, a place and at most one line about aid', () => {
  const plan = examplePlan(['252154']);
  assert.deepEqual(planSummary(plan, 'en'), {
    figure: createFormat('en').duration(31),
    label: 'Talarn · estimate',
    aid: '1 aid counted',
  });
  assert.deepEqual(planSummary(plan, 'ca'), {
    figure: createFormat('ca').duration(31),
    label: 'Talarn · estimació',
    aid: '1 ajut comptat',
  });
  // Nothing counted: what is still to verify is said instead, never as if it were granted.
  const pending = planResult.parse({
    ...plan,
    plans: [{ ...plan.plans[0], benefits: plan.plans[0].benefits.filter(benefit => !benefit.counted) }],
  });
  assert.equal(planSummary(pending, 'es').aid, '1 ayuda por verificar');
  // No timeline stays words, never a number; no town chosen is said as such.
  const none = planResult.parse({
    ...plan,
    plans: [{ ...plan.plans[0], status: 'no_positive_savings', withPlaceBenefits: null, benefits: [] }],
  });
  assert.deepEqual(
    [planSummary(none, 'en').figure, planSummary(none, 'en').aid],
    [createFormat('en').duration(null), null],
  );
  assert.doesNotMatch(planSummary(none, 'en').figure, /\d/);
  assert.equal(planSummary(examplePlan([]), 'es').label, 'Cataluña · estimación');
  // What a chip shows is what was saved, formatted for the language; unknown is a word.
  const values = (answers: Record<string, number | null>, householdSize?: number) =>
    topicValues({ journey: { ...emptyJourney(), answers, extras: { householdSize } }, lastPlan: null }, 'en');
  assert.deepEqual(values({ monthlyIncome: 310_000 }, 2), {
    monthlyIncome: '€3,100',
    monthlyExpenses: null,
    purchaseSavings: null,
    householdSize: '2',
    place: null,
  });
  assert.equal(values({ purchaseSavings: null }).purchaseSavings, 'Unknown');
  assert.equal(values({ purchaseSavings: 0 }).purchaseSavings, '€0');
});

test('the orb follows the sound, stops when the conversation ends or the page is hidden, and stays still on request', async () => {
  const card = await runCard({ hostLocale: 'es', sound: true });
  await card.serve();
  assert.deepEqual([card.sound.contexts, card.sound.reads], [0, 0]);
  await card.talk();
  // One context, an analyser on the microphone, and a level written as a custom property of the orb's stage.
  await settle(30);
  assert.deepEqual([card.sound.contexts, card.sound.analysers], [1, 1]);
  assert(card.sound.reads > 0, 'the microphone level is read');
  assert.match(card.node('stage').style['--level'], /^[01]\.\d{3}$/);
  assert(Number(card.node('stage').style['--level']) > 0);
  // ReloCat's voice gets its own analyser: while it speaks, the ring is its voice.
  card.browser.peer.ontrack?.({ streams: [{}] });
  assert.equal(card.sound.analysers, 2);
  // Hidden: no frame is asked for; visible again, the loop resumes.
  card.document.hidden = true;
  card.pageListeners.visibilitychange();
  await settle(30);
  const paused = card.sound.reads;
  await settle(40);
  assert.equal(card.sound.reads, paused);
  assert.equal(card.node('stage').style['--level'], '0.000');
  card.document.hidden = false;
  card.pageListeners.visibilitychange();
  await settle(30);
  assert(card.sound.reads > paused);
  // Muted: the ring rests, whatever the microphone hears.
  await card.browser.receive({ type: 'response.done' });
  await card.click('orb');
  await settle(500);
  assert(Number(card.node('stage').style['--level']) < 0.05);
  // The end of the conversation ends the loop and closes the context.
  await card.click('stop');
  const stopped = card.sound.reads;
  await settle(40);
  assert.deepEqual([card.sound.reads, card.sound.closed, card.node('stage').style['--level']], [stopped, 1, '0.000']);

  // Less motion asked for: no analyser, no frame loop; the word and the icon carry the state.
  const still = await runCard({ hostLocale: 'es', sound: true, reducedMotion: true });
  await still.serve();
  const frames = still.sound.frames;
  await still.talk();
  still.browser.peer.ontrack?.({ streams: [{}] });
  await settle(40);
  assert(still.sound.mediaQueries.includes('(prefers-reduced-motion: reduce)'));
  assert.deepEqual([still.sound.contexts, still.sound.analysers, still.sound.reads], [0, 0, 0]);
  assert.equal(still.sound.frames, frames, 'no frame was asked for');
  assert.equal(still.node('stage').style['--level'], undefined);
  assert.equal(still.text('state'), 'Pensando');
  await still.click('stop');
});

test('a refused microphone, a refused origin and a host without tools each leave a way forward', async () => {
  // The microphone is refused: one line says so, and the way forward is a short button and the chat link.
  const refused = await runCard({
    hostLocale: 'es',
    microphone: Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
  });
  await refused.serve();
  await refused.click('orb');
  assert.deepEqual([refused.text('notice-text'), refused.node('notice').hidden], ['Micrófono no permitido.', false]);
  assert.match(refused.node('notice').className, /rc-note--error/);
  assert.deepEqual([refused.node('card').dataset.voice, refused.label('orb')], ['idle', 'Empieza a hablar']);
  assert.deepEqual(
    [refused.node('type-instead').hidden, refused.text('type-instead'), refused.node('state').hidden],
    [false, 'Responde por escrito', true],
  );
  assert.equal(refused.text('continue'), 'Sigue en el chat');
  assert.equal(refused.browser.requests.length, 0);
  // "Reply in writing" starts the conversation without asking for the microphone again.
  await refused.click('type-instead');
  assert.equal(refused.browser.microphoneAsked(), 1);
  assert.deepEqual(plain(refused.browser.peer.transceivers), [['audio', { direction: 'recvonly' }]]);
  assert.equal(refused.browser.requests.length, 1);
  assert.deepEqual([refused.node('notice').hidden, refused.node('type-instead').hidden], [true, true]);
  void refused.browser.channel.onopen?.();
  await settle();
  await refused.serve();
  await refused.browser.receive({ type: 'session.updated' });
  await refused.browser.receive({ type: 'response.done' });
  // No microphone: the reply field is open, the orb mutes nothing, and there is no turn to end.
  assert.deepEqual([refused.text('state'), refused.node('card').dataset.mic], ['Escribe tu respuesta', 'off']);
  assert.deepEqual([refused.node('typed-answer').hidden, refused.node('done').hidden], [false, true]);
  assert.equal(refused.node('orb').attributes['aria-disabled'], 'true');
  await refused.click('orb');
  assert.equal(refused.text('state'), 'Escribe tu respuesta');
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
    await card.click('orb');
    assert.equal(card.text('notice-text'), cardCatalog.ca[key], key);
    assert.deepEqual(
      [card.label('orb'), card.text('state'), card.node('type-instead').hidden],
      ['Comença a parlar', 'Toca per parlar', true],
    );
    assert.deepEqual([card.browser.peer.closed, card.browser.track.stopped], [true, true]);
    // Closed, the line is gone; the same failure again says it again.
    await card.click('notice-close');
    assert.equal(card.node('notice').hidden, true);
  }

  // "Continue in the chat": ChatGPT's bridge when it is there, else the MCP Apps message, else the sentence.
  const prompts: string[] = [];
  const chatgpt = await runCard({
    hostLocale: 'es',
    openai: { sendFollowUpMessage: ({ prompt }: { prompt: string }) => void prompts.push(prompt) },
  });
  await chatgpt.serve();
  await chatgpt.click('continue');
  assert.deepEqual(prompts, [cardCatalog.es.startMessage]);
  assert.deepEqual([chatgpt.text('continue'), chatgpt.node('continue').disabled], ['Enviado al chat', true]);
  assert.deepEqual(chatgpt.chat, []);
  const standard = await runCard({ hostLocale: 'ca' });
  await standard.serve();
  await standard.click('continue');
  assert.deepEqual(standard.chat, [cardCatalog.ca.startMessage]);
  assert.equal(standard.text('continue'), 'Enviat al xat');
  // A host that takes no message: the sentence to type, the one notice that may wrap, closed like any other.
  const mute = await runCard({
    hostLocale: 'es',
    openai: { sendFollowUpMessage: () => Promise.reject(new Error('no')) },
  });
  await mute.serve();
  await mute.click('continue');
  assert.equal(mute.text('notice-text'), `Escribe esto en el chat: «${cardCatalog.es.startMessage}»`);
  assert.deepEqual([mute.node('notice').dataset.long, mute.node('continue').disabled], ['true', false]);
  await mute.click('notice-close');
  assert.equal(mute.node('notice').hidden, true);

  // A host that offers no tool calls: no call is attempted, and the conversation still starts.
  const bare = await runCard({ hostLocale: 'es', serverTools: false });
  await bare.serve();
  assert.equal(bare.toolCalls.length, 0);
  await bare.click('orb');
  assert.equal(bare.browser.requests.length, 1);
  void bare.browser.channel.onopen?.();
  await settle();
  const update = bare.browser.channel.sent[0] as unknown as ReturnType<typeof sessionUpdate>;
  assert.match(update.session.instructions, /This card cannot reach the ReloCat tools/);
  await bare.browser.receive({ type: 'session.updated' });
  assert.equal(bare.text('notice-text'), cardCatalog.es.noTools);
  // No plan there either: the trail opens a line that says so.
  await bare.click('trail');
  assert.deepEqual(
    [bare.node('plan').hidden, bare.text('plan-label'), bare.node('workspace').hidden],
    [false, 'Aún no hay plan', true],
  );
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
