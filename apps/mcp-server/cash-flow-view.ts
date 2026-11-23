import { createFormat } from '../../packages/i18n/format.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { cashFlow } from './cash-flow.messages.ts';

type Row = [label: string, value: string];

/**
 * What the sample cash-flow card says for a result of `sample_cash_flow`, in one language.
 * Pure, so `tests/i18n-pages.test.ts` reads it without a browser. Amounts are euros as the tool
 * returns them; one that is missing is a word, never zero.
 */
export function cashFlowView(summary: unknown, locale: Locale, failed = false) {
  const t = translator(cashFlow, locale);
  const format = createFormat(locale);
  const amount = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? format.money(value, 'EUR') : t('unidentified');
  const data = (typeof summary === 'object' && summary !== null ? summary : {}) as Record<string, unknown>;
  const expenses = data.monthlyExpenses;
  if (!Array.isArray(data.observedMonths) || typeof expenses !== 'object' || expenses === null)
    return { title: t('title'), coverage: t(failed ? 'unavailable' : 'loading'), totals: null, expenses: null };
  // Category names come from the statement; the two the sample relabels are translated.
  const labels: Record<string, string> = { Rent: t('rent'), 'Eating out': t('eatingOut') };
  return {
    title: t('title'),
    coverage: t('coverage', { count: data.observedMonths.length }),
    totals: [
      [t('salary'), amount(data.estimatedMonthlySalary)],
      [t('spending'), amount(data.monthlyCostOfLiving)],
      [t('net'), amount(data.monthlyNetCashFlow)],
    ] as Row[],
    expenses: Object.entries(expenses).map(([name, value]): Row => [labels[name] ?? name, amount(value)]),
  };
}
