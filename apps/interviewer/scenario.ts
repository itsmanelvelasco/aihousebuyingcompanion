import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { suggestHabits } from "../habits-agent/agent.ts";
import { compareSavings, summarizeCsv } from "./finances.mjs";
import type { firstScenarioInput } from "./savings-contract.ts";

export async function generateFirstScenario(input: z.infer<typeof firstScenarioInput>) {
  const { remaining, baselineMonths } = compareSavings({ ...input, habit: 0 });
  const baseline = { currency: input.currency, remaining, baselineMonths };
  if (!input.useDemoBank) return { ...baseline, suggestions: [] };

  const demo = summarizeCsv(await readFile(new URL("./demo.csv", import.meta.url), "utf8"));
  const cents = (amount: number) => Math.round(amount * 100);
  const expense = (category: string) => demo.monthlyExpenses[category] ?? 0;
  const firstMonth = demo.observedMonths[0];
  const lastMonth = demo.observedMonths.at(-1)!;
  const lastDay = new Date(Date.UTC(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5)), 0))
    .toISOString().slice(0, 10);
  const { suggestions } = suggestHabits({
    synthetic: true, currency: "EUR", from: `${firstMonth}-01`, to: lastDay,
    monthCount: demo.observedMonths.length, dataStatus: "observed",
    incomeCents: cents(demo.monthlyInflows), expenseCents: cents(demo.monthlyCostOfLiving),
    spendingByCategory: {
      food: cents(expense("Groceries") + expense("Eating out")),
      subscriptions: cents(expense("Subscriptions")),
      transport: cents(expense("Transport")),
    },
  });
  return { ...baseline, suggestions };
}
