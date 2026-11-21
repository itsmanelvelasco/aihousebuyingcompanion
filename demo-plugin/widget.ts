import { App } from '@modelcontextprotocol/ext-apps';
import type { DemoView } from './demo.ts';
import { drawWorld, nextSegment, stopNames, stops } from './map.ts';

const app = window.parent === window ? null : new App({ name: 'Arrela demo', version: '0.1.0' });
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const safe = (value: unknown) => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const displayMonths = (months: number | null) =>
  months === null ? 'Budget gap' : months === 0 ? 'Goal reached' : `${months} months`;
type BoardView = DemoView & { boardUrl?: string | null };
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
  const labels: Record<string, string> = {
    town: 'Target town', bedrooms: 'Bedrooms', household: 'Household size', employment: 'Employment',
    income: 'Monthly income', spending: 'Monthly spending', savings: 'Saved',
  };
  const monetary = new Set(['income', 'spending', 'savings']);
  const facts = Object.entries(view.answers).map(([id, value]) =>
    `<div><dt>${labels[id]}</dt><dd>${typeof value === 'number' && monetary.has(id) ? euro.format(value) : safe(value)}</dd></div>`).join('');
  const group = view.group;
  const count = Object.keys(view.answers).length;
  const fields = group?.questions.map(question =>
    `<label>${labels[question.id]}<input name="${question.id}" type="${question.kind}" maxlength="80"
      ${question.kind === 'number' ? 'min="0" step="1"' : ''} placeholder="${question.example}"></label>`).join('');
  return hero('01 · Intake', 'Let’s chart your route, Laia.', 'Describe your goal and finances in your own words. Arrela saves everything you share in the same turn.') +
    `<section class="panel"><span class="label">${count} of ${view.totalQuestions} details saved</span>
      ${group ? `<h2>${group.title}</h2>
        <form class="intake" id="answer"><div class="fields">${fields}</div><div class="actions"><button class="primary">Save answers</button>
        ${button('Use example answers', 'example', '', 'link')}</div></form>`
        : '<h2>Profile complete</h2><p>Your route is ready. The finish line is owning the home outright.</p>'}
      ${facts ? `<dl class="facts">${facts}</dl>` : ''}</section>
    <section class="panel"><h2>Sample bank connection</h2>
      ${view.bank ? `<p><strong>Sample snapshot loaded.</strong> ${view.bank.insight}</p><p class="small">${euro.format(view.bank.discretionary)} in fictional discretionary spending per month.</p>`
      : `<p>Use a fictional read-only feed to fill income, spending and savings. This replaces any finance answers in Laia’s demo.</p>
      <div class="actions">${button('Connect sample bank', 'sample_bank')}</div>`}</section>
    ${view.plan ? meter('Upfront milestone', Math.min(100, Math.floor(100 * view.plan.saved / view.plan.target)),
      `${euro.format(view.plan.saved)} of ${euro.format(view.plan.target)} · ${euro.format(view.plan.monthly)}/mo`) + timeline(view.plan) : ''}
    <p class="small">The upfront goal includes deposit, taxes and fees. Purchase timing and repayment are illustrative.</p>`;
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
  return hero('02 · Progress check', 'Marc’s homeownership trail.', `Level ${p.level} · Dot is at ${stopNames[p.checkpoint]}. Destination: debt-free homeownership.`) +
    world(p.checkpoint) +
    `<div class="split">${meter('Upfront milestone', p.percent, `${euro.format(p.saved)} / ${euro.format(p.target)}`)}
    ${meter('Quest XP', Math.floor(p.xp * 100 / p.xpGoal), `${p.xp} / ${p.xpGoal} XP`)}</div>
    ${timeline(p)}
    <div class="split"><section class="panel"><h2>Achievements</h2>
      ${p.badges.map(badge => `<span class="badge">★ ${badge}</span>`).join('')}
      <p class="small">Current savings pace is ${euro.format(p.monthly)} per month.</p></section>
    <section class="panel"><h2>Sample leaderboard</h2><ol class="ranks">
      ${p.leaderboard.map(person => `<li class="${person.name.includes('You') ? 'current' : ''}"><div class="rank"><span>${person.name}</span><strong>${person.xp} XP</strong></div></li>`).join('')}
    </ol><p class="small">Quest XP sets the rank.</p></section></div>
    <section class="panel"><span class="label">Community quest</span><h2>First buyers’ park picnic</h2>
      <p>Meet other first-time buyers at a free meetup and compare low-cost weekend plans. The group can also explore towns together.</p>
      ${p.joinedQuest ? '<span class="badge">✓ Joined · +100 XP</span>' : `<div class="actions">${button('Join sample picnic · +100 XP', 'join_quest')}</div>`}
      <details><summary>Show an invite to share</summary><p>“I’m doing the Arrela first-home trail. Want to join the park picnic and swap ideas for saving?”</p></details>
    </section>`;
}

