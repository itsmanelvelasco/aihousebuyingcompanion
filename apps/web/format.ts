/** Display formatting for the workspace. Pure functions: no DOM, no clock unless passed in. */

const euros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const whole = new Intl.NumberFormat('en-IE', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-IE', { maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export const UNKNOWN = 'Unknown';

/** Integer EUR cents to whole euros. Null is unknown, never zero. */
export function formatEuros(cents: number | null | undefined) {
  return cents === null || cents === undefined ? UNKNOWN : euros.format(cents / 100);
}

export function formatMonthly(cents: number | null | undefined) {
  return cents === null || cents === undefined ? UNKNOWN : `${euros.format(cents / 100)}/month`;
}

export function formatCount(value: number | null | undefined) {
  return value === null || value === undefined ? UNKNOWN : whole.format(value);
}

export function formatDecimal(value: number | null | undefined) {
  return value === null || value === undefined ? UNKNOWN : oneDecimal.format(value);
}

/** A 0–1 share as a whole percentage. */
export function formatShare(share: number | null | undefined) {
  return share === null || share === undefined ? UNKNOWN : `${Math.round(share * 100)}%`;
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;

/**
 * Months as years and months. Null means there is no finite timeline, and says so; zero means the
 * target is already met.
 */
export function formatDuration(months: number | null | undefined) {
  if (months === null || months === undefined) return 'No finite timeline';
  if (months === 0) return 'Already reached';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0) return plural(rest, 'month');
  if (rest === 0) return plural(years, 'year');
  return `${plural(years, 'year')} ${plural(rest, 'month')}`;
}

/** Compact form for bar labels: `4 y 2 mo`. */
export function formatDurationShort(months: number | null | undefined) {
  if (months === null || months === undefined) return 'No timeline';
  if (months === 0) return 'Reached';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0) return `${rest} mo`;
  if (rest === 0) return `${years} y`;
  return `${years} y ${rest} mo`;
}

/** Difference between two timelines. Null means the two cannot be compared. */
export function formatMonthsSaved(months: number | null | undefined) {
  if (months === null || months === undefined) return 'Not comparable';
  if (months === 0) return 'No change';
  return months > 0 ? `${plural(months, 'month')} sooner` : `${plural(-months, 'month')} later`;
}

/** `2026-11-21` or a full timestamp as `21 Nov 2026`. Anything else is returned unchanged. */
export function formatDate(value: string | null | undefined) {
  if (!value) return UNKNOWN;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}/.test(value) ? value : day.format(date);
}

export function formatClock(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : clock.format(date);
}

/** `12 s ago`, `3 min ago`, `2 h ago`. */
export function formatAgo(thenMs: number, nowMs: number) {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${plural(Math.floor(hours / 24), 'day')} ago`;
}

/** Host name of a source link, for a short visible label. */
export function sourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
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
