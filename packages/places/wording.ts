import { createFormat } from '../i18n/format.ts';
import { defaultLocale, formatTags, type Locale } from '../i18n/locales.ts';

/**
 * Values written into the sentences of the domain packages (places, planner, model).
 *
 * English keeps the plain forms the product has always printed in these sentences (ISO dates,
 * `€88318` where a sentence never grouped digits): the caller passes that text and it is returned
 * unchanged. Catalan and Spanish use `createFormat`, so amounts, shares and dates read as each
 * language writes them. Pure, so a browser bundle can include it.
 */
function build(locale: Locale) {
  const english = locale === defaultLocale;
  const format = createFormat(locale);
  const percent = new Intl.NumberFormat(formatTags[locale], { style: 'percent', maximumFractionDigits: 2 });
  const number = new Intl.NumberFormat(formatTags[locale], { maximumFractionDigits: 2 });
  const list = english ? null : new Intl.ListFormat(formatTags[locale], { style: 'long', type: 'conjunction' });
  return {
    locale,
    english,
    format,
    /** Integer cents: the English text as given, else whole euros, with cents only when there are some. */
    euros: (cents: number, englishText: string) =>
      english ? englishText : cents % 100 === 0 ? format.euros(cents) : format.eurosExact(cents),
    /** A 0–1 share with up to two decimals: `5%`, `5 %`. */
    percent: (rate: number) => (english ? `${Math.round(rate * 10_000) / 100}%` : percent.format(rate)),
    /** A plain number: the English text as given, else grouped and with the decimal comma. */
    number: (value: number, englishText: string = String(value)) => (english ? englishText : number.format(value)),
    /** An ISO day: unchanged in English, a written date otherwise. Text that is not a date stays as it is. */
    date: (iso: string) => (english || !/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso : format.date(iso.slice(0, 10))),
    /** "a, b and c" as the language writes it; English joins with the separator the sentence always used. */
    list: (items: string[], englishSeparator: string) => (list ? list.format(items) : items.join(englishSeparator)),
  };
}

export type Wording = ReturnType<typeof build>;
const built = new Map<Locale, Wording>();

export function wording(locale: Locale = defaultLocale): Wording {
  let value = built.get(locale);
  if (!value) {
    value = build(locale);
    built.set(locale, value);
  }
  return value;
}
