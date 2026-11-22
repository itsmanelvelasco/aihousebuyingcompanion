import { createHash } from 'node:crypto';

/**
 * The scripted life of Banc Demo's fictional customers.
 *
 * Everything here is a pure function of the seed, the customer and the calendar day: asking for the
 * plan of the same day twice gives the same movements, in the same order, with the same amounts.
 * The bank (`bank.ts`) walks this plan one movement per tick; nothing in this file keeps state,
 * reads a clock or talks to the network.
 */

/** Merchant categories the bank reports. ReloCat's provider maps them onto its own ledger enum. */
export const merchantCategories = [
  'salary',
  'rent',
  'utilities',
  'groceries',
  'restaurants',
  'transport',
  'subscriptions',
  'health',
  'education',
  'shopping',
  'loan',
  'transfer',
  'other',
] as const;
export type MerchantCategory = (typeof merchantCategories)[number];

export const transactionTypes = ['card_payment', 'direct_debit', 'transfer', 'salary'] as const;
export type TransactionType = (typeof transactionTypes)[number];

/** One fictional customer and the numbers its month is built from. All amounts are integer cents. */
export type Customer = {
  id: string;
  name: string;
  salaryCents: number;
  /** Day of the month the salary arrives (24-27, so the day after always exists). */
  salaryDay: number;
  rentCents: number;
  mainOpeningCents: number;
  savingsOpeningCents: number;
};

/** A movement the plan wants to happen at a given instant of the simulated calendar. */
export type PlannedMovement = {
  /** Simulated instant, ISO 8601 UTC. */
  at: string;
  customerId: string;
  /** Which of the customer's two accounts holds the movement. */
  account: 'main' | 'savings';
  type: TransactionType;
  /** Signed integer cents: money in is positive, money out is negative. */
  amountCents: number;
  counterparty: string;
  category: MerchantCategory;
  /** State the movement is born in. */
  state: 'pending' | 'completed' | 'declined';
  /** For a pending card payment: what it becomes one simulated day later. */
  settlesAs?: 'completed' | 'reverted';
  /** For a transfer between the customer's own accounts: the account that receives the money. */
  transferTo?: 'main' | 'savings';
};

/** A deterministic pseudo-random generator (mulberry32) keyed by the seed and any number of labels. */
export function seededRandom(seed: string, ...labels: (string | number)[]) {
  let state = createHash('sha256')
    .update([seed, ...labels].join('\n'))
    .digest()
    .readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** An integer between `min` and `max`, both included. */
function between(random: () => number, min: number, max: number) {
  return min + Math.floor(random() * (max - min + 1));
}

/** The customers of a seed: `cust-001`, `cust-002`, ... Each has a main and a savings account. */
export function createCustomers(seed: string, count: number): Customer[] {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, '0');
    const random = seededRandom(seed, 'customer', number);
    const salaryCents = between(random, 18, 32) * 10_000;
    return {
      id: `cust-${number}`,
      name: `Client fictici ${number}`,
      salaryCents,
      salaryDay: between(random, 24, 27),
      rentCents: Math.round((salaryCents * between(random, 28, 34)) / 10_000) * 100,
      mainOpeningCents: between(random, 2400, 5000) * 100,
      savingsOpeningCents: between(random, 3000, 12_000) * 100,
    };
  });
}

