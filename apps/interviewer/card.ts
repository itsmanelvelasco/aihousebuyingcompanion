import { App } from '@modelcontextprotocol/ext-apps';
import { browserLocale, rememberLocale } from '../../packages/i18n/browser.ts';
import { common } from '../../packages/i18n/common.ts';
import { type Locale, toLocale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { card as cardCatalog } from './card.messages.ts';
import type { AnswerControls, CardTopicId, HostApp, OpenAiHost, SpokenQuestion } from './card-host.ts';
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
  workspaceTowns,
} from './card-host.ts';
import { trail } from './plan.ts';
import type { VoicePhase as CallPhase, VoiceCall, VoiceEnd } from './realtime.ts';
import { startVoiceCall, voiceSupport } from './realtime.ts';
import type { PlaceChoice, PlanOutcome } from './session.ts';
import { createInterview, emptyJourney } from './session.ts';

/**
 * The interview card shown inside a chat: the voice interview of the interview page, in the card
 * itself. It talks to its host through `App` (the handshake, the size, the ReloCat tools, a message
 * into the chat) and to ReloCat's `/interview/voice` for the one thing a host cannot do: exchange
 * the WebRTC offer for the voice service's answer. The interview, its questions, the plan and the
 * voice call are the page's own modules; this file draws them at the size of a card.
 *
 * What is on screen is an orb, one state word, the current question and things to tap. The state is
 * a handful of variables and `render()` draws all of it, so a change of language is one more render.
 */

// The handshake comes first: a host drops a card that has not finished it within a few seconds.
const app = window.parent !== window ? new App({ name: 'ReloCat interview', version: '1.0.0' }) : null;
const requestOptions = { timeout: 15_000 };
let connected = false;

const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  card: node('card'),
  stage: node('stage'),
  orb: node<HTMLButtonElement>('orb'),
  state: node('state'),
  typeInstead: node<HTMLButtonElement>('type-instead'),
  topics: node('topics'),
  question: node('question'),
  choices: node('choices'),
  figure: node('figure'),
  number: node<HTMLFormElement>('number'),
  amount: node<HTMLInputElement>('amount'),
  amountLabel: node('amount-label'),
  unit: node('unit'),
  confirm: node<HTMLButtonElement>('confirm'),
  unknown: node<HTMLButtonElement>('unknown'),
  typed: node<HTMLFormElement>('typed-answer'),
  answer: node<HTMLInputElement>('answer'),
  send: node<HTMLButtonElement>('send-answer'),
  controls: node('controls'),
  keyboard: node<HTMLButtonElement>('keyboard'),
  done: node<HTMLButtonElement>('done'),
  stop: node<HTMLButtonElement>('stop'),
  trail: node<HTMLButtonElement>('trail'),
  trailArt: node('trail-art'),
  trailSteps: node('trail-steps'),
  trailCount: node('trail-count'),
  plan: node('plan'),
  planFigure: node('plan-figure'),
  planLabel: node('plan-label'),
  planAid: node('plan-aid'),
  workspace: node<HTMLButtonElement>('workspace'),
  notice: node('notice'),
  noticeText: node('notice-text'),
  noticeClose: node<HTMLButtonElement>('notice-close'),
  continueInChat: node<HTMLButtonElement>('continue'),
  languages: node('languages'),
  audio: node<HTMLAudioElement>('audio'),
};
const topicNodes = cardTopics.map(topic => ({
  ...topic,
  chip: node<HTMLButtonElement>(topic.node),
  value: node(`${topic.node}-value`),
}));

// ------------------------------------------------------------ language

type CardKey = keyof typeof cardCatalog.en;
let locale: Locale = browserLocale();
/** The person picked a language on the card: it wins over what the host states. */
let chosen = false;
let t = translator(cardCatalog, locale);

/** A control that is an icon: its name for assistive tech, and the same on hover. */
function named(element: HTMLElement, label: string) {
  element.setAttribute('aria-label', label);
  element.setAttribute('title', label);
}
function show(element: HTMLElement, text: string | null) {
  element.textContent = text ?? '';
  element.hidden = text === null;
}

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
    renderTopics();
    schedulePlan();
  },
});

