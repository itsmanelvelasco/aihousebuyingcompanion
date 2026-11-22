import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { safeId } from '../../packages/contracts/ids.ts';
import { dateSchema, transactionSchema } from '../../packages/finance/cashflow.ts';
import { ApiError } from '../../packages/http/server.ts';
import { createStore } from '../../packages/profiles/store.ts';

export { dateSchema } from '../../packages/finance/cashflow.ts';

const money = z.number().int().min(-100_000_000_000).max(100_000_000_000);
export const accountSchema = z
  .object({
    id: safeId,
    name: z.string().trim().min(1).max(100),
    currency: z.literal('EUR'),
    openingBalanceCents: money,
    openingDate: dateSchema,
    synthetic: z.literal(true),
  })
  .strict();
const ledgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    synthetic: z.literal(true),
    updatedAt: z.string(),
    accounts: z.array(accountSchema).max(20),
    transactions: z.array(transactionSchema).max(10000),
    revision: z.number().int().nonnegative().default(0),
    events: z
      .array(
        z.object({
          sequence: z.number().int().positive(),
          occurredAt: z.string(),
          type: z.literal('bank.updated'),
          accountCount: z.number().int().nonnegative(),
          transactionCount: z.number().int().nonnegative(),
          synthetic: z.literal(true),
        }),
      )
      .max(500)
      .default([]),
  })
  .strict();
