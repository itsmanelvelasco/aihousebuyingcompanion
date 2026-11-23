import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { z } from 'zod';
import { goalSchema, summarySchema } from '../../packages/contracts/habits.ts';
import { safeId } from '../../packages/contracts/ids.ts';
import type { Database } from '../../packages/db/database.ts';
import { DatabaseBusyError } from '../../packages/db/database.ts';
import { suggestHabits } from '../../packages/finance/habits.ts';
import type { ApiAuthorizer } from '../../packages/http/server.ts';
import { ApiError, apiAccess, pathParts, readJson, requireOwnRoute, sendJson } from '../../packages/http/server.ts';
import { createOpenAIHabits } from './agent.ts';
import { createHabitStore } from './store.ts';

const body = (req: Parameters<typeof readJson>[0]) => readJson(req, 65_536, 'Body exceeds 64 KiB');

export type HabitsOptions = {
  token: string;
  /** The runtime database; habits live next to the profiles they belong to. */
  db: Database;
  openai?: Parameters<typeof createOpenAIHabits>[0];
  dailyCalls?: number;
  /** Recognises a person's own credential; such a caller reaches only its own `/users/<id>/habits`. */
  authorize?: ApiAuthorizer;
};

/** Habit goals, check-ins and suggestions as a request handler, so one server can mount them. */
export function createHabitsHandler(options: HabitsOptions) {
  if (!options.token) throw new Error('The habits handler needs an API token');
  const store = createHabitStore(options.db);
  const ai = createOpenAIHabits(options.openai);
  const dailyCalls = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.dailyCalls ?? 20);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, value: unknown) => sendJson(res, status, value);
    try {
      const access = apiAccess(req, options.token, options.authorize);
      const parts = pathParts(req);
      // A person may keep their own goals and check-ins; the paid suggestion source stays with the operator.
      requireOwnRoute(access, req, parts, () => true);
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
        if (access !== 'admin') throw new ApiError(403, 'Forbidden');
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
      if (error instanceof DatabaseBusyError) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
        return reply(503, { error: 'Storage is busy; try again shortly', retryable: true });
      }
      reply(500, { error: 'Habit storage unavailable' });
    }
  };
  /**
   * The handler, with in-process access to one user's habits for the rest of the server: `read` the
   * state, and `save` one goal (create, or replace with `replace`) under the store's own rules for
   * the start day. The caller decides whose habits these are; the HTTP routes above are unchanged.
   */
  return Object.assign(handle, {
    read: (id: string) => store.read(id),
    save: (id: string, goal: unknown, replace = false) => store.saveGoal(safeId.parse(id), goal, replace),
  });
}

/** The same API as a standalone HTTP server, for tests and isolated use. */
export function createHabitsApi(options: HabitsOptions) {
  return createServer(createHabitsHandler(options));
}