let connection: VoiceCall | undefined;
/** The call that is live has a microphone; false while the person answers by typing only. */
let speaking = true;
let phase: 'idle' | CallPhase = 'idle';
let starting = false;
/** The person ended the last conversation: the orb is the start button again and the card says so. */
let over = false;
/** Why voice did not start or stopped, as a line of the catalog. */
let failure: CardKey | null = null;
/** After a microphone failure: the conversation can still run with typed replies. */
let offerTyping = false;
/** A save the profile did not take, while the account is connected. */
let saveFailed = false;
/** A sentence for the person to type in the chat, when the host took no message from the card. */
let toType: string | null = null;
/** Notices the person closed: each is shown once. */
const dismissed = new Set<string>();
let chatSent = false;
let workspaceAsked = false;

let planOutcome: PlanOutcome | null = null;
let planShown = false;
let planRun = 0;
let planTimer: ReturnType<typeof setTimeout> | undefined;
/** The handshake and the first look at who is connected; a conversation waits for it, but not for long. */
let ready: Promise<unknown> = Promise.resolve();

/** The question the session was last told to ask, and whether ReloCat has not asked it yet. */
let expected: SpokenQuestion | null = null;
let fresh = false;
/** The next question is about a town, not the planner's: similar names to pick from, when no town had the name said. */
let placeTurn: { towns?: string[] } | null = null;
/** What ReloCat last said, as the card shows it, with what the card knows about how to answer it. */
let said: { text: string; asked: SpokenQuestion | null; towns?: string[] } | null = null;
/** A chip the person tapped: the card asks for that one thing until it is answered or tapped again. */
let topic: CardTopicId | null = null;
/** An answer was tapped: the controls wait for the next question. */
let answered = false;
/** A tapped answer waiting for the end of ReloCat's turn. */
let queued: string | null = null;
let canSend = false;
let keyboardOpen = false;

// ------------------------------------------------------------ the sound level

type Tap = { analyser: AnalyserNode; samples: Uint8Array<ArrayBuffer> };
let audioContext: AudioContext | undefined;
let microphoneTap: Tap | undefined;
let voiceTap: Tap | undefined;
let frame = 0;
let level = 0;

/** No level animation for a person who asked for less motion: the word and the icon carry the state. */
const still = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Listen to a stream without playing it: nothing is connected to the speakers here. */
function tap(stream: MediaStream): Tap | undefined {
  const Context =
    globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context || still()) return undefined;
  try {
    audioContext ??= new Context();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    return { analyser, samples: new Uint8Array(analyser.fftSize) };
  } catch {
    return undefined;
  }
}
function setLevel(value: number) {
  level = value;
  ui.stage.style.setProperty('--level', value.toFixed(3));
}
/** One frame: the microphone while the person has the turn, ReloCat's voice while it speaks, nothing when muted. */
function measure() {
  frame = 0;
  if (!connection || document.hidden) return setLevel(0);
  const source = phase === 'speaking' ? voiceTap : phase === 'muted' ? undefined : microphoneTap;
  let loudness = 0;
  if (source) {
    source.analyser.getByteTimeDomainData(source.samples);
    let sum = 0;
    for (const sample of source.samples) sum += ((sample - 128) / 128) ** 2;
    loudness = Math.min(1, Math.sqrt(sum / source.samples.length) * 5);
  }
  setLevel(level + (loudness - level) * 0.3);
  frame = requestAnimationFrame(measure);
}
function startMeter() {
  if (frame || !connection || document.hidden || still() || !(microphoneTap || voiceTap)) return;
  frame = requestAnimationFrame(measure);
}
function stopMeter() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  setLevel(0);
}
function closeMeter() {
  stopMeter();
  microphoneTap = undefined;
  voiceTap = undefined;
  void audioContext?.close().catch(() => {});
  audioContext = undefined;
}
document.addEventListener('visibilitychange', () => (document.hidden ? stopMeter() : startMeter()));

// ------------------------------------------------------------ drawing

const live = () => Boolean(connection) || starting;
const talking = () => Boolean(connection?.greeted);

