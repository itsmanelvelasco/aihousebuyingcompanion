import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { z } from 'zod';
import { goalSchema, summarySchema } from '../../packages/contracts/habits.ts';
import { safeId } from '../../packages/contracts/ids.ts';
import { suggestHabits } from '../../packages/finance/habits.ts';
import { ApiError, pathParts, readJson, requireBearer, sendJson } from '../../packages/http/server.ts';
import { createOpenAIHabits } from './agent.ts';
import { createHabitStore } from './store.ts';

const body = (req: Parameters<typeof readJson>[0]) => readJson(req, 65_536, 'Body exceeds 64 KiB');

export type HabitsOptions = {
  token: string;
  dataRoot: string;
  profileRoot: string;
  openai?: Parameters<typeof createOpenAIHabits>[0];
  dailyCalls?: number;
};

/** Habit goals, check-ins and suggestions as a request handler, so one server can mount them. */
export function createHabitsHandler(options: HabitsOptions) {
  if (!options.token) throw new Error('HABITS_API_TOKEN is required');
  const store = createHabitStore(options.dataRoot, options.profileRoot);
  const ai = createOpenAIHabits(options.openai);
  const dailyCalls = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.dailyCalls ?? 20);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, value: unknown) => sendJson(res, status, value);
    try {
      requireBearer(req, options.token);
      const parts = pathParts(req);
      if (parts.length === 1 && parts[0] === 'limits' && req.method === 'GET')
        return reply(200, {
          openaiConfigured: ai.configured,
          model: ai.model,
          maxOutputTokens: ai.maxOutputTokens,
          maxAggregateCharacters: 6000,
          dailyAttemptLimit: dailyCalls,
          dollarBudgetEnforced: false,
        });
      if (parts[0] !== 'users' || parts[2] !== 'habits' || parts.length > 5) throw new ApiError(404, 'Route not found');
      const id = safeId.parse(parts[1]);
      if (parts.length === 3 && req.method === 'GET') return reply(200, await store.read(id));
      if (parts.length === 3 && req.method === 'POST') return reply(201, await store.saveGoal(id, await body(req)));
      if (parts[3] === 'suggestions' && parts.length === 4 && req.method === 'POST') {
        await store.read(id);
        const input = z
          .object({ source: z.enum(['rules', 'openai']).default('rules'), summary: summarySchema })
          .strict()
          .parse(await body(req));
        if (input.source === 'rules') return reply(200, suggestHabits(input.summary));
        if (!ai.configured)
          throw new ApiError(503, 'OpenAI is not configured; use rules or set server-side credentials');
        await store.reserveCall(dailyCalls);
        try {
          return reply(200, await ai.suggest(input.summary));
        } catch {
          throw new ApiError(
            502,
            'OpenAI suggestions unavailable or invalid; the attempt counts toward the limit. No automatic retry.',
          );
        }
      }
      const goalId = safeId.parse(parts[3]);
      if (parts.length === 4 && req.method === 'PUT') {
        const goal = goalSchema.parse(await body(req));
        if (goal.id !== goalId) throw new ApiError(400, 'Habit ID must match route');
        return reply(200, await store.saveGoal(id, goal, true));
      }
      if (parts.length === 5 && parts[4] === 'checkins' && req.method === 'POST')
        return reply(200, await store.checkin(id, goalId, await body(req)));
      throw new ApiError(405, 'Method not allowed');
    } catch (error) {
      if (error instanceof ApiError) return reply(error.status, { error: error.message });
      if (error instanceof z.ZodError) return reply(400, { error: 'Invalid request', issues: error.issues });
      reply(500, { error: 'Habit storage unavailable' });
    }
  };
}

/** The same API as a standalone HTTP server, for tests and isolated use. */
export function createHabitsApi(options: HabitsOptions) {
  return createServer(createHabitsHandler(options));
}
