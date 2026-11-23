import { minPasswordLength } from '../../packages/auth/accounts.ts';
import type { Scope } from '../../packages/auth/oauth.ts';
import { product } from '../../packages/config/product.ts';
import { escapeHtml as e } from '../../packages/http/server.ts';
import { common } from '../../packages/i18n/common.ts';
import { createFormat } from '../../packages/i18n/format.ts';
import { defaultLocale, type Locale } from '../../packages/i18n/locales.ts';
import { type Catalog, translator } from '../../packages/i18n/messages.ts';
import { languageSwitcher } from '../../packages/i18n/server.ts';
import { markDataUrl, wordmark } from '../../packages/ui/icons.ts';
import { themeCss } from '../../packages/ui/inline.ts';
import { accountMessages } from './account.messages.ts';
import { authMessages } from './auth.messages.ts';
import { bankMessages, categoryMessage } from './bank.messages.ts';
import { consentMessages, scopeMessage } from './consent.messages.ts';

/**
 * The account pages: sign up, sign in, sign out, the account (with the person's own bank data, the
 * password, the export and the deletion) and the OAuth consent screen. Plain server-rendered HTML
 * forms styled with the shared theme. There is no script on any of them, every form carries the
 * CSRF token of the session, and every value that came from a request, the database or a bank goes
 * through `escapeHtml`.
 *
 * Every page takes the language it is written in as its last argument (English when left out). The
 * texts come from the catalogs next to this file; a message may carry `<strong>` of its own, and
 * the values put into it are escaped first.
 */

const layoutCss = `
  body { min-height: 100vh; min-height: 100dvh; }
  .page { width: min(100% - 2 * var(--rc-space-5), 34rem); margin: 0 auto; padding: var(--rc-space-8) 0 var(--rc-space-12); }
  .page--wide { width: min(100% - 2 * var(--rc-space-5), 46rem); }
  .top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--rc-space-2) var(--rc-space-4); margin-bottom: var(--rc-space-8); }
  .top nav { display: flex; flex-wrap: wrap; gap: 0 var(--rc-space-4); align-items: center; min-width: 0; font-size: var(--rc-text-sm); }
  .top nav span { min-width: 0; overflow-wrap: anywhere; }
  .top nav a, .inline > a { display: inline-flex; align-items: center; min-height: var(--rc-control); }
  h1 { font-size: var(--rc-text-2xl); line-height: 2rem; margin: 0 0 var(--rc-space-2); }
  h2 { font-size: var(--rc-text-lg); line-height: 1.5rem; letter-spacing: 0; margin: 0 0 var(--rc-space-3); }
  h3 { font-size: var(--rc-text-md); line-height: 1.25rem; margin: var(--rc-space-5) 0 var(--rc-space-2); }
  p:not(.rc-note) { max-width: var(--rc-measure); }
  .lede { color: var(--rc-muted); margin: 0 0 var(--rc-space-6); overflow-wrap: anywhere; }
  .page > .rc-note { margin-bottom: var(--rc-space-4); }
  .page > .hint { margin-top: var(--rc-space-4); }
  /* A form: 20 px between fields, 4 px from a field to its hint, 24 px before the action. */
  form.stack, .stack { display: grid; gap: var(--rc-space-5); }
  .stack > .rc-field + .hint { margin-top: calc(var(--rc-space-1) - var(--rc-space-5)); }
  .stack > .rc-btn, .stack > .actions { margin-top: var(--rc-space-1); }
  .rc-field input:not([type="checkbox"], [type="radio"]) { min-height: var(--rc-control-lg); }
  @media (pointer: coarse) {
    .rc-field input:not([type="checkbox"], [type="radio"]) { min-height: calc(var(--rc-control-lg) + var(--rc-space-2)); }
  }
  .rc-card + .rc-card { margin-top: var(--rc-space-6); }
  .rc-card:not(.stack) > * + * { margin-top: var(--rc-space-3); }
  .rc-card:not(.stack) > h3 { margin-top: var(--rc-space-6); }
  .row { display: flex; flex-wrap: wrap; gap: var(--rc-space-3); align-items: center; justify-content: space-between; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--rc-space-3); }
  .facts { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: var(--rc-space-2) var(--rc-space-4); margin: 0; font-size: var(--rc-text-sm); }
  .facts dt { color: var(--rc-muted); }
  .facts dd { margin: 0; overflow-wrap: anywhere; }
  .stack > ul { margin: 0; padding-left: var(--rc-space-5); }
  ul.plain { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--rc-space-3); }
  .hint { color: var(--rc-muted); font-size: var(--rc-text-sm); margin: 0; }
  .danger { border-color: var(--rc-danger); }
  code { overflow-wrap: anywhere; }
  .scroll { overflow-x: auto; }
  .rc-table { width: 100%; font-size: var(--rc-text-sm); }
  .rc-table td.num, .rc-table th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .inline { display: flex; flex-wrap: wrap; gap: var(--rc-space-2) var(--rc-space-3); align-items: center; }
  .inline label { display: inline-flex; align-items: center; gap: var(--rc-space-2); font-size: var(--rc-text-sm); }
  .inline select, .inline input[type="date"] { width: auto; }
  .movements { min-width: 40rem; }
  .movements td.date { white-space: nowrap; }
  .movements select { max-width: 10rem; }
  .tag { display: inline-block; border: 1px solid var(--rc-line); border-radius: var(--rc-radius-pill); padding: 0 var(--rc-space-2); font-size: var(--rc-text-xs); line-height: 1.25rem; white-space: nowrap; color: var(--rc-muted); }
`;

