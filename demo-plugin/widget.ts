import { App } from '@modelcontextprotocol/ext-apps';
import type { DemoView } from './demo.ts';
import { drawRouteTimeline, drawWorld, nextSegment, stopNames, stops } from './map.ts';

const app = window.parent === window ? null : new App({ name: 'relo.cat demo', version: '0.1.0' });
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
byId('website-interview').hidden = app !== null;
const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const safe = (value: unknown) => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function displayMonths(months: number | null) {
  if (months === null) return 'Budget gap';
  if (months === 0) return 'Goal reached';
  if (months < 24) return `${months} ${months === 1 ? 'month' : 'months'}`;
  const remainder = months % 12;
  return `${Math.floor(months / 12)} years${remainder ? ` ${remainder} ${remainder === 1 ? 'month' : 'months'}` : ''}`;
}
type BoardView = DemoView & { boardUrl?: string | null; connection?: { mode: string; userId?: string; ledgerRevision?: number; runtime?: { enabled: boolean }; summary?: { netCashflowCents: number; from: string; to: string } }; townScreening?: { ready: boolean; missingFields: string[]; unsupportedFields: string[]; propertyChecks: { field: string; required: number }[]; result: { towns: { municipality: { name: string }; matchReasons: string[]; incentives: { title: string; sourceUrl: string; eligibilityStatus: string; callStatus: string }[] }[] } | null } };
let active: BoardView | undefined;
let busy = false;
let fullscreen = false;
let refreshing = false;

function button(label: string, action: string, key = '', style = 'primary') {
  return `<button type="button" class="${style}" data-action="${action}" data-key="${key}">${label}</button>`;
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
  const upfront = plan.upfrontMonths === 0 ? 'Upfront goal met' : displayMonths(plan.upfrontMonths);
  return `<ol class="timeline" aria-label="Timeline to debt-free ownership">
    <li><span class="label">Save</span><strong>${upfront}</strong><span>Upfront milestone</span></li>
    <li><span class="label">Buy &amp; repay</span><strong>${plan.termMonths / 12} years</strong><span>Sample mortgage term</span></li>
    <li><span class="label">Finish</span><strong>${plan.debtFreeMonths === null ? 'No estimate yet' : displayMonths(plan.debtFreeMonths)}</strong><span>Own outright · total from today</span></li>
  </ol>`;
}

