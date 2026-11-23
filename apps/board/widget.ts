import { App } from '@modelcontextprotocol/ext-apps';
import { browserLocale, rememberLocale } from '../../packages/i18n/browser.ts';
import { common } from '../../packages/i18n/common.ts';
import { createFormat } from '../../packages/i18n/format.ts';
import { type Locale, toLocale } from '../../packages/i18n/locales.ts';
import { type MessageValues, translator } from '../../packages/i18n/messages.ts';
import { type IconName, icon } from '../../packages/ui/icons.ts';
import type { DemoView } from './demo.ts';
import { drawRouteTimeline, drawWorld, nextSegment, stopNames, stops } from './map.ts';
import { board } from './messages.ts';
import { type HabitId, type PersonaId, sceneText } from './scenes.ts';
import { missingInformation, statusLabel } from './screen.ts';

const app = window.parent === window ? null : new App({ name: 'ReloCat demo', version: '0.1.0' });
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const safe = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

type BoardKey = keyof typeof board.en;
/**
 * The language of the board. The scenes arrive from the server as ids and figures (with English
 * text for the model); every word shown here is looked up in the catalogs in this language.
 */
let locale: Locale = browserLocale();
/** Set once the person picks a language here, so a later host context does not undo the choice. */
let localeChosen = false;
let words = translator(board, locale);
let shared = translator(common, locale);
let format = createFormat(locale);
let scene = sceneText(locale);
/** A board message, escaped for the HTML the views are written in. */
const t = (key: BoardKey, values?: MessageValues) => safe(words(key, values));
/** Whole euros of the script as money in the board's language. */
const euros = (amount: number) => safe(format.euros(Math.round(amount * 100)));
/** The English name the server gives the saver's own row of the leaderboard. */
const ownRow = sceneText('en').you;

function displayMonths(months: number | null) {
  if (months === null) return t('budgetGap');
  if (months === 0) return t('goalReached');
  if (months < 24) return safe(shared('months', { count: months }));
  const years = shared('years', { count: Math.floor(months / 12) });
  const remainder = months % 12;
  return safe(remainder ? shared('yearsAndMonths', { years, months: shared('months', { count: remainder }) }) : years);
}
type BoardView = DemoView & {
  boardUrl?: string | null;
  connection?: {
    mode: string;
    userId?: string;
    ledgerRevision?: number;
    runtime?: { enabled: boolean };
    summary?: { netCashflowCents: number; from: string; to: string };
  };
  townScreening?: {
    ready: boolean;
    missingFields: string[];
    unsupportedFields: string[];
    propertyChecks: { field: string; required: number }[];
    result: {
      towns: {
        municipality: { name: string };
        matchReasons: string[];
        incentives: { title: string; sourceUrl: string; eligibilityStatus: string; callStatus: string }[];
      }[];
    } | null;
  };
};
let active: BoardView | undefined;
let busy = false;
let fullscreen = false;
let refreshing = false;
/** Which connection line is showing, so a language change can say it again. */
let connectionState: 'starting' | 'synced' | 'paused' = 'starting';
function showConnection(state: typeof connectionState) {
  connectionState = state;
  byId('connection').textContent = words(state);
}

/** Button looks of the shared theme, by the short names the views use. */
const buttonClass: Record<string, string> = {
  primary: 'rc-btn rc-btn--primary',
  gold: 'rc-btn rc-btn--gold',
  link: 'rc-btn rc-btn--quiet',
  '': 'rc-btn',
};
const questIcons: Record<string, IconName> = { coffee: 'coffee', takeout: 'pot', picnic: 'basket' };
const badge = (text: string, name: IconName = 'star', tone = 'gold') =>
  `<span class="rc-pill rc-pill--${tone}">${icon(name)}${text}</span>`;

function button(label: string, action: string, key = '', style = 'primary') {
  return `<button type="button" class="${buttonClass[style] ?? buttonClass['']}" data-action="${action}" data-key="${key}">${label}</button>`;
}

