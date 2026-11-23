import {
  type CashFlowSummary,
  cashFlowStatements as cashFlowRule,
  classificationCandidates,
  parseTransactions,
  summarizeTransactions,
} from '../../packages/finance/csv.ts';
import { browserLocale, rememberLocale } from '../../packages/i18n/browser.ts';
import { common } from '../../packages/i18n/common.ts';
import { createFormat } from '../../packages/i18n/format.ts';
import { type Locale, toLocale } from '../../packages/i18n/locales.ts';
import { type MessageValues, translator } from '../../packages/i18n/messages.ts';
import type { AnswerValue } from '../../packages/model/questions.ts';
import {
  describeAnswer,
  isQuestionId,
  parseTyped,
  questionById,
  questionsIn,
  validateAnswer,
} from '../../packages/model/questions.ts';
import { cashQuestions, moneyIn, statementNote } from './cash.ts';
import type { FactAnswers } from './facts.ts';
import { toolCaller, voiceFactContext } from './facts.ts';
import { interview as catalog } from './messages.ts';
import { planView, trail } from './plan.ts';
import type { VoicePhase as CallPhase, VoiceCall, VoiceEnd } from './realtime.ts';
import { startVoiceCall, voiceSupport } from './realtime.ts';
import type { Asked, Journey, PlanOutcome } from './session.ts';
import { createInterview, emptyJourney } from './session.ts';
import type { VoiceContext } from './voice.ts';

type BankSource = 'demo' | 'csv';
/** Everything kept in this browser's storage between visits. */
type State = {
  cash: CashFlowSummary | null;
  /** Currency of the bank statement. Answers are always in euros. */
  currency: string;
  source: BankSource | null;
  /** How the last statement was categorized, as the English sentence earlier visits stored. */
  classification?: string;
  /** The same as a code and its counts, so the page can say it in the language shown. */
  classificationInfo?: { kind: 'local' | 'openai' | 'fallback'; classified?: number; total?: number };
  /**
   * The interview: answers by shared question id (`null` is "I don't know"), the few page details,
   * the towns chosen and what has not reached the profile yet.
   */
  journey: Journey;
};
/** What earlier versions of the page stored under the same key. */
type LegacyState = {
  profile?: Record<string, unknown>;
  facts?: FactAnswers;
  profileCurrency?: string;
};

/** What the conversation area shows: `idle` between conversations, else the phase of the live call (`realtime.ts`). */
type VoicePhase = 'idle' | CallPhase;

/** A page element that must exist with the expected type; the markup and this script ship together. */
function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`The page is missing #${id}.`);
  return node;
}

