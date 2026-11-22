import { minPasswordLength } from '../../packages/auth/accounts.ts';
import { type Scope, scopes } from '../../packages/auth/oauth.ts';
import { product } from '../../packages/config/product.ts';
import { escapeHtml as e } from '../../packages/http/server.ts';
import { markDataUrl, wordmark } from '../../packages/ui/icons.ts';
import { themeCss } from '../../packages/ui/inline.ts';

/**
 * The account pages: sign up, sign in, sign out, the account (with the person's own bank data, the
 * password, the export and the deletion) and the OAuth consent screen. Plain server-rendered HTML
 * forms styled with the shared theme. There is no script on any of them, every form carries the
 * CSRF token of the session, and every value that came from a request, the database or a bank goes
 * through `escapeHtml`.
 */

const layoutCss = `
  body { min-height: 100vh; }
  .page { width: min(100% - 32px, 34rem); margin: 0 auto; padding: var(--rc-space-8) 0 var(--rc-space-12); }
  .page--wide { width: min(100% - 32px, 46rem); }
  .top { display: flex; align-items: center; justify-content: space-between; gap: var(--rc-space-4); margin-bottom: var(--rc-space-8); }
  .top nav { display: flex; gap: var(--rc-space-3); align-items: center; font-size: var(--rc-text-sm); }
  h1 { font-size: var(--rc-text-2xl, 1.75rem); margin: 0 0 var(--rc-space-2); }
  h2 { font-size: var(--rc-text-lg, 1.25rem); margin: 0 0 var(--rc-space-3); }
  .lede { color: var(--rc-muted); margin: 0 0 var(--rc-space-6); }
  form.stack, .stack { display: grid; gap: var(--rc-space-4); }
  .rc-card + .rc-card { margin-top: var(--rc-space-5); }
  .row { display: flex; flex-wrap: wrap; gap: var(--rc-space-3); align-items: center; justify-content: space-between; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--rc-space-3); }
  .facts { display: grid; grid-template-columns: minmax(8rem, 14rem) 1fr; gap: 6px var(--rc-space-4); margin: 0; font-size: var(--rc-text-sm); }
  .facts dt { color: var(--rc-muted); }
  .facts dd { margin: 0; overflow-wrap: anywhere; }
  ul.plain { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--rc-space-3); }
  .hint { color: var(--rc-muted); font-size: var(--rc-text-sm); margin: 0; }
  .danger { border-color: var(--rc-danger); }
  code { overflow-wrap: anywhere; }
  h3 { font-size: var(--rc-text-md, 1.05rem); margin: var(--rc-space-5) 0 var(--rc-space-2); }
  .scroll { overflow-x: auto; }
  .rc-table { width: 100%; font-size: var(--rc-text-sm); }
  .rc-table td.num, .rc-table th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .inline { display: flex; flex-wrap: wrap; gap: var(--rc-space-2); align-items: center; }
  .inline select, .inline input[type="date"] { width: auto; }
  .movements { min-width: 40rem; }
  .movements td.date { white-space: nowrap; }
  .movements form.inline { flex-wrap: nowrap; }
  .movements select { max-width: 12rem; min-height: 0; padding-block: 4px; }
  .tag { display: inline-block; border: 1px solid var(--rc-line, currentColor); border-radius: 999px; padding: 0 8px; font-size: var(--rc-text-xs, 0.75rem); color: var(--rc-muted); }
`;

export type PageAccount = { email: string } | null;