function hero(label: string, heading: string, text: string) {
  return `<section class="hero panel"><span class="label">${label}</span><h1>${heading}</h1><p>${text}</p></section>`;
}

function meter(label: string, percent: number, detail: string) {
  return `<div class="panel"><div class="meter-row"><span>${label}</span><strong>${percent}%</strong></div>
    <div class="meter" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
      <div class="fill" style="width:${percent}%"></div></div><p class="small">${detail}</p></div>`;
}

function timeline(plan: { upfrontMonths: number | null; termMonths: number; debtFreeMonths: number | null }) {
  const upfront = plan.upfrontMonths === 0 ? t('upfrontMet') : displayMonths(plan.upfrontMonths);
  return `<ol class="timeline" aria-label="${t('timelineLabel')}">
    <li><span class="label">${t('timelineSave')}</span><strong>${upfront}</strong><span>${t('upfrontMilestone')}</span></li>
    <li><span class="label">${t('timelineBuy')}</span><strong>${safe(shared('years', { count: plan.termMonths / 12 }))}</strong><span>${t('sampleTerm')}</span></li>
    <li><span class="label">${t('timelineFinish')}</span><strong>${plan.debtFreeMonths === null ? t('noEstimate') : displayMonths(plan.debtFreeMonths)}</strong><span>${t('ownOutright')}</span></li>
  </ol>`;
}

function onboarding(view: Extract<DemoView, { answers: unknown }>) {
  const { group, answers } = view;
  const allExtras = view.extraGroups.flatMap(section => section.questions);
  const monetary = new Set([
    'income',
    'spending',
    'savings',
    ...allExtras.filter(field => field.kind === 'number' && field.money).map(field => field.id),
  ]);
  const facts = Object.entries(answers)
    .map(
      ([id, value]) =>
        `<div><dt>${safe(scene.factLabel(id))}</dt><dd>${typeof value === 'number' && monetary.has(id) ? euros(value) : safe(value)}</dd></div>`,
    )
    .join('');
  const inputs = (fields: typeof allExtras, prefill: boolean) =>
    fields
      .map(
        field =>
          `<label class="rc-field">${safe(scene.fieldLabel(field.id))}<input name="${field.id}" type="${field.kind}"
      ${field.kind === 'number' ? `min="${field.min}" max="${field.max}" step="1"` : 'maxlength="80"'}
      placeholder="${safe(scene.example(field.id) ?? field.example)}" value="${prefill ? safe(answers[field.id] ?? '') : ''}"></label>`,
      )
      .join('');
  return (
    hero(t('intakeLabel'), t('intakeHeading'), t('intakeText')) +
    `<section class="panel"><span class="label">${t('basicsSaved', { answered: view.answeredBasic, total: view.totalQuestions })}</span>
      ${
        group
          ? `<h2>${safe(scene.groupTitle(group.id))}</h2>
        <form class="intake"><div class="fields">${inputs(group.questions, false)}</div><div class="actions"><button class="rc-btn rc-btn--primary">${t('saveAnswers')}</button>
        ${button(t('useExample'), 'example', '', 'link')}</div></form>`
          : `<h2>${t('basicsComplete')}</h2><p>${t('refineBelow')}</p>`
      }
      ${facts ? `<dl class="facts">${facts}</dl>` : ''}</section>
    <details class="panel preferences" id="preferences">
      <summary>${t('refineProfile')}</summary>
      <form class="intake">${view.extraGroups
        .map(
          section =>
            `<fieldset><legend>${safe(scene.groupTitle(section.id))}</legend><div class="fields">${inputs(section.questions, true)}</div></fieldset>`,
        )
        .join('')}
        <div class="actions"><button class="rc-btn rc-btn--primary">${t('savePreferences')}</button></div>
      </form>
    </details>
    <section class="panel"><h2>${t('sampleBank')}</h2>
      ${
        view.bank
          ? `<p><strong>${t('snapshotLoaded')}</strong> ${safe(scene.bankInsight)}</p><p class="small">${t('discretionary', { amount: format.euros(view.bank.discretionary * 100) })}</p>`
          : `<p>${t('useSampleFeed')}</p>
      <div class="actions">${button(t('connectSampleBank'), 'sample_bank')}</div>`
      }</section>
    ${
      view.plan
        ? meter(
            t('upfrontMilestone'),
            Math.min(100, Math.floor((100 * view.plan.saved) / view.plan.target)),
            t('planProgress', {
              saved: format.euros(view.plan.saved * 100),
              target: format.euros(view.plan.target * 100),
              monthly: words('perMonth', { amount: format.euros(view.plan.monthly * 100) }),
            }),
          ) +
          timeline(view.plan) +
          `<p class="small">${safe(view.financeNotes.map(scene.financeNote).join(' '))} ${t('illustrative')}</p>`
        : ''
    }`
  );
}