/** The language switcher in the page header; only a page that has one carries these rules. */
const switcherCss = `
  .top .rc-lang { gap: var(--rc-space-1); margin-left: calc(-1 * var(--rc-space-2)); }
`;

export type PageAccount = { email: string } | null;

/**
 * The language of a page. `path` is where the language switcher links to: the page's own path and
 * query, which must answer a GET. Without it the page has no switcher (a page that exists only as
 * the answer to a form keeps the language already chosen).
 */
export type PageLanguage = { locale?: Locale; path?: string };

type Values = Record<string, string | number>;

/** `t(key, values, markup)`: the message with its values escaped; `markup` values are trusted tags. */
function writer<Key extends string>(catalog: Catalog<Key>, locale: Locale) {
  const translate = translator(catalog, locale);
  return (key: Key, values: Values = {}, markup: Record<string, string> = {}) => {
    const safe: Values = { ...markup };
    for (const [name, value] of Object.entries(values)) safe[name] = typeof value === 'number' ? value : e(value);
    return translate(key, safe);
  };
}

/** Integer cents as an amount in euros: `-1234` is `−€12.34`, and `−12,34 €` in Catalan and Spanish. */
export function euros(cents: number, locale: Locale = defaultLocale) {
  const amount = createFormat(locale).eurosExact(Math.abs(cents));
  return cents < 0 ? `−${amount}` : amount;
}

/** Everything a page needs to write itself in one language. */
function languageOf({ locale = defaultLocale, path }: PageLanguage = {}) {
  const format = createFormat(locale);
  const english = locale === defaultLocale;
  const account = writer(accountMessages, locale);
  /** English keeps the ISO day it has always printed; Catalan and Spanish write the date out. */
  const date = (iso: string) => (english ? iso.slice(0, 10) : format.date(iso.slice(0, 10)));
  return {
    locale,
    path,
    common: writer(common, locale),
    auth: writer(authMessages, locale),
    consent: writer(consentMessages, locale),
    account,
    bank: writer(bankMessages, locale),
    /** A calendar day. Not escaped. */
    date,
    /** A stored timestamp as a day, or the word for "never". Escaped. */
    day: (iso: string | null) => (iso ? e(date(iso)) : account('never')),
    /** A stored timestamp to the minute, in UTC, or the word for "never". Escaped. */
    minute: (iso: string | null) =>
      iso ? e(`${date(iso)}${english ? '' : ','} ${iso.slice(11, 16)} UTC`) : account('never'),
    /** A count as the language writes it; English keeps the plain digits it has always printed. */
    count: (value: number) => (english ? String(value) : format.count(value)),
    money: (cents: number) => euros(cents, locale),
  };
}
type Language = ReturnType<typeof languageOf>;

/** One complete page. `body` is trusted markup built by the functions below. */
function layout(
  title: string,
  body: string,
  options: { account?: PageAccount; csrf?: string; wide?: boolean; language?: Language } = {},
) {
  const l = options.language ?? languageOf();
  const nav = options.account
    ? `<span class="rc-muted">${e(options.account.email)}</span><a href="/account">${l.auth('navAccount')}</a>
       <form method="post" action="/logout"><input type="hidden" name="csrf" value="${e(options.csrf)}">
       <button class="rc-btn rc-btn--sm rc-btn--quiet" type="submit">${l.common('signOut')}</button></form>`
    : `<a href="/login">${l.common('signIn')}</a><a href="/signup">${l.common('createAccount')}</a>`;
  return `<!doctype html>
<html lang="${l.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(title)} · ${e(product.name)}</title>
<link rel="icon" href="${markDataUrl}">
<style>${themeCss()}${layoutCss}${l.path === undefined ? '' : switcherCss}</style>
</head>
<body>
<main class="page${options.wide ? ' page--wide' : ''}">
<header class="top">${wordmark({ href: '/connect' })}<nav aria-label="${l.auth('navLabel')}">${nav}</nav>${
    l.path === undefined ? '' : languageSwitcher(l.locale, l.path)
  }</header>
${body}
</main>
</body>
</html>`;
}

