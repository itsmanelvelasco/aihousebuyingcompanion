import { App } from '@modelcontextprotocol/ext-apps';
import { browserLocale, rememberLocale } from '../../packages/i18n/browser.ts';
import { common } from '../../packages/i18n/common.ts';
import { type Locale, toLocale } from '../../packages/i18n/locales.ts';
import { type MessageValues, translator } from '../../packages/i18n/messages.ts';
import { card as cardCatalog } from './card.messages.ts';
import type { HostApp, OpenAiHost } from './card-host.ts';
import {
  cardFailure,
  cardVoiceContext,
  cardVoiceTools,
  hostAccess,
  hostCallTool,
  notSavedNotice,
  sendToChat,
  workspaceRequest,
  workspaceTowns,
} from './card-host.ts';
import { interview as pageCatalog } from './messages.ts';
import { planView, trail } from './plan.ts';
import type { VoicePhase as CallPhase, VoiceCall, VoiceEnd } from './realtime.ts';
import { startVoiceCall, voiceSupport } from './realtime.ts';
import type { PlanOutcome } from './session.ts';
import { createInterview, emptyJourney } from './session.ts';

/**
 * The interview card shown inside a chat: the voice interview of the interview page, in the card
 * itself. It talks to its host through `App` (the handshake, the size, the ReloCat tools, a message
 * into the chat) and to ReloCat's `/interview/voice` for the one thing a host cannot do: exchange
 * the WebRTC offer for the voice service's answer. The interview, its questions, the plan and the
 * voice call are the page's own modules; this file only draws them at the size of a card.
 */

// The handshake comes first: a host drops a card that has not finished it within a few seconds.
const app = window.parent !== window ? new App({ name: 'ReloCat interview', version: '1.0.0' }) : null;
const requestOptions = { timeout: 15_000 };
let connected = false;

const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  card: node('card'),
  trail: node('trail'),
  trailArt: node('trail-art'),
  trailTitle: node('trail-title'),
  trailCount: node('trail-count'),
  trailSteps: node('trail-steps'),
  status: node('voice-status'),
  start: node<HTMLButtonElement>('start'),
  typeInstead: node<HTMLButtonElement>('type-instead'),
  mute: node<HTMLButtonElement>('mute'),
  stop: node<HTMLButtonElement>('stop'),
  caption: node('last-question'),
  typed: node<HTMLFormElement>('typed-answer'),
  answer: node<HTMLInputElement>('answer'),
  send: node<HTMLButtonElement>('send-answer'),
  plan: node('plan'),
  planBody: node('plan-body'),
  workspace: node<HTMLButtonElement>('workspace'),
  workspaceStatus: node('workspace-status'),
  notice: node('notice'),
  continueInChat: node<HTMLButtonElement>('continue'),
  chatStatus: node('chat-status'),
  languages: node('languages'),
  audio: node<HTMLAudioElement>('audio'),
};

// ------------------------------------------------------------ language

type CardKey = keyof typeof cardCatalog.en;
type PageKey = keyof typeof pageCatalog.en;
let locale: Locale = browserLocale();
/** The person picked a language on the card: it wins over what the host states. */
let chosen = false;
let t = translator(cardCatalog, locale);
let page = translator(pageCatalog, locale);

/** A line whose words depend on the language, kept as a function so a change of language says it again. */
type Line = () => string;
const lines = new Map<HTMLElement, Line>();
function say(element: HTMLElement, line: Line | null) {
  if (line) lines.set(element, line);
  else lines.delete(element);
  element.textContent = line ? line() : '';
  element.hidden = !line;
}
const own =
  (key: CardKey, values?: MessageValues): Line =>
  () =>
    t(key, values);
const shared =
  (key: PageKey, values?: MessageValues): Line =>
  () =>
    page(key, values);

// ------------------------------------------------------------ the interview

const today = () => new Date().toISOString().slice(0, 10);
const openai = () => (window as { openai?: OpenAiHost }).openai;
const host = () => ({ openai: openai(), app: app as HostApp | null });