const ui = {
  answer: element('answer', HTMLInputElement),
  audio: element('audio', HTMLAudioElement),
  bank: element('bank', HTMLButtonElement),
  bankBack: element('bank-back', HTMLButtonElement),
  bankPreview: element('bank-preview', HTMLElement),
  bankStatus: element('bank-status', HTMLElement),
  captions: element('captions', HTMLButtonElement),
  cash: element('cash', HTMLElement),
  classifierStatus: element('classifier-status', HTMLElement),
  clear: element('clear', HTMLButtonElement),
  conversation: element('conversation', HTMLElement),
  csv: element('csv', HTMLInputElement),
  currency: element('currency', HTMLSelectElement),
  dataPanel: element('data-panel', HTMLDialogElement),
  demo: element('demo', HTMLButtonElement),
  expenseDetails: element('expense-details', HTMLElement),
  expenses: element('expenses', HTMLElement),
  facts: element('facts', HTMLElement),
  guide: element('guide', HTMLButtonElement),
  guideError: element('guide-error', HTMLElement),
  guideField: element('guide-field', HTMLElement),
  guideWhy: element('guide-why', HTMLElement),
  guidedAnswer: element('guided-answer', HTMLFormElement),
  languages: element('languages', HTMLElement),
  importStatus: element('import-status', HTMLElement),
  lastQuestion: element('last-question', HTMLElement),
  mute: element('mute', HTMLButtonElement),
  optionsPanel: element('options-panel', HTMLDialogElement),
  plan: element('plan', HTMLElement),
  profileSignin: element('profile-signin', HTMLAnchorElement),
  profileStatus: element('profile-status', HTMLElement),
  saveProfile: element('save-profile', HTMLButtonElement),
  saveStatus: element('save-status', HTMLElement),
  sendAnswer: element('send-answer', HTMLButtonElement),
  signinNote: element('signin-note', HTMLElement),
  skip: element('skip', HTMLButtonElement),
  sourceButton: element('source-button', HTMLButtonElement),
  sources: element('sources', HTMLElement),
  start: element('start', HTMLButtonElement),
  stop: element('stop', HTMLButtonElement),
  trail: element('trail', HTMLElement),
  trailArt: element('trail-art', HTMLElement),
  trailCount: element('trail-count', HTMLElement),
  trailSteps: element('trail-steps', HTMLElement),
  trailTitle: element('trail-title', HTMLElement),
  typeToggle: element('type-toggle', HTMLButtonElement),
  typedAnswer: element('typed-answer', HTMLFormElement),
  useDecisions: element('use-decisions', HTMLInputElement),
  voiceStatus: element('voice-status', HTMLElement),
  workspaceLink: element('workspace-link', HTMLAnchorElement),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ------------------------------------------------------------ language

type Key = keyof typeof catalog.en;
/** The language the page shows: a `?lang=`, an earlier choice, then the browser's own. */
let locale: Locale = browserLocale();
let t = translator(catalog, locale);
/** English, for what is stored as a sentence. */
const english = translator(catalog, 'en');
/** A key built from an id, such as `category.Rent`; one the catalog lacks falls back to `fallback`. */
const worded = (key: string, fallback: string, values?: MessageValues) =>
  key in catalog.en ? t(key as Key, values) : fallback;

/**
 * A line of the page whose words depend on the language. The line is kept as a function, so a
 * language change says the same thing again instead of leaving the old sentence on screen.
 */
type Line = () => string;
const lines = new Map<HTMLElement, Line>();
function say(node: HTMLElement, line: Line) {
  lines.set(node, line);
  node.textContent = line();
}
/** A message of this page's catalog as a line. */
const line =
  (key: Key, values?: MessageValues): Line =>
  () =>
    t(key, values);

/** A failure the page explains itself, by message key. Any other error carries English text from a library. */
class Told extends Error {
  readonly key: Key;
  constructor(key: Key) {
    super(english(key));
    this.key = key;
  }
}
/**
 * An error in the page's language. English shows the error's own text, as before; another
 * language shows this page's sentence for it, since a library's message cannot be translated here.
 */
function explain(error: unknown, otherwise: Key) {
  if (error instanceof Told) return t(error.key);
  return locale === 'en' ? errorMessage(error) : t(otherwise);
}

// ------------------------------------------------------------ stored state

const key = 'homebuying-interviewer-v1';
const emptyState = (): State => ({ cash: null, currency: 'EUR', source: null, journey: emptyJourney() });

/**
 * What an earlier version stored, as the journey of this one. Its own money fields become the shared
 * answers they always were (pay, savings) when they were in euros; nothing is converted. The fields
 * with no input path (home type, amenities, notes, monthly contribution) are not carried over.
 */
function migrate(saved: Partial<State> & LegacyState): State {
  const { profile, facts, profileCurrency, ...rest } = saved;
  const state: State = { ...emptyState(), ...rest };
  if (saved.journey) return { ...state, journey: { ...emptyJourney(), ...saved.journey } };
  const journey: Journey = { ...emptyJourney(), answers: { ...facts } };
  const cents = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : undefined;
  if (profile && (profileCurrency ?? state.currency) === 'EUR') {
    journey.answers.purchaseSavings ??= cents(profile.saved);
    journey.answers.monthlyIncome ??= cents(profile.confirmedSalary);
    const target = cents(profile.target);
    if (target !== undefined) journey.extras.targetCashCents = target;
  }
  const size = profile?.householdSize;
  if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 1 && size <= 30)
    journey.extras.householdSize = size;
  for (const id of Object.keys(journey.answers) as (keyof FactAnswers)[])
    if (journey.answers[id] === undefined) delete journey.answers[id];
  journey.unsaved = [
    ...Object.keys(journey.answers),
    ...(journey.extras.householdSize === undefined ? [] : ['householdSize']),
    ...(journey.extras.targetCashCents === undefined ? [] : ['targetCash']),
  ];
  return { ...state, journey };
}

let state = emptyState();
let importAttempt = 0;
say(ui.saveStatus, line('savedHere'));
say(ui.importStatus, line('csvColumns'));
/** False when the server said voice cannot answer this visitor: the page then runs the written interview. */
const voiceOpen = document.documentElement.dataset.voice !== 'off';
const idleLine = () => line(voiceOpen ? 'ready' : 'readyWritten');
if (!voiceOpen) ui.start.dataset.i18n = 'startWritten';
say(ui.voiceStatus, idleLine());
try {
  const saved = localStorage.getItem(key);
  // Written only by save() below, so the stored shape is this page's own State, of this version or an earlier one.
  if (saved) state = migrate(JSON.parse(saved) as Partial<State> & LegacyState);
} catch {
  say(ui.saveStatus, line('loadFailed'));
}

function save(message: Line) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
    say(ui.saveStatus, message);
  } catch {
    say(ui.saveStatus, line('storageUnavailable'));
  }
}

function money(amount: number, currency = state.currency) {
  return moneyIn(locale, currency)(amount);
}

/**
 * The pay and spending questions about a statement in the page's language (`cash.ts`), with the note
 * for the voice model from the shared rule, which stays in English.
 */
function cashFlowStatements(cash: CashFlowSummary, write: (amount: number) => string) {
  return { ...cashQuestions(cash, write, locale), guidance: cashFlowRule(cash, write).guidance };
}

/** A small button at the end of a row. `name` says what it acts on, for a screen reader. */
type RowAction = { label: string; name: string; run: () => void };
function showRows(list: HTMLElement, entries: [label: string, value: string, action?: RowAction][]) {
  list.replaceChildren(
    ...entries.map(([label, value, action]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value;
      row.append(term, detail);
      if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'rc-btn rc-btn--sm rc-btn--quiet row-action';
        button.textContent = action.label;
        button.setAttribute('aria-label', action.name);
        button.addEventListener('click', action.run);
        row.append(button);
      }
      return row;
    }),
  );
}

/** The live voice call (`realtime.ts`), while there is one. */
let connection: VoiceCall | undefined;
/** The guided interview is running. */
let guiding = false;
/** The guided question on screen. `only`: one answer is being changed, and the interview ends after it. */
let guide: { asked: Asked; control: FactControl; only: boolean } | null = null;

// ------------------------------------------------------------ the interview