/** `YYYY-MM-DD` of the day after the given one. */
export function nextDay(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/** A share of the salary in cents, between two percentages given in hundredths of a percent. */
function share(random: () => number, salaryCents: number, minBasisPoints: number, maxBasisPoints: number) {
  return Math.max(100, Math.round((salaryCents * between(random, minBasisPoints, maxBasisPoints)) / 10_000));
}

const groceryShops = ['Mercat Demo', 'Supermercat Fictici', 'Forn Exemple'];
const cardShops: [string, MerchantCategory][] = [
  ['Restaurant Exemple', 'restaurants'],
  ['Botiga Mostra', 'shopping'],
  ['Farmacia Fictícia', 'health'],
  ['Llibreria Demo', 'education'],
];

/**
 * The movements of one customer on one simulated day, in time order. A believable month comes out
 * of the calendar: rent on the 1st, bills and subscriptions on fixed days, salary on the customer's
 * salary day and a transfer to savings the day after, groceries on Mondays, Thursdays and Saturdays,
 * and now and then a ticket, a card payment that stays pending or one the bank declines.
 */
export function planCustomerDay(seed: string, customer: Customer, date: string): PlannedMovement[] {
  const random = seededRandom(seed, customer.id, date);
  const day = new Date(`${date}T00:00:00.000Z`);
  const dayOfMonth = day.getUTCDate();
  const weekday = day.getUTCDay();
  const salary = customer.salaryCents;
  const movements: PlannedMovement[] = [];
  /** Add a movement at `hour:minute` of the day; minutes are drawn so same-hour movements keep an order. */
  const add = (hour: number, movement: Omit<PlannedMovement, 'at' | 'customerId' | 'account'>) => {
    const minute = String(between(random, 0, 59)).padStart(2, '0');
    const second = String(between(random, 0, 59)).padStart(2, '0');
    const at = `${date}T${String(hour).padStart(2, '0')}:${minute}:${second}.000Z`;
    movements.push({ at, customerId: customer.id, account: 'main', ...movement });
  };
  const debit = (hour: number, counterparty: string, category: MerchantCategory, amountCents: number) =>
    add(hour, { type: 'direct_debit', amountCents: -amountCents, counterparty, category, state: 'completed' });

  if (dayOfMonth === 1) debit(8, 'Finques Demo SL (lloguer)', 'rent', customer.rentCents);
  if (dayOfMonth === 2) debit(7, 'Transports Ficticis (abonament)', 'transport', 2135);
  if (dayOfMonth === 4) debit(9, 'Electrica Demo', 'utilities', share(random, salary, 200, 380));
  if (dayOfMonth === 6) debit(6, 'Streaming Exemple', 'subscriptions', 1399);
  if (dayOfMonth === 9) debit(9, 'Aigues Fictícies', 'utilities', share(random, salary, 90, 160));
  if (dayOfMonth === 14) debit(9, 'Fibra i Mobil Demo', 'utilities', 3990);
  if (dayOfMonth === 17) debit(6, 'Gimnas Mostra', 'subscriptions', 3490);
  if (dayOfMonth === 21) debit(6, 'Nuvol Demo', 'subscriptions', 299);
  if (dayOfMonth === customer.salaryDay)
    add(7, {
      type: 'salary',
      amountCents: salary,
      counterparty: 'Empresa Demo SA (nomina)',
      category: 'salary',
      state: 'completed',
    });
  if (dayOfMonth === customer.salaryDay + 1)
    add(10, {
      type: 'transfer',
      amountCents: -between(random, 10, 30) * 1000,
      counterparty: 'Traspas al compte d’estalvi',
      category: 'transfer',
      state: 'completed',
      transferTo: 'savings',
    });
  if ([1, 4, 6].includes(weekday))
    add(18, {
      type: 'card_payment',
      amountCents: -share(random, salary, 100, 350),
      counterparty: groceryShops[between(random, 0, groceryShops.length - 1)],
      category: 'groceries',
      state: 'completed',
    });
  if (random() < 0.25)
    add(8, {
      type: 'card_payment',
      amountCents: -between(random, 255, 1200),
      counterparty: 'Transports Ficticis (bitllet)',
      category: 'transport',
      state: 'completed',
    });
  if (random() < 0.18) {
    const [counterparty, category] = cardShops[between(random, 0, cardShops.length - 1)];
    add(20, {
      type: 'card_payment',
      amountCents: -share(random, salary, 80, 250),
      counterparty,
      category,
      state: 'pending',
      settlesAs: random() < 0.9 ? 'completed' : 'reverted',
    });
  }
  if (random() < 0.06)
    add(21, {
      type: 'card_payment',
      amountCents: -between(random, 3000, 20_000),
      counterparty: 'Botiga Mostra (targeta denegada)',
      category: 'shopping',
      state: 'declined',
    });
  return movements.sort((a, b) => a.at.localeCompare(b.at));
}

/** The movements of every customer on one day, in time order (ties broken by customer). */
export function planDay(seed: string, customers: readonly Customer[], date: string): PlannedMovement[] {
  return customers
    .flatMap(customer => planCustomerDay(seed, customer, date))
    .sort((a, b) => a.at.localeCompare(b.at) || a.customerId.localeCompare(b.customerId));
}