function world(checkpoint: number) {
  const names = stopNames(locale);
  return `<div class="world" role="img" aria-label="${t('dotAt', { stop: names[checkpoint] })}">
    <canvas id="map" width="480" height="260" aria-hidden="true"></canvas>
    ${stops.map(([x, y], i) => `<span class="stop" aria-hidden="true" style="left:${x / 4.8}%;top:${(y + 9) / 2.6}%">${safe(names[i])}</span>`).join('')}
    <div class="dot" id="dot" aria-hidden="true" style="left:${stops[checkpoint][0] / 4.8}%;top:${stops[checkpoint][1] / 2.6}%"></div>
  </div>`;
}

function progress(view: Extract<DemoView, { progress: unknown }>) {
  const p = view.progress;
  const completed = p.quests.filter(quest => quest.status === 'complete').map(quest => quest.id as HabitId);
  const coach = scene.coach(completed.length, p.estimate);
  const badges = scene.badges(completed);
  return (
    `<section class="hero panel coach"><div><span class="label">${t('checkinLabel')}</span>
    <h1>${safe(coach.headline)}</h1><p>${safe(coach.milestone)}</p></div>
    <div class="level-mark" aria-label="${t('levelLabel', { level: p.level })}"><span>${t('level')}</span><strong>${p.level}</strong></div></section>
    <div class="momentum"><div><strong>${safe(shared('months', { count: p.streak }))}</strong><span>${t('streak')}</span></div>
      <div><strong>${t('badgeCount', { count: badges.length })}</strong><span>${t('achievementsEarned')}</span></div>
      <div><strong>#${p.rank}</strong><span>${t('trailLeaderboard')}</span></div></div>
    <section class="panel habits" aria-label="${t('habitQuests')}">
      <div class="habits-header"><div><span class="label">${t('buildHabits')}</span><h2>${t('weeklyQuests')}</h2></div>
        <span class="rc-pill rc-pill--violet">${p.estimate ? t('ifKeptUp', { amount: format.euros(p.estimate * 100) }) : t('chooseSwap')}</span></div>
      ${p.quests
        .map(quest => {
          const text = scene.habit(quest.id as HabitId);
          return `<article class="habit ${quest.status === 'complete' ? 'habit-done' : ''}">
        <div class="habit-icon">${icon(quest.status === 'complete' ? 'tick' : (questIcons[quest.id] ?? 'check'))}</div>
        <div><span class="label">${quest.status === 'complete' ? t('questComplete') : quest.status === 'adopted' ? t('questAdopted') : t('questXp', { xp: quest.xp })}</span>
          <h3>${safe(text.title)}</h3><p>${safe(text.action)}</p>
          <div class="habit-spend"><span class="rc-pill">${t('spendNow', { amount: format.euros(quest.before * 100) })}</span><span class="rc-pill">${t('spendSwap', { amount: format.euros(quest.after * 100) })}</span>
            <strong class="rc-pill rc-pill--ok">${t('saveMonthly', { amount: format.euros(quest.saving * 100) })}</strong></div>
          <div class="actions">${
            quest.status === 'complete'
              ? badge(t('badgeXp', { badge: text.badge, xp: quest.xp }), 'tick')
              : quest.status === 'adopted'
                ? button(t('triedIt'), 'complete_habit', quest.id, 'gold')
                : button(t('tryHabit'), 'adopt_habit', quest.id, '')
          }</div>
          ${quest.id === 'picnic' ? `<details><summary>${t('showInvite')}</summary><p>${t('invite')}</p></details>` : ''}
        </div></article>`;
        })
        .join('')}
      <p class="small">${t('habitsNote')}</p>
    </section>` +
    world(p.checkpoint) +
    `<div class="split">${meter(t('upfrontMilestone'), p.percent, `${euros(p.saved)} / ${euros(p.target)}`)}
    ${meter(t('questXpMeter'), Math.floor((p.xp * 100) / p.xpGoal), `${p.xp} / ${p.xpGoal} XP`)}</div>
    ${timeline(p)}
    <div class="split"><section class="panel"><h2>${t('achievements')}</h2>
      <div class="badges">${badges.map(name => badge(safe(name))).join('')}</div>
      <p class="small">${t('savingsPace', { amount: format.euros(p.monthly * 100) })}</p></section>
    <section class="panel"><h2>${t('sampleLeaderboard')}</h2><ol class="ranks">
      ${p.leaderboard.map(person => `<li class="${person.name === ownRow ? 'current' : ''}"><div class="rank"><span>${safe(person.name === ownRow ? scene.you : person.name)}</span><strong>${t('xp', { xp: person.xp })}</strong></div></li>`).join('')}
    </ol><p class="small">${t('rankNote')}</p></section></div>`
  );
}

