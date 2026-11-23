import type { CashFlowSummary } from '../../packages/finance/csv.ts';
import { createFormat } from '../../packages/i18n/format.ts';
import { formatTags, type Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { interview } from './messages.ts';

/**
 * What the interview page says about a bank statement, in the person's language. Pure: no DOM.
 *
 * The rule of what may be said is `cashFlowStatements` in `packages/finance/csv.ts`: a monthly
 * average only for complete months, a rough indication for partial months, and no monthly figure
 * when the period is too short. This file words the same three cases from the catalog;
 * `tests/interviewer.test.ts` checks that its English is the rule's own wording.
 */

/** An amount in the statement's currency, with cents, as the language writes it. */
export function moneyIn(locale: Locale, currency: string) {
  if (currency === 'EUR') {
    const format = createFormat(locale);
    return (amount: number) => format.eurosExact(Math.round(amount * 100));
  }
  // `createFormat` writes euros only; a statement in another currency keeps its own.
  const other = new Intl.NumberFormat(formatTags[locale], { style: 'currency', currency });
  return (amount: number) => other.format(amount);
}

type Covered = Pick<CashFlowSummary, 'estimatedMonthlySalary' | 'monthlyCostOfLiving'> &
  Partial<Pick<CashFlowSummary, 'averageBasis' | 'coveredDays' | 'coveredFrom' | 'coveredTo'>>;

/** A day of the statement: the ISO date in English, as the rule writes it, and a written date otherwise. */
const dayIn = (locale: Locale) => (day: string) => (locale === 'en' ? day : createFormat(locale).date(day));

/** The two guided questions about pay and spending, worded for how much of a month the statement covers. */
export function cashQuestions(summary: Covered, money: (amount: number) => string, locale: Locale = 'en') {
  const t = translator(interview, locale);
  const day = dayIn(locale);
  const salary = summary.estimatedMonthlySalary;
  const spending = summary.monthlyCostOfLiving;
  if (summary.averageBasis === 'period_too_short') {
    const { coveredFrom: from, coveredTo: to } = summary;
    if (from && to && from !== to) {
      const values = { days: summary.coveredDays ?? 0, from: day(from), to: day(to) };
      return { salaryQuestion: t('salaryShortDays', values), spendingQuestion: t('spendingShortDays', values) };
    }
    return from
      ? {
          salaryQuestion: t('salaryShortDay', { day: day(from) }),
          spendingQuestion: t('spendingShortDay', { day: day(from) }),
        }
      : { salaryQuestion: t('salaryShortUndated'), spendingQuestion: t('spendingShortUndated') };
  }
  const rough = summary.averageBasis !== 'complete_months';
  return {
    salaryQuestion:
      salary == null
        ? t('ask.confirmedSalary')
        : t(rough ? 'salaryRough' : 'salaryComplete', { amount: money(salary) }),
    spendingQuestion:
      spending == null
        ? t('ask.cashFlowNotes')
        : t(rough ? 'spendingRough' : 'spendingComplete', { amount: money(spending) }),
  };
}

/**
 * The line under the statement: how many movements, what was left out, and what the monthly
 * figures are. The summary is stored with an English note (`averagingNote`); that note is shown
 * in English, and in another language the same facts are written from the summary's own fields.
 */
export function statementNote(
  cash: Pick<CashFlowSummary, 'transactionCount' | 'observedMonths' | 'excludedTransfers'> &
    Partial<
      Pick<
        CashFlowSummary,
        | 'averageBasis'
        | 'averagingNote'
        | 'completeMonths'
        | 'partialMonths'
        | 'coveredDays'
        | 'coveredFrom'
        | 'coveredTo'
      >
    >,
  locale: Locale = 'en',
) {
  const t = translator(interview, locale);
  const day = dayIn(locale);
  const list = (months: string[] = []) => months.join(', ');
  const period = { from: day(cash.coveredFrom ?? ''), to: day(cash.coveredTo ?? '') };
  const written = () => {
    if (!cash.averageBasis || !cash.coveredFrom) return '';
    if (cash.averageBasis === 'period_too_short') return t('noteTooShort', { ...period, days: cash.coveredDays ?? 0 });
    if (cash.averageBasis !== 'complete_months') return t('noteRough', period);
    const complete = t('noteComplete', {
      count: cash.completeMonths?.length ?? 0,
      months: list(cash.completeMonths),
    });
    return cash.partialMonths?.length
      ? `${complete} ${t('notePartialLeftOut', { months: list(cash.partialMonths), ...period })}`
      : complete;
  };
  return [
    t('statementSize', { count: cash.transactionCount, months: cash.observedMonths.length }),
    t('transfersExcluded', { count: cash.excludedTransfers }),
    locale === 'en' && cash.averagingNote ? cash.averagingNote : written(),
  ]
    .filter(Boolean)
    .join(' ');
}
