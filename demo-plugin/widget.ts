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
let active: DemoView | undefined;
let busy = false;
let fullscreen = false;

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

function onboarding(view: Extract<DemoView, { answers: unknown }>) {
  const labels: Record<string, string> = {
    town: 'Target town', bedrooms: 'Bedrooms', household: 'Household size', employment: 'Employment',
    income: 'Monthly income', spending: 'Monthly spending', savings: 'Saved',
  };
  const monetary = new Set(['income', 'spending', 'savings']);
  const facts = Object.entries(view.answers).map(([id, value]) =>
    `<div><dt>${labels[id]}</dt><dd>${typeof value === 'number' && monetary.has(id) ? euro.format(value) : safe(value)}</dd></div>`).join('');
  const next = view.next;
  const count = Object.keys(view.answers).length;
  return hero('01 · Intake', 'Meet Laia.', 'Tell Arrela about your home goal, one question at a time. Use fictional details in chat or answer here.') +
    `<section class="panel"><span class="label">${next ? `${count} of ${view.totalQuestions} answered` : 'Profile complete'}</span>
      ${next ? `<form class="answer" id="answer"><label for="answer-input">${next.prompt}</label>
        <input required id="answer-input" type="${next.kind}" maxlength="80" ${next.kind === 'number' ? 'min="0" step="1"' : ''} placeholder="${next.example}">
        <button class="primary">Save answer</button></form>
        <div class="actions">${button('Use example answer', 'example', '', 'link')}</div>`
        : '<p>Your inputs are ready. Review the first estimate below.</p>'}
      ${facts ? `<dl class="facts">${facts}</dl>` : ''}</section>
    <section class="panel"><h2>Sample bank connection</h2>
      ${view.bank ? `<p><strong>Sample snapshot loaded.</strong> ${view.bank.insight}</p><p class="small">${euro.format(view.bank.discretionary)} in fictional discretionary spending per month.</p>`
      : `<p>Use a fictional read-only feed to fill income, spending and savings. This replaces any finance answers in Laia’s demo.</p>
      <div class="actions">${button('Connect sample bank', 'sample_bank')}</div>`}</section>
    ${view.plan ? meter('Upfront goal', Math.min(100, Math.floor(100 * view.plan.saved / view.plan.target)),
      `${euro.format(view.plan.saved)} of ${euro.format(view.plan.target)} · ${euro.format(view.plan.monthly)}/mo · ${displayMonths(view.plan.months)}`) : ''}
    <p class="small">The sample upfront goal combines deposit, taxes and fees.</p>`;
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
  return hero('02 · Progress check', 'Marc’s homeownership trail.', `Level ${p.level} · Dot is at ${stopNames[p.checkpoint]}.`) +
    world(p.checkpoint) +
    `<div class="split">${meter('Upfront goal', p.percent, `${euro.format(p.saved)} / ${euro.format(p.target)} · ${displayMonths(p.months)} left`)}
    ${meter('Quest XP', Math.floor(p.xp * 100 / p.xpGoal), `${p.xp} / ${p.xpGoal} XP`)}</div>
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
      `Current route: ${view.baseline} months to the upfront goal. Compare each option against that baseline.`);
  if (view.unread) return heading + `<div class="actions">${button('Read 5 updates', 'read_inbox')}</div>`;
  const selected = view.inbox.find(item => item.id === view.chosen);
  return heading + (selected
    ? `<div class="alert"><strong>Route updated · ${displayMonths(selected.months)}</strong><p>${selected.verify}</p></div>`
    : view.chosen === 'keep' ? '<div class="alert">Current route kept.</div>' : '') +
    `<section class="panel stack" aria-label="Five sample opportunities">
      ${view.inbox.map(item => `<article class="inbox-card ${view.chosen === item.id ? 'selected' : ''}">
        <span class="label">${item.category}</span><h3>${item.title}</h3>
        <p class="small">${item.detail}</p><p class="small"><strong>Verify:</strong> ${item.verify}</p>
        <div class="actions"><span class="badge">${item.fasterBy} months sooner</span>
          ${button(view.chosen === item.id ? 'Selected route' : 'Take this route', 'choose_shortcut', item.id, 'gold')}</div>
      </article>`).join('')}
      <div>${button('Keep my original route', 'keep_route', '', '')}</div>
    </section>`;
}

function payoff(view: Extract<DemoView, { payoff: unknown }>) {
  const p = view.payoff;
  return `<div class="payoff">${hero('04 · Final payment', p.paid ? '★ Mortgage paid off!' : 'Jordi is one payment away.',
    p.paid ? 'Key Town complete. You earned the Mortgage-Free achievement.' : 'The last payment on the sample mortgage is €620. Finish the demo to celebrate with Dot.')}</div>
    ${world(p.paid ? 5 : 4)}
    ${meter('Mortgage repaid', p.percent, `${euro.format(p.original - p.remaining)} of ${euro.format(p.original)} · ${euro.format(p.remaining)} remaining`)}
    <div class="actions">${p.paid ? '<span class="badge">🏆 Mortgage-Free · Journey complete</span>'
    : button('Simulate final payment', 'final_payment', '', 'gold')}</div>`;
}

function checkpoint(view: DemoView) {
  if ('progress' in view) return view.progress.checkpoint;
  if ('payoff' in view) return view.payoff.paid ? 5 : 4;
  return undefined;
}

function render(view: DemoView) {
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
    const view = result.structuredContent as DemoView;
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
  if (action === 'example' && 'next' in active && active.next) {
    Object.assign(args, { action: 'answer', question: active.next.id, answer: active.next.example });
  }
  void call('update_demo', args);
});

document.addEventListener('submit', event => {
  if ((event.target as HTMLElement).id !== 'answer' || !active || !('next' in active) || !active.next) return;
  event.preventDefault();
  void call('update_demo', {
    runId: active.runId, action: 'answer', question: active.next.id,
    answer: byId<HTMLInputElement>('answer-input').value,
  });
});

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
    if (result.structuredContent?.runId) render(result.structuredContent as DemoView);
  };
  void app.connect().catch(() => { byId('status').textContent = 'Could not connect to the ChatGPT host.'; });
} else {
  const persona = new URLSearchParams(location.search).get('persona');
  void call('open_demo', persona ? { persona } : {});
}