const today = () => new Date().toISOString().slice(0, 10);
/** The MCP endpoint of this origin. It exists on the main ReloCat server, not when the interviewer runs alone. */
const mcpEndpoint = new URL('/mcp', window.location.href).href;

/** The one interview behind the voice session and the guided form: questions, saving and the plan. */
const interview = createInterview({
  call: toolCaller(fetch, mcpEndpoint),
  today,
  locale: () => locale,
  journey: state.journey,
  changed: () => {
    state.journey = interview.journey;
    save(line('factsSaved'));
    renderFacts();
    schedulePlan();
  },
});

/** What the last save to the profile said, until the answers change again. */
let profileNotice: Line | undefined;

/** The review list of answers, and where they are kept, which depends on where the page runs. */
function renderFacts(message?: Line) {
  profileNotice = message;
  const { answers, extras, places, unsaved } = interview.journey;
  const format = createFormat(locale);
  const change = (id: Parameters<typeof interview.question>[0], label: string): RowAction => ({
    label: t('change'),
    name: t('changeAnswer', { label }),
    run: () => void startGuide(interview.question(id)),
  });
  const rows: [string, string, RowAction?][] = [];
  for (const question of questionsIn(locale)) {
    const value = answers[question.id];
    // A schooling answer is about the children as they were listed; it is changed by answering again in order.
    if (value !== undefined)
      rows.push([
        question.label,
        describeAnswer(question.id, value, today(), locale),
        question.kind.type === 'per_child' ? undefined : change(question.id, question.label),
      ]);
  }
  if (extras.householdSize !== undefined)
    rows.push([
      t('review.householdSize'),
      format.count(extras.householdSize),
      change('householdSize', t('review.householdSize')),
    ]);
  if (extras.targetCashCents !== undefined)
    rows.push([t('review.targetCash'), format.eurosAuto(extras.targetCashCents)]);
  for (const place of places)
    rows.push([
      t('review.place'),
      `${place.name} (${place.comarca})`,
      {
        label: t('remove'),
        name: t('removeTown', { name: place.name }),
        run: () => void interview.removePlace(place.code),
      },
    ]);
  showRows(ui.facts, rows);
  const access = interview.access;
  const where: Key =
    access === 'signed_in' ? (unsaved.length ? 'access.signed_in' : 'access.signed_in_saved') : `access.${access}`;
  say(ui.profileStatus, message ?? (() => (rows.length ? t(where) : t('noDetails'))));
  ui.saveProfile.hidden = access !== 'signed_in' || !unsaved.length;
  ui.profileSignin.hidden = access !== 'signed_out';
  ui.signinNote.hidden = access !== 'signed_out';
  ui.workspaceLink.hidden = access === 'standalone';
  ui.workspaceLink.href = interview.workspaceUrl();
}

// ------------------------------------------------------------ plan and trail

/** The last answer of `plan_home_savings`; null until the first one. */
let planOutcome: PlanOutcome | null = null;
let planRun = 0;
let planTimer: ReturnType<typeof setTimeout> | undefined;

/** A titled list of the plan. `folded`: the long lists (assumptions, limits) open on request, so the plan stays short. */
function listed(heading: Key, items: string[], folded = false) {
  if (!items.length) return [];
  const list = document.createElement('ul');
  for (const item of items) list.append(Object.assign(document.createElement('li'), { textContent: item }));
  if (folded) {
    const details = document.createElement('details');
    details.append(Object.assign(document.createElement('summary'), { textContent: t(heading) }), list);
    return [details];
  }
  return [Object.assign(document.createElement('h3'), { textContent: t(heading) }), list];
}

/** The plan as the planner returned it: nothing on this page computes a timeline. */
function drawPlan() {
  if (planOutcome?.status !== 'ok') {
    say(
      ui.plan,
      line(
        planOutcome ? (planOutcome.status === 'standalone' ? 'plan.standalone' : 'plan.unavailable') : 'plan.loading',
      ),
    );
    return;
  }
  lines.delete(ui.plan);
  const view = planView(planOutcome.result, locale);
  const paragraph = (text: string, className = '') =>
    Object.assign(document.createElement('p'), { textContent: text, className });
  ui.plan.replaceChildren(
    paragraph(view.headline, 'plan-headline'),
    ...(view.figures ? [paragraph(view.figures)] : []),
    ...listed('plan.next', view.nextQuestion ? [view.nextQuestion] : []),
    ...listed('plan.counted', view.counted),
    ...listed('plan.awaiting', view.awaiting),
    ...listed('plan.assumes', view.assumes, true),
    ...listed('plan.limits', view.limitations, true),
    paragraph(view.disclaimer, 'hint'),
  );
}