/** The orb and the word under it. */
function renderOrb() {
  const word: CardKey =
    phase === 'connecting'
      ? 'connecting'
      : phase === 'speaking' || phase === 'thinking' || phase === 'muted'
        ? phase
        : speaking
          ? 'listening'
          : 'typing';
  ui.card.dataset.voice = phase;
  ui.card.dataset.live = String(live());
  if (live() && !speaking) ui.card.dataset.mic = 'off';
  else delete ui.card.dataset.mic;
  // After a microphone failure the way forward takes the place of the state line.
  show(ui.state, live() ? t(word) : offerTyping ? null : t(over ? 'ended' : 'tapToTalk'));
  ui.typeInstead.hidden = live() || !offerTyping;
  if (!live()) {
    named(ui.orb, t('start'));
    ui.orb.removeAttribute('aria-pressed');
    ui.orb.removeAttribute('aria-disabled');
  } else if (talking() && speaking) {
    const muted = Boolean(connection?.muted);
    named(ui.orb, t(muted ? 'unmute' : 'mute'));
    ui.orb.setAttribute('aria-pressed', String(muted));
    ui.orb.removeAttribute('aria-disabled');
  } else {
    // Connecting, or a conversation without a microphone: nothing to mute.
    named(ui.orb, t(word));
    ui.orb.removeAttribute('aria-pressed');
    ui.orb.setAttribute('aria-disabled', 'true');
  }
}

/** The five chips: what was understood from what the person said. Empty stays empty. */
function renderTopics() {
  const values = topicValues(interview, locale);
  const any = Object.values(values).some(value => value !== null);
  ui.topics.hidden = !(talking() || any);
  for (const item of topicNodes) {
    const value = values[item.id];
    show(item.value, value);
    item.chip.dataset.state = value === null ? 'empty' : 'filled';
    item.chip.setAttribute('aria-pressed', String(topic === item.id));
    item.chip.disabled = !talking();
  }
}

/** The question on screen and how it can be answered by tapping, with the text each answer sends. */
function asking(): { text: string; controls: AnswerControls; wrap: (answer: string) => string } | null {
  const plainly = (answer: string) => answer;
  if (topic) {
    const about = cardTopics.find(item => item.id === topic);
    const question = interview.question(topic);
    return {
      text: question.question,
      controls: answerControls({ answer: question.answer, allowUnknown: false }, locale),
      wrap: answer => t('topicAnswer', { topic: t(about?.label ?? 'topicPlace'), answer }),
    };
  }
  if (!said) return null;
  const controls: AnswerControls = said.towns
    ? { kind: 'chips', options: said.towns.map(town => ({ label: town, text: town })) }
    : answerControls(said.asked, locale);
  return { text: said.text, controls, wrap: plainly };
}

function renderQuestion() {
  const view = talking() ? asking() : null;
  const controls = view?.controls ?? null;
  // A chip the person opened is theirs to fill in; an answered question waits for the next one.
  const locked = topic === null && answered;
  show(ui.question, view?.text || null);
  ui.choices.hidden = controls?.kind !== 'chips';
  ui.choices.replaceChildren(
    ...(controls?.kind === 'chips' ? controls.options : []).map(option => {
      const chip = Object.assign(document.createElement('button'), { className: 'chip', textContent: option.label });
      chip.setAttribute('type', 'button');
      chip.disabled = locked;
      chip.addEventListener('click', () => {
        if (chip.disabled || !sendAnswer(view?.wrap(option.text) ?? '')) return;
        // The one chosen stays lit while the others wait for the next question.
        for (const other of ui.choices.children as Iterable<HTMLButtonElement>) {
          other.disabled = true;
          other.setAttribute('aria-pressed', String(other === chip));
        }
        renderTopics();
      });
      return chip;
    }),
  );
  const number = controls?.kind === 'number' ? controls : null;
  ui.figure.hidden = !number;
  if (number) {
    ui.unit.textContent = number.unit;
    ui.amountLabel.textContent = view?.text ?? '';
    ui.amount.disabled = locked;
    ui.confirm.disabled = locked || !typedNumber(ui.amount.value);
    show(ui.unknown, number.unknown);
    ui.unknown.disabled = locked;
  }
  // A name is typed: the reply field opens by itself for it.
  const typing = talking() && (keyboardOpen || !speaking || controls?.kind === 'text');
  ui.typed.hidden = !typing;
  ui.keyboard.setAttribute('aria-expanded', String(typing));
}