function shortcuts(view: Extract<DemoView, { inbox: unknown }>) {
  if (view.unread)
    return `${hero(t('alertLabel'), t('unreadRoutes', { count: view.unread }), t('fasterWay'))}<div class="actions">${button(t('compareRoutes'), 'read_inbox')}</div>`;

  const current = view.inbox.find(item => item.id === view.chosen);
  const preview = view.inbox.find(item => item.id === view.previewed);
  const highlighted = preview ?? current;
  const told = highlighted ? scene.opportunity(highlighted.id) : null;
  const chip = (route: (typeof view.inbox)[number]) =>
    `<button type="button" class="route-chip" data-action="preview_shortcut" data-key="${route.id}"
     aria-pressed="${highlighted?.id === route.id}"><strong>${t(current?.id === route.id ? 'routeActiveChip' : 'route', { letter: route.letter })}</strong>
     <span>${t('monthsSooner', { count: route.fasterBy })}</span><small>${safe(scene.opportunity(route.id).title)}</small></button>`;
  const routes = view.inbox.slice(0, 3);
  const secondary = view.inbox.slice(3);
  return (
    hero(t('comparisonLabel'), t('comparisonHeading'), t('comparisonText')) +
    `<div class="route-options" aria-label="${t('routesLabel')}">
      <button type="button" class="route-chip" data-action="preview_shortcut" aria-pressed="${!preview}">
        <strong>${t('currentRoute')}</strong><span>${current ? t('route', { letter: current.letter }) : t('monthsUpfront', { count: view.baseline.upfrontMonths ?? 0 })}</span>
        <small>${current ? safe(scene.opportunity(current.id).title) : t('stayOriginal')}</small></button>
      ${routes.map(chip).join('')}
    </div>
<section class="panel journey-chart" aria-label="${t('routeTimeline')}">
      <div class="journey-head">
        <div><span class="label">${t('journeyOf')}</span><h2>${t('journeyHeading')}</h2></div>
        <strong class="rc-pill rc-pill--violet">${highlighted ? t('routeSooner', { letter: highlighted.letter, count: highlighted.fasterBy }) : t('originalRoute')}</strong>
      </div>
      <canvas id="route-map" role="img" aria-label="${
        highlighted
          ? t('chartRoute', { years: view.pastMonths / 12, letter: highlighted.letter, count: highlighted.fasterBy })
          : t('chartOriginal', { years: view.pastMonths / 12 })
      }"></canvas>
      <div class="journey-legend"><span class="past">${t('legendPast')}</span><span class="selected-line">${t('legendSelected')}</span><span class="alternative">${t('legendOther')}</span></div>
    </section>
    <section class="panel route-detail" aria-label="${t('routeDetails')}">
      <span class="label">${preview && preview.id !== current?.id ? t('previewRoute', { letter: preview.letter }) : t('activeRoute')}</span>
      <h2>${told ? safe(told.title) : t('stayCurrent')}</h2>
      ${
        told
          ? `<p>${safe(told.detail)}</p><p class="small"><strong>${t('check')}</strong> ${safe(told.verify)}</p>`
          : `<p>${t('keepSaving', { monthly: format.euros(view.monthly * 100), goal: format.euros(view.target * 100) })}</p>`
      }
      ${timeline(highlighted ?? view.baseline)}
      ${
        preview && preview.id !== current?.id
          ? `<div class="actions">
        ${button(t('switchRoute', { letter: preview.letter }), 'choose_shortcut', preview.id, 'gold')}
        ${button(t('keepRoute'), 'keep_route', '', '')}</div>`
          : current
            ? badge(t('routeActive', { letter: current.letter, count: current.fasterBy }), 'tick', 'ok')
            : ''
      }
    </section>
    <details class="panel" ${secondary.some(route => route.id === highlighted?.id) ? 'open' : ''}>
      <summary>${t('moreRoutes', { count: secondary.length })}</summary>
      <div class="route-options secondary-routes">${secondary.map(chip).join('')}</div>
    </details>`
  );
}