/** The trail of checkpoints: the one to work on, its illustration, and how many are reached. */
function renderTrail() {
  const { answers, places } = interview.journey;
  const view = trail(
    {
      result: planOutcome?.status === 'ok' ? planOutcome.result : null,
      placeCount: places.length,
      bankMovements: state.cash ? state.cash.transactionCount : null,
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
  ui.trailArt.dataset.step = shown.id;
  ui.trailTitle.textContent = view.reached === view.total ? t('trail.allReached') : shown.title;
  ui.trailCount.textContent = t('trail.count', { reached: view.reached, total: view.total });
  ui.trailSteps.replaceChildren(
    ...view.steps.map(step => {
      const item = document.createElement('li');
      item.dataset.state = step.state;
      return item;
    }),
  );
}

/** Ask the planner again and show what it answers. A slower, older answer never replaces a newer one. */
async function renderPlan(): Promise<PlanOutcome> {
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
/** After a change of answers: one refresh for a burst of changes. */
function schedulePlan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(() => void renderPlan(), 200);
}

// ------------------------------------------------------------ answer controls

type FactControl = { nodes: HTMLElement[]; read: () => AnswerValue | null | undefined };

function labelled(text: string, input: HTMLElement, className = '') {
  const label = document.createElement('label');
  if (className) label.className = className;
  if (className === 'check') label.append(input, text);
  else label.append(text, input);
  return label;
}

function choiceSelect(options: [value: string, label: string][]) {
  const select = document.createElement('select');
  select.add(new Option(t('choose'), ''));
  for (const [value, label] of options) select.add(new Option(label, value));
  return select;
}

const yesNo = (allowUnknown: boolean): [string, string][] => [
  ['yes', t('yes')],
  ['no', t('no')],
  ...(allowUnknown ? ([['unknown', t('dontKnow')]] as [string, string][]) : []),
];
const fromYesNo = (value: string) =>
  value === 'yes' ? true : value === 'no' ? false : value === 'unknown' ? null : undefined;

/** The control for one question, built from its answer spec. Nothing is preselected. */
function factControl(asked: Asked): FactControl {
  const spec = asked.answer;
  switch (spec.type) {
    case 'place': {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 100;
      input.autocomplete = 'off';
      input.setAttribute('aria-labelledby', 'last-question');
      const options = document.createElement('datalist');
      options.id = 'pilot-towns';
      input.setAttribute('list', options.id);
      // The towns that can be chosen, so a name is picked, not guessed.
      void interview.pilotTowns().then(towns => {
        for (const town of towns ?? []) options.append(new Option(`${town.name} (${town.comarca})`, town.name));
      });
      return { nodes: [input, options], read: () => input.value.trim() || undefined };
    }
    case 'boolean': {
      const select = choiceSelect(yesNo(asked.allowUnknown));
      select.setAttribute('aria-labelledby', 'last-question');
      return { nodes: [select], read: () => fromYesNo(select.value) };
    }
    case 'choice': {
      const select = choiceSelect([
        ...spec.options.map((option): [string, string] => [option.value, option.label]),
        ...(asked.allowUnknown ? ([['unknown', t('dontKnow')]] as [string, string][]) : []),
      ]);
      select.setAttribute('aria-labelledby', 'last-question');
      return { nodes: [select], read: () => (select.value === 'unknown' ? null : select.value || undefined) };
    }
    case 'children': {
      const fieldset = document.createElement('fieldset');
      const count = choiceSelect([
        ['0', t('noChildren')],
        ...Array.from({ length: 8 }, (_, index): [string, string] => [String(index + 1), String(index + 1)]),
      ]);
      const rows = document.createElement('div');
      count.addEventListener('change', () => {
        const dates = [...rows.querySelectorAll('input')].map(input => input.value);
        rows.replaceChildren(
          ...Array.from({ length: Number(count.value) || 0 }, (_, index) => {
            const input = document.createElement('input');
            input.type = 'date';
            input.max = today();
            input.value = dates[index] ?? '';
            return labelled(t('childBirthDate', { number: index + 1 }), input);
          }),
        );
      });
      fieldset.append(labelled(t('howManyChildren'), count), rows);
      return {
        nodes: [fieldset],
        read: () =>
          count.value === ''
            ? undefined
            : [...rows.querySelectorAll('input')].map(input => ({ birthDate: input.value })),
      };
    }
    case 'per_child': {
      const fieldset = document.createElement('fieldset');
      const selects = spec.children.map(child => {
        const select = choiceSelect(yesNo(asked.allowUnknown));
        fieldset.append(labelled(child.label, select));
        return select;
      });
      return {
        nodes: [fieldset],
        read: () => {
          const values = selects.map(select => fromYesNo(select.value));
          return values.some(value => value === undefined) ? undefined : (values as (boolean | null)[]);
        },
      };
    }
    default: {
      // People in the home is a plain count: it is read with the rules of a number question.
      const typed = (text: string) => parseTyped(isQuestionId(asked.id) ? asked.id : 'floorArea', text) ?? Number.NaN;
      const input = document.createElement('input');
      input.type = spec.type === 'date' ? 'date' : 'text';
      if (spec.type === 'date') [input.min, input.max] = [spec.min, spec.max];
      else input.inputMode = 'decimal';
      input.setAttribute('aria-labelledby', 'last-question');
      if (!asked.allowUnknown)
        return { nodes: [input], read: () => (input.value.trim() ? typed(input.value) : undefined) };
      const unknown = document.createElement('input');
      unknown.type = 'checkbox';
      unknown.addEventListener('change', () => {
        input.disabled = unknown.checked;
      });
      return {
        nodes: [input, labelled(t('dontKnow'), unknown, 'check')],
        read: () => (unknown.checked ? null : input.value.trim() ? typed(input.value) : undefined),
      };
    }
  }
}

function renderCash() {
  const cash = state.cash;
  const interviewing = Boolean(connection) || guiding;
  ui.start.hidden = interviewing;
  ui.stop.hidden = !interviewing;
  ui.guide.disabled = interviewing;
  ui.sourceButton.textContent = t(cash ? (state.source === 'demo' ? 'demoBankAdded' : 'bankDataAdded') : 'addBank');
  ui.expenseDetails.hidden = !cash;
  say(ui.classifierStatus, () => {
    const info = state.classificationInfo;
    if (!info) return state.classification ?? '';
    return info.kind === 'openai'
      ? t('classifiedOpenai', { classified: info.classified ?? 0, total: info.total ?? 0 })
      : t(info.kind === 'fallback' ? 'classifiedFallback' : 'classifiedLocal');
  });
  if (!cash) {
    showRows(ui.cash, []);
    showRows(ui.expenses, []);
    return;
  }
  say(ui.importStatus, () => (state.cash ? statementNote(state.cash, locale) : t('csvColumns')));
  if (cash.averageBasis === 'period_too_short') {
    // Too short for a monthly figure: show what the days covered hold, labelled as such, and nothing monthly.
    const days = { days: cash.coveredDays };
    showRows(ui.cash, [
      [t('monthlyFigures'), t('notAvailableShort')],
      [t('receivedIn', days), money(cash.periodTotals.inflows)],
      [t('spentIn', days), money(cash.periodTotals.outflows)],
    ]);
    showRows(ui.expenses, []);
    return;
  }
  // The same figures read as a rough indication when no calendar month is complete.
  const rough = cash.averageBasis !== 'complete_months';
  const row = (name: 'salary' | 'otherIncome' | 'inflows' | 'costOfLiving' | 'net') =>
    t(rough ? `row.${name}.rough` : `row.${name}`);
  const amount = (value: number | null) => (value === null ? createFormat(locale).unknown : money(value));
  const otherIncome: [string, string][] =
    (cash.monthlyOtherIncome ?? 0) > 0 ? [[row('otherIncome'), amount(cash.monthlyOtherIncome)]] : [];
  showRows(ui.cash, [
    [row('salary'), cash.estimatedMonthlySalary === null ? t('unidentified') : money(cash.estimatedMonthlySalary)],
    ...otherIncome,
    [row('inflows'), amount(cash.monthlyInflows)],
    [row('costOfLiving'), amount(cash.monthlyCostOfLiving)],
    [row('net'), amount(cash.monthlyNetCashFlow)],
  ]);
  // A category is an internal id (it is what the classifier answers with); only its label is translated.
  showRows(
    ui.expenses,
    Object.entries(cash.monthlyExpenses).map(([name, amount]) => [worded(`category.${name}`, name), money(amount)]),
  );
}

/** Categories from the optional Decisions route, one per candidate, or null where it was unsure. */
function readCategories(body: unknown, expected: number): (string | null)[] {
  const categories = isRecord(body) ? body.categories : undefined;
  if (!Array.isArray(categories) || categories.length !== expected) throw new Error('Invalid classification.');
  return categories.map(category => (typeof category === 'string' ? category : null));
}

async function importCsv(text: string, source: BankSource, currency: string, useDecisions: boolean, attempt: number) {
  if (attempt !== importAttempt) return;
  const transactions = parseTransactions(text);
  const candidates = useDecisions ? classificationCandidates(transactions) : [];
  let categories: (string | null)[] = [];
  // The stored sentence stays English, as earlier visits stored it; the page shows `info` in its own language.
  let classification = english('classifiedLocal');
  let info: State['classificationInfo'] = { kind: 'local' };
  if (candidates.length) {
    const status = source === 'demo' ? ui.bankStatus : ui.importStatus;
    say(status, line('classifying'));
    try {
      const response = await fetch('classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(candidates),
        signal: AbortSignal.timeout(7500),
      });
      if (!response.ok) throw new Error('Decisions unavailable.');
      categories = readCategories(await response.json(), candidates.length);
      const classified = categories.filter(Boolean).length;
      if (classified) {
        info = { kind: 'openai', classified, total: candidates.length };
        classification = english('classifiedOpenai', { classified, total: candidates.length });
      }
    } catch {
      categories = [];
      info = { kind: 'fallback' };
      classification = english('classifiedFallback');
    }
  }
  if (attempt !== importAttempt) return;
  state.cash = summarizeTransactions(transactions, candidates, categories);
  state.classification = classification;
  state.classificationInfo = info;
  state.source = source;
  state.currency = currency;
  ui.currency.value = currency;
  save(line('cashSaved'));
  renderCash();
  renderTrail();
  ui.dataPanel.close();
  if (connection?.configured) {
    connection.shareWhenQuiet(cashUpdateNote);
  } else if (!connection && !guiding) {
    setVoiceStatus('idle', line(source === 'demo' ? 'demoAddedReady' : 'csvAddedReady'));
  }
}

ui.demo.addEventListener('click', async () => {
  const attempt = ++importAttempt;
  ui.demo.disabled = true;
  say(ui.bankStatus, line('connectingDemo'));
  try {
    const response = await fetch('demo.csv');
    if (!response.ok) throw new Told('sampleUnavailable');
    await importCsv(await response.text(), 'demo', 'EUR', true, attempt);
    say(ui.bankStatus, () => '');
  } catch (error) {
    if (attempt === importAttempt) say(ui.bankStatus, () => explain(error, 'sampleUnavailable'));
  } finally {
    ui.demo.disabled = false;
  }
});
ui.csv.addEventListener('change', async () => {
  const file = ui.csv.files?.[0];
  if (!file) return;
  const attempt = ++importAttempt;
  const currency = ui.currency.value;
  const useDecisions = ui.useDecisions.checked;
  ui.csv.value = '';
  try {
    if (file.size > 5_000_000) throw new Told('csvTooLarge');
    await importCsv(await file.text(), 'csv', currency, useDecisions, attempt);
  } catch (error) {
    // The parser explains a bad row in English; another language gets this page's own sentence.
    if (attempt === importAttempt) say(ui.importStatus, () => explain(error, 'csvUnreadable'));
  }
});

function showBankPreview(visible: boolean) {
  ui.sources.hidden = visible;
  ui.bankPreview.hidden = !visible;
}

function openPanel(id: string, previewBank = false) {
  const dialog = element(id, HTMLDialogElement);
  const openDialog = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (openDialog && openDialog !== dialog) openDialog.close();
  if (id === 'data-panel') showBankPreview(previewBank);
  if (!dialog.open) dialog.showModal();
}

for (const button of document.querySelectorAll<HTMLElement>('[data-open]')) {
  const panel = button.dataset.open;
  if (panel)
    button.addEventListener('click', () => {
      openPanel(panel);
      // The plan is read again each time it is looked at.
      if (panel === 'plan-panel') void renderPlan();
    });
}
for (const button of document.querySelectorAll<HTMLElement>('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog')?.close());
}
ui.bank.addEventListener('click', () => {
  showBankPreview(true);
  ui.demo.focus();
});
ui.bankBack.addEventListener('click', () => {
  showBankPreview(false);
  ui.bank.focus();
});