const errorNote = (message?: string) =>
  message ? `<p class="rc-note rc-note--error" id="form-error" role="alert">${e(message)}</p>` : '';
/** Ties a field to the form's error message, and to its own hint, for assistive technology. */
const describedBy = (error: string | undefined, hint?: string) => {
  const ids = [hint, error ? 'form-error' : undefined].filter(Boolean).join(' ');
  return ids ? ` aria-describedby="${ids}"` : '';
};
const hidden = (name: string, value: string | undefined) =>
  value === undefined ? '' : `<input type="hidden" name="${e(name)}" value="${e(value)}">`;

/** A title and one sentence, both already in the language of the page. */
export function messagePage(
  title: string,
  message: string,
  account: PageAccount = null,
  csrf?: string,
  language?: PageLanguage,
) {
  const l = languageOf(language);
  return layout(
    title,
    `<h1>${e(title)}</h1><p class="lede">${e(message)}</p><p><a class="rc-btn" href="/connect">${l.auth('backToRelocat')}</a></p>`,
    { account, csrf, language: l },
  );
}

/** `error` is already in the language of the page. */
export function signUpPage(
  input: { csrf: string; next?: string; email?: string; error?: string; closed?: boolean },
  language?: PageLanguage,
) {
  const l = languageOf(language);
  const title = l.common('createAccount');
  if (input.closed)
    return layout(title, `<h1>${title}</h1><p class="rc-note">${l.auth('signUpClosed')}</p>`, { language: l });
  const signIn = `<a href="/login${input.next ? `?next=${encodeURIComponent(input.next)}` : ''}">`;
  return layout(
    title,
    `<h1>${l.auth('signUpHeading')}</h1>
<p class="lede">${l.auth('signUpLede')}</p>
${errorNote(input.error)}
<form class="stack rc-card" method="post" action="/signup" autocomplete="on">
  ${hidden('csrf', input.csrf)}${hidden('next', input.next)}
  <label class="rc-field">${l.auth('email')}
    <input type="email" name="email" required maxlength="254" autocomplete="email" autocapitalize="none" spellcheck="false"${describedBy(input.error)} value="${e(input.email)}"></label>
  <label class="rc-field">${l.auth('password')}
    <input type="password" name="password" required minlength="${minPasswordLength}" maxlength="200" autocomplete="new-password"${describedBy(input.error, 'password-hint')}>
  </label>
  <p class="hint" id="password-hint">${l.auth('signUpPasswordHint', { min: String(minPasswordLength) })}</p>
  <button class="rc-btn rc-btn--primary" type="submit">${title}</button>
</form>
<p class="hint">${l.auth('signUpHaveOne', {}, { link: signIn, endLink: '</a>' })}</p>`,
    { language: l },
  );
}

/** `error` and `notice` are already in the language of the page. */
export function loginPage(
  input: { csrf: string; next?: string; email?: string; error?: string; notice?: string },
  language?: PageLanguage,
) {
  const l = languageOf(language);
  const title = l.common('signIn');
  const signUp = `<a href="/signup${input.next ? `?next=${encodeURIComponent(input.next)}` : ''}">`;
  return layout(
    title,
    `<h1>${title}</h1>
<p class="lede">${l.auth('loginLede')}</p>
${input.notice ? `<p class="rc-note" role="status">${e(input.notice)}</p>` : ''}${errorNote(input.error)}
<form class="stack rc-card" method="post" action="/login" autocomplete="on">
  ${hidden('csrf', input.csrf)}${hidden('next', input.next)}
  <label class="rc-field">${l.auth('email')}
    <input type="email" name="email" required maxlength="254" autocomplete="username" autocapitalize="none" spellcheck="false"${describedBy(input.error)} value="${e(input.email)}"></label>
  <label class="rc-field">${l.auth('password')}
    <input type="password" name="password" required maxlength="200" autocomplete="current-password"${describedBy(input.error)}></label>
  <button class="rc-btn rc-btn--primary" type="submit">${title}</button>
</form>
<p class="hint">${l.auth('loginNewHere', {}, { link: signUp, endLink: '</a>' })}</p>`,
    { language: l },
  );
}