function celebrate() {
  const icons = (['key', 'home', 'sparkle', 'star', 'trophy', 'sparkle', 'star'] as const).map(name => icon(name));
  return `<div class="celebration" aria-hidden="true">${Array.from({ length: 18 }, (_, index) => {
    const angle = (index / 18) * Math.PI * 2;
    return `<span style="--dx:${Math.round(Math.cos(angle) * 340)}px;--dy:${Math.round(Math.sin(angle) * 205)}px;--delay:${(index % 6) * 32}ms">${icons[index % icons.length]}</span>`;
  }).join('')}</div>`;
}

function payoff(view: Extract<DemoView, { payoff: unknown }>) {
  const p = view.payoff;
  if (view.credits) {
    const credits = scene.credits;
    return `<section class="credits panel" aria-label="${t('creditsLabel')}">
      <div class="victory">
        ${celebrate()}
        <div class="victory-medal">${icon('key')}</div>
        <span class="label">${t('finalAchievement')}</span>
        <h1>${safe(credits.title)}</h1><p>${t('ownsOutright')}</p>
        <strong class="rc-pill rc-pill--gold victory-banner">${t('mortgageFree')}</strong>
      </div>
      <div class="credit-stats">${credits.stats.map(stat => `<div><strong>${safe(stat.value)}</strong><span>${safe(stat.label)}</span></div>`).join('')}</div>
      <ol class="credit-milestones">${credits.milestones
        .map(milestone => `<li><h2>${safe(milestone.title)}</h2><p>${safe(milestone.detail)}</p></li>`)
        .join('')}</ol>
      <h2>${t('achievementsUnlocked')}</h2>
      <div class="badges">${credits.achievements.map(name => badge(safe(name))).join('')}</div>
      <div class="actions">${button(t('backToFinish'), 'hide_credits', '', 'gold')}</div>
    </section>`;
  }
  return `<div class="payoff">${hero(
    t('completeLabel'),
    p.paid ? t('ownsHeading') : t('replayHeading'),
    p.paid ? t('finishText') : t('oneInstallment', { amount: format.euros(p.remaining * 100) }),
  )}</div>
    ${world(p.paid ? 5 : 4)}
    ${meter(
      t('mortgageRepaid'),
      p.percent,
      t('payoffDetail', {
        repaid: format.euros((p.original - p.remaining) * 100),
        original: format.euros(p.original * 100),
        remaining: format.euros(p.remaining * 100),
        otherDebt: format.euros(p.otherDebt * 100),
      }),
    )}
    <div class="actions">${
      p.paid
        ? button(t('rollCredits'), 'show_credits', '', 'gold') + button(t('replayLast'), 'replay_payment', '', 'link')
        : button(t('completePayment'), 'final_payment', '', 'gold')
    }</div>`;
}

