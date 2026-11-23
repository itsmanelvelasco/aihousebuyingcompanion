import type { IncomingMessage } from 'node:http';
import { common } from './common.ts';
import { type Locale, localeNames, locales, negotiateLocale, toLocale } from './locales.ts';
import { type Catalog, type Translate, translator } from './messages.ts';

/**
 * The server side of languages: which language a request gets, the cookie that remembers a
 * choice, and the helpers that write a page template in one language.
 */
export const localeCookieName = 'rc_lang';

function cookieValue(request: IncomingMessage, name: string) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

/**
 * The language of a page request: `?lang=` when the person just chose one, then the cookie that
 * remembers an earlier choice, then the browser's `Accept-Language`. `chosen` is set only for the
 * first, so the caller knows to send `localeCookie`.
 */
export function requestLocale(request: IncomingMessage): { locale: Locale; chosen: boolean } {
  const query = (request.url ?? '').split('?')[1] ?? '';
  const fromQuery = toLocale(new URLSearchParams(query).get('lang'));
  if (fromQuery) return { locale: fromQuery, chosen: true };
  const header = request.headers['accept-language'];
  return {
    locale: negotiateLocale(cookieValue(request, localeCookieName), Array.isArray(header) ? header.join(',') : header),
    chosen: false,
  };
}

/** `Set-Cookie` value that remembers a language for a year. Not a secret, so scripts may read it. */
export const localeCookie = (locale: Locale, secure: boolean) =>
  `${localeCookieName}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;

/**
 * The language a tool call asks for: its own `locale` argument, else what the host states in
 * `_meta` (ChatGPT sends `openai/locale`), else English.
 */
export function toolLocale(argument: unknown, meta?: Record<string, unknown> | null): Locale {
  const stated = meta?.['openai/locale'] ?? meta?.locale;
  return negotiateLocale(typeof argument === 'string' ? argument : null, typeof stated === 'string' ? stated : null);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

/**
 * Writes a page template in one language:
 *
 *   {{t:key}}            the message, escaped for HTML text and attribute values
 *   {{t-html:key}}       the message as written, for a message that carries its own markup
 *   <html lang="en">     becomes the language of the page
 *   <!-- LANGUAGES -->   the language switcher (links to the same page with `?lang=`)
 *
 * An unknown key throws, so a typo fails at start instead of shipping a blank.
 */
export function localizeHtml<Key extends string>(
  html: string,
  catalog: Catalog<Key>,
  locale: Locale,
  options: { path?: string } = {},
) {
  const t = translator(catalog, locale);
  const message = (key: string) => {
    if (!(key in catalog.en)) throw new Error(`Unknown message "${key}"`);
    return t(key as Key);
  };
  return html
    .replace(/<html lang="[a-z-]*"/, `<html lang="${locale}"`)
    .replace(/\{\{t-html:([\w.-]+)\}\}/g, (_, key: string) => message(key))
    .replace(/\{\{t:([\w.-]+)\}\}/g, (_, key: string) => escapeHtml(message(key)))
    .replace('<!-- LANGUAGES -->', () => languageSwitcher(locale, options.path ?? ''));
}

/**
 * The language switcher of a server-rendered page: three links, the current one marked. `path`
 * is the page's own path (and query without `lang`); it is written into `href` escaped.
 */
export function languageSwitcher(locale: Locale, path: string) {
  const [pathname, query = ''] = path.split('?');
  const label = translator(common, locale)('language');
  const links = locales
    .map(option => {
      const parameters = new URLSearchParams(query);
      parameters.set('lang', option);
      const current = option === locale ? ' aria-current="true"' : '';
      return `<a href="${escapeHtml(`${pathname}?${parameters}`)}" lang="${option}" hreflang="${option}"${current}>${localeNames[option]}</a>`;
    })
    .join('');
  return `<nav class="rc-lang" aria-label="${escapeHtml(label)}">${links}</nav>`;
}

export type { Translate };
