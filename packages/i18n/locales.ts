/**
 * The three languages ReloCat is written in. English is the source language and the fallback:
 * every message exists in English, and Catalan and Spanish must have the same keys
 * (`tests/i18n.test.ts` checks every catalog).
 */
export const locales = ['en', 'ca', 'es'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

/** Each language named in itself, for the language switcher. */
export const localeNames: Record<Locale, string> = { en: 'English', ca: 'Català', es: 'Castellano' };

/** The BCP 47 tag used for numbers and dates: euro amounts and dates as they are written in each language. */
export const formatTags: Record<Locale, string> = { en: 'en-IE', ca: 'ca-ES', es: 'es-ES' };

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (locales as readonly string[]).includes(value);

/** `ca-ES`, `ca_ES` or `CA` to `ca`; anything that is not one of the three languages to undefined. */
export function toLocale(tag: string | null | undefined): Locale | undefined {
  if (!tag) return undefined;
  const language = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(language) ? language : undefined;
}

/**
 * The languages of an `Accept-Language` header, best first. Entries with `q=0` are refused
 * languages and are left out; a malformed weight counts as 1, as browsers send it.
 */
export function acceptedLanguages(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag, ...parameters] = part.trim().split(';');
      const weight = parameters.map(parameter => /^\s*q=([\d.]+)\s*$/i.exec(parameter)?.[1]).find(Boolean);
      const q = weight === undefined ? 1 : Number(weight);
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 1, index };
    })
    .filter(entry => entry.tag && entry.tag !== '*' && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map(entry => entry.tag);
}

/**
 * The first of the candidates that is one of the three languages, or English. Pass them in order
 * of how explicit they are: what the person chose, then what the host says, then what the browser
 * prefers. A candidate may be a single tag or a whole `Accept-Language` header.
 */
export function negotiateLocale(...candidates: (string | readonly string[] | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    const tags =
      typeof candidate === 'string'
        ? candidate.includes(',')
          ? acceptedLanguages(candidate)
          : [candidate]
        : (candidate ?? []);
    for (const tag of tags) {
      const locale = toLocale(tag);
      if (locale) return locale;
    }
  }
  return defaultLocale;
}