function townScreen(screen: NonNullable<BoardView['townScreening']>) {
  const towns = screen.result?.towns.map(
    town =>
      `<article><h3>${safe(town.municipality.name)}</h3><p>${town.matchReasons.map(safe).join(' · ')}</p>${town.incentives
        .map(
          policy =>
            `<p><a href="${safe(policy.sourceUrl)}" target="_blank" rel="noopener noreferrer">${safe(policy.title)}</a> · ${safe(statusLabel(policy.callStatus, locale))} · ${safe(statusLabel(policy.eligibilityStatus, locale))}</p>`,
        )
        .join('')}</article>`,
  );
  return `<section class="panel"><h2>${t('screenHeading')}</h2><p>${t('screenNote')}</p>${screen.propertyChecks
    .map(check => `<p class="small">${t('propertyCheck', { count: Number(check.required) })}</p>`)
    .join('')}${towns ? towns.join('') : `<p>${safe(missingInformation(screen.missingFields, locale))}</p>`}</section>`;
}

function checkpoint(view: DemoView) {
  if ('progress' in view) return view.progress.checkpoint;
  if ('payoff' in view && !view.credits) return view.payoff.paid ? 5 : 4;
  return undefined;
}

function render(view: BoardView, force = false) {
  if (
    !force &&
    active?.runId === view.runId &&
    active.revision >= view.revision &&
    active.connection?.ledgerRevision === view.connection?.ledgerRevision
  )
    return;
  const preferencesOpen = byId<HTMLDetailsElement>('preferences')?.open;
  const enteringCredits = 'payoff' in view && !!view.credits && (!active || !('payoff' in active) || !active.credits);
  if (!app && (enteringCredits || (active && active.persona !== view.persona))) window.scrollTo(0, 0);
  const previous = active?.persona === view.persona ? checkpoint(active) : undefined;
  active = view;
  byId('personas').innerHTML = view.choices
    .map(
      person => `<button type="button" data-action="switch_persona"
    data-key="${person.id}" aria-pressed="${view.persona === person.id}"><strong>${person.name}</strong>${safe(scene.personaLabel(person.id as PersonaId))}</button>`,
    )
    .join('');
  byId('view').innerHTML =
    'answers' in view
      ? onboarding(view)
      : 'progress' in view
        ? progress(view)
        : 'inbox' in view
          ? shortcuts(view)
          : payoff(view);
  if (view.connection?.mode === 'public_demo') {
    const connection = view.connection;
    const screen = view.townScreening;
    // Read-only: the board shows the fictional persona's feed and cannot start, stop or write anything.
    byId('view').insertAdjacentHTML(
      'afterbegin',
      `<section class="panel"><span class="label">${t('demoProfile', { userId: String(connection.userId) })}</span><h2>${t('demoFeed')}</h2><p>${t('ledgerNote', { revision: connection.ledgerRevision ?? 0 })}</p><div class="actions">${button(t('refreshBank'), 'refresh_data', '', 'link')}</div>${connection.summary ? `<p class="small">${t('netCashFlow', { amount: format.euros(connection.summary.netCashflowCents), from: format.date(connection.summary.from), to: format.date(connection.summary.to) })}</p>` : ''}</section>`,
    );
    if (screen) byId('view').insertAdjacentHTML('beforeend', townScreen(screen));
  }
  const current = checkpoint(view);
  if (current !== undefined) {
    drawWorld(byId<HTMLCanvasElement>('map'), current);
    if (previous !== undefined && current === previous + 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const frames = nextSegment(previous, false).map(([x, y]) => ({ left: `${x / 4.8}%`, top: `${y / 2.6}%` }));
      byId('dot').animate(frames, { duration: 780, easing: 'ease-in-out' });
    }
  }
  renderRouteTimeline(view);
  if (preferencesOpen && 'answers' in view) byId<HTMLDetailsElement>('preferences').open = true;
  byId('controls').hidden = false;
  byId('fullscreen').hidden = !app;
  showConnection('synced');
  const link = byId<HTMLAnchorElement>('board-link');
  link.hidden = !app || !view.boardUrl;
  if (view.boardUrl) link.href = view.boardUrl;
  if (!app) {
    const url = new URL(location.href);
    url.searchParams.delete('persona');
    if (view.sharedBoard) url.searchParams.delete('run');
    else url.searchParams.set('run', view.runId);
    history.replaceState(null, '', url);
  }
}