function onboarding(view: Extract<DemoView, { answers: unknown }>) {
  const { group, answers } = view;
  const allExtras = view.extraGroups.flatMap(section => section.questions);
  const labels: Record<string, string> = {
    town: 'Target town', bedrooms: 'Bedrooms', household: 'Household size', employment: 'Employment',
    income: 'Monthly income', spending: 'Monthly spending (including debt)', savings: 'Saved', floorArea: 'Floor area m?', destinationCode: 'Commute municipality code', maxCommuteMinutes: 'Maximum commute minutes', schoolMode: 'School travel mode', allowComarcaEstimate: 'Allow comarca estimate', upfrontTarget: 'Upfront cash target', emergencyReserve: 'Emergency reserve',
    ...Object.fromEntries(allExtras.map(field => [field.id, field.label])),
  };
  const monetary = new Set(['income', 'spending', 'savings',
    ...allExtras.filter(field => field.kind === 'number' && field.money).map(field => field.id)]);
  const facts = Object.entries(answers).map(([id, value]) =>
    `<div><dt>${labels[id]}</dt><dd>${typeof value === 'number' && monetary.has(id) ? euro.format(value) : safe(value)}</dd></div>`).join('');
  const inputs = (fields: typeof allExtras, prefill: boolean) => fields.map(field =>
    `<label>${field.label}<input name="${field.id}" type="${field.kind}"
      ${field.kind === 'number' ? `min="${field.min}" max="${field.max}" step="1"` : 'maxlength="80"'}
      placeholder="${field.example}" value="${prefill ? safe(answers[field.id] ?? '') : ''}"></label>`).join('');
  return hero('01 · Intake', 'Let’s chart your route, Laia.', 'Tell us what works for your household. Start with the basics, then add the details that could change where you live.') +
    `<section class="panel"><span class="label">${view.answeredBasic} of ${view.totalQuestions} basics saved</span>
      ${group ? `<h2>${group.title}</h2>
        <form class="intake"><div class="fields">${inputs(group.questions, false)}</div><div class="actions"><button class="primary">Save answers</button>
        ${button('Use example answers', 'example', '', 'link')}</div></form>`
        : '<h2>Basics complete</h2><p>Refine the route below with your housing, school and travel preferences.</p>'}
      ${facts ? `<dl class="facts">${facts}</dl>` : ''}</section>
    <details class="panel preferences" id="preferences">
      <summary>Refine your household and housing profile</summary>
      <form class="intake">${view.extraGroups.map(section =>
        `<fieldset><legend>${section.title}</legend><div class="fields">${inputs(section.questions, true)}</div></fieldset>`).join('')}
        <div class="actions"><button class="primary">Save preferences</button></div>
      </form>
    </details>
    <section class="panel"><h2>Sample bank connection</h2>
      ${view.bank ? `<p><strong>Sample snapshot loaded.</strong> ${view.bank.insight}</p><p class="small">${euro.format(view.bank.discretionary)} in discretionary spending per month.</p>`
      : `<p>Use the sample feed to fill income, living expenses, savings and debt payments.</p>
      <div class="actions">${button('Connect sample bank', 'sample_bank')}</div>`}</section>
    ${view.plan ? meter('Upfront milestone', Math.min(100, Math.floor(100 * view.plan.saved / view.plan.target)),
      `${euro.format(view.plan.saved)} of ${euro.format(view.plan.target)} · ${euro.format(view.plan.monthly)}/mo`) + timeline(view.plan) +
      `<p class="small">${view.financeNote} Purchase timing and repayment are illustrative.</p>` : ''}`;
}

function world(checkpoint: number) {
  return `<div class="world" role="img" aria-label="Dot at ${stopNames[checkpoint]}">
    <canvas id="map" width="480" height="260" aria-hidden="true"></canvas>
    ${stops.map(([x, y], i) => `<span class="stop" aria-hidden="true" style="left:${x / 4.8}%;top:${(y + 9) / 2.6}%">${stopNames[i]}</span>`).join('')}
    <div class="dot" id="dot" aria-hidden="true" style="left:${stops[checkpoint][0] / 4.8}%;top:${stops[checkpoint][1] / 2.6}%">••</div>
  </div>`;
}

