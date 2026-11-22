import { monthsToTarget } from './savings.ts';

/**
 * Bank CSV intake for the interview: parse statement rows, group spending by keyword category
 * and average it per complete month. Amounts are parsed to integer cents and reported in the
 * statement's currency units. Runs unchanged in Node and in the browser.
 *
 * Which months are averaged. The statement covers the days from its earliest to its latest row. A
 * calendar month is complete when that range contains it from its first to its last day; a complete
 * month without rows counts as a month with no movements. Monthly figures are the totals of the
 * complete months divided by their number, each rounded once to the cent. The first and last months
 * are usually partial and are left out, and reported in `partialMonths`.
 *
 * When no month is complete the figures cannot be a monthly average. They are then the totals of
 * every row divided by the days covered, expressed in months of 365.25 / 12 days and never less than
 * one month, and `averageBasis` says `partial_months_only`: read them as a rough indication.
 */
const categories: Record<string, RegExp> = {
  Rent: /\brent\b|alquiler|arrendamiento/,
  Groceries: /grocer|supermarket|mercadona|lidl|aldi|carrefour/,
  'Eating out': /restaurant|cafe|coffee|takeaway|delivery|glovo|uber eats/,
  Utilities: /electric|water bill|internet|utility|energia|iberdrola/,
  Transport: /metro|train|fuel|uber|transit|renfe/,
  Subscriptions: /netflix|spotify|subscription/,
  Shopping: /amazon|shopping|clothing/,
  Health: /pharmacy|farmacia|medical|dental|clinic/,
  Entertainment: /cinema|theat(er|re)|museum|concert|ticketmaster/,
};
const internalTransfer = /internal transfer|own account|transferencia propia/;

export const expenseCategories = [...Object.keys(categories), 'Other'];
export const incomeCategories = ['Payroll', 'Other income'];
export const classificationLimit = 80;

export type CsvTransaction = { date: string; month: string; label: string; cents: number };
export type MerchantCandidate = { direction: 'in' | 'out'; description: string };
export type CashFlowSummary = ReturnType<typeof summarizeTransactions>;
export type SavingsPlanInput = { target: number; saved: number; monthly: number; habit: number };

function merchantCandidate({ label, cents }: CsvTransaction): MerchantCandidate | null {
  if (!cents || internalTransfer.test(label)) return null;
  const description = label
    .replace(/https?:\/\/\S+|\S+@\S+|\b[\p{L}]{2}\d[\p{L}\d]{8,}\b/gu, ' ')
    .replace(/[^\p{L}\s&'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
  return description ? { direction: cents > 0 ? 'in' : 'out', description } : null;
}

const merchantKey = (candidate: MerchantCandidate) => `${candidate.direction}:${candidate.description}`;

/** Distinct shortened merchant descriptions that may be sent for optional classification. */
export function classificationCandidates(transactions: CsvTransaction[]) {
  const unique = new Map<string, MerchantCandidate>();
  for (const transaction of transactions) {
    const candidate = merchantCandidate(transaction);
    if (!candidate) continue;
    unique.set(merchantKey(candidate), candidate);
    if (unique.size >= classificationLimit) break;
  }
  return [...unique.values()];
}

function parseCsv(source: string) {
  const csv = source.replace(/^﻿/, '').trim();
  const delimiter = csv.split(/\r?\n/, 1)[0].includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const character = csv[i];
    if (character === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (character === delimiter || character === '\n')) {
      row.push(field.trim());
      field = '';
      if (character === '\n') {
        rows.push(row);
        row = [];
      }
    } else field += character;
  }
  if (quoted) throw new Error('The CSV has an unfinished quoted field.');
  rows.push([...row, field.trim()]);
  return rows.filter(cells => cells.some(Boolean));
}

export function parseTransactions(csv: string): CsvTransaction[] {
  const [headers = [], ...rows] = parseCsv(csv);
  const names = headers.map(header => header.toLowerCase());
  const date = names.indexOf('date');
  const description = names.indexOf('description');
  const amount = names.indexOf('amount');
  if ([date, description, amount].includes(-1) || !rows.length) {
    throw new Error('Use a CSV with date, description, and amount columns and at least one transaction.');
  }
  let totalCents = 0;
  return rows.map((row, index) => {
    const day = row[date];
    const label = row[description]?.toLowerCase();
    const rawAmount = row[amount]?.replace(',', '.');
    const cents = Math.round(Number(rawAmount) * 100);
    totalCents += Math.abs(cents);
    const parsedDate = new Date(day);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(+parsedDate) ||
      parsedDate.toISOString().slice(0, 10) !== day ||
      !label ||
      !/^[+-]?\d+(?:\.\d{1,2})?$/.test(rawAmount) ||
      !Number.isSafeInteger(totalCents)
    ) {
      throw new Error(`Invalid transaction on data row ${index + 1}. Use YYYY-MM-DD dates and signed amounts.`);
    }
    return { date: day, month: day.slice(0, 7), label, cents };
  });
}

