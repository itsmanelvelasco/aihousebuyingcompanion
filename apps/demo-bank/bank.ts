import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ApiError } from '../../packages/http/server.ts';
import type { Customer, PlannedMovement } from './simulation.ts';
import { createCustomers, merchantCategories, nextDay, planDay, transactionTypes } from './simulation.ts';

/**
 * Banc Demo: the state and behaviour of a fictional neobank, without any HTTP.
 *
 * It keeps customers, accounts and the newest transactions in memory (a rolling window: the oldest
 * are folded into the account balances), walks the scripted simulation one movement per tick, and
 * pushes signed webhook events with retries. `server.ts` puts the REST API on
 * top. It is a demo: one process, no database, and every record it produces is fabricated.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const cents = z.number().int().safe();
export const transactionStates = ['pending', 'completed', 'declined', 'reverted'] as const;
export type TransactionState = (typeof transactionStates)[number];
export const eventTypes = ['TransactionCreated', 'TransactionStateChanged'] as const;
export type EventType = (typeof eventTypes)[number];

const transactionSchema = z
  .object({
    id: z.string(),
    /** Position in the bank's change order; it moves forward every time the transaction changes. */
    seq: z.number().int().positive(),
    customerId: z.string(),
    accountId: z.string(),
    type: z.enum(transactionTypes),
    state: z.enum(transactionStates),
    amountCents: cents,
    counterparty: z.string(),
    /** For a transfer between the customer's own accounts: the account on the other side. */
    ownAccountId: z.string().nullable(),
    category: z.enum(merchantCategories),
    createdAt: instant,
    updatedAt: instant,
    completedAt: instant.nullable(),
    /** Shared by the two legs of an own-account transfer. */
    transferId: z.string().nullable(),
  })
  .strict();
type StoredTransaction = z.infer<typeof transactionSchema>;

const subscriptionSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    secret: z.string(),
    events: z.array(z.enum(eventTypes)),
    createdAt: z.string(),
  })
  .strict();
type Subscription = z.infer<typeof subscriptionSchema>;

const deliverySchema = z
  .object({
    id: z.string(),
    eventId: z.string(),
    eventType: z.enum(eventTypes),
    subscriptionId: z.string(),
    url: z.string(),
    /** The exact bytes that are signed and sent, kept so a retry sends the same event. */
    body: z.string(),
    state: z.enum(['pending', 'delivered', 'dead']),
    attempts: z.number().int().nonnegative(),
    /** Wall-clock milliseconds of the next attempt, or null when no attempt is left. */
    nextAttemptAt: z.number().nullable(),
    lastStatus: z.number().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
type Delivery = z.infer<typeof deliverySchema>;

const plannedSchema = z
  .object({
    at: instant,
    customerId: z.string(),
    account: z.enum(['main', 'savings']),
    type: z.enum(transactionTypes),
    amountCents: cents,
    counterparty: z.string(),
    category: z.enum(merchantCategories),
    state: z.enum(['pending', 'completed', 'declined']),
    settlesAs: z.enum(['completed', 'reverted']).optional(),
    transferTo: z.enum(['main', 'savings']).optional(),
  })
  .strict();
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), at: instant, movement: plannedSchema }).strict(),
  z
    .object({
      kind: z.literal('settle'),
      at: instant,
      transactionId: z.string(),
      state: z.enum(['completed', 'reverted']),
    })
    .strict(),
]);
type Action = z.infer<typeof actionSchema>;

const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    synthetic: z.literal(true),
    seed: z.string(),
    startDate: day,
    customerCount: z.number().int().positive(),
    /** Changes whenever the bank starts from nothing, so cursors of a previous life are refused. */
    epoch: z.string(),
    simTime: instant,
    nextDay: day,
    ticks: z.number().int().nonnegative(),
    counters: z.object({ tx: cents, seq: cents, event: cents, subscription: cents, delivery: cents }).strict(),
    queue: z.array(actionSchema),
    /** Completed cents of the transactions dropped from the window, per account. */
    carried: z.record(z.string(), cents).default({}),
    /** Highest change position dropped from the window; a cursor before it has missed changes. */
    droppedThroughSeq: cents.default(0),
    droppedCount: cents.default(0),
    transactions: z.array(transactionSchema),
    subscriptions: z.array(subscriptionSchema),
    deliveries: z.array(deliverySchema),
  })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;

const decimal = z.string().regex(/^-?\d{1,9}(\.\d{1,2})?$/, 'Use a decimal string such as "-12.50"');