function progress(view: Extract<DemoView, { progress: unknown }>) {
  const p = view.progress;
  return `<section class="hero panel coach"><div><span class="label">02 · Journey check-in</span>
    <h1>${p.coach.headline}</h1><p>${p.coach.milestone}</p></div>
    <div class="level-mark" aria-label="Level ${p.level}"><span>LEVEL</span><strong>${p.level}</strong></div></section>
    <div class="momentum"><div><strong>${p.streak} months</strong><span>Savings streak</span></div>
      <div><strong>${p.badges.length} badges</strong><span>Achievements earned</span></div>
      <div><strong>#${p.rank}</strong><span>Trail leaderboard</span></div></div>
    <section class="panel habits" aria-label="Habit quests">
      <div class="habits-header"><div><span class="label">Build your savings habits</span><h2>Your weekly quests</h2></div>
        <span class="habit-total">${p.estimate ? `+${euro.format(p.estimate)}/mo if kept up` : 'Choose a swap to try'}</span></div>
      ${p.quests.map(quest => `<article class="habit ${quest.status === 'complete' ? 'habit-done' : ''}">
        <div class="habit-icon" aria-hidden="true">${quest.icon}</div>
        <div><span class="label">${quest.status === 'complete' ? 'Completed' : quest.status === 'adopted' ? 'In progress' : `+${quest.xp} XP`}</span>
          <h3>${quest.title}</h3><p>${quest.action}</p>
          <div class="habit-spend"><span>${euro.format(quest.before)} now</span><span>${euro.format(quest.after)} with the swap</span>
            <strong>Save ${euro.format(quest.saving)}/mo</strong></div>
          <div class="actions">${quest.status === 'complete' ? `<span class="badge">✓ ${quest.badge} · +${quest.xp} XP</span>`
            : quest.status === 'adopted' ? button('I tried it', 'complete_habit', quest.id, 'gold')
            : button('Try this habit', 'adopt_habit', quest.id)}</div>
          ${quest.id === 'picnic' ? '<details><summary>Show an invite to share</summary><p>“Want to join me at the free park picnic and swap ideas for saving?”</p></details>' : ''}
        </div></article>`).join('')}
      <p class="small">Savings are estimates for repeating each swap. Check-ins earn XP and leave your actual balance unchanged.</p>
    </section>` +
    world(p.checkpoint) +
    `<div class="split">${meter('Upfront milestone', p.percent, `${euro.format(p.saved)} / ${euro.format(p.target)}`)}
    ${meter('Quest XP', Math.floor(p.xp * 100 / p.xpGoal), `${p.xp} / ${p.xpGoal} XP`)}</div>
    ${timeline(p)}
    <div class="split"><section class="panel"><h2>Achievements</h2>
      ${p.badges.map(badge => `<span class="badge">★ ${badge}</span>`).join('')}
      <p class="small">Current savings pace is ${euro.format(p.monthly)} per month.</p></section>
    <section class="panel"><h2>Sample leaderboard</h2><ol class="ranks">
      ${p.leaderboard.map(person => `<li class="${person.name.includes('You') ? 'current' : ''}"><div class="rank"><span>${person.name}</span><strong>${person.xp} XP</strong></div></li>`).join('')}
    </ol><p class="small">Quest XP sets the rank.</p></section></div>`;
}

function shortcuts(view: Extract<DemoView, { inbox: unknown }>) {
  if (view.unread) return hero('03 · Route alert', `${view.unread} unread route updates`,
    'There may be a faster way to reach your goal. Want to compare routes?') +
    `<div class="actions">${button('Compare routes', 'read_inbox')}</div>`;

  const current = view.inbox.find(item => item.id === view.chosen);
  const preview = view.inbox.find(item => item.id === view.previewed);
  const highlighted = preview ?? current;
  const chip = (route: typeof view.inbox[number]) =>
    `<button type="button" class="route-chip" data-action="preview_shortcut" data-key="${route.id}"
     aria-pressed="${highlighted?.id === route.id}"><strong>Route ${route.letter}${current?.id === route.id ? ' · Active' : ''}</strong>
     <span>${route.fasterBy} months sooner</span><small>${route.title}</small></button>`;
  const routes = view.inbox.slice(0, 3);
  const secondary = view.inbox.slice(3);
  return hero('03 · Route comparison', 'Same destination. Different journeys.', 'Pick a route to see what changes between today and owning your home outright.') +
    `<div class="route-options" aria-label="Routes to owning outright">
      <button type="button" class="route-chip" data-action="preview_shortcut" aria-pressed="${!preview}">
        <strong>Current route</strong><span>${current ? `Route ${current.letter}` : `${view.baseline.upfrontMonths} months upfront`}</span>
        <small>${current ? current.title : 'Stay with the original plan'}</small></button>
      ${routes.map(chip).join('')}
    </div>
<section class="panel journey-chart" aria-label="Homeownership route timeline">
      <div class="journey-head">
        <div><span class="label">Núria’s journey</span><h2>From first savings to the last payment</h2></div>
        <strong class="journey-gain">${highlighted ? `Route ${highlighted.letter} · ${highlighted.fasterBy} months sooner` : 'Original route'}</strong>
      </div>
      <canvas id="route-map" role="img" aria-label="Time by stage. ${view.pastMonths / 12} years have passed. ${highlighted
        ? `Route ${highlighted.letter} is highlighted with ${highlighted.fasterBy} months saved.` : 'The original route is highlighted.'}"></canvas>
      <div class="journey-legend"><span class="past">Path completed</span><span class="selected-line">Selected future</span><span class="alternative">Other options</span></div>
    </section>
    <section class="panel route-detail" aria-label="Route details">
      <span class="label">${preview && preview.id !== current?.id ? `Preview · Route ${preview.letter}` : 'Active route'}</span>
      <h2>${highlighted?.title ?? 'Stay with the current plan'}</h2>
      ${highlighted ? `<p>${highlighted.detail}</p><p class="small"><strong>Check:</strong> ${highlighted.verify}</p>` :
        '<p>Keep saving €800 per month toward the €54,000 upfront milestone.</p>'}
      ${timeline(highlighted ?? view.baseline)}
      ${preview && preview.id !== current?.id ? `<div class="actions">
        ${button(`Switch to Route ${preview.letter}`, 'choose_shortcut', preview.id, 'gold')}
        ${button('Keep current route', 'keep_route', '', '')}</div>`
        : current ? `<span class="badge">✓ Route ${current.letter} active · ${current.fasterBy} months sooner</span>` : ''}
    </section>
    <details class="panel" ${secondary.some(route => route.id === highlighted?.id) ? 'open' : ''}>
      <summary>More route updates (${secondary.length})</summary>
      <div class="route-options secondary-routes">${secondary.map(chip).join('')}</div>
    </details>`;
}