export function summarizeTransactions(
  transactions: CsvTransaction[],
  candidates: MerchantCandidate[] = [],
  decisions: (string | null)[] = [],
) {
  const classifications = new Map<string, string>();
  for (const [index, candidate] of candidates.entries()) {
    const category = decisions[index];
    const allowed = candidate.direction === 'in' ? incomeCategories : expenseCategories;
    if (category && allowed.includes(category)) classifications.set(merchantKey(candidate), category);
  }
  // Complete months, judged from the range of dates in the file.
  const dates = transactions.map(transaction => transaction.date).sort();
  const coveredFrom = dates[0] ?? null;
  const coveredTo = dates.at(-1) ?? null;
  const observedMonths = [...new Set(transactions.map(transaction => transaction.month))].sort();
  const completeMonths: string[] = [];
  if (coveredFrom && coveredTo) {
    let [year, month] = [Number(coveredFrom.slice(0, 4)), Number(coveredFrom.slice(5, 7))];
    for (;;) {
      const name = `${year}-${String(month).padStart(2, '0')}`;
      if (name > coveredTo.slice(0, 7)) break;
      const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      if (coveredFrom <= `${name}-01` && coveredTo >= lastDay) completeMonths.push(name);
      [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
    }
  }
  const partialMonths = observedMonths.filter(month => !completeMonths.includes(month));
  const averageBasis = completeMonths.length ? ('complete_months' as const) : ('partial_months_only' as const);
  const coveredDays =
    coveredFrom && coveredTo ? Math.round((Date.parse(coveredTo) - Date.parse(coveredFrom)) / 86_400_000) + 1 : 0;
  // Months the totals are divided by: the complete months, else the days covered (at least one month).
  const divisor = completeMonths.length || Math.max(1, coveredDays / (365.25 / 12));
  const averaged = (month: string) => averageBasis === 'partial_months_only' || completeMonths.includes(month);

  const payMonths = new Set<string>();
  const expenses: Record<string, number> = {};
  let inflows = 0;
  let outflows = 0;
  let payroll = 0;
  let transfers = 0;
  for (const transaction of transactions) {
    const { month, label, cents } = transaction;
    const candidate = classifications.size ? merchantCandidate(transaction) : null;
    const predicted = candidate && classifications.get(merchantKey(candidate));
    if (internalTransfer.test(label)) {
      transfers++;
    } else if (!averaged(month)) {
      // A row of a partial month is counted in `transactionCount` and left out of every average.
    } else if (cents > 0) {
      inflows += cents;
      if (predicted === 'Payroll' || /salary|payroll|n[oó]mina|wages/.test(label)) {
        payMonths.add(month);
        payroll += cents;
      }
    } else if (cents < 0) {
      outflows -= cents;
      const fallback = expenseCategories.find(name => categories[name]?.test(label)) ?? 'Other';
      const category = predicted && predicted !== 'Other' ? predicted : fallback;
      expenses[category] = (expenses[category] ?? 0) - cents;
    }
  }
  const average = (cents: number) => Math.round(cents / divisor) / 100;
  const list = (months: string[]) => months.join(', ');
  const averagingNote =
    averageBasis === 'complete_months'
      ? `Monthly figures are averages of ${completeMonths.length} complete month(s): ${list(completeMonths)}.${
          partialMonths.length
            ? ` Left out as partial: ${list(partialMonths)} (the statement runs from ${coveredFrom} to ${coveredTo}).`
            : ''
        }`
      : `The statement runs from ${coveredFrom} to ${coveredTo} and covers no complete calendar month (${list(partialMonths)} are partial). The monthly figures are the totals of those ${coveredDays} day(s) spread over ${Math.round(divisor * 100) / 100} month(s): a rough indication, not a monthly average.`;
  return {
    /** Every month with at least one row, complete or not. */
    observedMonths,
    /** The months the monthly figures average; empty when only partial months exist. */
    completeMonths,
    /** Months with rows that the statement does not cover from the first to the last day. */
    partialMonths,
    averageBasis,
    averagingNote,
    coveredFrom,
    coveredTo,
    transactionCount: transactions.length,
    excludedTransfers: transfers,
    estimatedMonthlySalary: payroll ? average(payroll) : null,
    monthlyOtherIncome: average(inflows - payroll),
    /** Averaged months in which pay was identified. */
    salaryMonths: payMonths.size,
    monthlyInflows: average(inflows),
    monthlyCostOfLiving: average(outflows),
    monthlyNetCashFlow: average(inflows - outflows),
    monthlyExpenses: Object.fromEntries(
      Object.entries(expenses)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => [name, average(value)]),
    ),
  };
}

export function summarizeCsv(csv: string) {
  return summarizeTransactions(parseTransactions(csv));
}

/** Baseline and habit-adjusted months to a cash target, using the shared timeline rule. */
export function compareSavings({ target, saved, monthly, habit }: SavingsPlanInput) {
  const remaining = Math.max(0, target - saved);
  return {
    remaining,
    baselineMonths: monthsToTarget(remaining, monthly),
    withHabitMonths: monthsToTarget(remaining, monthly + habit),
  };
}
