import { common } from './common.ts';
import { defaultLocale, formatTags, type Locale } from './locales.ts';
import { translator } from './messages.ts';

/**
 * Numbers, money, dates and durations as each language writes them. Pure: no DOM, and no clock
 * unless one is passed in. Unknown is a word, never zero. English output is what the product
 * printed before it had other languages.
 */
// English dates are day-first ("23 Nov 2026"), as the product has always printed them.
const dateTags: Record<Locale, string> = { ...formatTags, en: 'en-GB' };

function build(locale: Locale) {
  const t = translator(common, locale);
  const tag = formatTags[locale];
  const euros = new Intl.NumberFormat(tag, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const eurosExact = new Intl.NumberFormat(tag, { style: 'currency', currency: 'EUR' });
  const whole = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
  const oneDecimal = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 });
  const day = new Intl.DateTimeFormat(dateTags[locale], { dateStyle: 'medium', timeZone: 'UTC' });
  const clock = new Intl.DateTimeFormat(dateTags[locale], { hour: '2-digit', minute: '2-digit' });
  const unknown = t('unknown');
  const known = <Value>(value: Value | null | undefined): value is Value => value !== null && value !== undefined;
  const asDate = (value: string | number | Date) => (value instanceof Date ? value : new Date(value));

  return {
    locale,
    unknown,
    /** Integer EUR cents as whole euros. */
    euros: (cents: number | null | undefined) => (known(cents) ? euros.format(cents / 100) : unknown),
    /** Integer EUR cents with cents, for a single movement. */
    eurosExact: (cents: number | null | undefined) => (known(cents) ? eurosExact.format(cents / 100) : unknown),
    /** Integer EUR cents a month: `€1,200/month`. */
    monthly: (cents: number | null | undefined) =>
      known(cents) ? t('perMonth', { amount: euros.format(cents / 100) }) : unknown,
    count: (value: number | null | undefined) => (known(value) ? whole.format(value) : unknown),
    decimal: (value: number | null | undefined) => (known(value) ? oneDecimal.format(value) : unknown),
    /** A 0–1 share as a whole percentage. */
    share: (share: number | null | undefined) => (known(share) ? percent.format(share) : unknown),
    /** An ISO date or date-time as a calendar day; text that is not a date is returned as it is. */
    date: (value: string | number | Date | null | undefined) => {
      if (!known(value)) return unknown;
      const date = asDate(value);
      return Number.isNaN(date.getTime()) ? String(value) : day.format(date);
    },
    clock: (value: string | number | Date) => clock.format(asDate(value)),
    /** Months as years and months. Null: there is no finite timeline. Zero: already reached. */
    duration: (months: number | null | undefined) => {
      if (!known(months)) return t('noFiniteTimeline');
      if (months === 0) return t('alreadyReached');
      const years = Math.floor(months / 12);
      const rest = months % 12;
      if (years === 0) return t('months', { count: rest });
      if (rest === 0) return t('years', { count: years });
      return t('yearsAndMonths', { years: t('years', { count: years }), months: t('months', { count: rest }) });
    },
    /** Compact form for bar labels: `4 y 2 mo`. */
    durationShort: (months: number | null | undefined) => {
      if (!known(months)) return t('noTimeline');
      if (months === 0) return t('reached');
      const years = Math.floor(months / 12);
      const rest = months % 12;
      if (years === 0) return t('monthsShort', { count: rest });
      if (rest === 0) return t('yearsShort', { count: years });
      return `${t('yearsShort', { count: years })} ${t('monthsShort', { count: rest })}`;
    },
  };
}

export type Format = ReturnType<typeof build>;
const formats = new Map<Locale, Format>();

/** The formatters of one language. Built once per language. */
export function createFormat(locale: Locale = defaultLocale): Format {
  let format = formats.get(locale);
  if (!format) {
    format = build(locale);
    formats.set(locale, format);
  }
  return format;
}
