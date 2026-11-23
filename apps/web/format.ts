import { createFormat } from '../../packages/i18n/format.ts';
import { defaultLocale, type Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { formatMessages } from './messages/format.messages.ts';

/**
 * Display formatting for the workspace. Pure functions: no DOM, no clock unless passed in.
 * Each takes the language last and defaults to English; the numbers, dates and durations
 * themselves come from `createFormat` in `packages/i18n`.
 */

export const UNKNOWN = createFormat(defaultLocale).unknown;

const words = (locale: Locale) => translator(formatMessages, locale);

/** Integer EUR cents to whole euros. Null is unknown, never zero. */
export function formatEuros(cents: number | null | undefined, locale: Locale = defaultLocale) {
  return createFormat(locale).euros(cents);
}

export function formatMonthly(cents: number | null | undefined, locale: Locale = defaultLocale) {
  return createFormat(locale).monthly(cents);
}

export function formatCount(value: number | null | undefined, locale: Locale = defaultLocale) {
  return createFormat(locale).count(value);
}

export function formatDecimal(value: number | null | undefined, locale: Locale = defaultLocale) {
  return createFormat(locale).decimal(value);
}

/** A 0–1 share as a whole percentage. */
export function formatShare(share: number | null | undefined, locale: Locale = defaultLocale) {
  return createFormat(locale).share(share);
}

/**
 * Months as years and months. Null means there is no finite timeline, and says so; zero means the
 * target is already met.
 */
export function formatDuration(months: number | null | undefined, locale: Locale = defaultLocale) {
  return createFormat(locale).duration(months);
}

/** Compact form for bar labels: `4 y 2 mo`. */
export function formatDurationShort(months: number | null | undefined, locale: Locale = defaultLocale) {
  return createFormat(locale).durationShort(months);
}

/** Difference between two timelines. Null means the two cannot be compared. */
export function formatMonthsSaved(months: number | null | undefined, locale: Locale = defaultLocale) {
  const t = words(locale);
  if (months === null || months === undefined) return t('notComparable');
  if (months === 0) return t('noChange');
  return months > 0 ? t('monthsSooner', { count: months }) : t('monthsLater', { count: -months });
}

/** `2026-11-21` or a full timestamp as `21 Nov 2026`. Anything else is returned unchanged. */
export function formatDate(value: string | null | undefined, locale: Locale = defaultLocale) {
  const format = createFormat(locale);
  if (!value) return format.unknown;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}/.test(value) ? value : format.date(date);
}

export function formatClock(value: string, locale: Locale = defaultLocale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : createFormat(locale).clock(date);
}

/** `12 s ago`, `3 min ago`, `2 h ago`. */
export function formatAgo(thenMs: number, nowMs: number, locale: Locale = defaultLocale) {
  const t = words(locale);
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 5) return t('justNow');
  if (seconds < 60) return t('secondsAgo', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('hoursAgo', { count: hours }) : t('daysAgo', { count: Math.floor(hours / 24) });
}

/** Host name of a source link, for a short visible label. */
export function sourceHost(url: string, locale: Locale = defaultLocale) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return words(locale)('source');
  }
}

/** Only http(s) links are rendered as links. */
export function safeHref(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}
