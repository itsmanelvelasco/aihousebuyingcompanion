import { z } from 'zod';
import { safeId } from './ids.ts';

export const category = z.enum([
  'housing',
  'food',
  'transport',
  'utilities',
  'subscriptions',
  'healthcare',
  'education',
  'debt',
  'other',
]);
const money = z.number().int().safe().nonnegative().max(100_000_000_000);
export const summarySchema = z
  .object({
    /** True only when every movement behind the totals is fabricated; false for real bank data. */
    synthetic: z.boolean(),
    currency: z.literal('EUR'),
    from: z.iso.date(),
    to: z.iso.date(),
    monthCount: z.number().int().min(1).max(24),
    dataStatus: z.enum(['unknown', 'partial', 'observed']),
    incomeCents: money,
    expenseCents: money,
    spendingByCategory: z.partialRecord(category, money),
    recurringCategoryCounts: z.partialRecord(category, z.number().int().min(0).max(100)).optional(),
  })
  .strict()
  .refine(value => value.from <= value.to, 'from must not follow to');
export type FinancialSummary = z.infer<typeof summarySchema>;
export const suggestionSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    action: z.string().trim().min(1).max(300),
    category,
  })
  .strict();
export const suggestionsSchema = z.object({ suggestions: z.array(suggestionSchema).min(1).max(5) }).strict();
export const goalSchema = suggestionSchema
  .extend({
    id: safeId,
    targetDaysPerWeek: z.number().int().min(1).max(7),
    plannedMonthlySavingCents: money.nullable().default(null),
    active: z.boolean().default(true),
    /**
     * The day the person started the habit, or null when it is not known. The store sets it to the
     * current day when a goal is created active or switched back on, unless the request states a
     * day. The planner adds a habit on top of bank-observed spending only when it started after the
     * observed period; with null it cannot tell and leaves the habit out.
     */
    startedOn: z.iso.date().nullable().default(null),
  })
  .strict();
export const checkinSchema = z
  .object({
    id: safeId,
    date: z.iso.date(),
    completed: z.boolean(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();
export const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** True for a fictional persona, false for a person who belongs to an account. */
    synthetic: z.boolean(),
    userId: safeId,
    goals: z.array(goalSchema).max(20),
    checkins: z.array(checkinSchema.extend({ goalId: safeId })).max(1000),
  })
  .strict();