// ------------------------------------------------------------ voice functions

function showRequestedPanel({ panel }: Record<string, unknown>): Record<string, unknown> {
  switch (panel) {
    case 'demo_bank':
      openPanel('data-panel', true);
      ui.demo.focus();
      return { opened: 'Demo bank confirmation' };
    case 'upload_csv':
      openPanel('data-panel');
      ui.csv.focus();
      return { opened: 'Bank data panel with CSV picker' };
    default:
      return { error: 'Unknown panel.' };
  }
}

/** Open the workspace with the same towns. A browser may refuse a window nobody clicked for: then the link is shown. */
function openWorkspace(): Record<string, unknown> {
  if (interview.access === 'standalone')
    return { opened: false, reason: 'This page runs without the ReloCat server, so there is no workspace to open.' };
  const url = interview.workspaceUrl();
  const opened = window.open(url, '_blank');
  if (opened) {
    opened.opener = null;
    return { opened: true, towns: interview.journey.places.map(place => place.name) };
  }
  openPanel('plan-panel');
  ui.workspaceLink.focus();
  return {
    opened: false,
    linkOnScreen: true,
    reason: 'The browser did not allow opening it by voice. The link is on screen and focused: ask them to press it.',
  };
}

/** The functions of the voice session (`voice.ts`); each is answered by the same interview as the guided form. */
async function runVoiceTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
    case 'save_interview_answers':
      return interview.saveSpoken(args);
    case 'save_place':
      return interview.savePlaceSpoken(args);
    case 'show_plan': {
      const outcome = await renderPlan();
      openPanel('plan-panel');
      return interview.planSpoken(outcome);
    }
    case 'open_workspace':
      return openWorkspace();
    case 'save_to_profile':
      return interview.saveAllSpoken();
    default:
      return showRequestedPanel(args);
  }
}

