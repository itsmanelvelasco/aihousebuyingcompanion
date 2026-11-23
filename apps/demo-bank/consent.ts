import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError, escapeHtml as e } from '../../packages/http/server.ts';
import { defaultLocale, type Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { languageSwitcher } from '../../packages/i18n/server.ts';
import { consentPageMessages } from './consent.messages.ts';

/**
 * Banc Demo's consent desk: how a customer of the fictional bank allows an application to read
 * their accounts. It has the shape of a real bank's redirect flow, and none of its substance:
 *
 *   1. The application (authenticated with its API key) creates a consent request with the address
 *      the customer must be sent back to and its own `state`: `POST /consents`.
 *   2. The customer opens the bank's page `GET /consent/<id>`, says which customer they are and
 *      approves or refuses. A real bank would make them sign in and pass strong customer
 *      authentication here; Banc Demo has no logins, so the page offers its fictional customers to
 *      pick from and says so.
 *   3. The bank sends the customer back with a one-time `code` (or `error=access_denied`) and the
 *      unchanged `state`.
 *   4. The application exchanges the code, once, for the customer reference: `POST /consents/token`.
 *
 * Requests and codes live in memory only and expire in minutes. Everything is fictional.
 *
 * The page is written in English, Catalan or Spanish (`consent.messages.ts`); the customers' names
 * are invented names and stay as they are.
 */

export const createConsentSchema = z
  .object({ redirect_uri: z.string().url().max(500), state: z.string().min(16).max(200) })
  .strict();
export const exchangeSchema = z.object({ code: z.string().min(16).max(200) }).strict();
const decisionSchema = z.object({ decision: z.enum(['approve', 'deny']), customer_id: z.string().max(64).optional() });

type Request = { id: string; redirectUri: string; state: string; expiresAt: number };
type Code = { customerId: string; expiresAt: number };

export type ConsentDeskOptions = {
  clock?: () => Date;
  /** The bank's fictional customers, to pick from on the consent page. */
  customers: () => { id: string; name: string }[];
  /** Accept return addresses on any host. By default only this machine (loopback) and `returnOrigins`. */
  allowRemote?: boolean;
  /**
   * Origins, besides this machine, the bank may send a customer back to: the public origin of the
   * application the bank is mounted on (`https://www.relo.cat`). Compared exactly, scheme and port
   * included; anything that is not an http(s) origin is ignored.
   */
  returnOrigins?: readonly string[];
  /** How long the customer has to decide. Default 10 minutes. */
  requestTtlMs?: number;
  /** How long the one-time code can be exchanged. Default 2 minutes. */
  codeTtlMs?: number;
  /** How long an approved consent lasts, in days. Default 90, as banks commonly grant. */
  consentDays?: number;
};

const maxOpen = 200;

/** The language links of the consent page, in the bank's own look. */
const switcherCss = `  .rc-lang { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 16px; font-size: 0.875rem; line-height: 1.25rem; }
  .rc-lang a { display: inline-flex; align-items: center; min-height: 44px; color: var(--bank-muted); }
  .rc-lang a[aria-current="true"] { color: var(--bank-ink); font-weight: 600; text-decoration-thickness: 2px; }
`;

/** `https://host[:port]` of each entry that is an http(s) address; the rest is dropped. */
export function normalizeOrigins(values: readonly string[] = []) {
  const origins = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') origins.add(url.origin);
    } catch {
      // Not an address: ignored, so a typo narrows what is accepted instead of widening it.
    }
  }
  return origins;
}

