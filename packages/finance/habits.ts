import type { z } from 'zod';
import type { FinancialSummary, suggestionsSchema } from '../contracts/habits.ts';
import { summarySchema } from '../contracts/habits.ts';

/** Rule-based habit suggestions from aggregate totals. No model call and no assumed savings. */
export function suggestHabits(input: FinancialSummary) {
  const summary = summarySchema.parse(input);
  const suggestions: z.infer<typeof suggestionsSchema>['suggestions'] = [
    {
      title: 'Weekly money check-in',
      action: 'Choose one short weekly check-in to review your plan and decide whether a habit still fits your needs.',
      category: 'other',
    },
  ];
  if (summary.dataStatus !== 'observed')
    return {
      source: 'rules',
      synthetic: true,
      suggestions,
      warnings: ['History is incomplete; no spending reduction or savings amount is assumed.'],
    };
  const candidates = [
    [
      'subscriptions',
      'Review optional subscriptions',
      'List optional subscriptions and decide which you still value. Keep essential services; do not cancel anything automatically.',
    ],
    [
      'food',
      'Plan one affordable meal',
      'Choose a realistic meal plan for one day that fits your dietary needs. Track whether planning helps; no saving is guaranteed.',
    ],
    [
      'transport',
      'Review one regular journey',
      'Compare one safe, practical journey option against your time and accessibility needs before changing how you travel.',
    ],
    [
      'other',
      'Review flexible spending',
      'Review one flexible spending choice and choose a small change only if it fits your priorities.',
    ],
  ] as const;
  for (const [category, title, action] of candidates)
    if ((summary.spendingByCategory[category] ?? 0) > 0) suggestions.push({ title, action, category });
  if (summary.expenseCents >= summary.incomeCents)
    suggestions[0] = {
      title: 'Review the cash-flow gap',
      action:
        'Confirm that income and essential commitments are complete before committing to extra savings. A deficit is a planning signal, not a personal failure.',
      category: 'other',
    };
  return {
    source: 'rules',
    synthetic: true,
    suggestions: suggestions.slice(0, 5),
    warnings: [
      'Suggestions are optional habits for review, not financial transactions, credit decisions or guaranteed savings.',
    ],
  };
}