/** What the voice session is told when it starts: where answers go, the statement, and the first question. */
async function voiceContext(): Promise<VoiceContext> {
  const { answers, extras, places } = interview.journey;
  return {
    locale,
    access: interview.access,
    cash: state.cash,
    statementCurrency: state.currency,
    bankSource: state.source,
    cashGuidance: (state.cash && cashFlowStatements(state.cash, money).guidance) ?? '',
    // Ids only: the values of answers typed in the guided interview are not sent to the voice service.
    answeredIds: [
      ...voiceFactContext(answers, today()).answeredFactIds,
      ...(extras.householdSize === undefined ? [] : ['householdSize']),
      ...(extras.targetCashCents === undefined ? [] : ['targetCash']),
    ],
    places: places.map(place => place.name),
    towns: (await interview.pilotTowns()) ?? [],
    nextQuestion: interview.spoken(await interview.nextQuestion()),
  };
}

// ------------------------------------------------------------ guided interview

/** The words of a question on screen: with a statement, pay and spending are asked about its figures. */
function wordedQuestion(asked: Asked) {
  if (state.cash && asked.id === 'monthlyIncome') return cashFlowStatements(state.cash, money).salaryQuestion;
  if (state.cash && asked.id === 'monthlyExpenses')
    return `${cashFlowStatements(state.cash, money).spendingQuestion} ${asked.question}`;
  return asked.question;
}

/** Show one guided question: the one given (a change of answer), or the next one the planner ranks first. */
async function showGuideQuestion(given?: Asked) {
  const asked = given ?? (await interview.nextQuestion());
  if (!guiding) return;
  if (!asked) {
    endInterview(line('guidedDoneResults'));
    return;
  }
  const control = factControl(asked);
  guide = { asked, control, only: Boolean(given) };
  ui.guideField.replaceChildren(...control.nodes);
  ui.lastQuestion.textContent = wordedQuestion(asked);
  ui.lastQuestion.hidden = false;
  ui.guideError.hidden = true;
  ui.guideWhy.textContent = [t('whyWeAsk', { why: asked.why }), asked.effect, asked.sensitivity, asked.help]
    .filter(Boolean)
    .join(' ');
  ui.guideWhy.hidden = false;
  setVoiceStatus('idle', () => t('guidedFacts', { where: accessLine() }));
  ui.guideField.querySelector<HTMLElement>('input, select')?.focus();
}