/** One complete page. `body` is trusted markup built by the functions below. */
function layout(title: string, body: string, options: { account?: PageAccount; csrf?: string; wide?: boolean } = {}) {
  const nav = options.account
    ? `<span class="rc-muted">${e(options.account.email)}</span><a href="/account">Account</a>
       <form method="post" action="/logout"><input type="hidden" name="csrf" value="${e(options.csrf)}">
       <button class="rc-btn rc-btn--sm rc-btn--quiet" type="submit">Sign out</button></form>`
    : '<a href="/login">Sign in</a><a href="/signup">Create account</a>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(title)} · ${e(product.name)}</title>
<link rel="icon" href="${markDataUrl}">
<style>${themeCss()}${layoutCss}</style>
</head>
<body>
<main class="page${options.wide ? ' page--wide' : ''}">
<header class="top">${wordmark({ href: '/connect' })}<nav aria-label="Account">${nav}</nav></header>
${body}
</main>
</body>
</html>`;
}

const errorNote = (message?: string) =>
  message ? `<p class="rc-note rc-note--error" role="alert">${e(message)}</p>` : '';
const hidden = (name: string, value: string | undefined) =>
  value === undefined ? '' : `<input type="hidden" name="${e(name)}" value="${e(value)}">`;

export function messagePage(title: string, message: string, account: PageAccount = null, csrf?: string) {
  return layout(
    title,
    `<h1>${e(title)}</h1><p class="lede">${e(message)}</p><p><a class="rc-btn" href="/connect">Back to ReloCat</a></p>`,
    { account, csrf },
  );
}

export function signUpPage(input: { csrf: string; next?: string; email?: string; error?: string; closed?: boolean }) {
  if (input.closed)
    return layout(
      'Create account',
      '<h1>Create account</h1><p class="rc-note">New accounts are closed on this server.</p>',
    );
  return layout(
    'Create account',
    `<h1>Create your account</h1>
<p class="lede">An account keeps your own answers and plans private to you, and lets ChatGPT or another assistant read and save them only when you allow it.</p>
${errorNote(input.error)}
<form class="stack rc-card" method="post" action="/signup" autocomplete="on">
  ${hidden('csrf', input.csrf)}${hidden('next', input.next)}
  <label class="rc-field">Email
    <input type="email" name="email" required maxlength="254" autocomplete="email" value="${e(input.email)}"></label>
  <label class="rc-field">Password
    <input type="password" name="password" required minlength="${minPasswordLength}" maxlength="200" autocomplete="new-password">
  </label>
  <p class="hint">At least ${minPasswordLength} characters. There is no password reset yet: this server sends no email, so keep the password somewhere safe.</p>
  <button class="rc-btn rc-btn--primary" type="submit">Create account</button>
</form>
<p class="hint">Already have one? <a href="/login${input.next ? `?next=${encodeURIComponent(input.next)}` : ''}">Sign in</a>.</p>`,
  );
}

export function loginPage(input: { csrf: string; next?: string; email?: string; error?: string; notice?: string }) {
  return layout(
    'Sign in',
    `<h1>Sign in</h1>
<p class="lede">Sign in to see and save your own plan.</p>
${input.notice ? `<p class="rc-note" role="status">${e(input.notice)}</p>` : ''}${errorNote(input.error)}
<form class="stack rc-card" method="post" action="/login" autocomplete="on">
  ${hidden('csrf', input.csrf)}${hidden('next', input.next)}
  <label class="rc-field">Email
    <input type="email" name="email" required maxlength="254" autocomplete="username" value="${e(input.email)}"></label>
  <label class="rc-field">Password
    <input type="password" name="password" required maxlength="200" autocomplete="current-password"></label>
  <button class="rc-btn rc-btn--primary" type="submit">Sign in</button>
</form>
<p class="hint">New here? <a href="/signup${input.next ? `?next=${encodeURIComponent(input.next)}` : ''}">Create an account</a>.
There is no password reset yet, because this server sends no email.</p>`,
  );
}

export function logoutPage(input: { csrf: string; account: PageAccount }) {
  return layout(
    'Sign out',
    `<h1>Sign out</h1>
<form class="stack rc-card" method="post" action="/logout">
  ${hidden('csrf', input.csrf)}
  <p>Sign out of ReloCat in this browser? Assistants you connected keep their access until you remove them on the account page.</p>
  <div class="actions"><button class="rc-btn rc-btn--primary" type="submit">Sign out</button>
  <a class="rc-btn" href="/account">Cancel</a></div>
</form>`,
    input,
  );
}

const scopeList = (granted: Scope[]) => `<ul>${granted.map(scope => `<li>${e(scopes[scope])}</li>`).join('')}</ul>`;

/** The consent screen: which application asks, where it will be sent back to, and what it may do. */
export function consentPage(input: {
  csrf: string;
  account: { email: string };
  client: { name: string };
  redirectUri: string;
  scopes: Scope[];
  /** The original authorization parameters, replayed by the form so the POST is validated again. */
  params: Record<string, string>;
}) {
  const target = new URL(input.redirectUri);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !/^https?:$/.test(target.protocol);
  return layout(
    'Connect an application',
    `<h1>Connect ${e(input.client.name)}?</h1>
<p class="lede">Signed in as <strong>${e(input.account.email)}</strong>.</p>
<form class="stack rc-card" method="post" action="/oauth/authorize">
  ${hidden('csrf', input.csrf)}${Object.entries(input.params)
    .map(([name, value]) => hidden(name, value))
    .join('')}
  <p><strong>${e(input.client.name)}</strong> wants to use ReloCat for you. It will be able to:</p>
  ${scopeList(input.scopes)}
  ${
    input.scopes.includes('bank:manage')
      ? '<p class="rc-note">About your bank data: this application may start a bank connection, but a bank is only connected after you approve on the bank’s own page yourself. It may import a statement you give it, after telling you what the statement contains. It receives totals, balances and the state of your connections, not your individual movements, and nothing it can do moves money.</p>'
      : ''
  }
  <p class="hint">It cannot see your password, and it cannot reach anybody else’s data. The name above was supplied by the application and is not verified by ReloCat. After you choose, you return to <strong>${e(target.host || target.protocol)}</strong>.</p>
  ${
    local
      ? '<p class="rc-note rc-note--warn">This application runs on your own device (a local address). Allow it only if you started this connection yourself.</p>'
      : ''
  }
  <div class="actions">
    <button class="rc-btn rc-btn--primary" type="submit" name="decision" value="allow">Allow</button>
    <button class="rc-btn" type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>
<p class="hint">You can remove this access at any time on your account page.</p>`,
    { account: input.account, csrf: input.csrf },
  );
}

export type StoredSummary = {
  userId: string;
  createdAt: string;
  lastLoginAt: string | null;
  /** Rows stored about the person, by kind. */
  counts: { label: string; count: number }[];
  /** The resolved answers, as `group.field` and a printable value. */
  answers: { field: string; value: string }[];
};

/** Ledger categories as a person reads them. */
export const categoryLabels: Record<string, string> = {
  income: 'Income',
  housing: 'Housing',
  food: 'Food',
  transport: 'Transport',
  utilities: 'Utilities',
  subscriptions: 'Subscriptions',
  healthcare: 'Health',
  education: 'Education',
  debt: 'Debt',
  other: 'Other',
  internal_transfer: 'Transfer between my accounts',
};

/** Integer cents as an amount in euros: `-1234` is `−€12.34`. */
export function euros(cents: number) {
  const amount = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Math.abs(cents) / 100);
  return cents < 0 ? `−${amount}` : amount;
}

const day = (iso: string | null) => (iso ? e(iso.slice(0, 10)) : 'never');
const minute = (iso: string | null) => (iso ? e(`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`) : 'never');
const syntheticTag = (synthetic: boolean | null) =>
  synthetic === true ? ' <span class="tag">fictional data</span>' : '';

/** What the bank section of the account page shows. Everything is the signed-in person's own. */
export type BankSection = {
  /** False when the bank part could not be loaded; the rest of the page still works. */
  available: boolean;
  banks: { id: string; displayName: string; synthetic: boolean; connect: 'consent_at_bank' | 'direct' }[];
  connections: {
    id: string;
    providerId: string;
    displayName: string;
    synthetic: boolean | null;
    webhooks: boolean;
    polling: boolean;
    consent: 'not_required' | 'granted' | 'expired';
    consentExpiresAt: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  }[];
  pendingConsents: { providerId: string; expiresAt: string }[];
  accounts: { id: string; name: string; balanceCents: number | null; synthetic: boolean }[];
  imports: { id: string; createdAt: string; rowCount: number; coveredFrom: string; coveredTo: string }[];
  movements: {
    id: string;
    accountId: string;
    date: string;
    description: string;
    amountCents: number;
    category: string;
    status: string;
    synthetic: boolean;
    categoryChosen: boolean;
  }[];
  total: number;
  page: number;
  pageSize: number;
  from?: string;
  to?: string;
  /** The account that holds imported statements; only its movements can be deleted. */
  manualAccountId: string;
};

function bankSection(csrf: string, bank: BankSection) {
  if (!bank.available)
    return `<section class="rc-card" id="bank" aria-labelledby="bank-title"><h2 id="bank-title">Your bank data</h2>
<p class="rc-note rc-note--warn">Your bank data cannot be shown right now. Try again in a moment.</p></section>`;
  const token = hidden('csrf', csrf);
  const connectedProviders = new Set(bank.connections.map(connection => connection.providerId));
  const banks = bank.banks.length
    ? `<ul class="plain">${bank.banks
        .map(item => {
          const again = connectedProviders.has(item.id);
          const how =
            item.connect === 'consent_at_bank'
              ? 'You approve access on the bank’s own page and come back here.'
              : 'A demo feed that fabricates movements; there is nothing to approve.';
          return `<li class="row"><div><strong>${e(item.displayName)}</strong>${syntheticTag(item.synthetic)}
<p class="hint">${how}</p></div>
<form method="post" action="/account/bank/connect">${token}${hidden('provider', item.id)}
<button class="rc-btn rc-btn--sm" type="submit">${again && item.connect === 'consent_at_bank' ? 'Connect again' : 'Connect'}</button></form></li>`;
        })
        .join('')}</ul>`
    : '<p class="hint">No bank can be connected on this server.</p>';
  const state = (connection: BankSection['connections'][number]) => {
    if (connection.consent === 'expired')
      return 'Your consent at the bank has expired: nothing is fetched until you connect this bank again.';
    if (connection.lastError) return `Last attempt failed: ${e(connection.lastError)}`;
    return connection.lastSyncAt ? `Last fetched ${minute(connection.lastSyncAt)}` : 'Not fetched yet';
  };
  const feed = (connection: BankSection['connections'][number]) =>
    connection.webhooks
      ? 'the bank tells ReloCat when something changes'
      : connection.polling
        ? 'checked regularly'
        : 'fetched when you ask';
  const connections = bank.connections.length
    ? `<ul class="plain">${bank.connections
        .map(
          connection => `<li class="row"><div><strong>${e(connection.displayName)}</strong>${syntheticTag(connection.synthetic)}
<p class="hint">${state(connection)} · ${feed(connection)}${
            connection.consent === 'granted' && connection.consentExpiresAt
              ? ` · consent until ${day(connection.consentExpiresAt)}`
              : ''
          }</p></div>
<div class="actions">
<form method="post" action="/account/bank/sync">${token}${hidden('connection', connection.id)}
<button class="rc-btn rc-btn--sm" type="submit">Fetch now</button></form>
<form method="post" action="/account/bank/disconnect">${token}${hidden('connection', connection.id)}
<button class="rc-btn rc-btn--sm rc-btn--quiet" type="submit">Disconnect</button></form></div></li>`,
        )
        .join('')}</ul>`
    : '<p class="hint">No bank is connected. Your plan then uses only the figures you stated yourself.</p>';
  const pending = bank.pendingConsents.length
    ? `<p class="hint">${bank.pendingConsents.length} authorisation(s) started at a bank and not finished; they lapse by ${minute(
        bank.pendingConsents[0].expiresAt,
      )}.</p>`
    : '';
  const accounts = bank.accounts.length
    ? `<div class="scroll"><table class="rc-table"><thead><tr><th>Account</th><th class="num">Balance today</th></tr></thead><tbody>${bank.accounts
        .map(
          account =>
            `<tr><td>${e(account.name)}${syntheticTag(account.synthetic)}${
              account.id === bank.manualAccountId ? ' <span class="tag">net of imported movements</span>' : ''
            }</td><td class="num">${account.balanceCents === null ? 'unknown' : e(euros(account.balanceCents))}</td></tr>`,
        )
        .join('')}</tbody></table></div>
<p class="hint">A balance is not what you have saved for a home: it also holds rent, bills and reserves. ReloCat never counts it as purchase savings unless you say so.</p>`
    : '';
  const imports = bank.imports.length
    ? `<ul class="plain">${bank.imports
        .map(
          item => `<li class="row"><div>${e(item.coveredFrom)} to ${e(item.coveredTo)} · ${e(item.rowCount)} rows
<p class="hint">Imported ${day(item.createdAt)}</p></div>
<form method="post" action="/account/bank/import/delete">${token}${hidden('import', item.id)}
<button class="rc-btn rc-btn--sm rc-btn--quiet" type="submit">Delete with its movements</button></form></li>`,
        )
        .join('')}</ul>`
    : '';
  const filter = new URLSearchParams();
  if (bank.from) filter.set('from', bank.from);
  if (bank.to) filter.set('to', bank.to);
  const pageLink = (page: number, label: string) => {
    const query = new URLSearchParams(filter);
    if (page > 1) query.set('page', String(page));
    const text = query.toString();
    return `<a class="rc-btn rc-btn--sm" href="/account${text ? `?${e(text)}` : ''}#movements">${label}</a>`;
  };
  const pages = Math.max(1, Math.ceil(bank.total / bank.pageSize));
  const back = hidden('from', bank.from) + hidden('to', bank.to) + hidden('page', String(bank.page));
  const rows = bank.movements
    .map(movement => {
      const allowed = Object.keys(categoryLabels).filter(category =>
        category === 'other' || category === 'internal_transfer'
          ? true
          : (category === 'income') === movement.amountCents > 0,
      );
      const options = allowed
        .map(
          category =>
            `<option value="${e(category)}"${category === movement.category ? ' selected' : ''}>${e(categoryLabels[category])}</option>`,
        )
        .join('');
      const remove =
        movement.accountId === bank.manualAccountId
          ? `<form method="post" action="/account/bank/movement/delete">${token}${back}${hidden('movement', movement.id)}
<button class="rc-btn rc-btn--sm rc-btn--quiet" type="submit" aria-label="Delete this movement">Delete</button></form>`
          : '';
      return `<tr><td class="date">${e(movement.date)}</td>
<td>${e(movement.description)}${movement.status === 'pending' ? ' <span class="tag">pending</span>' : ''}${syntheticTag(movement.synthetic)}</td>
<td class="num">${e(euros(movement.amountCents))}</td>
<td><form class="inline" method="post" action="/account/bank/movement">${token}${back}${hidden('movement', movement.id)}
<select name="category" aria-label="Category of this movement">${options}</select>
<button class="rc-btn rc-btn--sm" type="submit">Save</button>${movement.categoryChosen ? '<span class="tag">your choice</span>' : ''}</form></td>
<td>${remove}</td></tr>`;
    })
    .join('');
  const movements = `<h3 id="movements">Your movements</h3>
<form class="inline" method="get" action="/account">
  <label>From <input type="date" name="from" value="${e(bank.from)}"></label>
  <label>To <input type="date" name="to" value="${e(bank.to)}"></label>
  <button class="rc-btn rc-btn--sm" type="submit">Show</button>
  ${bank.from || bank.to ? '<a href="/account#movements">All dates</a>' : ''}
</form>
${
  bank.movements.length
    ? `<div class="scroll"><table class="rc-table movements"><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th>Category</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="row"><p class="hint">${e(bank.total)} movement(s) · page ${e(bank.page)} of ${e(pages)}</p>
<div class="actions">${bank.page > 1 ? pageLink(bank.page - 1, 'Newer') : ''}${bank.page < pages ? pageLink(bank.page + 1, 'Older') : ''}</div></div>
<p class="hint">Choose “Transfer between my accounts” for money you moved between your own accounts, so it is not counted as income or spending. A category you choose is kept when the bank reports the movement again. Movements that came from a bank cannot be deleted here, because the next fetch would bring them back.</p>`
    : '<p class="hint">No movements for these dates.</p>'
}`;
  return `<section class="rc-card" id="bank" aria-labelledby="bank-title">
  <h2 id="bank-title">Your bank data</h2>
  <p class="hint">Only you see your movements. Assistants you connect get totals and states, not the movements themselves.</p>
  <h3>Connected banks</h3>
  ${connections}${pending}
  <h3>Connect a bank</h3>
  ${banks}
  ${accounts ? `<h3>Accounts</h3>${accounts}` : ''}
  <h3>Import a statement</h3>
  <form class="stack" method="post" action="/account/bank/import" enctype="multipart/form-data">
    ${token}
    <label class="rc-field">CSV file with the columns date, description and amount
      <input type="file" name="statement" accept=".csv,text/csv" required></label>
    <p class="hint">Dates as YYYY-MM-DD, amounts signed (money out negative), up to 256 KiB. You see a summary first; nothing is saved until you confirm.</p>
    <div><button class="rc-btn" type="submit">Read the statement</button></div>
  </form>
  ${imports ? `<h3>Statements you imported</h3>${imports}` : ''}
  ${movements}
</section>`;
}

export function accountPage(input: {
  csrf: string;
  account: { email: string };
  stored: StoredSummary;
  clients: { grantId: string; clientName: string; scopes: Scope[]; connectedAt: string }[];
  bank?: BankSection;
  notice?: string;
  error?: string;
}) {
  const { stored } = input;
  const clients = input.clients.length
    ? `<ul class="plain">${input.clients
        .map(
          client => `<li class="row"><div><strong>${e(client.clientName)}</strong>
<p class="hint">Connected ${day(client.connectedAt)} · ${client.scopes.map(scope => e(scopes[scope])).join(' · ')}</p></div>
<form method="post" action="/account/disconnect">${hidden('csrf', input.csrf)}${hidden('grant', client.grantId)}
<button class="rc-btn rc-btn--sm" type="submit">Remove access</button></form></li>`,
        )
        .join('')}</ul>`
    : '<p class="hint">No assistant or application is connected. Add ReloCat to ChatGPT or another MCP client and it will ask you here.</p>';
  return layout(
    'Your account',
    `<h1>Your account</h1>
<p class="lede">Everything ReloCat stores about you, and who else may use it.</p>
${input.notice ? `<p class="rc-note" role="status">${e(input.notice)}</p>` : ''}${errorNote(input.error)}
<section class="rc-card" aria-labelledby="stored-title">
  <h2 id="stored-title">What is stored about you</h2>
  <dl class="facts">
    <dt>Email</dt><dd>${e(input.account.email)}</dd>
    <dt>Account created</dt><dd>${day(stored.createdAt)}</dd>
    <dt>Last sign-in</dt><dd>${day(stored.lastLoginAt)}</dd>
    <dt>Your record id</dt><dd><code>${e(stored.userId)}</code></dd>
    ${stored.counts.map(item => `<dt>${e(item.label)}</dt><dd>${e(item.count)}</dd>`).join('')}
  </dl>
  ${
    stored.answers.length
      ? `<details><summary>Your saved answers (${stored.answers.length})</summary><dl class="facts">${stored.answers
          .map(answer => `<dt>${e(answer.field)}</dt><dd>${e(answer.value)}</dd>`)
          .join('')}</dl></details>`
      : '<p class="hint">You have not saved any answers yet.</p>'
  }
  <p class="hint">Your password is stored only as a salted hash. Money is stored in whole cents.</p>
  <div class="actions">
    <a class="rc-btn rc-btn--primary" href="/workspace">Open your workspace</a>
    <form method="post" action="/account/export">${hidden('csrf', input.csrf)}
      <button class="rc-btn" type="submit">Download everything as JSON</button></form>
  </div>
  <p class="hint">The download holds every row stored about you, table by table. Hashes of your password and of tokens, and sealed bank credentials, are left out and named in the file.</p>
</section>
${input.bank ? bankSection(input.csrf, input.bank) : ''}
<section class="rc-card" aria-labelledby="clients-title">
  <h2 id="clients-title">Connected assistants</h2>
  ${clients}
</section>
<section class="rc-card" aria-labelledby="password-title">
  <h2 id="password-title">Change your password</h2>
  <form class="stack" method="post" action="/account/password" autocomplete="on">
    ${hidden('csrf', input.csrf)}
    <label class="rc-field">Current password
      <input type="password" name="current" required maxlength="200" autocomplete="current-password"></label>
    <label class="rc-field">New password
      <input type="password" name="next" required minlength="${minPasswordLength}" maxlength="200" autocomplete="new-password"></label>
    <p class="hint">At least ${minPasswordLength} characters. Changing it signs you out of every other browser and disconnects every assistant; you stay signed in here.</p>
    <div><button class="rc-btn" type="submit">Change password</button></div>
  </form>
</section>
<section class="rc-card danger" aria-labelledby="delete-title">
  <h2 id="delete-title">Delete your account</h2>
  <p>This permanently deletes your account, your answers, your bank connections with their stored credentials, your movements and imported statements, habits and every connected assistant. It cannot be undone.</p>
  <form class="stack" method="post" action="/account/delete">
    ${hidden('csrf', input.csrf)}
    <label class="rc-field">Password
      <input type="password" name="password" required maxlength="200" autocomplete="current-password"></label>
    <label><input type="checkbox" name="confirm" value="yes" required> I understand that all my data will be deleted.</label>
    <div><button class="rc-btn" type="submit">Delete my account and data</button></div>
  </form>
</section>`,
    { account: input.account, csrf: input.csrf, wide: true },
  );
}

/**
 * The step between "Connect" and the bank: it says where the person is going and what the bank
 * will be asked for, and the way out is a plain link, so no form of this site ever posts to a bank.
 */
export function bankLeavePage(input: {
  csrf: string;
  account: { email: string };
  bank: { displayName: string; synthetic: boolean };
  redirectUrl: string;
  expiresAt: string;
}) {
  const host = new URL(input.redirectUrl).host;
  return layout(
    'Continue to your bank',
    `<h1>Continue to ${e(input.bank.displayName)}</h1>
<div class="rc-card stack">
  <p>You are leaving ReloCat for <strong>${e(host)}</strong>, where you allow or refuse access yourself. ReloCat never sees how you sign in there.</p>
  <p>ReloCat asks to <strong>read</strong> your accounts, balances and movements. It cannot move money.</p>
  ${
    input.bank.synthetic
      ? '<p class="rc-note">This is a fictional bank for demonstrations: its customers and movements are invented.</p>'
      : ''
  }
  <p class="hint">After you choose, the bank sends you back here. This step is valid until ${minute(input.expiresAt)} and only in this browser, while you stay signed in.</p>
  <div class="actions">
    <a class="rc-btn rc-btn--primary" rel="noreferrer" href="${e(input.redirectUrl)}">Continue to ${e(input.bank.displayName)}</a>
    <a class="rc-btn" href="/account#bank">Cancel</a>
  </div>
</div>`,
    { account: input.account, csrf: input.csrf },
  );
}

/** What a statement would add, shown before anything is saved. */
export type StatementPreview = {
  previewHash: string;
  expiresAt: string;
  alreadyImported: boolean;
  rowCount: number;
  newRows: number;
  alreadyInLedger: number;
  skippedZeroAmountRows: number;
  coveredFrom: string;
  coveredTo: string;
  coveredDays: number;
  periodTotals: { inflowCents: number; outflowCents: number; netCents: number };
  byCategory: Record<string, { count: number; cents: number }>;
  monthlyFigures: boolean;
  averagingNote: string;
};

export function statementPreviewPage(input: {
  csrf: string;
  account: { email: string };
  preview: StatementPreview;
  filename?: string;
}) {
  const { preview } = input;
  const categories = Object.entries(preview.byCategory)
    .sort((a, b) => a[1].cents - b[1].cents)
    .map(
      ([category, entry]) =>
        `<tr><td>${e(categoryLabels[category] ?? category)}</td><td class="num">${e(entry.count)}</td><td class="num">${e(euros(entry.cents))}</td></tr>`,
    )
    .join('');
  return layout(
    'Import a statement',
    `<h1>Check this statement</h1>
<p class="lede">Nothing has been saved yet. This is what the file${input.filename ? ` <strong>${e(input.filename)}</strong>` : ''} contains.</p>
<section class="rc-card stack">
  <dl class="facts">
    <dt>Period</dt><dd>${e(preview.coveredFrom)} to ${e(preview.coveredTo)} (${e(preview.coveredDays)} days)</dd>
    <dt>Rows</dt><dd>${e(preview.rowCount)}${preview.skippedZeroAmountRows ? ` (${e(preview.skippedZeroAmountRows)} more without an amount are left out)` : ''}</dd>
    <dt>New movements</dt><dd>${e(preview.newRows)}</dd>
    <dt>Already in your ledger</dt><dd>${e(preview.alreadyInLedger)}</dd>
    <dt>Came in</dt><dd>${e(euros(preview.periodTotals.inflowCents))}</dd>
    <dt>Went out</dt><dd>${e(euros(preview.periodTotals.outflowCents))}</dd>
    <dt>Net</dt><dd>${e(euros(preview.periodTotals.netCents))}</dd>
  </dl>
  <div class="scroll"><table class="rc-table"><thead><tr><th>Category</th><th class="num">Rows</th><th class="num">Sum</th></tr></thead><tbody>${categories}</tbody></table></div>
  <p class="${preview.monthlyFigures ? 'hint' : 'rc-note rc-note--warn'}">${e(preview.averagingNote)}</p>
  ${
    preview.alreadyImported
      ? '<p class="rc-note">You imported this exact statement before. Importing it again changes nothing.</p>'
      : ''
  }
  <p class="hint">The movements are saved as your own real data, in the account “Statements you imported”. Categories are guessed from the description; you can correct each one afterwards. Totals leave out transfers between your own accounts.</p>
  <div class="actions">
    <form method="post" action="/account/bank/import/confirm">${hidden('csrf', input.csrf)}${hidden('preview', preview.previewHash)}
      <button class="rc-btn rc-btn--primary" type="submit">Import ${e(preview.newRows)} movement(s)</button></form>
    <form method="post" action="/account/bank/import/cancel">${hidden('csrf', input.csrf)}${hidden('preview', preview.previewHash)}
      <button class="rc-btn" type="submit">Discard</button></form>
  </div>
  <p class="hint">This summary is kept until ${minute(preview.expiresAt)}; after that, read the file again.</p>
</section>`,
    { account: input.account, csrf: input.csrf, wide: true },
  );
}