function celebrate() {
  const icons = ['🔑', '🏡', '🎉', '✨', '⭐', '🏆', '💛'];
  return `<div class="celebration" aria-hidden="true">${Array.from({ length: 18 }, (_, index) => {
    const angle = index / 18 * Math.PI * 2;
    return `<span style="--dx:${Math.round(Math.cos(angle) * 340)}px;--dy:${Math.round(Math.sin(angle) * 205)}px;--delay:${index % 6 * 32}ms">${icons[index % icons.length]}</span>`;
  }).join('')}</div>`;
}

function payoff(view: Extract<DemoView, { payoff: unknown }>) {
  const p = view.payoff;
  if (view.credits) {
    const credits = view.credits;
    return `<section class="credits panel" aria-label="Journey credits">
      <div class="victory">
        ${celebrate()}
        <div class="victory-medal" aria-hidden="true">🔑</div>
        <span class="label">Final achievement unlocked</span>
        <h1>${credits.title}</h1><p>Jordi owns his home outright.</p>
        <strong class="victory-banner">Mortgage-free</strong>
      </div>
      <div class="credit-stats">${credits.stats.map(stat => `<div><strong>${stat.value}</strong><span>${stat.label}</span></div>`).join('')}</div>
      <ol class="credit-milestones">${credits.milestones.map(milestone =>
        `<li><h2>${milestone.title}</h2><p>${milestone.detail}</p></li>`).join('')}</ol>
      <h2>Achievements unlocked</h2>
      <p>${credits.achievements.map(badge => `<span class="badge">★ ${badge}</span>`).join('')}</p>
      <div class="actions">${button('Back to the finish', 'hide_credits', '', 'gold')}</div>
    </section>`;
  }
  return `<div class="payoff">${hero('04 · Journey complete', p.paid ? '★ Jordi owns his home outright!' : 'Replay Jordi’s final installment.',
    p.paid ? 'Dot reached the finish line. Want to see the credits?'
      : 'One €620 installment to go on the replay.')}</div>
    ${world(p.paid ? 5 : 4)}
    ${meter('Mortgage repaid', p.percent,
      `${euro.format(p.original - p.remaining)} of ${euro.format(p.original)} · ${euro.format(p.remaining)} mortgage remaining · ${euro.format(p.otherDebt)} other debt`)}
    <div class="actions">${p.paid ? button('Roll the credits', 'show_credits', '', 'gold') +
      button('Replay the last installment', 'replay_payment', '', 'link')
    : button('Complete the simulated payment', 'final_payment', '', 'gold')}</div>`;
}