/** Where the answers are going, in the page's language. */
function accessLine() {
  const { access, journey } = interview;
  return t(access === 'signed_in' && !journey.unsaved.length ? 'access.signed_in_saved' : `access.${access}`);
}

async function startGuide(only?: Asked) {
  if (connection || guiding) return;
  guiding = true;
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
  ui.guidedAnswer.hidden = false;
  renderCash();
  await showGuideQuestion(only);
}

function endInterview(message: Line) {
  const previous = connection;
  connection = undefined;
  previous?.close();
  ui.audio.srcObject = null;
  ui.mute.hidden = true;
  ui.typeToggle.disabled = true;
  ui.typeToggle.setAttribute('aria-pressed', 'false');
  ui.typedAnswer.hidden = true;
  ui.sendAnswer.disabled = true;
  ui.answer.value = '';
  if (guiding) {
    guiding = false;
    guide = null;
    interview.resumeSkipped();
    ui.guidedAnswer.hidden = true;
    ui.lastQuestion.hidden = true;
  }
  renderFacts();
  setVoiceStatus('idle', message);
  renderCash();
}

function setVoiceStatus(phase: VoicePhase, message: Line) {
  ui.conversation.dataset.voice = phase;
  say(ui.voiceStatus, message);
}

/** What the status line says in each phase of a live call. */
const phaseLines: Record<CallPhase, Key> = {
  connecting: 'connectingMic',
  hearing: 'hearing',
  speaking: 'speaking',
  thinking: 'thinking',
  muted: 'muted',
  listening: 'listening',
};

/** What to tell a live session about a statement added mid-interview, built when it is said. */
const cashUpdateNote = () =>
  `The user just updated their data in the bank data panel. Briefly acknowledge the update and continue the interview with one relevant question. Say clearly if the data is fictional. ${(state.cash && cashFlowStatements(state.cash, money).guidance) ?? ''} Source: ${state.source === 'demo' ? 'fictional demo account' : 'user CSV'}. Updated context: ${JSON.stringify({ statementCurrency: state.currency, cash: state.cash })}`;

/** Why a call ended by itself, as the line the page shows. */
function endLine(reason: VoiceEnd): Line {
  switch (reason.kind) {
    case 'timeout':
      return line('voiceTimeout');
    case 'failed':
      return line('voiceFailed');
    case 'disconnected':
      return line('voiceDisconnected');
    case 'error':
      return line('voiceError');
    default:
      return () => {
        // The server and the browser explain a failure in English; another language names the cause by its status.
        const { status, message } = reason;
        const named = t(
          status === 403
            ? 'voiceLocalOnly'
            : status === 503
              ? 'voiceNoKey'
              : status === 429
                ? 'voiceTooMany'
                : 'voiceNotStarted',
        );
        return `${locale === 'en' ? message || named : named} ${t('openGuided')}`;
      };
  }
}

function startInterview() {
  if (connection || guiding) return;
  const support = voiceSupport();
  if (!support.microphone || !support.peer) {
    setVoiceStatus('idle', line('voiceUnsupported'));
    return;
  }
  // The WebRTC peer, the data-channel protocol and the turn-taking are the shared call (`realtime.ts`).
  const call = startVoiceCall({
    endpoint: 'voice',
    context: voiceContext,
    runTool: runVoiceTool,
    onPhase: phase => setVoiceStatus(phase, line(phaseLines[phase])),
    onGreeted: () => {
      ui.mute.hidden = false;
      say(ui.mute, line('mute'));
      ui.mute.setAttribute('aria-pressed', 'false');
      ui.typeToggle.disabled = false;
    },
    onCaption: transcript => {
      ui.lastQuestion.textContent = transcript;
      ui.lastQuestion.hidden = ui.captions.getAttribute('aria-pressed') !== 'true';
    },
    onCanSend: allowed => {
      ui.sendAnswer.disabled = !allowed;
    },
    onRemoteStream: stream => {
      ui.audio.srcObject = stream;
    },
    onEnd: reason => {
      if (connection === call) endInterview(endLine(reason));
    },
  });
  connection = call;
  renderCash();
  ui.lastQuestion.hidden = true;
  ui.lastQuestion.textContent = '';
}

ui.start.addEventListener('click', () => {
  void (voiceOpen ? startInterview() : startGuide());
});
ui.stop.addEventListener('click', () => endInterview(line('ended')));
ui.mute.addEventListener('click', () => {
  if (!connection?.setMuted(!connection.muted)) return;
  say(ui.mute, line(connection.muted ? 'unmute' : 'mute'));
  ui.mute.setAttribute('aria-pressed', String(connection.muted));
});
ui.captions.addEventListener('click', () => {
  const enabled = ui.captions.getAttribute('aria-pressed') !== 'true';
  ui.captions.setAttribute('aria-pressed', String(enabled));
  if (!guiding) ui.lastQuestion.hidden = !enabled || !ui.lastQuestion.textContent;
  ui.optionsPanel.close();
});
ui.typeToggle.addEventListener('click', () => {
  const opening = ui.typedAnswer.hidden;
  ui.typedAnswer.hidden = !opening;
  ui.typeToggle.setAttribute('aria-pressed', String(opening));
  ui.optionsPanel.close();
  if (opening) ui.answer.focus();
});
ui.guide.addEventListener('click', () => void startGuide());