/** The same interview as the page, with the host as the way to the ReloCat tools. Its answers live in the card. */
const interview = createInterview({
  call: hostCallTool(app as HostApp | null, () => connected),
  today,
  locale: () => locale,
  journey: emptyJourney(),
  access: hostAccess,
  notSavedNotice: notSavedNotice(() => locale),
  changed: () => {
    renderNotice();
    schedulePlan();
  },
});

let connection: VoiceCall | undefined;
/** The call that is live has a microphone; false while the person answers by typing only. */
let speaking = true;
let phase: 'idle' | CallPhase = 'idle';
/** After a microphone failure: the conversation can still run with typed replies. */
let offerTyping = false;
let planOutcome: PlanOutcome | null = null;
let planShown = false;
let planRun = 0;
let planTimer: ReturnType<typeof setTimeout> | undefined;
/** The handshake and the first look at who is connected; a conversation waits for it, but not for long. */
let ready: Promise<unknown> = Promise.resolve();
let starting = false;

/** Where the answers go, once a conversation has started: said by voice once, and kept in sight here. */
function renderNotice() {
  if (!connection?.greeted && !interview.journey.unsaved.length && !Object.keys(interview.journey.answers).length)
    return say(ui.notice, null);
  const access = interview.access;
  say(ui.notice, own(access === 'signed_in' ? 'savedToProfile' : access === 'signed_out' ? 'notSaved' : 'noTools'));
}

/** The trail of checkpoints: the one to work on, its illustration, and how many are reached. */
function renderTrail() {
  const { answers, places } = interview.journey;
  const view = trail(
    {
      result: planOutcome?.status === 'ok' ? planOutcome.result : null,
      placeCount: places.length,
      bankMovements: null,
      local: {
        answered: Object.keys(answers).length,
        moneyComplete: (['monthlyIncome', 'monthlyExpenses', 'purchaseSavings'] as const).every(
          id => typeof answers[id] === 'number',
        ),
      },
    },
    locale,
  );
  const shown = view.current ?? view.steps.find(step => step.state !== 'done') ?? view.steps[view.steps.length - 1];
  ui.trail.hidden = false;
  ui.trail.setAttribute('aria-label', page('trail.label'));
  ui.trailArt.dataset.step = shown.id;
  ui.trailTitle.textContent = view.reached === view.total ? page('trail.allReached') : shown.title;
  ui.trailCount.textContent = page('trail.count', { reached: view.reached, total: view.total });
  ui.trailSteps.replaceChildren(
    ...view.steps.map(step => {
      const item = document.createElement('li');
      item.dataset.state = step.state;
      return item;
    }),
  );
}

const paragraph = (text: string, className = '') =>
  Object.assign(document.createElement('p'), { textContent: text, className });
function listed(heading: PageKey, items: string[]) {
  if (!items.length) return [];
  const list = document.createElement('ul');
  for (const item of items) list.append(Object.assign(document.createElement('li'), { textContent: item }));
  return [Object.assign(document.createElement('h3'), { textContent: page(heading) }), list];
}

/** The short plan: the shortest timeline, the next question, the aid counted and the aid still to verify. */
function drawPlan() {
  ui.plan.hidden = !planShown;
  if (!planShown) return;
  if (planOutcome?.status !== 'ok') {
    ui.planBody.replaceChildren(
      paragraph(
        planOutcome
          ? planOutcome.status === 'standalone'
            ? t('noTools')
            : page('plan.unavailable')
          : page('plan.loading'),
      ),
    );
    ui.workspace.hidden = true;
    return;
  }
  const view = planView(planOutcome.result, locale);
  ui.planBody.replaceChildren(
    paragraph(view.headline, 'plan-headline'),
    ...(view.figures ? [paragraph(view.figures)] : []),
    ...listed('plan.next', view.nextQuestion ? [view.nextQuestion] : []),
    ...listed('plan.counted', view.counted),
    ...listed('plan.awaiting', view.awaiting),
    paragraph(view.disclaimer, 'hint'),
  );
  ui.workspace.hidden = false;
}

