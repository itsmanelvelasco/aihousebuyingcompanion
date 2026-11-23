import { defaultLocale, formatTags, type Locale, locales } from './locales.ts';

/**
 * Message catalogs. A catalog is written once per area (one `messages.ts` next to the code that
 * uses it) with `defineMessages`: the English texts first, then the same keys in Catalan and
 * Spanish. TypeScript refuses a translation with a missing or an extra key.
 *
 * A message is a plain string, with `{name}` where a value goes. For a count, write the variants
 * inside the message: `{count, plural, one {# place} other {# places}}`; `#` is the number,
 * formatted for the language. The three languages need only `one` and `other`.
 *
 * Money, dates and durations are not written into messages: format them with `createFormat`
 * and pass the result as a value.
 */
export type Catalog<Key extends string = string> = Readonly<Record<Locale, Readonly<Record<Key, string>>>>;
export type MessageValues = Readonly<Record<string, string | number>>;

export function defineMessages<const English extends Record<string, string>>(
  en: English,
  translations: {
    ca: Record<keyof English, string>;
    es: Record<keyof English, string>;
  },
): Catalog<keyof English & string> {
  return { en, ca: translations.ca, es: translations.es } as Catalog<keyof English & string>;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();
const rulesOf = (locale: Locale) => {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(formatTags[locale]);
    pluralRules.set(locale, rules);
  }
  return rules;
};
const numberOf = (locale: Locale) => {
  let format = numberFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(formatTags[locale]);
    numberFormats.set(locale, format);
  }
  return format;
};

/** The index of the brace that closes the one at `open`, or -1. */
function closingBrace(text: string, open: number) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}' && --depth === 0) return index;
  }
  return -1;
}

/** `one {# place} other {# places}` to `{ one: '# place', other: '# places' }`. */
function pluralVariants(text: string) {
  const variants: Record<string, string> = {};
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) break;
    const close = closingBrace(text, open);
    if (close < 0) break;
    variants[text.slice(index, open).trim()] = text.slice(open + 1, close);
    index = close + 1;
  }
  return variants;
}

/**
 * Fills a message. A placeholder with no value is left as written, so a missing value shows up
 * in a test instead of printing "undefined".
 */
export function formatMessage(message: string, values: MessageValues = {}, locale: Locale = defaultLocale): string {
  let out = '';
  let index = 0;
  while (index < message.length) {
    const open = message.indexOf('{', index);
    if (open < 0) break;
    const close = closingBrace(message, open);
    if (close < 0) break;
    out += message.slice(index, open);
    const inner = message.slice(open + 1, close);
    const plural = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
    if (plural) {
      const count = values[plural[1]];
      const variants = pluralVariants(plural[2]);
      if (typeof count === 'number') {
        const variant = variants[`=${count}`] ?? variants[rulesOf(locale).select(count)] ?? variants.other ?? '';
        out += formatMessage(variant.replaceAll('#', numberOf(locale).format(count)), values, locale);
      } else out += message.slice(open, close + 1);
    } else {
      const name = inner.trim();
      out += name in values ? String(values[name]) : message.slice(open, close + 1);
    }
    index = close + 1;
  }
  return out + message.slice(index);
}

export type Translate<Key extends string> = (key: Key, values?: MessageValues) => string;

/** `t('key', { name })` for one catalog in one language. A key missing at run time falls back to English. */
export function translator<Key extends string>(catalog: Catalog<Key>, locale: Locale): Translate<Key> {
  const messages = catalog[locale] ?? catalog[defaultLocale];
  return (key, values) => formatMessage(messages[key] ?? catalog[defaultLocale][key] ?? key, values, locale);
}

/** The placeholder names of a message, sorted: what a translation must also use. */
export function placeholders(message: string): string[] {
  const names = new Set<string>();
  let index = 0;
  while (index < message.length) {
    const open = message.indexOf('{', index);
    if (open < 0) break;
    const close = closingBrace(message, open);
    if (close < 0) break;
    const inner = message.slice(open + 1, close);
    const plural = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
    if (plural) {
      names.add(plural[1]);
      for (const variant of Object.values(pluralVariants(plural[2])))
        for (const name of placeholders(variant)) names.add(name);
    } else names.add(inner.trim());
    index = close + 1;
  }
  return [...names].sort();
}

/** What is wrong with a catalog, as sentences; empty when the three languages agree. */
export function catalogProblems(catalog: Catalog): string[] {
  const problems: string[] = [];
  const english = catalog.en;
  for (const locale of locales) {
    const messages = catalog[locale];
    if (!messages) {
      problems.push(`${locale}: the language is missing`);
      continue;
    }
    for (const key of Object.keys(english)) {
      const message = messages[key];
      if (typeof message !== 'string' || message.trim() === '') problems.push(`${locale}.${key}: missing or empty`);
      else if (placeholders(message).join() !== placeholders(english[key]).join())
        problems.push(
          `${locale}.${key}: placeholders {${placeholders(message)}} differ from English {${placeholders(english[key])}}`,
        );
    }
    for (const key of Object.keys(messages)) if (!(key in english)) problems.push(`${locale}.${key}: not in English`);
  }
  return problems;
}