function guideProblem(text: string) {
  ui.guideError.textContent = text;
  ui.guideError.hidden = false;
}
ui.guidedAnswer.addEventListener('submit', async event => {
  event.preventDefault();
  const asking = guide;
  if (!guiding || !asking) return;
  const { asked } = asking;
  const value = asking.control.read();
  if (value === undefined) return guideProblem(t('chooseOrSkip'));
  const button = ui.guidedAnswer.querySelector<HTMLButtonElement>('button:not([type="button"])');
  let label: string;
  let where: 'profile' | 'device';
  if (button) button.disabled = true;
  try {
    if (asked.id === 'place') {
      // A typed town is chosen only when it is exactly a town of the pilot; pressing the button confirms it.
      const outcome = await interview.savePlace(String(value), true);
      if (!outcome.saved) {
        const names = (outcome.similar ?? []).map(town => town.name);
        return guideProblem(
          outcome.reason === 'unavailable'
            ? t('placeUnavailable')
            : names.length
              ? t('placeNoMatch', { names: createFormat(locale).list(names) })
              : t('placeNoMatchNone'),
        );
      }
      [label, where] = [outcome.place.name, outcome.stored];
    } else if (asked.id === 'householdSize') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 30)
        return guideProblem(t('peopleBetween'));
      [label, where] = [t('review.householdSize'), (await interview.answer('householdSize', value)).stored];
    } else {
      const childCount = asked.answer.type === 'per_child' ? asked.answer.children.length : undefined;
      const problem =
        typeof value === 'number' && Number.isNaN(value)
          ? t('notANumber')
          : validateAnswer(
              asked.id,
              value,
              { today: today(), ...(childCount === undefined ? {} : { childCount }) },
              locale,
            );
      if (problem) return guideProblem(problem);
      const id = asked.id;
      [label, where] = [questionById(id, locale).label, (await interview.answer(id, value)).stored];
    }
  } finally {
    if (button) button.disabled = false;
  }
  say(ui.saveStatus, line(where === 'profile' ? 'answerSavedProfile' : 'factSaved', { label }));
  if (asking.only) endInterview(line(where === 'profile' ? 'answerSavedProfile' : 'factSaved', { label }));
  else await showGuideQuestion();
});
ui.skip.addEventListener('click', () => {
  if (!guiding || !guide) return;
  if (guide.only) return endInterview(idleLine());
  // A skipped question stays unanswered: it is not recorded as "I don't know".
  interview.skip(guide.asked.id);
  ui.guideError.hidden = true;
  void showGuideQuestion();
});
ui.saveProfile.addEventListener('click', async () => {
  // Only shown when an answer given here did not reach the profile: before signing in, or when a save failed.
  ui.saveProfile.disabled = true;
  const outcome = await interview.flush();
  ui.saveProfile.disabled = false;
  renderFacts(outcome.saved ? line('savedToProfile') : line(`save.${outcome.reason}`));
});
ui.typedAnswer.addEventListener('submit', event => {
  event.preventDefault();
  const text = ui.answer.value.trim();
  if (connection?.sayTyped(text)) ui.answer.value = '';
});
ui.clear.addEventListener('click', () => {
  if (!window.confirm(t('confirmClear'))) return;
  importAttempt++;
  state = emptyState();
  interview.reset(state.journey);
  planOutcome = null;
  endInterview(idleLine());
  ui.lastQuestion.hidden = true;
  ui.lastQuestion.textContent = '';
  ui.currency.value = state.currency;
  say(ui.importStatus, line('csvPrompt'));
  save(line('cleared'));
  void renderPlan();
});
ui.currency.value = state.currency;
renderCash();
renderFacts();
renderTrail();
// Where the answers go depends on where the page runs; until the server answers, they stay here. Answers
// given before signing in are saved as soon as the person is back, signed in.
void interview.start().then(({ saved }) => {
  renderFacts(saved ? line(saved.saved ? 'savedToProfile' : `save.${saved.reason}`) : undefined);
  void renderPlan();
});
if (state.cash) say(ui.voiceStatus, line('readyResume'));

/** The template, the answers and every line on screen, in the language now chosen. */
function applyLocale(next: Locale) {
  const changed = next !== locale;
  locale = next;
  t = translator(catalog, locale);
  document.documentElement.lang = locale;
  document.title = t('title');
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]'))
    node.textContent = t(node.dataset.i18n as Key);
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]'))
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel as Key));
  // These two start hidden with fixed markup; their words are set here.
  ui.saveProfile.textContent = t('saveToProfile');
  ui.profileSignin.textContent = t('signInToSave');
  ui.languages.setAttribute('aria-label', translator(common, locale)('language'));
  for (const option of ui.languages.querySelectorAll('button'))
    option.setAttribute('aria-pressed', String(option.dataset.lang === locale));
  renderCash();
  renderFacts(profileNotice);
  drawPlan();
  renderTrail();
  for (const [node, text] of lines) node.textContent = text();
  if (!changed) return;
  // The planner words its sentences in the language asked for: the plan is read again.
  if (planOutcome) void renderPlan();
  // A guided question on screen is asked again in the new language.
  if (guiding && guide) void showGuideQuestion(guide.only ? interview.question(guide.asked.id) : undefined);
}
ui.languages.addEventListener('click', event => {
  const chosen = toLocale((event.target as HTMLElement).closest<HTMLButtonElement>('button[data-lang]')?.dataset.lang);
  if (!chosen || chosen === locale) return;
  rememberLocale(chosen);
  applyLocale(chosen);
  // A live voice conversation is told, so the next spoken turn is in the new language, and its settings
  // follow: the labels it names and the language its transcription expects.
  void connection?.changeLanguage(chosen);
});
applyLocale(locale);