function renderRouteTimeline(view: DemoView) {
  if (!('inbox' in view) || !view.inbox.length) return;
  const highlighted = view.inbox.find(route => route.id === (view.previewed ?? view.chosen));
  drawRouteTimeline(
    byId<HTMLCanvasElement>('route-map'),
    [{ letter: 'original', ...view.baseline }, ...view.inbox],
    highlighted?.letter ?? 'original',
    view.pastMonths,
    locale,
  );
}
window.addEventListener('resize', () => {
  if (active) renderRouteTimeline(active);
});

async function call(name: string, args: Record<string, unknown>) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(control => {
    control.disabled = true;
  });
  byId('status').textContent = '';
  try {
    const result = app
      ? await app.callServerTool({ name, arguments: args })
      : await fetch('/preview/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, args }),
        }).then(response => response.json());
    if (result.isError || !result.structuredContent) {
      // The server explains a refusal in English, for the model. In another language the board says
      // only that it failed, in that language, instead of a sentence the person may not read.
      const explained = result.content?.find((item: { type: string }) => item.type === 'text')?.text;
      throw new Error(
        locale === 'en' && explained
          ? explained
          : words(name === 'open_demo' || locale === 'en' ? 'loadFailed' : 'actionFailed'),
      );
    }
    const view = result.structuredContent as BoardView;
    render(view);
    if (app) {
      void app
        .updateModelContext({
          content: [
            {
              type: 'text',
              text: `ReloCat is showing ${view.person.name} (${view.persona}) in demo run ${view.runId}. ${view.message}`,
            },
          ],
        })
        .catch(() => {});
    }
  } catch (error) {
    byId('status').textContent = error instanceof Error ? error.message : words('actionFailed');
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach(control => {
      control.disabled = false;
    });
  }
}

function parseFormAnswers(raw: Record<string, unknown>) {
  const numeric = new Set([
    'bedrooms',
    'household',
    'income',
    'spending',
    'savings',
    'budget',
    'floorArea',
    'maxCommuteMinutes',
    'upfrontTarget',
    'emergencyReserve',
    'homeSize',
    'dependants',
    'commuteTime',
    'debtPayments',
    'reserve',
    'cashTarget',
  ]);
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      active?.connection?.mode !== 'connected_synthetic'
        ? value
        : numeric.has(key)
          ? Number(value)
          : key === 'allowComarcaEstimate'
            ? String(value).trim().toLowerCase() === 'true'
              ? true
              : String(value).trim().toLowerCase() === 'false'
                ? false
                : value
            : key === 'schoolStages'
              ? String(value)
                  .split(',')
                  .map(stage => stage.trim())
                  .filter(Boolean)
              : value,
    ]),
  );
}

document.addEventListener('click', event => {
  const control = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!active || !control) return;
  const { action, key } = control.dataset;
  if (!action) return;
  const args: Record<string, unknown> = { runId: active.runId, action };
  if (action === 'switch_persona') args.persona = key;
  if (action === 'adopt_habit' || action === 'complete_habit') args.habit = key;
  if ((action === 'choose_shortcut' || action === 'preview_shortcut') && key) args.opportunity = key;
  if (action === 'example' && 'group' in active && active.group) {
    Object.assign(args, {
      action: 'answer_batch',
      answers: parseFormAnswers(
        Object.fromEntries(
          active.group.questions.map(question => [question.id, scene.example(question.id) ?? question.example]),
        ),
      ),
    });
  }
  void call('update_demo', args);
});

