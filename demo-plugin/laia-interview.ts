import { z } from 'zod';
import { expenseCategories } from '../apps/interviewer/finances.mjs';
import { generateFirstScenario } from '../apps/interviewer/scenario.ts';
import type { Answers } from './intake.ts';

const amount = z.number().min(-10_000_000).max(10_000_000).multipleOf(0.01);
const money = amount.nonnegative();
const note = z.string().trim().min(1).max(300);

export const laiaInterviewProfile = z.strictObject({
  householdSize: z.number().int().min(1).max(30),
  homeType: z.enum(['Flat', 'House', 'Either']),
  location: note,
  amenities: note,
  nearbyAreas: note,
  lifestyle: note,
  confirmedSalary: money,
  confirmedSpending: money,
  cashFlowNotes: note,
  target: money.positive(),
  saved: money,
  monthly: amount,
}).partial();

const category = z.string().refine(name => expenseCategories.includes(name), 'Unknown spending category.');
const cashSummary = z.strictObject({
  monthlyInflows: money,
  monthlyCostOfLiving: money,
  monthlyExpenses: z.record(category, money),
  estimatedMonthlySalary: money.nullable(),
});

export const laiaInterviewSchema = z.strictObject({
  profile: laiaInterviewProfile,
  cash: cashSummary.nullable().default(null),
  source: z.enum(['demo', 'csv']).nullable(),
  currency: z.literal('EUR'),
}).refine(data => !data.cash || data.source !== null, 'Choose the source of the cash-flow summary.');

export type LaiaInterview = z.infer<typeof laiaInterviewSchema>;
export type FirstScenario = Awaited<ReturnType<typeof generateFirstScenario>>;

export function interviewBoardAnswers({ profile }: LaiaInterview): Answers {
  const answers: Answers = {};
  if (profile.householdSize !== undefined) answers.household = profile.householdSize;
  if (profile.location !== undefined) answers.town = profile.location;
  if (profile.confirmedSalary !== undefined) answers.income = profile.confirmedSalary;
  if (profile.target !== undefined) answers.cashTarget = profile.target;
  // The interview asks about purchase-earmarked savings and total spending.
  // The board's separate fields ask for all savings and spending excluding debt.
  return answers;
}

export async function interviewScenario({ profile, currency, source }: LaiaInterview): Promise<FirstScenario | null> {
  const { target, saved, monthly } = profile;
  if (target === undefined || saved === undefined || monthly === undefined) return null;
  return generateFirstScenario({ target, saved, monthly, currency, useDemoBank: source === 'demo' });
}
