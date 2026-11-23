import { type Locale, negotiateLocale, toLocale } from './locales.ts';

/**
 * Which language a page or widget shows, decided in the browser. Most explicit first:
 *
 * 1. `?lang=ca` in the address (a shared link, the language switcher of a page);
 * 2. the language the person picked before on this origin;
 * 3. the language the chat host states (`hostLocale`: ChatGPT's `window.openai.locale`, or the
 *    `locale` of an MCP Apps host context);
 * 4. the language the server rendered the page in (`<html lang>`), when it is not the default;
 * 5. the browser's own languages.
 *
 * A widget runs in a sandboxed frame where storage may be refused; every access is guarded.
 */
export const localeStorageKey = 'relocat.lang';

type Reader = {
  search?: string;
  stored?: string | null;
  hostLocale?: string | null;
  documentLang?: string | null;
  languages?: readonly string[];
};

/** The decision itself, as a pure function of what the browser offers. */
export function chooseLocale(reader: Reader): Locale {
  const fromQuery = toLocale(new URLSearchParams(reader.search ?? '').get('lang'));
  if (fromQuery) return fromQuery;
  const stored = toLocale(reader.stored);
  if (stored) return stored;
  return negotiateLocale(
    reader.hostLocale,
    reader.documentLang === 'en' ? null : reader.documentLang,
    reader.languages,
  );
}

function stored() {
  try {
    return globalThis.localStorage?.getItem(localeStorageKey) ?? null;
  } catch {
    return null;
  }
}

/** The host's stated language, when the page runs inside ChatGPT. */
function openaiLocale() {
  const host = (globalThis as { openai?: { locale?: unknown } }).openai;
  return typeof host?.locale === 'string' ? host.locale : null;
}

/** The language to show now. `hostLocale` is what an MCP Apps host context states, when there is one. */
export function browserLocale(hostLocale?: string | null): Locale {
  return chooseLocale({
    search: globalThis.location?.search,
    stored: stored(),
    hostLocale: hostLocale ?? openaiLocale(),
    documentLang: globalThis.document?.documentElement.lang,
    languages: globalThis.navigator?.languages ?? [],
  });
}

/** Remembers a choice made with the language switcher and marks the document with it. */
export function rememberLocale(locale: Locale) {
  try {
    globalThis.localStorage?.setItem(localeStorageKey, locale);
  } catch {
    // Storage is refused in some sandboxed frames; the choice then lasts for this view only.
  }
  if (globalThis.document) globalThis.document.documentElement.lang = locale;
}