function checkpoint(view: DemoView) {
  if ('progress' in view) return view.progress.checkpoint;
  if ('payoff' in view && !view.credits) return view.payoff.paid ? 5 : 4;
  return undefined;
}

function render(view: BoardView) {
  if (active?.runId === view.runId && active.revision >= view.revision && active.connection?.ledgerRevision === view.connection?.ledgerRevision) return;
  const preferencesOpen = byId<HTMLDetailsElement>('preferences')?.open;
  const enteringCredits = 'payoff' in view && !!view.credits && (!active || !('payoff' in active) || !active.credits);
  if (!app && (enteringCredits || (active && active.persona !== view.persona))) window.scrollTo(0, 0);
  const previous = active?.persona === view.persona ? checkpoint(active) : undefined;
  active = view;
  byId('personas').innerHTML = view.choices.map(person => `<button type="button" data-action="switch_persona"
    data-key="${person.id}" aria-pressed="${view.persona === person.id}"><strong>${person.name}</strong>${person.label}</button>`).join('');
  byId('view').innerHTML = 'answers' in view ? onboarding(view) : 'progress' in view ? progress(view)
    : 'inbox' in view ? shortcuts(view) : payoff(view);
  if (view.connection?.mode === 'connected_synthetic') {
    const connection = view.connection;
    const screen = view.townScreening;
    byId('view').insertAdjacentHTML('afterbegin', `<section class="panel"><span class="label">Connected fictional profile · ${safe(connection.userId)}</span><h2>Runtime bank feed</h2><p>Ledger revision ${safe(connection.ledgerRevision ?? 0)} · ${connection.runtime?.enabled ? 'Background simulation running' : 'Background simulation stopped'}</p><div class="actions">${button(connection.runtime?.enabled ? 'Stop simulated feed' : 'Start simulated feed', connection.runtime?.enabled ? 'stop_bank_runtime' : 'start_bank_runtime')}${button('Refresh bank data', 'refresh_data', '', 'link')}</div>${connection.summary ? `<p class="small">Observed net cash flow: ${euro.format(connection.summary.netCashflowCents / 100)} (${safe(connection.summary.from)} to ${safe(connection.summary.to)}). Historical totals are not a current-month forecast.</p>` : ''}</section>`);
    if (screen) byId('view').insertAdjacentHTML('beforeend', `<section class="panel"><h2>Sourced municipality screen</h2><p>Provisional town comparison; this is not a verified property match or mortgage approval.</p>${screen.propertyChecks.map(check => `<p class="small">Property check pending: ${safe(check.required)} bedrooms.</p>`).join('')}${screen.result ? screen.result.towns.map(town => `<article><h3>${safe(town.municipality.name)}</h3><p>${town.matchReasons.map(safe).join(' · ')}</p>${town.incentives.map(policy => `<p><a href="${safe(policy.sourceUrl)}" target="_blank" rel="noopener noreferrer">${safe(policy.title)}</a> · ${safe(policy.callStatus)} · ${safe(policy.eligibilityStatus)}</p>`).join('')}</article>`).join('') : `<p>More information needed: ${screen.missingFields.map(safe).join(', ') || 'resolve profile conflicts'}.</p>`}</section>`);
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
  byId('connection').textContent = 'Live board · synced with chat';
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
  drawRouteTimeline(byId<HTMLCanvasElement>('route-map'), [{ letter: 'original', ...view.baseline }, ...view.inbox],
    highlighted?.letter ?? 'original', view.pastMonths);
}
window.addEventListener('resize', () => { if (active) renderRouteTimeline(active); });

async function call(name: string, args: Record<string, unknown>) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(control => { control.disabled = true; });
  byId('status').textContent = '';
  try {
    const result = app
      ? await app.callServerTool({ name, arguments: args })
      : await fetch('/preview/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args }) }).then(response => response.json());
    if (result.isError || !result.structuredContent) {
      throw new Error(result.content?.find((item: { type: string }) => item.type === 'text')?.text ?? 'The demo could not load.');
    }
    const view = result.structuredContent as BoardView;
    render(view);
    if (app) {
      void app.updateModelContext({ content: [{ type: 'text',
        text: `relo.cat is showing ${view.person.name} (${view.persona}) in demo run ${view.runId}. ${view.message}` }] }).catch(() => {});
    }
  } catch (error) {
    byId('status').textContent = error instanceof Error ? error.message : 'Something went wrong. Try again.';
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach(control => { control.disabled = false; });
  }
}

function parseFormAnswers(raw: Record<string, unknown>) {
  const numeric = new Set(['bedrooms', 'household', 'income', 'spending', 'savings', 'budget', 'floorArea', 'maxCommuteMinutes', 'upfrontTarget', 'emergencyReserve', 'homeSize', 'dependants', 'commuteTime', 'debtPayments', 'reserve', 'cashTarget']);
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key,
    active?.connection?.mode !== 'connected_synthetic' ? value : numeric.has(key) ? Number(value)
      : key === 'allowComarcaEstimate' ? (String(value).trim().toLowerCase() === 'true' ? true : String(value).trim().toLowerCase() === 'false' ? false : value)
      : key === 'schoolStages' ? String(value).split(',').map(stage => stage.trim()).filter(Boolean) : value]));
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
    Object.assign(args, { action: 'answer_batch', answers: parseFormAnswers(Object.fromEntries(
      active.group.questions.map(question => [question.id, question.example]),
    )) });
  }
  void call('update_demo', args);
});