document.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (!form.classList.contains('intake') || !active || !('answers' in active)) return;
  event.preventDefault();
  const answers = parseFormAnswers(
    Object.fromEntries(
      [...new FormData(form)].filter(([key, value]) => key === 'schoolStages' || String(value).trim()),
    ),
  );
  if (!Object.keys(answers).length) {
    byId('status').textContent = words('enterAnswer');
    return;
  }
  void call('update_demo', { runId: active.runId, action: 'answer_batch', answers });
});

async function refresh() {
  if (!active || busy || refreshing) return;
  const runId = active.runId;
  refreshing = true;
  try {
    let view: BoardView;
    if (app) {
      // Inside a chat host the frame is on another origin, so the board is re-read through the host.
      const result = await app.callServerTool({ name: 'open_demo', arguments: { runId } });
      if (result.isError || !result.structuredContent) throw new Error('Board unavailable');
      view = result.structuredContent as BoardView;
    } else {
      const url = new URL('/preview/state', location.origin);
      if (!active.sharedBoard) url.searchParams.set('run', runId);
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error('Board unavailable');
      view = (await response.json()) as BoardView;
    }
    if (!busy && active.runId === runId) render(view);
    showConnection('synced');
  } catch {
    showConnection('paused');
  } finally {
    refreshing = false;
  }
}
// A page polls its own origin every second; a hosted frame goes through the host, so it polls less often.
setInterval(() => void refresh(), app ? 4000 : 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

byId('fullscreen').onclick = async () => {
  if (!app) return;
  try {
    const result = await app.requestDisplayMode({ mode: fullscreen ? 'inline' : 'fullscreen' });
    fullscreen = result.mode === 'fullscreen';
    byId('fullscreen').textContent = words(fullscreen ? 'collapse' : 'expand');
  } catch {
    byId('status').textContent = words('inlineOnly');
  }
};

/** Everything the template itself says, and the views, in the language now chosen. */
function applyLocale(next: Locale) {
  locale = next;
  words = translator(board, locale);
  shared = translator(common, locale);
  format = createFormat(locale);
  scene = sceneText(locale);
  document.documentElement.lang = locale;
  document.title = words('title');
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]'))
    node.textContent = words(node.dataset.i18n as BoardKey);
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]'))
    node.setAttribute('aria-label', words(node.dataset.i18nAriaLabel as BoardKey));
  byId('languages').setAttribute('aria-label', shared('language'));
  for (const option of document.querySelectorAll<HTMLButtonElement>('#languages button'))
    option.setAttribute('aria-pressed', String(option.dataset.lang === locale));
  byId('fullscreen').textContent = words(fullscreen ? 'collapse' : 'expand');
  showConnection(connectionState);
  byId('status').textContent = '';
  if (active) render(active, true);
}
byId('languages').addEventListener('click', event => {
  const chosen = toLocale((event.target as HTMLElement).closest<HTMLButtonElement>('button[data-lang]')?.dataset.lang);
  if (!chosen) return;
  localeChosen = true;
  rememberLocale(chosen);
  applyLocale(chosen);
});
applyLocale(locale);

if (app) {
  app.ontoolresult = result => {
    if (result.structuredContent?.runId) render(result.structuredContent as BoardView);
  };
  // The chat host states its language once connected, and again when the person changes it there.
  const followHost = (hostLocale?: string | null) => {
    if (localeChosen) return;
    const next = browserLocale(hostLocale);
    if (next !== locale) applyLocale(next);
  };
  app.onhostcontextchanged = context => followHost(context.locale);
  void app
    .connect()
    .then(() => followHost(app.getHostContext()?.locale))
    .catch(() => {
      byId('status').textContent = words('hostFailed');
    });
} else {
  const params = new URLSearchParams(location.search);
  const persona = params.get('persona');
  const runId = params.get('run');
  void call('open_demo', { ...(persona ? { persona } : {}), ...(runId ? { runId } : {}) }).then(() => {
    if (active || !runId) return;
    const url = new URL(location.href);
    url.searchParams.delete('run');
    history.replaceState(null, '', url);
    void call('open_demo', persona ? { persona } : {});
  });
}
