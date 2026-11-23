import { formatTags, type Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { board } from './messages.ts';

/**
 * The words of the read-only town screen. Pure, so the wording is tested without a browser.
 *
 * The screen reports what it still needs as input paths such as `housing.homeSizeM2`. A path is an
 * internal name: it is mapped to what the person would call it, and one without a name here is
 * "more details", never the path itself.
 */
type BoardKey = keyof typeof board.en;

const missingLabels: Record<string, BoardKey> = {
  'housing.tenure': 'missingTenure',
  'housing.budgetCents': 'missingBudget',
  'housing.homeSizeM2': 'missingHomeSize',
  'school.stages': 'missingSchoolStages',
  'school.mode': 'missingSchoolMode',
  'transport.destinationCode': 'missingDestination',
  'transport.maxCommuteMinutes': 'missingCommuteTime',
};

/** "More information needed: home size and where you commute to." With nothing missing, conflicts are what is left. */
export function missingInformation(fields: readonly string[], locale: Locale = 'en') {
  const t = translator(board, locale);
  if (!fields.length) return t('resolveConflicts');
  // A path may carry a reason after a colon (`school.stages:required_for_constraints`); the field is what is named.
  const keys = fields.map(field => missingLabels[field.split(':')[0]]);
  const known = keys.filter((key): key is BoardKey => key !== undefined);
  // What has a name comes first; anything else is one "more details" at the end.
  const all: BoardKey[] = known.length < keys.length ? [...known, 'missingOther'] : known;
  const names = [...new Set(all)].map(key => t(key));
  const list = new Intl.ListFormat(formatTags[locale], { style: 'long', type: 'conjunction' }).format(names);
  return t('moreNeeded', { fields: list });
}

const statusLabels: Record<string, BoardKey> = {
  open: 'callOpen',
  closed: 'callClosed',
  upcoming: 'callUpcoming',
  unknown: 'callUnknown',
  eligible: 'eligible',
  ineligible: 'ineligible',
  needs_verification: 'needsVerification',
};

/** A call or eligibility status in words; one this board does not know is shown as the source wrote it. */
export function statusLabel(value: string, locale: Locale = 'en') {
  return statusLabels[value] ? translator(board, locale)(statusLabels[value]) : value;
}
