import { openaiModels } from '../../packages/config/env.ts';
import type { FinancialSummary } from '../../packages/contracts/habits.ts';
import { suggestionsSchema, summarySchema } from '../../packages/contracts/habits.ts';

export function createOpenAIHabits(
  options: { apiKey?: string; model?: string; maxOutputTokens?: number; fetcher?: typeof fetch } = {},
) {
  const model = options.model ?? openaiModels().habits;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model)) throw new Error('Invalid model ID');
  const maxOutputTokens = options.maxOutputTokens ?? 1024;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 2048)
    throw new Error('Output token limit must be 128–2048');
  return {
    model,
    maxOutputTokens,
    configured: Boolean(options.apiKey),
    async suggest(input: FinancialSummary) {
      if (!options.apiKey) throw new Error('OpenAI is not configured');
      const summary = summarySchema.parse(input);
      // Only allowlisted financial totals leave this service. No identity, notes or merchants.
      const aggregate = JSON.stringify(summary);
      if (aggregate.length > 6000) throw new Error('Aggregate exceeds prompt limit');
      const response = await (options.fetcher ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model,
          store: false,
          max_output_tokens: maxOutputTokens,
          reasoning: { effort: 'low' },
          instructions:
            'Suggest 1–5 optional, kind, practical money habits using only the supplied aggregates. Do not infer identity, diagnose, shame, recommend loans/investments, promise credit approval or savings, reduce essential needs, or perform actions. Incomplete history requires a review habit, not an assumed reduction. Never include a monetary savings claim. Return the required JSON.',
          input: aggregate,
          text: {
            format: {
              type: 'json_schema',
              name: 'habit_suggestions',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['suggestions'],
                properties: {
                  suggestions: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 5,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['title', 'action', 'category'],
                      properties: {
                        title: { type: 'string' },
                        action: { type: 'string' },
                        category: {
                          type: 'string',
                          enum: [
                            'housing',
                            'food',
                            'transport',
                            'utilities',
                            'subscriptions',
                            'healthcare',
                            'education',
                            'debt',
                            'other',
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      });
      if (!response.ok) throw new Error('OpenAI request failed; no automatic retry or rules fallback was used');
      const result = (await response.json()) as {
        status?: string;
        output?: { type: string; content?: { type: string; text?: string }[] }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (result.status !== 'completed') throw new Error('OpenAI response did not complete');
      const text = (result.output ?? [])
        .filter(item => item.type === 'message')
        .flatMap(item => item.content ?? [])
        .filter(item => item.type === 'output_text')
        .map(item => item.text ?? '')
        .join('');
      const parsed = suggestionsSchema.parse(JSON.parse(text));
      return {
        source: 'openai',
        // The suggestions describe the aggregates they were made from, fabricated or real.
        synthetic: summary.synthetic,
        model,
        ...parsed,
        usage: { inputTokens: result.usage?.input_tokens ?? null, outputTokens: result.usage?.output_tokens ?? null },
        warnings: ['AI suggestions require user review. No habit is adopted or acted on automatically.'],
      };
    },
  };
}
