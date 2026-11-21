import { z } from "zod";

const currency = z.enum(["EUR", "USD", "GBP"]);
const savingsPlan = z.object({
  target: z.number().positive(),
  saved: z.number().nonnegative(),
  monthly: z.number(),
});

export const savingsComparisonInput = savingsPlan.extend({ habit: z.number().nonnegative() });
export const savingsComparisonOutput = z.object({
  remaining: z.number().nonnegative(),
  baselineMonths: z.number().int().nonnegative().nullable(),
  withHabitMonths: z.number().int().nonnegative().nullable(),
});

export const firstScenarioInput = savingsPlan.extend({
  currency,
  useDemoBank: z.boolean().default(false),
}).strict();

export const firstScenarioOutput = savingsComparisonOutput.omit({ withHabitMonths: true }).extend({
  currency,
  suggestions: z.array(z.object({ title: z.string(), action: z.string(), category: z.string() })),
});

export const savingsCoachOutput = firstScenarioOutput.extend({ fictional: z.literal(true), ...savingsPlan.shape });
export type SavingsCoach = z.infer<typeof savingsCoachOutput>;