export function logoutPage(input: { csrf: string; account: PageAccount }, language?: PageLanguage) {
  const l = languageOf(language);
  const title = l.common('signOut');
  return layout(
    title,
    `<h1>${title}</h1>
<form class="stack rc-card" method="post" action="/logout">
  ${hidden('csrf', input.csrf)}
  <p>${l.auth('logoutQuestion')}</p>
  <div class="actions"><button class="rc-btn rc-btn--primary" type="submit">${title}</button>
  <a class="rc-btn" href="/account">${l.common('cancel')}</a></div>
</form>`,
    { ...input, language: l },
  );
}

const scopeList = (granted: Scope[], l: Language) =>
  `<ul>${granted.map(scope => `<li>${l.consent(scopeMessage[scope])}</li>`).join('')}</ul>`;

/** The consent screen: which application asks, where it will be sent back to, and what it may do. */
export function consentPage(
  input: {
    csrf: string;
    account: { email: string };
    client: { name: string };
    redirectUri: string;
    scopes: Scope[];
    /** The original authorization parameters, replayed by the form so the POST is validated again. */
    params: Record<string, string>;
  },
  language?: PageLanguage,
) {
  const l = languageOf(language);
  const target = new URL(input.redirectUri);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !/^https?:$/.test(target.protocol);
  return layout(
    l.consent('title'),
    `<h1>${l.consent('heading', { client: input.client.name })}</h1>
<p class="lede">${l.consent('signedInAs', { email: input.account.email })}</p>
<form class="stack rc-card" method="post" action="/oauth/authorize">
  ${hidden('csrf', input.csrf)}${Object.entries(input.params)
    .map(([name, value]) => hidden(name, value))
    .join('')}
  <p>${l.consent('wants', { client: input.client.name })}</p>
  ${scopeList(input.scopes, l)}
  ${input.scopes.includes('bank:manage') ? `<p class="rc-note">${l.consent('bankNote')}</p>` : ''}
  <p class="hint">${l.consent('limits', { host: target.host || target.protocol })}</p>
  ${local ? `<p class="rc-note rc-note--warn">${l.consent('local')}</p>` : ''}
  <div class="actions">
    <button class="rc-btn rc-btn--primary" type="submit" name="decision" value="allow">${l.consent('allow')}</button>
    <button class="rc-btn" type="submit" name="decision" value="deny">${l.consent('deny')}</button>
  </div>
</form>
<p class="hint">${l.consent('removable')}</p>`,
    { account: input.account, csrf: input.csrf, language: l },
  );
}

export type StoredSummary = {
  userId: string;
  createdAt: string;
  lastLoginAt: string | null;
  /** Rows stored about the person, by kind. The label is already in the language of the page. */
  counts: { label: string; count: number }[];
  /** The resolved answers, as `group.field` and a printable value. */
  answers: { field: string; value: string }[];
};

const categoryIds = Object.keys(categoryMessage) as (keyof typeof categoryMessage)[];
const isCategory = (category: string): category is keyof typeof categoryMessage =>
  Object.hasOwn(categoryMessage, category);

/** Ledger categories as a person reads them, in English. */
export const categoryLabels: Record<string, string> = Object.fromEntries(
  categoryIds.map(category => [category, bankMessages.en[categoryMessage[category]]]),
);

/** A ledger category in the language of the page; one this page does not know keeps its id. Escaped. */
const categoryLabel = (category: string, l: Language) =>
  isCategory(category) ? l.bank(categoryMessage[category]) : e(category);

const syntheticTag = (synthetic: boolean | null, l: Language) =>
  synthetic === true ? ` <span class="tag">${l.bank('fictionalTag')}</span>` : '';

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

