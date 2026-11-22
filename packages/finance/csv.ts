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
 * When no month is complete the figures cannot be a monthly average. With at least
 * `minimumDaysForMonthlyFigure` days covered they are the totals of every row divided by the days
 * covered, expressed in months of 365.25 / 12 days and never less than one month, and
 * `averageBasis` says `partial_months_only`: read them as a rough indication.
 *
 * With fewer days than that (a single day, a week) the statement is too short for any monthly
 * figure: `averageBasis` says `period_too_short`, every monthly figure is `null` and the per-category
 * figures are empty, so nothing can be repeated as "a month". `periodTotals` still says what came in
 * and went out in the days covered, and `averagingNote` asks for a longer statement.
 */
/** Days a statement must cover before its totals may be scaled to a rough monthly figure. */
export const minimumDaysForMonthlyFigure = 28;

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
  const coveredDays =
    coveredFrom && coveredTo ? Math.round((Date.parse(coveredTo) - Date.parse(coveredFrom)) / 86_400_000) + 1 : 0;
  const averageBasis: 'complete_months' | 'partial_months_only' | 'period_too_short' = completeMonths.length
    ? 'complete_months'
    : coveredDays >= minimumDaysForMonthlyFigure
      ? 'partial_months_only'
      : 'period_too_short';
  const tooShort = averageBasis === 'period_too_short';
  // Months the totals are divided by: the complete months, else the days covered (at least one month).
  const divisor = completeMonths.length || Math.max(1, coveredDays / (365.25 / 12));
  const averaged = (month: string) => averageBasis !== 'complete_months' || completeMonths.includes(month);

  const payMonths = new Set<string>();
  const expenses: Record<string, number> = {};
  let inflows = 0;
  let outflows = 0;
  let payroll = 0;
  let transfers = 0;
  // What came in and went out over every day covered, partial months included.
  let periodInflows = 0;
  let periodOutflows = 0;
  for (const transaction of transactions) {
    const { month, label, cents } = transaction;
    const candidate = classifications.size ? merchantCandidate(transaction) : null;
    const predicted = candidate && classifications.get(merchantKey(candidate));
    if (!internalTransfer.test(label)) {
      if (cents > 0) periodInflows += cents;
      else periodOutflows -= cents;
    }
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
  /** A monthly figure, or null when the statement is too short to give one. */
  const monthly = (cents: number) => (tooShort ? null : average(cents));
  const list = (months: string[]) => months.join(', ');
  const averagingNote =
    averageBasis === 'complete_months'
      ? `Monthly figures are averages of ${completeMonths.length} complete month(s): ${list(completeMonths)}.${
          partialMonths.length
            ? ` Left out as partial: ${list(partialMonths)} (the statement runs from ${coveredFrom} to ${coveredTo}).`
            : ''
        }`
      : tooShort
        ? `The statement runs from ${coveredFrom} to ${coveredTo}: ${coveredDays} day(s). That is too short for a monthly figure, so none is given. In those ${coveredDays} day(s) ${periodInflows / 100} came in and ${periodOutflows / 100} went out. Ask for a statement that covers at least one complete calendar month, or for the person's own estimate of a typical month.`
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
    /** Days from the earliest to the latest row, both included. */
    coveredDays,
    /** What came in and went out over the days covered, transfers between own accounts left out. Not monthly. */
    periodTotals: {
      inflows: periodInflows / 100,
      outflows: periodOutflows / 100,
      net: (periodInflows - periodOutflows) / 100,
    },
    transactionCount: transactions.length,
    excludedTransfers: transfers,
    // Every monthly figure below is null when `averageBasis` is `period_too_short`.
    estimatedMonthlySalary: payroll && !tooShort ? average(payroll) : null,
    monthlyOtherIncome: monthly(inflows - payroll),
    /** Averaged months in which pay was identified. */
    salaryMonths: payMonths.size,
    monthlyInflows: monthly(inflows),
    monthlyCostOfLiving: monthly(outflows),
    monthlyNetCashFlow: monthly(inflows - outflows),
    monthlyExpenses: tooShort
      ? {}
      : Object.fromEntries(
          Object.entries(expenses)
            .sort((a, b) => b[1] - a[1])
            .map(([name, value]) => [name, average(value)]),
        ),
  };
}

export function summarizeCsv(csv: string) {
  return summarizeTransactions(parseTransactions(csv));
}

/**
 * What may be said about a statement summary, in one place so the interview page, the voice model
 * and the MCP tools agree. The wording follows `averageBasis`: a monthly average only for complete
 * months, a rough indication for partial months, and no monthly figure at all, with a request for
 * a longer statement, when the period is too short.
 *
 * A summary saved before `averageBasis` existed has none; its figures are read as a rough indication.
 */
export function cashFlowStatements(
  summary: Pick<CashFlowSummary, 'estimatedMonthlySalary' | 'monthlyCostOfLiving'> &
    Partial<Pick<CashFlowSummary, 'averageBasis' | 'coveredDays' | 'coveredFrom' | 'coveredTo'>>,
  money: (amount: number) => string,
) {
  const salary = summary.estimatedMonthlySalary;
  const spending = summary.monthlyCostOfLiving;
  const askPay = 'What is your typical monthly take-home pay?';
  const askSpending = 'What are your main monthly expenses, such as rent, food and transport?';
  if (summary.averageBasis === 'period_too_short') {
    const period =
      summary.coveredFrom && summary.coveredFrom !== summary.coveredTo
        ? `${summary.coveredDays} days (${summary.coveredFrom} to ${summary.coveredTo})`
        : `a single day${summary.coveredFrom ? ` (${summary.coveredFrom})` : ''}`;
    return {
      /** False when no monthly figure may be quoted. */
      monthlyFigures: false,
      salaryQuestion: `Your statement covers only ${period}, which is too short to work out a monthly figure. ${askPay}`,
      spendingQuestion: `Your statement covers only ${period}, which is too short for a monthly spending figure. Can you add a statement that covers at least one full calendar month? If not, ${askSpending.charAt(0).toLowerCase()}${askSpending.slice(1)}`,
      guidance: `The statement covers only ${period}, which is too short for a monthly figure. Do not present any amount as monthly income, spending or an average. Say that the period is too short and ask for a statement covering at least one complete calendar month, or for the person's own estimate of a typical month.`,
    };
  }
  if (summary.averageBasis !== 'complete_months') {
    const caveat =
      'Your statement does not cover a complete calendar month, so this is a rough indication, not a monthly average';
    return {
      monthlyFigures: true,
      salaryQuestion: salary == null ? askPay : `${caveat}: about ${money(salary)} in monthly pay. ${askPay}`,
      spendingQuestion:
        spending == null
          ? askSpending
          : `${caveat}: about ${money(spending)} of spending a month. Can you add a longer statement, or tell me what a typical month looks like?`,
      guidance:
        'No calendar month is fully covered: the monthly figures are a rough indication, not a monthly average. Say so and ask for a statement covering at least one complete calendar month.',
    };
  }
  return {
    monthlyFigures: true,
    salaryQuestion: salary == null ? askPay : `The CSV suggests ${money(salary)} in monthly pay. ${askPay}`,
    spendingQuestion:
      spending == null
        ? askSpending
        : `Average spending was ${money(spending)} a month. Was anything unusual or missing?`,
    guidance: null,
  };
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
