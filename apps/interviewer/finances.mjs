const categories = {
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

export const expenseCategories = [...Object.keys(categories), 'Other'];
export const incomeCategories = ['Payroll', 'Other income'];
export const classificationLimit = 80;

function merchantCandidate({ label, cents }) {
  if (!cents || /internal transfer|own account|transferencia propia/.test(label)) return null;
  const description = label
    .replace(/https?:\/\/\S+|\S+@\S+|\b[\p{L}]{2}\d[\p{L}\d]{8,}\b/gu, ' ')
    .replace(/[^\p{L}\s&'-]+/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 100).trim();
  return description ? { direction: cents > 0 ? 'in' : 'out', description } : null;
}

const merchantKey = candidate => `${candidate.direction}:${candidate.description}`;

export function classificationCandidates(transactions) {
  const unique = new Map();
  for (const transaction of transactions) {
    const candidate = merchantCandidate(transaction);
    if (!candidate) continue;
    unique.set(merchantKey(candidate), candidate);
    if (unique.size >= classificationLimit) break;
  }
  return [...unique.values()];
}

function parseCsv(source) {
  const csv = source.replace(/^\uFEFF/, '').trim();
  const delimiter = csv.split(/\r?\n/, 1)[0].includes(';') ? ';' : ',';
  const rows = [];
  let row = [];
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

export function parseTransactions(csv) {
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
    const value = Number(rawAmount);
    const cents = Math.round(value * 100);
    totalCents += Math.abs(cents);
    const parsedDate = new Date(day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(+parsedDate) ||
        parsedDate.toISOString().slice(0, 10) !== day || !label ||
        !/^[+-]?\d+(?:\.\d{1,2})?$/.test(rawAmount) || !Number.isSafeInteger(totalCents)) {
      throw new Error(`Invalid transaction on data row ${index + 1}. Use YYYY-MM-DD dates and signed amounts.`);
    }
    return { month: day.slice(0, 7), label, cents };
  });
}

export function summarizeTransactions(transactions, candidates = [], decisions = []) {
  const classifications = new Map();
  for (const [index, candidate] of candidates.entries()) {
    const category = decisions[index];
    const allowed = candidate.direction === 'in' ? incomeCategories : expenseCategories;
    if (allowed.includes(category)) classifications.set(merchantKey(candidate), category);
  }
  const months = new Map();
  const expenses = {};
  let inflows = 0;
  let outflows = 0;
  let payroll = 0;
  let transfers = 0;
  for (const transaction of transactions) {
    const { month, label, cents } = transaction;
    if (!months.has(month)) months.set(month, 0);
    const candidate = classifications.size ? merchantCandidate(transaction) : null;
    const predicted = candidate && classifications.get(merchantKey(candidate));
    if (/internal transfer|own account|transferencia propia/.test(label)) {
      transfers++;
    } else if (cents > 0) {
      inflows += cents;
      if (predicted === 'Payroll' || /salary|payroll|n[oó]mina|wages/.test(label)) {
        months.set(month, months.get(month) + cents);
        payroll += cents;
      }
    } else if (cents < 0) {
      outflows -= cents;
      const fallback = expenseCategories.find(name => categories[name]?.test(label)) ?? 'Other';
      const category = predicted && predicted !== 'Other' ? predicted : fallback;
      expenses[category] = (expenses[category] ?? 0) - cents;
    }
  }
  const average = cents => Math.round(cents / months.size) / 100;
  const pay = [...months.values()];
  return {
    observedMonths: [...months.keys()].sort(),
    transactionCount: transactions.length,
    excludedTransfers: transfers,
    estimatedMonthlySalary: payroll ? average(payroll) : null,
    monthlyOtherIncome: average(inflows - payroll),
    salaryMonths: pay.filter(Boolean).length,
    monthlyInflows: average(inflows),
    monthlyCostOfLiving: average(outflows),
    monthlyNetCashFlow: average(inflows - outflows),
    monthlyExpenses: Object.fromEntries(Object.entries(expenses)
      .sort((a, b) => b[1] - a[1]).map(([name, value]) => [name, average(value)])),
  };
}

export function summarizeCsv(csv) {
  return summarizeTransactions(parseTransactions(csv));
}

export function compareSavings({ target, saved, monthly, habit }) {
  const remaining = Math.max(0, target - saved);
  const months = rate => {
    if (remaining === 0) return 0;
    const estimate = Math.ceil(remaining / rate);
    return rate > 0 && Number.isSafeInteger(estimate) ? estimate : null;
  };
  return { remaining, baselineMonths: months(monthly), withHabitMonths: months(monthly + habit) };
}