function shortcuts(view: Extract<DemoView, { inbox: unknown }>) {
  const heading = hero('03 · Shortcuts', view.unread ? `${view.unread} unread route updates` : 'Núria’s route inbox',
    view.unread ? 'Arrela found five changes that might get you there sooner. Want to read them now?' :
      'Compare five routes to owning outright. Each assumes the same 20-year mortgage term after reaching the upfront milestone.');
  if (view.unread) return heading + `<div class="actions">${button('Read 5 updates', 'read_inbox')}</div>`;
  const selected = view.inbox.find(item => item.id === view.chosen);
  return heading + (selected
    ? `<div class="alert"><strong>Route updated · ${selected.fasterBy} months sooner to debt-free ownership</strong><p>${selected.verify}</p></div>`
    : view.chosen === 'keep' ? '<div class="alert">Current route kept.</div>' : '') + timeline(selected ?? view.baseline) +
    `<section class="panel stack" aria-label="Five sample opportunities">
      ${view.inbox.map(item => `<article class="inbox-card ${view.chosen === item.id ? 'selected' : ''}">
        <span class="label">${item.category}</span><h3>${item.title}</h3>
        <p class="small">${item.detail}</p><p class="small"><strong>Verify:</strong> ${item.verify}</p>
        <div class="actions"><span class="badge">${item.fasterBy} months sooner to owning outright</span>
          <span class="small">${item.upfrontMonths === 0 ? 'Upfront goal met' : `${item.upfrontMonths} months to upfront goal`}</span>
          ${button(view.chosen === item.id ? 'Selected route' : 'Take this route', 'choose_shortcut', item.id, 'gold')}</div>
      </article>`).join('')}
      <div>${button('Keep my original route', 'keep_route', '', '')}</div>
    </section>`;
}

function payoff(view: Extract<DemoView, { payoff: unknown }>) {
  const p = view.payoff;
  return `<div class="payoff">${hero('04 · Finish line', p.paid ? '★ Jordi owns his home outright!' : 'Replay Jordi’s final installment.',
    p.paid ? 'The mortgage is paid off, and there’s no other demo debt. Dot has reached the finish line.'
      : 'Jordi’s last €620 installment in the fictional mortgage is ready to replay.')}</div>
    ${world(p.paid ? 5 : 4)}
    ${meter('Mortgage repaid', p.percent,
      `${euro.format(p.original - p.remaining)} of ${euro.format(p.original)} · ${euro.format(p.remaining)} mortgage remaining · ${euro.format(p.otherDebt)} other debt`)}
    <div class="actions">${p.paid ? '<span class="badge">🏆 Mortgage-Free · Journey complete</span>' +
      button('Replay the last installment', 'replay_payment', '', 'link')
    : button('Complete the simulated payment', 'final_payment', '', 'gold')}</div>`;
}

function checkpoint(view: DemoView) {
  if ('progress' in view) return view.progress.checkpoint;
  if ('payoff' in view) return view.payoff.paid ? 5 : 4;
  return undefined;
}

function render(view: BoardView) {
  if (active?.runId === view.runId && active.revision >= view.revision) return;
  const previous = active?.persona === view.persona ? checkpoint(active) : undefined;
  active = view;
  byId('personas').innerHTML = view.choices.map(person => `<button type="button" data-action="switch_persona"
    data-key="${person.id}" aria-pressed="${view.persona === person.id}"><strong>${person.name}</strong>${person.label}</button>`).join('');
  byId('view').innerHTML = 'answers' in view ? onboarding(view) : 'progress' in view ? progress(view)
    : 'inbox' in view ? shortcuts(view) : payoff(view);
  const current = checkpoint(view);
  if (current !== undefined) {
    drawWorld(byId<HTMLCanvasElement>('map'), current);
    if (previous !== undefined && current === previous + 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const frames = nextSegment(previous, false).map(([x, y]) => ({ left: `${x / 4.8}%`, top: `${y / 2.6}%` }));
      byId('dot').animate(frames, { duration: 780, easing: 'ease-in-out' });
    }
  }
  byId('controls').hidden = false;
  byId('fullscreen').hidden = !app;
  byId('pair-code').textContent = view.pairCode;
  byId('connection').textContent = 'Live board · say this code to pair';
  const link = byId<HTMLAnchorElement>('board-link');
  link.hidden = !app || !view.boardUrl;
  if (view.boardUrl) link.href = view.boardUrl;
  if (!app) {
    const url = new URL(location.href);
    url.searchParams.delete('persona');
    url.searchParams.set('run', view.runId);
    history.replaceState(null, '', url);
  }
}

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
        text: `Arrela is showing ${view.person.name} (${view.persona}) in demo run ${view.runId}. ${view.message}` }] }).catch(() => {});
    }
  } catch (error) {
    byId('status').textContent = error instanceof Error ? error.message : 'Something went wrong. Try again.';
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach(control => { control.disabled = false; });
  }
}

document.addEventListener('click', event => {
  const control = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!active || !control) return;
  const { action, key } = control.dataset;
  if (!action) return;
  const args: Record<string, unknown> = { runId: active.runId, action };
  if (action === 'switch_persona') args.persona = key;
  if (action === 'choose_shortcut') args.opportunity = key;
  if (action === 'example' && 'group' in active && active.group) {
    Object.assign(args, { action: 'answer_batch', answers: Object.fromEntries(
      active.group.questions.map(question => [question.id, question.example]),
    ) });
  }
  void call('update_demo', args);
});

document.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (form.id !== 'answer' || !active || !('group' in active) || !active.group) return;
  event.preventDefault();
  const answers = Object.fromEntries([...new FormData(form)].filter(([, value]) => String(value).trim()));
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
  url.searchParams.set('run', runId);
  refreshing = true;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Board unavailable');
    const view = await response.json() as BoardView;
    if (!busy && active.runId === runId) render(view);
    byId('connection').textContent = 'Live board · say this code to pair';
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