export type Ledger = z.infer<typeof ledgerSchema>;
const importSchema = z.object({ transactions: z.array(transactionSchema).min(1).max(500) }).strict();
export function createBankStore(root: string) {
  const profiles = createStore(root);
  const locks = new Map<string, Promise<unknown>>();
  async function read(id: string): Promise<Ledger> {
    await profiles.read(id, 'details');
    try {
      return ledgerSchema.parse(JSON.parse(await readFile(join(root, safeId.parse(id), 'bank-ledger.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        schemaVersion: 1,
        synthetic: true,
        updatedAt: '',
        accounts: [],
        transactions: [],
        revision: 0,
        events: [],
      };
    }
  }
  function validate(ledger: Ledger) {
    ledgerSchema.parse(ledger);
    for (const tx of ledger.transactions) {
      const account = ledger.accounts.find(a => a.id === tx.accountId);
      if (!account) throw new ApiError(400, `Unknown account: ${tx.accountId}`);
      if (tx.date < account.openingDate) throw new ApiError(400, 'Movement precedes account opening balance date');
    }
  }
  async function mutate<T>(id: string, change: (ledger: Ledger) => T) {
    safeId.parse(id);
    const previous = locks.get(id) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const ledger = await read(id);
        const previousContent = JSON.stringify([ledger.accounts, ledger.transactions]);
        const result = change(ledger);
        if (previousContent === JSON.stringify([ledger.accounts, ledger.transactions])) return { result, ledger };
        ledger.updatedAt = new Date().toISOString();
        ledger.revision++;
        ledger.events.push({
          sequence: ledger.revision,
          occurredAt: ledger.updatedAt,
          type: 'bank.updated',
          accountCount: ledger.accounts.length,
          transactionCount: ledger.transactions.length,
          synthetic: true,
        });
        ledger.events = ledger.events.slice(-500);
        validate(ledger);
        const target = join(root, id, 'bank-ledger.json');
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
        return { result, ledger };
      });
    locks.set(id, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(id) === operation) locks.delete(id);
    }
  }
  return {
    read,
    async events(id: string, after: number, limit: number) {
      const ledger = await read(id);
      const oldest = ledger.events[0]?.sequence ?? ledger.revision + 1;
      const requiresRefresh = after > ledger.revision || after < oldest - 1;
      const selected = ledger.events.filter(event => event.sequence > after).slice(0, limit);
      const nextCursor =
        requiresRefresh && after > ledger.revision ? ledger.revision : (selected.at(-1)?.sequence ?? after);
      return {
        synthetic: true,
        events: selected,
        latestRevision: ledger.revision,
        nextCursor,
        requiresRefresh,
        hasMore: nextCursor < ledger.revision,
      };
    },
    async createAccount(id: string, input: unknown) {
      const account = accountSchema.parse(input);
      return mutate(id, ledger => {
        if (ledger.accounts.some(a => a.id === account.id)) throw new ApiError(409, 'Account already exists');
        if (ledger.accounts.length >= 20) throw new ApiError(400, 'Account limit reached');
        ledger.accounts.push(account);
        return account;
      });
    },
    async updateAccount(id: string, accountId: string, input: unknown) {
      const account = accountSchema.parse(input);
      if (account.id !== accountId) throw new ApiError(400, 'Account ID must match route');
      return mutate(id, ledger => {
        const index = ledger.accounts.findIndex(a => a.id === accountId);
        if (index < 0) throw new ApiError(404, 'Account not found');
        ledger.accounts[index] = account;
        return account;
      });
    },
    async importTransactions(id: string, input: unknown) {
      const { transactions } = importSchema.parse(input);
      return mutate(id, ledger => {
        let inserted = 0,
          duplicates = 0;
        for (const tx of transactions) {
          const existing = ledger.transactions.find(item => item.id === tx.id);
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(tx))
              throw new ApiError(409, `Movement ID conflict: ${tx.id}`);
            duplicates++;
            continue;
          }
          ledger.transactions.push(tx);
          inserted++;
        }
        if (ledger.transactions.length > 10000) throw new ApiError(400, 'Movement limit reached');
        return { inserted, duplicates };
      });
    },
    async updateTransaction(id: string, transactionId: string, input: unknown) {
      const tx = transactionSchema.parse(input);
      if (tx.id !== transactionId) throw new ApiError(400, 'Movement ID must match route');
      return mutate(id, ledger => {
        const index = ledger.transactions.findIndex(item => item.id === transactionId);
        if (index < 0) throw new ApiError(404, 'Movement not found');
        ledger.transactions[index] = tx;
        return tx;
      });
    },
    async deleteTransaction(id: string, transactionId: string) {
      return mutate(id, ledger => {
        const index = ledger.transactions.findIndex(item => item.id === transactionId);
        if (index < 0) throw new ApiError(404, 'Movement not found');
        ledger.transactions.splice(index, 1);
        return { deleted: transactionId };
      });
    },
    async seedDemo(id: string) {
      const snapshot = await profiles.read(id, 'bank-account');
      const data = z
        .object({
          snapshotDate: dateSchema,
          balanceCents: money.nonnegative(),
          monthlyIncomeCents: money.nonnegative(),
          monthlyExpensesCents: money.nonnegative(),
          debtPaymentsCents: money.nonnegative(),
        })
        .parse(snapshot);
      const snapshotDate = new Date(`${data.snapshotDate}T00:00:00Z`);
      return mutate(id, ledger => {
        if (ledger.accounts.length || ledger.transactions.length)
          throw new ApiError(409, 'Demo seeding requires an empty ledger');
        const first = new Date(Date.UTC(snapshotDate.getUTCFullYear(), snapshotDate.getUTCMonth() - 3, 1));
        const cashflow = data.monthlyIncomeCents - data.monthlyExpensesCents - data.debtPaymentsCents;
        ledger.accounts.push({
          id: 'demo-current',
          name: 'Fictional current account',
          currency: 'EUR',
          synthetic: true,
          openingDate: first.toISOString().slice(0, 10),
          openingBalanceCents: data.balanceCents - cashflow * 3,
        });
        for (let index = 0; index < 3; index++) {
          const month = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index, 1))
            .toISOString()
            .slice(0, 7);
          const expenses = data.monthlyExpensesCents;
          const subscription = Math.min(expenses, 2500);
          const rent = Math.floor((expenses - subscription) * 0.55);
          const rows = [
            ['salary', 'income', data.monthlyIncomeCents, 'Fictional household income', '02'],
            ['rent', 'housing', -rent, 'Fictional rent', '05'],
            ['subscription', 'subscriptions', -subscription, 'Fictional subscription', '10'],
            ['living', 'other', -(expenses - subscription - rent), 'Fictional living expenses', '15'],
            ['debt', 'debt', -data.debtPaymentsCents, 'Fictional debt payment', '20'],
          ] as const;
          for (const [key, category, amount, description, day] of rows) {
            if (!amount) continue;
            ledger.transactions.push(
              transactionSchema.parse({
                id: `${key}-${month}`,
                accountId: 'demo-current',
                date: `${month}-${day}`,
                amountCents: amount,
                description,
                category,
                currency: 'EUR',
                status: 'booked',
                synthetic: true,
              }),
            );
          }
        }
        return {
          seeded: true,
          from: first.toISOString().slice(0, 10),
          to: new Date(Date.UTC(snapshotDate.getUTCFullYear(), snapshotDate.getUTCMonth(), 0))
            .toISOString()
            .slice(0, 10),
          note: 'Three scripted months, derived from the profile snapshot; not actual transaction history.',
        };
      });
    },
  };
}

export function accountBalances(ledger: Ledger, asOf: string) {
  return ledger.accounts.map(account => {
    if (asOf < account.openingDate) return { ...account, balanceCents: null, asOf, status: 'before_opening_date' };
    const balance = ledger.transactions
      .filter(tx => tx.accountId === account.id && tx.status === 'booked' && tx.date <= asOf)
      .reduce((sum, tx) => sum + tx.amountCents, account.openingBalanceCents);
    if (!Number.isSafeInteger(balance)) throw new ApiError(400, 'Balance exceeds safe integer range');
    return { ...account, balanceCents: balance, asOf, status: 'calculated' };
  });
}