function renderControls() {
  ui.controls.hidden = !live();
  ui.keyboard.disabled = !talking() || !speaking;
  ui.done.hidden = !speaking;
  ui.done.disabled = !talking() || (phase !== 'listening' && phase !== 'hearing');
  ui.send.disabled = !canSend;
}

/** One notice at a time, each shown once: what failed first, then where the answers go. */
function notice(): { id: string; text: string; tone: 'warn' | 'error'; long?: boolean } | null {
  if (toType) return { id: 'typeIt', text: t('typeIt', { message: toType }), tone: 'warn', long: true };
  if (failure && !dismissed.has(failure)) return { id: failure, text: t(failure), tone: 'error' };
  if (saveFailed && !dismissed.has('saveFailed')) return { id: 'saveFailed', text: t('saveFailed'), tone: 'error' };
  const { answers, unsaved } = interview.journey;
  if (!connection?.greeted && !unsaved.length && !Object.keys(answers).length) return null;
  if (interview.access === 'signed_in') return null;
  const key = interview.access === 'signed_out' ? 'notSaved' : 'noTools';
  return dismissed.has(key) ? null : { id: key, text: t(key), tone: 'warn' };
}
function renderNotice() {
  const current = notice();
  ui.notice.hidden = !current;
  ui.noticeText.textContent = current?.text ?? '';
  ui.notice.className = `rc-note rc-note--${current?.tone ?? 'warn'} note`;
  ui.notice.dataset.long = String(Boolean(current?.long));
}

/** The trail in one row: the checkpoint to work on, seven segments and the count. It opens the plan. */
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
  const count = { reached: view.reached, total: view.total };
  ui.trail.hidden = false;
  ui.trail.setAttribute(
    'aria-label',
    view.reached === view.total ? t('trailLabelAll', count) : t('trailLabel', { ...count, current: shown.title }),
  );
  ui.trail.setAttribute('aria-expanded', String(planShown));
  ui.trailArt.dataset.step = shown.id;
  ui.trailCount.textContent = t('trailCount', count);
  ui.trailSteps.replaceChildren(
    ...view.steps.map(step => {
      const item = document.createElement('li');
      item.dataset.state = step.state;
      return item;
    }),
  );
}

/** The plan at the size of a card: the shortest timeline, where, one line about aid, and the way to the workspace. */
function drawPlan() {
  ui.trail.setAttribute('aria-expanded', String(planShown));
  ui.plan.hidden = !planShown;
  if (!planShown) return;
  const summary = planOutcome?.status === 'ok' ? planSummary(planOutcome.result, locale) : null;
  show(ui.planFigure, summary?.figure ?? null);
  ui.planLabel.textContent = summary?.label ?? t(planOutcome ? 'planNone' : 'planLoading');
  show(ui.planAid, summary?.aid ?? null);
  show(ui.workspace, summary ? t(workspaceAsked ? 'workspaceSent' : 'openWorkspace') : null);
}

function render() {
  renderOrb();
  renderTopics();
  renderQuestion();
  renderControls();
  renderNotice();
  ui.continueInChat.textContent = t(chatSent ? 'sent' : 'continueInChat');
  ui.continueInChat.disabled = chatSent;
}

// ------------------------------------------------------------ the plan