/** Ask the planner and show what it answers. A slower, older answer never replaces a newer one. */
async function readPlan(): Promise<PlanOutcome> {
  const run = ++planRun;
  if (!planOutcome) drawPlan();
  const outcome = await interview.plan();
  if (run === planRun) {
    planOutcome = outcome;
    drawPlan();
    renderTrail();
  }
  return outcome;
}
/** After a change of answers: one refresh for a burst of changes, so the trail follows the plan. */
function schedulePlan() {
  renderTrail();
  const { answers, places } = interview.journey;
  // Nothing answered yet: there is no plan to read, and showing the card costs no tool call.
  if (interview.access === 'standalone' || (!planShown && !places.length && !Object.keys(answers).length)) return;
  clearTimeout(planTimer);
  planTimer = setTimeout(() => void readPlan(), 200);
}

/** Ask ReloCat, in the chat, for the workspace of the towns of the plan; the card says how it went. */
async function askForWorkspace() {
  const text = workspaceRequest(workspaceTowns(interview), locale);
  const sent = await sendToChat(host(), text);
  say(
    ui.workspaceStatus,
    sent ? own('workspaceSent') : () => t('typeIt', { message: workspaceRequest(workspaceTowns(interview), locale) }),
  );
  return sent;
}

const runVoiceTool = cardVoiceTools({
  interview,
  showPlan: () => {
    planShown = true;
    return readPlan();
  },
  askForWorkspace: async () => {
    // The button for it is in the plan summary: it is on screen whether or not the message went out.
    planShown = true;
    drawPlan();
    return askForWorkspace();
  },
});

// ------------------------------------------------------------ the conversation

const phaseLines: Record<CallPhase, PageKey> = {
  connecting: 'connectingMic',
  hearing: 'hearing',
  speaking: 'speaking',
  thinking: 'thinking',
  muted: 'muted',
  listening: 'listening',
};

function render() {
  const live = Boolean(connection) || starting;
  const talking = Boolean(connection?.greeted);
  ui.card.dataset.voice = phase;
  ui.start.hidden = live;
  ui.typeInstead.hidden = live || !offerTyping;
  ui.stop.hidden = !live;
  ui.mute.hidden = !talking || !speaking;
  ui.typed.hidden = !talking;
  if (!live) ui.caption.hidden = true;
}

function setStatus(next: 'idle' | CallPhase, line: Line) {
  phase = next;
  say(ui.status, line);
  render();
}

/** End the conversation and say why. The answers given stay in the card for the next one. */
function endConversation(line: Line, typing = false) {
  const previous = connection;
  connection = undefined;
  previous?.close();
  ui.audio.srcObject = null;
  ui.answer.value = '';
  ui.send.disabled = true;
  offerTyping = typing;
  setStatus('idle', line);
  renderNotice();
}

function ended(reason: VoiceEnd) {
  const failure = cardFailure(reason);
  endConversation(own(failure.key), failure.offerTyping);
}

async function startConversation(withMicrophone: boolean) {
  if (connection || starting) return;
  const support = voiceSupport();
  if (!support.peer) return endConversation(own('voiceUnavailable'));
  if (withMicrophone && !support.microphone) return endConversation(own('micUnavailable'), true);
  starting = true;
  say(ui.chatStatus, null);
  setStatus('connecting', withMicrophone ? shared('connectingMic') : own('typing'));
  await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 4000))]);
  starting = false;
  speaking = withMicrophone;
  offerTyping = false;
  const call = startVoiceCall({
    // The card runs on the host's own origin, so the address of ReloCat's voice route is absolute.
    endpoint: document.documentElement.dataset.voiceEndpoint ?? 'voice',
    microphone: withMicrophone,
    context: () => cardVoiceContext(interview, locale, today()),
    runTool: runVoiceTool,
    onPhase: next =>
      setStatus(
        next,
        !speaking && next !== 'speaking' && next !== 'thinking' ? own('typing') : shared(phaseLines[next]),
      ),
    onGreeted: () => {
      say(ui.mute, shared('mute'));
      ui.mute.setAttribute('aria-pressed', 'false');
      renderNotice();
      render();
      if (!speaking) ui.answer.focus();
    },
    // Captions are always on in the card: in a chat the sound is often off.
    onCaption: transcript => {
      ui.caption.textContent = transcript;
      ui.caption.hidden = false;
    },
    onCanSend: allowed => {
      ui.send.disabled = !allowed;
    },
    onRemoteStream: stream => {
      ui.audio.srcObject = stream;
      // The person pressed a button in this frame, so playing is allowed; a refusal leaves the captions.
      void ui.audio.play?.()?.catch(() => {});
    },
    onEnd: reason => {
      if (connection === call) ended(reason);
    },
  });
  connection = call;
  ui.caption.textContent = '';
  render();
}