/** Body of `POST /simulate/transaction`. */
export const simulateTransactionSchema = z
  .object({
    customer_id: z.string().min(1).max(64),
    /** Defaults to the customer's main account. */
    account_id: z.string().min(1).max(64).optional(),
    /** Signed decimal string: negative for money out. Never zero. */
    amount: decimal,
    description: z.string().trim().min(1).max(140),
    category: z.enum(merchantCategories).default('other'),
    type: z.enum(transactionTypes).default('card_payment'),
    state: z.enum(['pending', 'completed', 'declined']).default('completed'),
    /** Another account of the same customer: makes it an own-account transfer with two legs. */
    to_account_id: z.string().min(1).max(64).optional(),
  })
  .strict();

/** Body of `PUT /webhooks/:id/secret`. Without a secret the bank invents a new one. */
export const rotateSecretSchema = z.object({ signing_secret: z.string().min(16).max(200).optional() }).strict();

/** Body of `POST /webhooks`. */
export const subscribeSchema = z
  .object({
    url: z.string().url().max(500),
    /** Defaults to every event type. */
    events: z.array(z.enum(eventTypes)).min(1).max(eventTypes.length).optional(),
  })
  .strict();

export type DemoBankCoreOptions = {
  /**
   * Same seed, same start date and same customer count give the same history. Default `banc-demo`.
   * When a snapshot is restored, an unset seed or start date is taken from the snapshot.
   */
  seed?: string;
  /**
   * First simulated day, `YYYY-MM-DD`. Default: the first day of the month three months before now,
   * decided once: a snapshot keeps the date it started with, so a new month does not move it.
   */
  startDate?: string;
  /** Number of fictional customers (`cust-001`, ...). Default 4. */
  customers?: number;
  /** The wall clock: event timestamps, signatures and retry delays. The simulated calendar is separate. */
  clock?: () => Date;
  /**
   * Milliseconds between simulation ticks once `start()` is called. Null (the default) starts no
   * timer: the caller steps the simulation with `step()`.
   */
  intervalMs?: number | null;
  /** Fast-forward silently from the start date to the wall clock when starting empty. Default true. */
  backfill?: boolean;
  /** JSON file the state is saved to and restored from. Without it a restart starts over. */
  snapshotFile?: string;
  /** Signing secret given to every webhook subscription. Default: a random secret per subscription. */
  signingSecret?: string;
  /** Webhook delivery policy. */
  delivery?: {
    /** Attempts before a delivery is dead-lettered. Default 6. */
    maxAttempts?: number;
    /** Delay before the second attempt; it doubles after every failure. Default 1000. */
    baseMs?: number;
    /** How long one attempt may take. Default 5000. */
    timeoutMs?: number;
    /** How often due deliveries are looked for once `start()` is called. Default 250. */
    pumpMs?: number;
  };
  /** Accept webhook URLs on any host. By default only this machine (loopback) can be called. */
  allowRemoteWebhooks?: boolean;
  /**
   * Size of the rolling window of transactions. Beyond it the transaction that changed longest ago
   * is dropped and its completed amount is folded into the account's balance, so the bank never
   * stops producing movements. A cursor that points before the window is answered with 410.
   * Default 5000.
   */
  maxTransactions?: number;
  /** HTTP client used for deliveries; tests can replace it. */
  fetch?: typeof fetch;
};

const maxSubscriptions = 10;
const maxDeliveries = 500;
/** Receivers must reject signatures older than this; every attempt is signed with a fresh timestamp. */
export const signatureToleranceSeconds = 300;