/** Ask the planner and show what it answers. A slower, older answer never replaces a newer one. */
async function readPlan(): Promise<PlanOutcome> {
  const run = ++planRun;
  if (!planOutcome) drawPlan();
  const outcome = await interview.plan();
  if (run === planRun) {
    planOutcome = outcome;
    drawPlan();
    renderTrail();
    renderTopics();
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
  workspaceAsked = sent;
  toType = sent ? null : text;
  drawPlan();
  renderNotice();
  return sent;
}

const voiceTools = cardVoiceTools({
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

/** The question the session will ask next: the card offers its answers to tap when ReloCat asks it. */
function expect(question: unknown) {
  expected = (question as SpokenQuestion | null | undefined) ?? null;
  fresh = expected !== null;
}

/** Answer a function of the session, and keep what the card shows of it: the next question, towns to pick from. */
async function runVoiceTool(tool: string, args: Record<string, unknown>) {
  const result = await voiceTools(tool, args);
  if ('nextQuestion' in result) expect(result.nextQuestion);
  if (tool === 'save_place') {
    // A town that is in the list is stored at once; only a name that fits several or none is asked about.
    const outcome = result as { saved?: boolean; similar?: PlaceChoice[] };
    placeTurn = outcome.saved ? null : outcome.similar?.length ? { towns: outcome.similar.map(town => town.name) } : {};
  }
  // Connected and still not saved: the profile did not take it.
  if (tool.startsWith('save_') && interview.access === 'signed_in' && typeof result.sayOnce === 'string') {
    saveFailed = true;
    dismissed.delete('saveFailed');
  }
  render();
  return result;
}

// ------------------------------------------------------------ the conversation

/**
 * An answer of the person as text: a tapped chip, a figure, a typed reply. All three go to the session
 * as the person's turn, so the model hears it, saves it with its tools and moves on. Tapped while
 * ReloCat is still speaking, it waits for the end of that turn.
 */
function sendAnswer(text: string) {
  if (!connection || !text) return false;
  answered = true;
  topic = null;
  if (!connection.sayTyped(text)) queued = text;
  return true;
}

/** End the conversation. The answers given stay in the card for the next one. */
function endConversation(why: { failure: CardKey; typing: boolean } | null) {
  const previous = connection;
  connection = undefined;
  previous?.close();
  closeMeter();
  ui.audio.srcObject = null;
  ui.answer.value = '';
  ui.amount.value = '';
  phase = 'idle';
  over = why === null;
  failure = why?.failure ?? null;
  if (failure) dismissed.delete(failure);
  offerTyping = why?.typing ?? false;
  canSend = false;
  queued = null;
  topic = null;
  said = null;
  placeTurn = null;
  keyboardOpen = false;
  // The plan stays in sight when there is one.
  if (planOutcome?.status === 'ok') planShown = true;
  drawPlan();
  render();
}

function ended(reason: VoiceEnd) {
  const { key, offerTyping: typing } = cardFailure(reason);
  endConversation({ failure: key, typing });
}

async function startConversation(withMicrophone: boolean) {
  if (connection || starting) return;
  const support = voiceSupport();
  if (!support.peer) return endConversation({ failure: 'voiceUnavailable', typing: false });
  if (withMicrophone && !support.microphone) return endConversation({ failure: 'micUnavailable', typing: true });
  starting = true;
  speaking = withMicrophone;
  phase = 'connecting';
  over = false;
  failure = null;
  offerTyping = false;
  toType = null;
  render();
  await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 4000))]);
  starting = false;
  const call = startVoiceCall({
    // The card runs on the host's own origin, so the address of ReloCat's voice route is absolute.
    endpoint: document.documentElement.dataset.voiceEndpoint ?? 'voice',
    microphone: withMicrophone,
    context: async () => {
      const context = await cardVoiceContext(interview, locale, today());
      expect(context.nextQuestion);
      return context;
    },
    runTool: runVoiceTool,
    onPhase: next => {
      phase = next;
      renderOrb();
      renderControls();
    },
    onGreeted: () => {
      render();
      if (!speaking) ui.answer.focus();
    },
    // What ReloCat says is always shown: in a chat the sound is often off. Only the line that asks.
    onCaption: transcript => {
      const line = shownQuestion(transcript);
      const town = line.asks ? placeTurn : null;
      const asked = line.asks && !town && fresh ? expected : null;
      if (line.asks) {
        placeTurn = null;
        fresh = false;
      }
      // The opening asks nothing: the five chips say it, so its closing words are not repeated under the orb.
      const opening = said === null && !line.asks;
      said = { text: opening ? '' : line.text, asked, towns: town?.towns };
      topic = null;
      answered = false;
      queued = null;
      ui.amount.value = '';
      renderTopics();
      renderQuestion();
    },
    onCanSend: allowed => {
      canSend = allowed;
      ui.send.disabled = !allowed;
      if (allowed && queued && connection === call) {
        const text = queued;
        queued = null;
        call.sayTyped(text);
      }
    },
    onLocalStream: stream => {
      microphoneTap = tap(stream);
      startMeter();
    },
    onRemoteStream: stream => {
      ui.audio.srcObject = stream;
      // The person pressed a button in this frame, so playing is allowed; a refusal leaves the question on screen.
      void ui.audio.play?.()?.catch(() => {});
      voiceTap = tap(stream);
      startMeter();
    },
    onEnd: reason => {
      if (connection === call) ended(reason);
    },
  });
  connection = call;
  said = null;
  answered = false;
  render();
  startMeter();
}

