import { minPasswordLength } from '../../packages/auth/accounts.ts';
import { type Scope, scopes } from '../../packages/auth/oauth.ts';
import { product } from '../../packages/config/product.ts';
import { escapeHtml as e } from '../../packages/http/server.ts';
import { markDataUrl, wordmark } from '../../packages/ui/icons.ts';
import { themeCss } from '../../packages/ui/inline.ts';

/**
 * The account pages: sign up, sign in, sign out, the account and the OAuth consent screen. Plain
 * server-rendered HTML forms styled with the shared theme. There is no script on any of them, and
 * every value that came from a request or the database goes through `escapeHtml`.
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

export function accountPage(input: {
  csrf: string;
  account: { email: string };
  stored: StoredSummary;
  clients: { grantId: string; clientName: string; scopes: Scope[]; connectedAt: string }[];
  notice?: string;
  error?: string;
}) {
  const { stored } = input;
  const day = (iso: string | null) => (iso ? e(iso.slice(0, 10)) : 'never');
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
  <p><a class="rc-btn rc-btn--primary" href="/workspace">Open your workspace</a></p>
</section>
<section class="rc-card" aria-labelledby="clients-title">
  <h2 id="clients-title">Connected assistants</h2>
  ${clients}
</section>
<section class="rc-card danger" aria-labelledby="delete-title">
  <h2 id="delete-title">Delete your account</h2>
  <p>This permanently deletes your account, your answers, bank summaries, habits and every connection. It cannot be undone.</p>
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