function bankSection(csrf: string, bank: BankSection, l: Language) {
  const t = l.bank;
  if (!bank.available)
    return `<section class="rc-card" id="bank" aria-labelledby="bank-title"><h2 id="bank-title">${t('title')}</h2>
<p class="rc-note rc-note--warn">${t('unavailable')}</p></section>`;
  const token = hidden('csrf', csrf);
  const english = l.locale === defaultLocale;
  const connectedProviders = new Set(bank.connections.map(connection => connection.providerId));
  const banks = bank.banks.length
    ? `<ul class="plain">${bank.banks
        .map(item => {
          const again = connectedProviders.has(item.id) && item.connect === 'consent_at_bank';
          const how = item.connect === 'consent_at_bank' ? t('howConsent') : t('howDirect');
          return `<li class="row"><div><strong>${e(item.displayName)}</strong>${syntheticTag(item.synthetic, l)}
<p class="hint">${how}</p></div>
<form method="post" action="/account/bank/connect">${token}${hidden('provider', item.id)}
<button class="rc-btn rc-btn--sm" type="submit" aria-label="${t(again ? 'connectAgainBank' : 'connectBank', { bank: item.displayName })}">${t(again ? 'connectAgain' : 'connect')}</button></form></li>`;
        })
        .join('')}</ul>`
    : `<p class="hint">${t('noBanks')}</p>`;
  const state = (connection: BankSection['connections'][number]) => {
    if (connection.consent === 'expired') return t('stateExpired');
    if (connection.lastError) return t('stateFailed', { error: connection.lastError });
    return connection.lastSyncAt ? t('stateFetched', {}, { time: l.minute(connection.lastSyncAt) }) : t('stateNever');
  };
  const feed = (connection: BankSection['connections'][number]) =>
    connection.webhooks ? t('feedWebhooks') : connection.polling ? t('feedPolling') : t('feedManual');
  const connections = bank.connections.length
    ? `<ul class="plain">${bank.connections
        .map(
          connection => `<li class="row"><div><strong>${e(connection.displayName)}</strong>${syntheticTag(connection.synthetic, l)}
<p class="hint">${state(connection)} · ${feed(connection)}${
            connection.consent === 'granted' && connection.consentExpiresAt
              ? ` · ${t('consentUntil', {}, { date: l.day(connection.consentExpiresAt) })}`
              : ''
          }</p></div>
<div class="actions">
<form method="post" action="/account/bank/sync">${token}${hidden('connection', connection.id)}
<button class="rc-btn rc-btn--sm" type="submit" aria-label="${t('fetchNowFrom', { bank: connection.displayName })}">${t('fetchNow')}</button></form>
<form method="post" action="/account/bank/disconnect">${token}${hidden('connection', connection.id)}
<button class="rc-btn rc-btn--sm rc-btn--quiet" type="submit" aria-label="${t('disconnectBank', { bank: connection.displayName })}">${t('disconnect')}</button></form></div></li>`,
        )
        .join('')}</ul>`
    : `<p class="hint">${t('noConnections')}</p>`;
  const pending = bank.pendingConsents.length
    ? `<p class="hint">${t(
        'pending',
        { count: bank.pendingConsents.length },
        { time: l.minute(bank.pendingConsents[0].expiresAt) },
      )}</p>`
    : '';
  const accountName = (account: BankSection['accounts'][number]) =>
    // The account for statements is named by the product, not by the person or a bank.
    !english && account.id === bank.manualAccountId && account.name === bankMessages.en.manualAccountName
      ? t('manualAccountName')
      : e(account.name);
  const accounts = bank.accounts.length
    ? `<div class="scroll"><table class="rc-table"><thead><tr><th>${t('accountColumn')}</th><th class="num">${t('balanceColumn')}</th></tr></thead><tbody>${bank.accounts
        .map(
          account =>
            `<tr><td>${accountName(account)}${syntheticTag(account.synthetic, l)}${
              account.id === bank.manualAccountId ? ` <span class="tag">${t('netImported')}</span>` : ''
            }</td><td class="num">${account.balanceCents === null ? t('balanceUnknown') : e(l.money(account.balanceCents))}</td></tr>`,
        )
        .join('')}</tbody></table></div>
<p class="hint">${t('balanceNote')}</p>`
    : '';
  const imports = bank.imports.length
    ? `<ul class="plain">${bank.imports
        .map(
          item => `<li class="row"><div>${t('importRange', { from: l.date(item.coveredFrom), to: l.date(item.coveredTo), rows: item.rowCount })}
<p class="hint">${t('imported', {}, { date: l.day(item.createdAt) })}</p></div>
<form method="post" action="/account/bank/import/delete">${token}${hidden('import', item.id)}
<button class="rc-btn rc-btn--sm rc-btn--quiet" type="submit">${t('deleteImport')}</button></form></li>`,
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
      const allowed = categoryIds.filter(category =>
        category === 'other' || category === 'internal_transfer'
          ? true
          : (category === 'income') === movement.amountCents > 0,
      );
      const options = allowed
        .map(
          category =>
            `<option value="${e(category)}"${category === movement.category ? ' selected' : ''}>${categoryLabel(category, l)}</option>`,
        )
        .join('');
      const remove =
        movement.accountId === bank.manualAccountId
          ? `<form method="post" action="/account/bank/movement/delete">${token}${back}${hidden('movement', movement.id)}
<button class="rc-btn rc-btn--sm rc-btn--quiet" type="submit" aria-label="${t('deleteMovement')}">${t('delete')}</button></form>`
          : '';
      return `<tr><td class="date">${e(l.date(movement.date))}</td>
<td>${e(movement.description)}${movement.status === 'pending' ? ` <span class="tag">${t('pendingTag')}</span>` : ''}${syntheticTag(movement.synthetic, l)}</td>
<td class="num">${e(l.money(movement.amountCents))}</td>
<td><form class="inline" method="post" action="/account/bank/movement">${token}${back}${hidden('movement', movement.id)}
<select class="rc-input" name="category" aria-label="${t('categoryOf')}">${options}</select>
<button class="rc-btn rc-btn--sm" type="submit" aria-label="${t('saveCategory')}">${t('save')}</button>${movement.categoryChosen ? `<span class="tag">${t('yourChoice')}</span>` : ''}</form></td>
<td>${remove}</td></tr>`;
    })
    .join('');
  const movements = `<h3 id="movements">${t('movementsTitle')}</h3>
<form class="inline" method="get" action="/account">
  <label>${t('from')} <input class="rc-input" type="date" name="from" value="${e(bank.from)}"></label>
  <label>${t('to')} <input class="rc-input" type="date" name="to" value="${e(bank.to)}"></label>
  <button class="rc-btn rc-btn--sm" type="submit">${t('show')}</button>
  ${bank.from || bank.to ? `<a href="/account#movements">${t('allDates')}</a>` : ''}
</form>
${
  bank.movements.length
    ? `<div class="scroll"><table class="rc-table movements"><thead><tr><th>${t('dateColumn')}</th><th>${t('descriptionColumn')}</th><th class="num">${t('amountColumn')}</th><th>${t('categoryColumn')}</th><th><span class="rc-sr-only">${t('deleteColumn')}</span></th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="row"><p class="hint">${t('movementCount', { total: bank.total, page: l.count(bank.page), pages: l.count(pages) })}</p>
<div class="actions">${bank.page > 1 ? pageLink(bank.page - 1, t('newer')) : ''}${bank.page < pages ? pageLink(bank.page + 1, t('older')) : ''}</div></div>
<p class="hint">${t('movementsNote')}</p>`
    : `<p class="hint">${t('noMovements')}</p>`
}`;
  return `<section class="rc-card" id="bank" aria-labelledby="bank-title">
  <h2 id="bank-title">${t('title')}</h2>
  <p class="hint">${t('privacy')}</p>
  <h3>${t('connectedTitle')}</h3>
  ${connections}${pending}
  <h3>${t('connectTitle')}</h3>
  ${banks}
  ${accounts ? `<h3>${t('accountsTitle')}</h3>${accounts}` : ''}
  <h3>${t('importTitle')}</h3>
  <form class="stack" method="post" action="/account/bank/import" enctype="multipart/form-data">
    ${token}
    <label class="rc-field">${t('csvLabel')}
      <input type="file" name="statement" accept=".csv,text/csv" required></label>
    <p class="hint">${t('csvHint')}</p>
    <div class="actions"><button class="rc-btn" type="submit">${t('readStatement')}</button></div>
  </form>
  ${imports ? `<h3>${t('importsTitle')}</h3>${imports}` : ''}
  ${movements}
</section>`;
}

/** `notice`, `error` and the labels of `stored.counts` are already in the language of the page. */
export function accountPage(
  input: {
    csrf: string;
    account: { email: string };
    stored: StoredSummary;
    clients: { grantId: string; clientName: string; scopes: Scope[]; connectedAt: string }[];
    bank?: BankSection;
    notice?: string;
    error?: string;
  },
  language?: PageLanguage,
) {
  const l = languageOf(language);
  const t = l.account;
  const { stored } = input;
  const clients = input.clients.length
    ? `<ul class="plain">${input.clients
        .map(
          client => `<li class="row"><div><strong>${e(client.clientName)}</strong>
<p class="hint">${t(
            'clientConnected',
            {},
            {
              date: l.day(client.connectedAt),
              scopes: client.scopes.map(scope => l.consent(scopeMessage[scope])).join(' · '),
            },
          )}</p></div>
<form method="post" action="/account/disconnect">${hidden('csrf', input.csrf)}${hidden('grant', client.grantId)}
<button class="rc-btn rc-btn--sm" type="submit" aria-label="${t('removeAccessOf', { client: client.clientName })}">${t('removeAccess')}</button></form></li>`,
        )
        .join('')}</ul>`
    : `<p class="hint">${t('noClients')}</p>`;
  return layout(
    t('title'),
    `<h1>${t('title')}</h1>
<p class="lede">${t('lede')}</p>
${input.notice ? `<p class="rc-note" role="status">${e(input.notice)}</p>` : ''}${errorNote(input.error)}
<section class="rc-card" aria-labelledby="stored-title">
  <h2 id="stored-title">${t('storedTitle')}</h2>
  <dl class="facts">
    <dt>${l.auth('email')}</dt><dd>${e(input.account.email)}</dd>
    <dt>${t('created')}</dt><dd>${l.day(stored.createdAt)}</dd>
    <dt>${t('lastSignIn')}</dt><dd>${l.day(stored.lastLoginAt)}</dd>
    <dt>${t('recordId')}</dt><dd><code>${e(stored.userId)}</code></dd>
    ${stored.counts.map(item => `<dt>${e(item.label)}</dt><dd>${e(l.count(item.count))}</dd>`).join('')}
  </dl>
  ${
    stored.answers.length
      ? `<details><summary>${t('savedAnswers', { count: l.count(stored.answers.length) })}</summary><dl class="facts">${stored.answers
          .map(answer => `<dt>${e(answer.field)}</dt><dd>${e(answer.value)}</dd>`)
          .join('')}</dl></details>`
      : `<p class="hint">${t('noAnswers')}</p>`
  }
  <p class="hint">${t('storageNote')}</p>
  <div class="actions">
    <a class="rc-btn rc-btn--primary" href="/workspace">${t('openWorkspace')}</a>
    <form method="post" action="/account/export">${hidden('csrf', input.csrf)}
      <button class="rc-btn" type="submit">${t('download')}</button></form>
  </div>
  <p class="hint">${t('downloadNote')}</p>
</section>
${input.bank ? bankSection(input.csrf, input.bank, l) : ''}
<section class="rc-card" aria-labelledby="clients-title">
  <h2 id="clients-title">${t('clientsTitle')}</h2>
  ${clients}
</section>
<section class="rc-card" aria-labelledby="password-title">
  <h2 id="password-title">${t('passwordTitle')}</h2>
  <form class="stack" method="post" action="/account/password" autocomplete="on">
    ${hidden('csrf', input.csrf)}
    <label class="rc-field">${t('currentPassword')}
      <input type="password" name="current" required maxlength="200" autocomplete="current-password"></label>
    <label class="rc-field">${t('newPassword')}
      <input type="password" name="next" required minlength="${minPasswordLength}" maxlength="200" autocomplete="new-password" aria-describedby="new-password-hint"></label>
    <p class="hint" id="new-password-hint">${t('newPasswordHint', { min: String(minPasswordLength) })}</p>
    <div class="actions"><button class="rc-btn" type="submit">${t('changePassword')}</button></div>
  </form>
</section>
<section class="rc-card danger" aria-labelledby="delete-title">
  <h2 id="delete-title">${t('deleteTitle')}</h2>
  <p>${t('deleteWarning')}</p>
  <form class="stack" method="post" action="/account/delete">
    ${hidden('csrf', input.csrf)}
    <label class="rc-field">${l.auth('password')}
      <input type="password" name="password" required maxlength="200" autocomplete="current-password"></label>
    <label class="rc-check"><input type="checkbox" name="confirm" value="yes" required> ${t('deleteConfirm')}</label>
    <div class="actions"><button class="rc-btn rc-btn--danger" type="submit">${t('deleteButton')}</button></div>
  </form>
</section>`,
    { account: input.account, csrf: input.csrf, wide: true, language: l },
  );
}

/**
 * The step between "Connect" and the bank: it says where the person is going and what the bank
 * will be asked for, and the way out is a plain link, so no form of this site ever posts to a bank.
 */
export function bankLeavePage(
  input: {
    csrf: string;
    account: { email: string };
    bank: { displayName: string; synthetic: boolean };
    redirectUrl: string;
    expiresAt: string;
  },
  language?: PageLanguage,
) {
  const l = languageOf(language);
  const t = l.bank;
  const host = new URL(input.redirectUrl).host;
  const continueTo = t('leaveTo', { bank: input.bank.displayName });
  return layout(
    t('leaveTitle'),
    `<h1>${continueTo}</h1>
<div class="rc-card stack">
  <p>${t('leaveWhere', { host })}</p>
  <p>${t('leaveAsks')}</p>
  ${input.bank.synthetic ? `<p class="rc-note">${t('leaveFictional')}</p>` : ''}
  <p class="hint">${t('leaveAfter', {}, { time: l.minute(input.expiresAt) })}</p>
  <div class="actions">
    <a class="rc-btn rc-btn--primary" rel="noreferrer" href="${e(input.redirectUrl)}">${continueTo}</a>
    <a class="rc-btn" href="/account#bank">${l.common('cancel')}</a>
  </div>
</div>`,
    { account: input.account, csrf: input.csrf, language: l },
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
  /** Which months the monthly figures rest on: see `packages/finance/csv.ts`. */
  averageBasis?: string;
  /** The English sentence about that, as the statement reader words it. */
  averagingNote: string;
};

const averagingMessage = {
  complete_months: 'noteCompleteMonths',
  partial_months_only: 'notePartialMonths',
  period_too_short: 'noteTooShort',
} as const;

/**
 * What the monthly figures of a statement rest on. English is the reader's own sentence; the other
 * languages say the same from the figures of the preview, without the list of months.
 */
function averagingNote(preview: StatementPreview, l: Language) {
  const basis = preview.averageBasis ?? '';
  if (l.locale === defaultLocale || !Object.hasOwn(averagingMessage, basis)) return e(preview.averagingNote);
  return l.bank(averagingMessage[basis as keyof typeof averagingMessage], {
    from: l.date(preview.coveredFrom),
    to: l.date(preview.coveredTo),
    days: preview.coveredDays,
    inflow: l.money(preview.periodTotals.inflowCents),
    outflow: l.money(preview.periodTotals.outflowCents),
  });
}

export function statementPreviewPage(
  input: {
    csrf: string;
    account: { email: string };
    preview: StatementPreview;
    filename?: string;
  },
  language?: PageLanguage,
) {
  const l = languageOf(language);
  const t = l.bank;
  const { preview } = input;
  const categories = Object.entries(preview.byCategory)
    .sort((a, b) => a[1].cents - b[1].cents)
    .map(
      ([category, entry]) =>
        `<tr><td>${categoryLabel(category, l)}</td><td class="num">${e(l.count(entry.count))}</td><td class="num">${e(l.money(entry.cents))}</td></tr>`,
    )
    .join('');
  return layout(
    t('importTitle'),
    `<h1>${t('previewHeading')}</h1>
<p class="lede">${input.filename ? t('previewLedeFile', { filename: input.filename }) : t('previewLede')}</p>
<section class="rc-card stack">
  <dl class="facts">
    <dt>${t('period')}</dt><dd>${t('periodValue', { from: l.date(preview.coveredFrom), to: l.date(preview.coveredTo), days: preview.coveredDays })}</dd>
    <dt>${t('rows')}</dt><dd>${
      preview.skippedZeroAmountRows
        ? t('rowsWithSkipped', { rows: l.count(preview.rowCount), skipped: preview.skippedZeroAmountRows })
        : e(l.count(preview.rowCount))
    }</dd>
    <dt>${t('newMovements')}</dt><dd>${e(l.count(preview.newRows))}</dd>
    <dt>${t('alreadyInLedger')}</dt><dd>${e(l.count(preview.alreadyInLedger))}</dd>
    <dt>${t('cameIn')}</dt><dd>${e(l.money(preview.periodTotals.inflowCents))}</dd>
    <dt>${t('wentOut')}</dt><dd>${e(l.money(preview.periodTotals.outflowCents))}</dd>
    <dt>${t('net')}</dt><dd>${e(l.money(preview.periodTotals.netCents))}</dd>
  </dl>
  <div class="scroll"><table class="rc-table"><thead><tr><th>${t('categoryColumn')}</th><th class="num">${t('rows')}</th><th class="num">${t('sumColumn')}</th></tr></thead><tbody>${categories}</tbody></table></div>
  <p class="${preview.monthlyFigures ? 'hint' : 'rc-note rc-note--warn'}">${averagingNote(preview, l)}</p>
  ${preview.alreadyImported ? `<p class="rc-note">${t('alreadyImported')}</p>` : ''}
  <p class="hint">${t('previewNote')}</p>
  <div class="actions">
    <form method="post" action="/account/bank/import/confirm">${hidden('csrf', input.csrf)}${hidden('preview', preview.previewHash)}
      <button class="rc-btn rc-btn--primary" type="submit">${t('importButton', { count: preview.newRows })}</button></form>
    <form method="post" action="/account/bank/import/cancel">${hidden('csrf', input.csrf)}${hidden('preview', preview.previewHash)}
      <button class="rc-btn" type="submit">${t('discard')}</button></form>
  </div>
  <p class="hint">${t('keptUntil', {}, { time: l.minute(preview.expiresAt) })}</p>
</section>`,
    { account: input.account, csrf: input.csrf, wide: true, language: l },
  );
}
