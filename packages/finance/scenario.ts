import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { compareSavings, summarizeCsv } from './csv.ts';
import { suggestHabits } from './habits.ts';

export const firstScenarioInput = z
  .object({
    target: z.number().positive(),
    saved: z.number().nonnegative(),
    monthly: z.number(),
    currency: z.enum(['EUR', 'USD', 'GBP']),
    useDemoBank: z.boolean().default(false),
  })
  .strict();

export const firstScenarioOutput = z.object({
  currency: z.enum(['EUR', 'USD', 'GBP']),
  remaining: z.number().nonnegative(),
  baselineMonths: z.number().int().nonnegative().nullable(),
  suggestions: z.array(z.object({ title: z.string(), action: z.string(), category: z.string() })),
});

export async function generateFirstScenario(input: z.infer<typeof firstScenarioInput>) {
  const { remaining, baselineMonths } = compareSavings({ ...input, habit: 0 });
  const baseline = { currency: input.currency, remaining, baselineMonths };
  if (!input.useDemoBank) return { ...baseline, suggestions: [] };

  const demo = summarizeCsv(await readFile(new URL('../../data/demo-bank.csv', import.meta.url), 'utf8'));
  // The summary describes its complete months only; with none, the history is partial and says so.
  const complete = demo.averageBasis === 'complete_months';
  const months = complete ? demo.completeMonths : demo.observedMonths;
  // The summary holds monthly averages; the habit rules take totals for the period.
  const cents = (monthly: number | null) => Math.round((monthly ?? 0) * 100) * months.length;
  const expense = (category: string) => demo.monthlyExpenses[category] ?? 0;
  const firstMonth = months[0];
  const lastMonth = months.at(-1)!;
  const lastDay = new Date(Date.UTC(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5)), 0))
    .toISOString()
    .slice(0, 10);
  const { suggestions } = suggestHabits({
    synthetic: true,
    currency: 'EUR',
    from: `${firstMonth}-01`,
    to: lastDay,
    monthCount: months.length,
    dataStatus: complete ? 'observed' : 'partial',
    incomeCents: cents(demo.monthlyInflows),
    expenseCents: cents(demo.monthlyCostOfLiving),
    spendingByCategory: {
      food: cents(expense('Groceries') + expense('Eating out')),
      subscriptions: cents(expense('Subscriptions')),
      transport: cents(expense('Transport')),
    },
  });
  return { ...baseline, suggestions };
}