function isLoopback(url: URL) {
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

export function createConsentDesk(options: ConsentDeskOptions) {
  const clock = options.clock ?? (() => new Date());
  const requestTtlMs = options.requestTtlMs ?? 10 * 60_000;
  const codeTtlMs = options.codeTtlMs ?? 2 * 60_000;
  const consentDays = options.consentDays ?? 90;
  const consentMs = consentDays * 86_400_000;
  const returnOrigins = normalizeOrigins(options.returnOrigins);
  const requests = new Map<string, Request>();
  const codes = new Map<string, Code>();

  /** Forget what expired, and the oldest entries beyond the cap. */
  function sweep() {
    const now = clock().getTime();
    for (const [id, request] of requests) if (request.expiresAt <= now) requests.delete(id);
    for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code);
    for (const map of [requests, codes] as Map<string, unknown>[])
      while (map.size > maxOpen) map.delete(map.keys().next().value as string);
  }

  function open(id: string) {
    sweep();
    const request = requests.get(id);
    if (!request) throw new ApiError(404, 'This consent request is unknown or has expired');
    return request;
  }

  return {
    /** Step 1, called by the application with its API key. */
    create(input: unknown) {
      const { redirect_uri: redirectUri, state } = createConsentSchema.parse(input);
      const url = new URL(redirectUri);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        throw new ApiError(400, 'Use an http or https return address without credentials or fragment');
      if (!options.allowRemote && !isLoopback(url) && !returnOrigins.has(url.origin))
        throw new ApiError(
          400,
          'This demo bank only sends customers back to this machine (localhost) or to the application it is mounted on',
        );
      sweep();
      const request: Request = {
        id: `consent-${randomBytes(16).toString('hex')}`,
        redirectUri: url.href,
        state,
        expiresAt: clock().getTime() + requestTtlMs,
      };
      requests.set(request.id, request);
      return {
        synthetic: true,
        consent_id: request.id,
        /** Path of the page the customer must open on the bank's own origin. */
        consent_path: `/consent/${request.id}`,
        expires_at: new Date(request.expiresAt).toISOString(),
      };
    },

    /**
     * Step 2: the page the customer sees, and the origin its form will redirect to. `switcher`
     * adds the links that show this same page in another language. `basePath` is the path the bank
     * is mounted under when another server serves this page on its own origin (`/banc-demo`), so
     * the form and the language links stay inside the mount.
     */
    page(id: string, locale: Locale = defaultLocale, switcher = false, basePath = '') {
      const request = open(id);
      const t = translator(consentPageMessages, locale);
      const target = new URL(request.redirectUri);
      const customers = options.customers();
      const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${t('title')}</title>
<style>
  /* Banc Demo's own look, on purpose not ReloCat's: system type, grey-blue ink, light only. */
  :root {
    color-scheme: light;
    --bank-page: #f4f1ea; --bank-card: #fff; --bank-ink: #1f2a2e; --bank-ink-hover: #33424a; --bank-ink-active: #0f1719;
    --bank-muted: #5b6468; --bank-line: #d9d3c5; --bank-control-line: #767f83; --bank-tint: #edf0f1;
    --bank-flag: #7a2e1d; --bank-focus: #0b57d0;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: var(--bank-page); color: var(--bank-ink); }
  main { max-width: 36.5rem; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { margin: 12px 0 16px; font-size: 2rem; font-weight: 600; line-height: 2.5rem; letter-spacing: -0.02em; }
  p { margin: 0 0 16px; }
  .card { background: var(--bank-card); border: 1px solid var(--bank-line); border-radius: 12px; padding: 20px; }
  .tag { display: inline-block; background: var(--bank-flag); color: #fff; border-radius: 999px; padding: 4px 12px; font-size: 0.75rem; line-height: 1rem; }
  label, select, button { font: inherit; }
  label { display: grid; gap: 8px; margin-bottom: 4px; font-size: 0.875rem; line-height: 1.25rem; color: var(--bank-muted); }
  select { width: 100%; min-height: 48px; padding: 8px 12px; border: 1px solid var(--bank-control-line); border-radius: 8px; background: var(--bank-card); color: var(--bank-ink); font-size: 1rem; line-height: 1.5; cursor: pointer; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
  button { min-width: 120px; min-height: 44px; padding: 8px 20px; border-radius: 8px; border: 1px solid var(--bank-ink); background: var(--bank-card); color: var(--bank-ink); font-weight: 600; line-height: 1.5rem; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; transition: background-color 150ms ease-out, border-color 150ms ease-out, transform 150ms ease-out; }
  button.primary { background: var(--bank-ink); color: #fff; }
  @media (hover: hover) {
    select:hover { border-color: var(--bank-ink); }
    button:hover { background: var(--bank-tint); }
    button.primary:hover { border-color: var(--bank-ink-hover); background: var(--bank-ink-hover); }
  }
  button:active { transform: scale(0.97); background: var(--bank-line); }
  button.primary:active { border-color: var(--bank-ink-active); background: var(--bank-ink-active); }
  :focus-visible { outline: 2px solid var(--bank-focus); outline-offset: 2px; }
  .hint { color: var(--bank-muted); font-size: 0.875rem; line-height: 1.25rem; }
  .card > .hint { margin: 0; }
  main > .hint { margin: 16px 0 0; }
  @media (pointer: coarse) { select { min-height: 56px; } }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } button:active { transform: none; } }
${switcher ? switcherCss : ''}</style>
</head>
<body>
<main>${
        switcher
          ? `
${languageSwitcher(locale, `${basePath}/consent/${request.id}`)}`
          : ''
      }
<p><span class="tag">${t('fictionalBank')}</span></p>
<h1>Banc Demo</h1>
<form class="card" method="post" action="${e(basePath)}/consent/${e(request.id)}">
  <p><strong>${t('question')}</strong></p>
  <p>${t('asks', { host: e(target.host) })}</p>
  <label>${t('youAre')}
    <select name="customer_id" required>
      ${customers.map(customer => `<option value="${e(customer.id)}">${e(customer.name)} (${e(customer.id)})</option>`).join('')}
    </select>
  </label>
  <p class="hint">${t('fictionalNote')}</p>
  <div class="actions">
    <button class="primary" type="submit" name="decision" value="approve">${t('allow', { days: consentDays })}</button>
    <button type="submit" name="decision" value="deny">${t('deny')}</button>
  </div>
</form>
<p class="hint">${t('after', { host: e(target.host) })}</p>
</main>
</body>
</html>`;
      return { html, formAction: target.origin };
    },

    /** Step 3: the customer's decision. Returns where to send them; the request cannot be decided twice. */
    decide(id: string, input: unknown) {
      const request = open(id);
      const { decision, customer_id: customerId } = decisionSchema.parse(input);
      const back = new URL(request.redirectUri);
      back.searchParams.set('state', request.state);
      if (decision === 'deny') {
        requests.delete(id);
        back.searchParams.set('error', 'access_denied');
        return back.href;
      }
      if (!customerId || !options.customers().some(customer => customer.id === customerId))
        throw new ApiError(400, 'Choose one of the fictional customers');
      requests.delete(id);
      const code = `code-${randomBytes(24).toString('hex')}`;
      codes.set(code, { customerId, expiresAt: clock().getTime() + codeTtlMs });
      back.searchParams.set('code', code);
      return back.href;
    },

    /** Step 4, called by the application with its API key. A code works once. */
    exchange(input: unknown) {
      const { code } = exchangeSchema.parse(input);
      sweep();
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry) throw new ApiError(400, 'This code is unknown, expired or was already used');
      return {
        synthetic: true,
        customer_id: entry.customerId,
        expires_at: new Date(clock().getTime() + consentMs).toISOString(),
      };
    },

    /** Consent requests and codes waiting right now. */
    waiting: () => ({ requests: requests.size, codes: codes.size }),
  };
}

export type ConsentDesk = ReturnType<typeof createConsentDesk>;