/** Integer cents as the decimal string a bank API returns: `-1234` becomes `"-12.34"`. */
export function centsToDecimal(amountCents: number) {
  const absolute = Math.abs(amountCents);
  const text = `${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
  return amountCents < 0 ? `-${text}` : text;
}

/** A decimal string already checked by `decimal` as integer cents. */
function decimalToCents(amount: string) {
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = amount.replace('-', '').split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -value : value;
}

/**
 * The signature of one delivery attempt: lowercase hex HMAC-SHA256, keyed with the subscription's
 * signing secret, over `<timestamp>.<raw body>`, where the timestamp is the decimal string sent in
 * `X-Demo-Bank-Timestamp` (milliseconds since the Unix epoch).
 */
export function signWebhook(secret: string, timestamp: string, rawBody: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * A short, non-reversible mark of a signing secret, shown on each webhook so its owner can tell
 * whether the bank still signs with the secret the receiver verifies with.
 */
export function secretFingerprint(secret: string) {
  return createHash('sha256').update(`demo-bank-webhook-secret\n${secret}`).digest('hex').slice(0, 16);
}

const padded = (value: number) => String(value).padStart(6, '0');

/** The two accounts of every customer. */
function createAccounts(customers: Customer[]) {
  return customers.flatMap(customer => {
    const number = customer.id.slice('cust-'.length);
    return [
      {
        id: `acc-${number}-main`,
        customerId: customer.id,
        kind: 'main' as const,
        name: 'Compte corrent fictici',
        openingBalanceCents: customer.mainOpeningCents,
      },
      {
        id: `acc-${number}-savings`,
        customerId: customer.id,
        kind: 'savings' as const,
        name: 'Compte d’estalvi fictici',
        openingBalanceCents: customer.savingsOpeningCents,
      },
    ];
  });
}
type Account = ReturnType<typeof createAccounts>[number];

/** True for URLs that point at this machine. */
function isLoopback(url: URL) {
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/** The first day of the month three months before the given instant. */
function defaultStartDate(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0, 10);
}

export function createDemoBankCore(options: DemoBankCoreOptions = {}) {
  const clock = options.clock ?? (() => new Date());
  const customerCountSchema = z.number().int().min(1).max(50);
  let seed = options.seed ?? 'banc-demo';
  let customerCount = customerCountSchema.parse(options.customers ?? 4);
  let startDate = day.parse(options.startDate ?? defaultStartDate(clock()));
  const maxTransactions = z
    .number()
    .int()
    .min(1)
    .parse(options.maxTransactions ?? 5000);
  const maxAttempts = options.delivery?.maxAttempts ?? 6;
  const retryBaseMs = options.delivery?.baseMs ?? 1000;
  const timeoutMs = options.delivery?.timeoutMs ?? 5000;
  const pumpMs = options.delivery?.pumpMs ?? 250;
  const http = options.fetch ?? fetch;

  let customers = createCustomers(seed, customerCount);
  let customerById = new Map(customers.map(customer => [customer.id, customer]));
  let accounts = createAccounts(customers);
  const accountOf = (customerId: string, kind: 'main' | 'savings') =>
    accounts.find(account => account.customerId === customerId && account.kind === kind)!;

  let epoch = randomBytes(6).toString('hex');
  let simTime = `${startDate}T00:00:00.000Z`;
  let nextPlanDay = startDate;
  let ticks = 0;
  let counters = { tx: 0, seq: 0, event: 0, subscription: 0, delivery: 0 };
  let queue: Action[] = [];
  let carried: Record<string, number> = {};
  let droppedThroughSeq = 0;
  let droppedCount = 0;
  const transactions = new Map<string, StoredTransaction>();
  const subscriptions = new Map<string, Subscription>();
  let deliveries: Delivery[] = [];

  const sending = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const shutdown = new AbortController();
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();
  let closed = false;

  // --- Snapshot: the whole state in one JSON file, replaced atomically. ---------------------------

  function snapshot(): Snapshot {
    return {
      schemaVersion: 1,
      synthetic: true,
      seed,
      startDate,
      customerCount,
      epoch,
      simTime,
      nextDay: nextPlanDay,
      ticks,
      counters,
      queue,
      carried,
      droppedThroughSeq,
      droppedCount,
      transactions: [...transactions.values()],
      subscriptions: [...subscriptions.values()],
      deliveries,
    };
  }

  /** Write the snapshot now: a temporary file, then a rename, so a crash never leaves half a file. */
  function save() {
    const file = options.snapshotFile;
    if (!file) return saving;
    saving = saving
      .catch(() => {})
      .then(async () => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          // A first start on a fresh machine: the folder of the snapshot may not exist yet.
          await mkdir(dirname(file), { recursive: true });
          await writeFile(temporary, `${JSON.stringify(snapshot())}\n`, { mode: 0o600 });
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    return saving;
  }

  /** Save soon. Changes that arrive together share one write. */
  function changed() {
    if (!options.snapshotFile || saveTimer || closed) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void save().catch(() => {});
    }, 200);
    saveTimer.unref();
  }

  /** Restore a previous life. Returns false when there is no snapshot file. */
  async function restore() {
    if (!options.snapshotFile) return false;
    let text: string;
    try {
      text = await readFile(options.snapshotFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const stored = snapshotSchema.parse(JSON.parse(text));
    // Only a setting that was given can disagree with the snapshot. The default start date depends
    // on today's date, so comparing it would refuse the bank's own snapshot when the month changes.
    if (
      (options.seed !== undefined && stored.seed !== seed) ||
      (options.startDate !== undefined && stored.startDate !== startDate) ||
      (options.customers !== undefined && stored.customerCount !== customerCount)
    )
      throw new Error(
        'The demo bank snapshot was made with another seed, start date or customer count; delete it or restore those settings',
      );
    // The history belongs to the seed, start date and customers it was made with: reuse them.
    ({ seed, startDate, epoch, simTime, ticks, counters, queue, deliveries } = stored);
    ({ carried, droppedThroughSeq, droppedCount } = stored);
    customerCount = customerCountSchema.parse(stored.customerCount);
    customers = createCustomers(seed, customerCount);
    customerById = new Map(customers.map(customer => [customer.id, customer]));
    accounts = createAccounts(customers);
    nextPlanDay = stored.nextDay;
    for (const transaction of stored.transactions) transactions.set(transaction.id, transaction);
    trim();
    for (const subscription of stored.subscriptions) subscriptions.set(subscription.id, subscription);
    return true;
  }

  // --- Webhooks: events, signed deliveries, retries with backoff, dead letters. -------------------

  /** Queue one event for every subscription that listens to its type. Never waits for a receiver. */
  function emit(type: EventType, transaction: StoredTransaction, previousState: TransactionState | null) {
    const listeners = [...subscriptions.values()].filter(subscription => subscription.events.includes(type));
    if (!listeners.length) return;
    const now = clock();
    const body = JSON.stringify({
      id: `evt-${padded(++counters.event)}`,
      type,
      created_at: now.toISOString(),
      synthetic: true,
      data: {
        customer_id: transaction.customerId,
        account_id: transaction.accountId,
        transaction_id: transaction.id,
        state: transaction.state,
        previous_state: previousState,
      },
    });
    for (const subscription of listeners) {
      deliveries.push({
        id: `dlv-${padded(++counters.delivery)}`,
        eventId: `evt-${padded(counters.event)}`,
        eventType: type,
        subscriptionId: subscription.id,
        url: subscription.url,
        body,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: now.getTime(),
        lastStatus: null,
        lastError: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    }
    // The log is bounded: finished deliveries go first, then the oldest pending ones.
    while (deliveries.length > maxDeliveries) {
      const finished = deliveries.findIndex(delivery => delivery.state !== 'pending');
      deliveries.splice(Math.max(finished, 0), 1);
    }
  }

  /** One attempt. The outcome is recorded on the delivery; this function never throws. */
  async function attempt(delivery: Delivery) {
    const subscription = subscriptions.get(delivery.subscriptionId);
    let status: number | null = null;
    let error: string | null = null;
    if (!subscription) error = 'subscription deleted';
    else {
      const timestamp = String(clock().getTime());
      try {
        const response = await http(delivery.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)]),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'demo-bank-webhooks/1',
            'X-Demo-Bank': 'fictional',
            'X-Demo-Bank-Event-Id': delivery.eventId,
            'X-Demo-Bank-Timestamp': timestamp,
            'X-Demo-Bank-Signature': signWebhook(subscription.secret, timestamp, delivery.body),
            'X-Demo-Bank-Delivery-Attempt': String(delivery.attempts + 1),
          },
          body: delivery.body,
        });
        status = response.status;
        await response.body?.cancel().catch(() => {});
        if (!response.ok) error = `receiver answered ${status}`;
      } catch (failure) {
        error = (failure as Error)?.name === 'TimeoutError' ? 'timeout' : 'connection failed';
      }
    }
    if (closed && error && subscription) return; // Interrupted by shutdown: the attempt does not count.
    const now = clock();
    delivery.attempts++;
    delivery.lastStatus = status;
    delivery.lastError = error;
    delivery.updatedAt = now.toISOString();
    if (!error) {
      delivery.state = 'delivered';
      delivery.nextAttemptAt = null;
    } else if (!subscription || delivery.attempts >= maxAttempts) {
      delivery.state = 'dead';
      delivery.nextAttemptAt = null;
    } else {
      delivery.nextAttemptAt = now.getTime() + retryBaseMs * 2 ** (delivery.attempts - 1);
    }
    changed();
  }

  /** Start every delivery that is due on the wall clock. Returns immediately. */
  function pump() {
    if (closed) return;
    const now = clock().getTime();
    for (const delivery of deliveries) {
      if (delivery.state !== 'pending' || sending.has(delivery.id) || (delivery.nextAttemptAt ?? 0) > now) continue;
      sending.add(delivery.id);
      const running: Promise<void> = attempt(delivery).finally(() => {
        sending.delete(delivery.id);
        inFlight.delete(running);
      });
      inFlight.add(running);
    }
  }

  // --- Transactions. ------------------------------------------------------------------------------

  type NewTransaction = {
    customerId: string;
    accountId: string;
    type: StoredTransaction['type'];
    state: 'pending' | 'completed' | 'declined';
    amountCents: number;
    counterparty: string;
    category: StoredTransaction['category'];
    ownAccountId?: string;
    transferId?: string;
  };

  function createTransaction(input: NewTransaction, at: string, notify: boolean) {
    const transaction: StoredTransaction = {
      id: `tx-${padded(++counters.tx)}`,
      seq: ++counters.seq,
      customerId: input.customerId,
      accountId: input.accountId,
      type: input.type,
      state: input.state,
      amountCents: input.amountCents,
      counterparty: input.counterparty,
      ownAccountId: input.ownAccountId ?? null,
      category: input.category,
      createdAt: at,
      updatedAt: at,
      completedAt: input.state === 'completed' ? at : null,
      transferId: input.transferId ?? null,
    };
    transactions.set(transaction.id, transaction);
    if (notify) emit('TransactionCreated', transaction, null);
    trim();
    return transaction;
  }

  /**
   * Keep the window at its size: drop the transactions that changed longest ago. A completed one
   * stays in its account's balance through `carried`; a pending one never settled and counts for
   * nothing. Readers whose cursor is older than a dropped change are told to start again (410).
   */
  function trim() {
    while (transactions.size > maxTransactions) {
      // Usually one transaction too many: a scan is cheaper than keeping a second ordering.
      let oldest: StoredTransaction | undefined;
      for (const transaction of transactions.values())
        if (!oldest || transaction.seq < oldest.seq) oldest = transaction;
      if (!oldest) return;
      if (oldest.state === 'completed')
        carried[oldest.accountId] = (carried[oldest.accountId] ?? 0) + oldest.amountCents;
      droppedThroughSeq = Math.max(droppedThroughSeq, oldest.seq);
      droppedCount++;
      transactions.delete(oldest.id);
    }
  }

  /** Create a movement and, for an own-account transfer, its mirror leg on the receiving account. */
  function createMovement(input: NewTransaction, receivingAccountId: string | undefined, at: string, notify: boolean) {
    if (!receivingAccountId) return [createTransaction(input, at, notify)];
    const transferId = `trf-${padded(counters.tx + 1)}`;
    return [
      createTransaction({ ...input, ownAccountId: receivingAccountId, transferId }, at, notify),
      createTransaction(
        {
          ...input,
          accountId: receivingAccountId,
          amountCents: -input.amountCents,
          ownAccountId: input.accountId,
          transferId,
        },
        at,
        notify,
      ),
    ];
  }

  /** Move a pending transaction to its final state. Anything else is a conflict. */
  function settle(
    transaction: StoredTransaction,
    state: 'completed' | 'declined' | 'reverted',
    at: string,
    notify: boolean,
  ) {
    if (transaction.state !== 'pending') throw new ApiError(409, 'Only a pending transaction can change state');
    const previous = transaction.state;
    transaction.state = state;
    transaction.updatedAt = at;
    transaction.completedAt = state === 'completed' ? at : null;
    transaction.seq = ++counters.seq;
    if (notify) emit('TransactionStateChanged', transaction, previous);
    return transaction;
  }

  // --- The simulation: one planned action per tick, on a simulated calendar. ----------------------

  const byTime = (a: Action, b: Action) => a.at.localeCompare(b.at);

  /** Make sure the next action is known: plan further days until the head of the queue is settled. */
  function plan() {
    while (!queue.length || queue[0].at >= `${nextPlanDay}T00:00:00.000Z`) {
      for (const movement of planDay(seed, customers, nextPlanDay))
        queue.push({ kind: 'create', at: movement.at, movement });
      queue.sort(byTime);
      nextPlanDay = nextDay(nextPlanDay);
    }
  }

  function apply(action: Action, notify: boolean): StoredTransaction[] {
    simTime = action.at;
    if (action.kind === 'settle') {
      const transaction = transactions.get(action.transactionId);
      // It may have been settled by hand through the admin API in the meantime.
      return transaction?.state === 'pending' ? [settle(transaction, action.state, action.at, notify)] : [];
    }
    const movement: PlannedMovement = action.movement;
    const account = accountOf(movement.customerId, movement.account);
    const created = createMovement(
      {
        customerId: movement.customerId,
        accountId: account.id,
        type: movement.type,
        state: movement.state,
        amountCents: movement.amountCents,
        counterparty: movement.counterparty,
        category: movement.category,
      },
      movement.transferTo ? accountOf(movement.customerId, movement.transferTo).id : undefined,
      action.at,
      notify,
    );
    if (movement.state === 'pending' && movement.settlesAs) {
      const settlesAt = new Date(new Date(action.at).getTime() + 86_400_000).toISOString();
      queue.push({ kind: 'settle', at: settlesAt, transactionId: created[0].id, state: movement.settlesAs });
      queue.sort(byTime);
    }
    return created;
  }

  /** Run one planned action. Returns the transactions it created or changed. */
  function tick(notify = true) {
    plan();
    const affected = apply(queue.shift()!, notify);
    ticks++;
    if (notify) {
      changed();
      pump();
    }
    return affected;
  }

  /** Replay the plan silently up to the wall clock, so a new bank has a past to pull. */
  function backfill() {
    const until = clock().toISOString();
    for (;;) {
      plan();
      if (queue[0].at > until) break;
      tick(false);
    }
  }

  const ready = (async () => {
    if (await restore()) return;
    if (options.backfill !== false) backfill();
    await save();
  })();
  ready.catch(() => {});

  // --- Views: what the API returns. ---------------------------------------------------------------

  /** Balance just before the oldest transaction still in the window. */
  function windowOpeningCents(account: Account) {
    return account.openingBalanceCents + (carried[account.id] ?? 0);
  }

  /** First day the window covers for an account: the start date until history has been dropped. */
  function windowOpenedOn(account: Account) {
    if (!droppedCount) return startDate;
    let first = simTime;
    for (const transaction of transactions.values())
      if (transaction.accountId === account.id && transaction.createdAt < first) first = transaction.createdAt;
    return first.slice(0, 10);
  }

  function balanceCents(account: Account) {
    let balance = windowOpeningCents(account);
    for (const transaction of transactions.values())
      if (transaction.accountId === account.id && transaction.state === 'completed') balance += transaction.amountCents;
    return balance;
  }

  function accountView(account: Account) {
    return {
      id: account.id,
      customer_id: account.customerId,
      name: account.name,
      type: account.kind === 'main' ? 'current' : 'savings',
      currency: 'EUR',
      /** Opening balance plus completed transactions. */
      balance: centsToDecimal(balanceCents(account)),
      /**
       * Balance immediately before the oldest transaction the bank still lists, and the day of that
       * transaction. They move forward together when old history leaves the rolling window, so
       * opening balance plus listed completed transactions always equals `balance`.
       */
      opening_balance: centsToDecimal(windowOpeningCents(account)),
      opened_on: windowOpenedOn(account),
      synthetic: true,
    };
  }

  function transactionView(transaction: StoredTransaction) {
    return {
      id: transaction.id,
      customer_id: transaction.customerId,
      account_id: transaction.accountId,
      type: transaction.type,
      state: transaction.state,
      amount: centsToDecimal(transaction.amountCents),
      currency: 'EUR',
      description: transaction.counterparty,
      counterparty: {
        name: transaction.counterparty,
        /** True for a transfer between two accounts of the same customer. */
        own_account: transaction.ownAccountId !== null,
        account_id: transaction.ownAccountId,
      },
      merchant_category: transaction.category,
      transfer_id: transaction.transferId,
      created_at: transaction.createdAt,
      updated_at: transaction.updatedAt,
      completed_at: transaction.completedAt,
      synthetic: true,
    };
  }

  function subscriptionView(subscription: Subscription) {
    return {
      id: subscription.id,
      url: subscription.url,
      events: subscription.events,
      /** Changes when the signing secret changes; the secret itself is never listed. */
      secret_fingerprint: secretFingerprint(subscription.secret),
      created_at: subscription.createdAt,
      synthetic: true,
    };
  }

  function requireCustomer(customerId: string): Customer {
    const customer = customerById.get(customerId);
    if (!customer) throw new ApiError(404, 'Customer not found');
    return customer;
  }

  const encodeCursor = (seq: number) => Buffer.from(JSON.stringify({ e: epoch, s: seq })).toString('base64url');
  /**
   * The position a cursor stands for. A cursor of another bank life, or one so old that changes
   * after it have left the rolling window, is refused with 410.
   */
  function decodeCursor(cursor: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new ApiError(400, 'Invalid cursor');
    }
    const position = z.object({ e: z.string(), s: z.number().int().nonnegative() }).safeParse(parsed);
    if (!position.success) throw new ApiError(400, 'Invalid cursor');
    if (position.data.e !== epoch || position.data.s > counters.seq || position.data.s < droppedThroughSeq)
      throw new ApiError(410, 'Cursor expired: start again without a cursor');
    return position.data.s;
  }

  return {
    /** Resolves when the snapshot has been restored or the history backfilled. Rejects on a bad snapshot. */
    ready,

    listCustomers() {
      return customers.map(customer => ({ id: customer.id, name: customer.name, synthetic: true }));
    },

    listAccounts(customerId: string) {
      requireCustomer(customerId);
      return accounts.filter(account => account.customerId === customerId).map(accountView);
    },

    /**
     * One page of a customer's transactions in change order: oldest change first, and a transaction
     * that changes state moves to the end. A reader that stores `next_cursor` and passes it back
     * therefore sees every new transaction and every state change exactly once per change.
     */
    listTransactions(
      customerId: string,
      query: { from?: string; cursor?: string; limit?: number; accountId?: string } = {},
    ) {
      requireCustomer(customerId);
      const after = query.cursor ? decodeCursor(query.cursor) : 0;
      const from = query.from && (query.from.length === 10 ? `${query.from}T00:00:00.000Z` : query.from);
      const limit = query.limit ?? 100;
      const matching = [...transactions.values()]
        .filter(
          transaction =>
            transaction.customerId === customerId &&
            transaction.seq > after &&
            (!from || transaction.createdAt >= from) &&
            (!query.accountId || transaction.accountId === query.accountId),
        )
        .sort((a, b) => a.seq - b.seq);
      const page = matching.slice(0, limit);
      const hasMore = matching.length > page.length;
      // Past the last page the cursor jumps to the bank's newest change, so the next read is cheap.
      const position = hasMore ? page[page.length - 1].seq : counters.seq;
      return {
        synthetic: true,
        transactions: page.map(transactionView),
        next_cursor: encodeCursor(position),
        has_more: hasMore,
      };
    },

    getTransaction(customerId: string, transactionId: string) {
      requireCustomer(customerId);
      const transaction = transactions.get(transactionId);
      if (!transaction || transaction.customerId !== customerId) throw new ApiError(404, 'Transaction not found');
      return transactionView(transaction);
    },

    /** Register a webhook. The signing secret is returned here and never again. */
    subscribe(input: unknown) {
      const request = subscribeSchema.parse(input);
      const url = new URL(request.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new ApiError(400, 'Use an http or https URL without credentials');
      if (!options.allowRemoteWebhooks && !isLoopback(url))
        throw new ApiError(400, 'This demo bank only calls webhooks on this machine (localhost)');
      if (subscriptions.size >= maxSubscriptions) throw new ApiError(400, 'Webhook limit reached');
      const subscription: Subscription = {
        id: `wh-${padded(++counters.subscription)}`,
        url: url.href,
        secret: options.signingSecret ?? `whsec-${randomBytes(24).toString('hex')}`,
        events: request.events ?? [...eventTypes],
        createdAt: clock().toISOString(),
      };
      subscriptions.set(subscription.id, subscription);
      changed();
      return {
        ...subscriptionView(subscription),
        signing_secret: subscription.secret,
        signature_tolerance_seconds: signatureToleranceSeconds,
      };
    },

    listSubscriptions() {
      return [...subscriptions.values()].map(subscriptionView);
    },

    /**
     * Replace the signing secret of a webhook, with the one given or a new random one. Its owner
     * uses this when the receiver starts verifying with another secret; deliveries that are still
     * waiting are signed with the new secret on their next attempt.
     */
    rotateSecret(subscriptionId: string, input: unknown) {
      const request = rotateSecretSchema.parse(input ?? {});
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) throw new ApiError(404, 'Webhook not found');
      subscription.secret = request.signing_secret ?? `whsec-${randomBytes(24).toString('hex')}`;
      changed();
      return {
        ...subscriptionView(subscription),
        signing_secret: subscription.secret,
        signature_tolerance_seconds: signatureToleranceSeconds,
      };
    },

    /** Remove a webhook. Its deliveries that were still waiting are dead-lettered on their next attempt. */
    unsubscribe(subscriptionId: string) {
      if (!subscriptions.delete(subscriptionId)) throw new ApiError(404, 'Webhook not found');
      changed();
      pump();
      return { deleted: subscriptionId };
    },

    /** The bounded delivery log, newest first. Bodies and secrets are not included. */
    listDeliveries(query: { state?: Delivery['state']; limit?: number } = {}) {
      return deliveries
        .filter(delivery => !query.state || delivery.state === query.state)
        .slice(-(query.limit ?? 100))
        .reverse()
        .map(delivery => ({
          id: delivery.id,
          event_id: delivery.eventId,
          event_type: delivery.eventType,
          webhook_id: delivery.subscriptionId,
          url: delivery.url,
          /** `pending` (waiting for an attempt or a retry), `delivered`, or `dead` (gave up). */
          state: delivery.state,
          attempts: delivery.attempts,
          next_attempt_at: delivery.nextAttemptAt === null ? null : new Date(delivery.nextAttemptAt).toISOString(),
          last_status: delivery.lastStatus,
          last_error: delivery.lastError,
          created_at: delivery.createdAt,
          updated_at: delivery.updatedAt,
        }));
    },

    /** Run `count` simulation ticks now and return the transactions they created or changed. */
    async step(count = 1) {
      await ready;
      const affected: StoredTransaction[] = [];
      for (let index = 0; index < count && !closed; index++) affected.push(...tick());
      return affected.map(transactionView);
    },

    /** Fire one specific movement now, at the simulation's current time. */
    async simulate(input: unknown) {
      await ready;
      const request = simulateTransactionSchema.parse(input);
      requireCustomer(request.customer_id);
      const own = accounts.filter(account => account.customerId === request.customer_id);
      const account = request.account_id
        ? own.find(candidate => candidate.id === request.account_id)
        : own.find(candidate => candidate.kind === 'main');
      if (!account) throw new ApiError(404, 'Account not found for this customer');
      const amountCents = decimalToCents(request.amount);
      if (amountCents === 0) throw new ApiError(400, 'The amount must not be zero');
      let receiving: Account | undefined;
      if (request.to_account_id) {
        receiving = own.find(candidate => candidate.id === request.to_account_id);
        if (!receiving || receiving.id === account.id)
          throw new ApiError(400, 'to_account_id must be another account of the same customer');
        if (amountCents > 0) throw new ApiError(400, 'A transfer leaves account_id: use a negative amount');
        if (request.state !== 'completed') throw new ApiError(400, 'Own-account transfers are completed at once');
      }
      const created = createMovement(
        {
          customerId: request.customer_id,
          accountId: account.id,
          type: receiving ? 'transfer' : request.type,
          state: request.state,
          amountCents,
          counterparty: request.description,
          category: receiving ? 'transfer' : request.category,
        },
        receiving?.id,
        simTime,
        true,
      );
      changed();
      pump();
      return created.map(transactionView);
    },

    /** Settle a pending transaction by hand: `completed`, `declined` or `reverted`. */
    async changeState(transactionId: string, state: 'completed' | 'declined' | 'reverted') {
      await ready;
      const transaction = transactions.get(transactionId);
      if (!transaction) throw new ApiError(404, 'Transaction not found');
      const view = transactionView(settle(transaction, state, simTime, true));
      changed();
      pump();
      return view;
    },

    /** Start due webhook deliveries and wait until none is in flight. Tests step retries with this. */
    async flushDeliveries() {
      pump();
      while (inFlight.size) await Promise.all([...inFlight]);
    },

    status() {
      return {
        synthetic: true,
        seed,
        start_date: startDate,
        /** The simulated calendar: the instant of the last movement. It runs ahead of the wall clock. */
        simulation_time: simTime,
        ticks,
        running: Boolean(tickTimer),
        interval_ms: options.intervalMs ?? null,
        /** Always null: the bank keeps a rolling window instead of pausing. Kept for older readers. */
        paused_reason: null,
        customers: customers.length,
        /** Transactions in the rolling window, its size, and how many older ones have left it. */
        transactions: transactions.size,
        max_transactions: maxTransactions,
        dropped_transactions: droppedCount,
        webhooks: subscriptions.size,
        deliveries: {
          pending: deliveries.filter(delivery => delivery.state === 'pending').length,
          delivered: deliveries.filter(delivery => delivery.state === 'delivered').length,
          dead: deliveries.filter(delivery => delivery.state === 'dead').length,
        },
      };
    },

    /** Start the real-time loop: one tick every `intervalMs`, and a pump for due deliveries. */
    async start() {
      await ready;
      if (closed || tickTimer || !options.intervalMs) return;
      tickTimer = setInterval(() => {
        try {
          tick();
        } catch {
          // A failing tick must not stop the bank; the next one tries again.
        }
      }, options.intervalMs);
      pumpTimer = setInterval(pump, pumpMs);
      pump();
    },

    /** Stop the timers, abandon deliveries in flight and write the final snapshot. */
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(tickTimer);
      clearInterval(pumpTimer);
      clearTimeout(saveTimer);
      tickTimer = undefined;
      shutdown.abort();
      await Promise.allSettled([...inFlight]);
      await ready.catch(() => {});
      await save().catch(() => {});
    },
  };
}

export type DemoBankCore = ReturnType<typeof createDemoBankCore>;