// The orb: the start button, then the mute control.
ui.orb.addEventListener('click', () => {
  if (!live()) return void startConversation(true);
  if (!talking() || !connection?.setMuted(!connection.muted)) return;
  renderOrb();
  renderControls();
});
ui.typeInstead.addEventListener('click', () => void startConversation(false));
ui.stop.addEventListener('click', () => endConversation(null));
ui.done.addEventListener('click', () => void connection?.endTurn());
ui.keyboard.addEventListener('click', () => {
  keyboardOpen = ui.typed.hidden;
  renderQuestion();
  if (keyboardOpen) ui.answer.focus();
});
ui.typed.addEventListener('submit', event => {
  event.preventDefault();
  const text = ui.answer.value.trim();
  const view = asking();
  // A name typed for a chip says which chip it is for.
  if (!sendAnswer(view && topic ? view.wrap(text) : text)) return;
  ui.answer.value = '';
  renderTopics();
  renderQuestion();
});
ui.amount.addEventListener('input', () => {
  ui.confirm.disabled = ui.amount.disabled || !typedNumber(ui.amount.value);
});
ui.number.addEventListener('submit', event => {
  event.preventDefault();
  const view = asking();
  const value = typedNumber(ui.amount.value);
  if (ui.amount.disabled || !value || view?.controls?.kind !== 'number') return;
  sendAnswer(view.wrap(t('amount', { value, unit: view.controls.unit })));
  renderTopics();
  renderQuestion();
});
ui.unknown.addEventListener('click', () => {
  const view = asking();
  if (ui.unknown.disabled || view?.controls?.kind !== 'number' || !view.controls.unknown) return;
  sendAnswer(view.wrap(view.controls.unknown));
  renderQuestion();
});
// A chip: tap it to give or correct that one thing; tap it again to go back to the conversation.
for (const item of topicNodes)
  item.chip.addEventListener('click', () => {
    if (!talking()) return;
    topic = topic === item.id ? null : item.id;
    ui.amount.value = '';
    renderTopics();
    renderQuestion();
    if (topic === 'place') ui.answer.focus();
  });
// The trail asks for the plan and opens its summary; tapped again, it closes it.
ui.trail.addEventListener('click', () => {
  planShown = !planShown;
  drawPlan();
  if (planShown) void readPlan();
});
ui.workspace.addEventListener('click', () => void askForWorkspace());
ui.noticeClose.addEventListener('click', () => {
  const current = notice();
  if (current?.id === 'typeIt') toType = null;
  else if (current) dismissed.add(current.id);
  renderNotice();
});

/**
 * "Continue in the chat": the opening message goes into the chat as the person's own, and the
 * interview goes on there by text or with the host's voice mode. A conversation in the card ends
 * first, so two interviews never run at once. A host that cannot take the message gets the sentence to type.
 */
ui.continueInChat.addEventListener('click', async () => {
  ui.continueInChat.setAttribute('aria-busy', 'true');
  if (connection) endConversation(null);
  const message = t('startMessage');
  chatSent = await sendToChat(host(), message);
  toType = chatSent ? null : message;
  ui.continueInChat.removeAttribute('aria-busy');
  render();
});

/** The template and everything on screen, in the language now shown. */
function applyLocale(next: Locale) {
  const changed = next !== locale;
  locale = next;
  t = translator(cardCatalog, locale);
  document.documentElement.lang = locale;
  document.title = t('title');
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]'))
    element.textContent = t(element.dataset.i18n as CardKey);
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-label]'))
    named(element, t(element.dataset.i18nLabel as CardKey));
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]'))
    element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder as CardKey));
  ui.languages.setAttribute('aria-label', translator(common, locale)('language'));
  for (const option of ui.languages.querySelectorAll<HTMLElement>('button'))
    option.setAttribute('aria-pressed', String(option.dataset.lang === locale));
  // A sentence to type was written in the language it was asked in: it is not kept across languages.
  if (changed) toType = null;
  render();
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

applyLocale(locale);

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