ui.start.addEventListener('click', () => void startConversation(true));
ui.typeInstead.addEventListener('click', () => void startConversation(false));
ui.stop.addEventListener('click', () => endConversation(own('ended')));
ui.mute.addEventListener('click', () => {
  if (!connection?.setMuted(!connection.muted)) return;
  say(ui.mute, shared(connection.muted ? 'unmute' : 'mute'));
  ui.mute.setAttribute('aria-pressed', String(connection.muted));
});
ui.typed.addEventListener('submit', event => {
  event.preventDefault();
  if (connection?.sayTyped(ui.answer.value.trim())) ui.answer.value = '';
});
ui.workspace.addEventListener('click', () => void askForWorkspace());

/**
 * "Continue in the chat instead": the opening message goes into the chat as the person's own, and
 * the interview goes on there by text or with the host's voice mode. A conversation in the card ends
 * first, so two interviews never run at once. A host that cannot take the message gets the sentence to type.
 */
ui.continueInChat.addEventListener('click', async () => {
  ui.continueInChat.setAttribute('aria-busy', 'true');
  if (connection) endConversation(own('ended'));
  const sent = await sendToChat(host(), t('startMessage'));
  ui.continueInChat.removeAttribute('aria-busy');
  ui.continueInChat.disabled = sent;
  say(ui.chatStatus, sent ? own('sent') : () => t('typeIt', { message: t('startMessage') }));
});

/** The template and every line on screen, in the language now shown. */
function applyLocale(next: Locale) {
  const changed = next !== locale;
  locale = next;
  t = translator(cardCatalog, locale);
  page = translator(pageCatalog, locale);
  document.documentElement.lang = locale;
  document.title = t('title');
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]'))
    element.textContent = t(element.dataset.i18n as CardKey);
  for (const element of document.querySelectorAll<HTMLElement>('[data-say]'))
    element.textContent = page(element.dataset.say as PageKey);
  ui.languages.setAttribute('aria-label', translator(common, locale)('language'));
  for (const option of ui.languages.querySelectorAll<HTMLElement>('button'))
    option.setAttribute('aria-pressed', String(option.dataset.lang === locale));
  for (const [element, line] of lines) element.textContent = line();
  renderTrail();
  drawPlan();
  // The planner words its sentences in the language asked for: the plan is read again.
  if (changed && planOutcome) void readPlan();
}
ui.languages.addEventListener('click', event => {
  const picked = toLocale((event.target as HTMLElement).closest<HTMLElement>('button[data-lang]')?.dataset.lang);
  if (!picked || picked === locale) return;
  chosen = true;
  rememberLocale(picked);
  applyLocale(picked);
  // A live conversation is told, so the next spoken turn is in the new language.
  void connection?.changeLanguage(picked);
});

say(ui.status, own('ready'));
applyLocale(locale);
render();

if (app) {
  // The host's language applies unless the person chose one here or the address states one.
  app.onhostcontextchanged = context => {
    if (context.locale && !chosen) applyLocale(browserLocale(context.locale));
  };
  ready = app
    .connect(undefined, requestOptions)
    .then(() => {
      connected = true;
      if (!chosen) applyLocale(browserLocale(app.getHostContext()?.locale));
      return interview.start();
    })
    .catch(() => {
      // Without a host the card still talks: the answers stay in it.
    });
}
