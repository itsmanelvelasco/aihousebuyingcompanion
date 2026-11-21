import { z } from 'zod';
import { userId } from '../profile-api/store.ts';

export const category = z.enum(['housing', 'food', 'transport', 'utilities', 'subscriptions', 'healthcare', 'education', 'debt', 'other']);
const money = z.number().int().safe().nonnegative().max(100_000_000_000);
export const summarySchema = z.object({
  synthetic: z.literal(true), currency: z.literal('EUR'),
  from: z.iso.date(), to: z.iso.date(),
  monthCount: z.number().int().min(1).max(24),
  dataStatus: z.enum(['unknown', 'partial', 'observed']),
  incomeCents: money, expenseCents: money,
  spendingByCategory: z.partialRecord(category, money),
  recurringCategoryCounts: z.partialRecord(category, z.number().int().min(0).max(100)).optional()
}).strict().refine(value => value.from <= value.to, 'from must not follow to');
export type FinancialSummary = z.infer<typeof summarySchema>;
export const suggestionSchema = z.object({
  title: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(300),
  category
}).strict();
export const suggestionsSchema = z.object({ suggestions: z.array(suggestionSchema).min(1).max(5) }).strict();
export const goalSchema = suggestionSchema.extend({
  id: userId, targetDaysPerWeek: z.number().int().min(1).max(7),
  plannedMonthlySavingCents: money.nullable().default(null), active: z.boolean().default(true)
}).strict();
export const checkinSchema = z.object({
  id: userId, date: z.iso.date(), completed: z.boolean(), note: z.string().trim().max(200).optional()
}).strict();
export const stateSchema = z.object({
  schemaVersion: z.literal(1), synthetic: z.literal(true), userId,
  goals: z.array(goalSchema).max(20),
  checkins: z.array(checkinSchema.extend({ goalId: userId })).max(1000)
}).strict();
