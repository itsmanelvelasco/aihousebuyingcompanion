import { z } from 'zod';
import { suggestionsSchema, summarySchema } from './contracts.ts';
import type { FinancialSummary } from './contracts.ts';

export function suggestHabits(input: FinancialSummary) {
  const summary = summarySchema.parse(input);
  const suggestions: z.infer<typeof suggestionsSchema>['suggestions'] = [{ title: 'Weekly money check-in', action: 'Choose one short weekly check-in to review your plan and decide whether a habit still fits your needs.', category: 'other' }];
  if (summary.dataStatus !== 'observed') return { source: 'rules', synthetic: true, suggestions, warnings: ['History is incomplete; no spending reduction or savings amount is assumed.'] };
  const candidates = [
    ['subscriptions', 'Review optional subscriptions', 'List optional subscriptions and decide which you still value. Keep essential services; do not cancel anything automatically.'],
    ['food', 'Plan one affordable meal', 'Choose a realistic meal plan for one day that fits your dietary needs. Track whether planning helps; no saving is guaranteed.'],
    ['transport', 'Review one regular journey', 'Compare one safe, practical journey option against your time and accessibility needs before changing how you travel.'],
    ['other', 'Review flexible spending', 'Review one flexible spending choice and choose a small change only if it fits your priorities.']
  ] as const;
  for (const [category, title, action] of candidates) if ((summary.spendingByCategory[category] ?? 0) > 0) suggestions.push({ title, action, category });
  if (summary.expenseCents >= summary.incomeCents) suggestions[0] = { title: 'Review the cash-flow gap', action: 'Confirm that income and essential commitments are complete before committing to extra savings. A deficit is a planning signal, not a personal failure.', category: 'other' };
  return { source: 'rules', synthetic: true, suggestions: suggestions.slice(0, 5), warnings: ['Suggestions are optional habits for review, not financial transactions, credit decisions or guaranteed savings.'] };
}

export function createOpenAIHabits(options: { apiKey?: string; model?: string; maxOutputTokens?: number; fetcher?: typeof fetch } = {}) {
  const model = options.model ?? 'gpt-6.2-sol';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model)) throw new Error('Invalid model ID');
  const maxOutputTokens = options.maxOutputTokens ?? 1024;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 2048) throw new Error('Output token limit must be 128–2048');
  return {
    model, maxOutputTokens, configured: Boolean(options.apiKey),
    async suggest(input: FinancialSummary) {
      if (!options.apiKey) throw new Error('OpenAI is not configured');
      const summary = summarySchema.parse(input);
      // Only allowlisted financial totals leave this service. No identity, notes or merchants.
      const aggregate = JSON.stringify(summary);
      if (aggregate.length > 6000) throw new Error('Aggregate exceeds prompt limit');
      const response = await (options.fetcher ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model, store: false, max_output_tokens: maxOutputTokens, reasoning: { effort: 'low' },
          instructions: 'Suggest 1–5 optional, kind, practical money habits using only the supplied synthetic aggregates. Do not infer identity, diagnose, shame, recommend loans/investments, promise credit approval or savings, reduce essential needs, or perform actions. Incomplete history requires a review habit, not an assumed reduction. Never include a monetary savings claim. Return the required JSON.',
          input: aggregate,
          text: { format: { type: 'json_schema', name: 'habit_suggestions', strict: true, schema: {
            type: 'object', additionalProperties: false, required: ['suggestions'], properties: {
              suggestions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['title', 'action', 'category'], properties: { title: { type: 'string' }, action: { type: 'string' }, category: { type: 'string', enum: ['housing', 'food', 'transport', 'utilities', 'subscriptions', 'healthcare', 'education', 'debt', 'other'] } } } }
            }
          } } }
        })
      });
      if (!response.ok) throw new Error('OpenAI request failed; no automatic retry or rules fallback was used');
      const result = await response.json() as { status?: string; output?: { type: string; content?: { type: string; text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      if (result.status !== 'completed') throw new Error('OpenAI response did not complete');
      const text = (result.output ?? []).filter(item => item.type === 'message').flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text ?? '').join('');
      const parsed = suggestionsSchema.parse(JSON.parse(text));
      return { source: 'openai', synthetic: true, model, ...parsed, usage: { inputTokens: result.usage?.input_tokens ?? null, outputTokens: result.usage?.output_tokens ?? null }, warnings: ['AI suggestions require user review. No habit is adopted or acted on automatically.'] };
    }
  };
}