document.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (!form.classList.contains('intake') || !active || !('answers' in active)) return;
  event.preventDefault();
  const answers = parseFormAnswers(Object.fromEntries([...new FormData(form)].filter(([key, value]) => key === 'schoolStages' || String(value).trim())));
  if (!Object.keys(answers).length) {
    byId('status').textContent = 'Enter an answer or use the example answers.';
    return;
  }
  void call('update_demo', { runId: active.runId, action: 'answer_batch', answers });
});

async function refresh() {
  if (!active || busy || refreshing || (app && !active.boardUrl)) return;
  const runId = active.runId;
  const origin = app ? new URL(active.boardUrl!).origin : location.origin;
  const url = new URL('/preview/state', origin);
  if (!active.sharedBoard) url.searchParams.set('run', runId);
  refreshing = true;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Board unavailable');
    const view = await response.json() as BoardView;
    if (!busy && active.runId === runId) render(view);
    byId('connection').textContent = 'Live board · synced with chat';
  } catch {
    byId('connection').textContent = 'Live sync paused · reconnecting';
  } finally {
    refreshing = false;
  }
}
setInterval(() => void refresh(), 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });

byId('fullscreen').onclick = async () => {
  if (!app) return;
  try {
    const result = await app.requestDisplayMode({ mode: fullscreen ? 'inline' : 'fullscreen' });
    fullscreen = result.mode === 'fullscreen';
    byId('fullscreen').textContent = fullscreen ? 'Collapse' : 'Expand';
  } catch {
    byId('status').textContent = 'This host is keeping the board inline.';
  }
};

if (app) {
  app.ontoolresult = result => {
    if (result.structuredContent?.runId) render(result.structuredContent as BoardView);
  };
  void app.connect().catch(() => { byId('status').textContent = 'Could not connect to the ChatGPT host.'; });
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
