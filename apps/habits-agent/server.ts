import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ApiError, userId } from '../profile-api/store.ts';
import { createHabitStore } from './store.ts';
import { summarySchema, goalSchema } from './contracts.ts';
import { createOpenAIHabits, suggestHabits } from './agent.ts';

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 65536) throw new ApiError(413, 'Body exceeds 64 KiB'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'Invalid JSON'); }
}
export function createHabitsApi(options: { token: string; dataRoot: string; profileRoot: string; openai?: Parameters<typeof createOpenAIHabits>[0]; dailyCalls?: number }) {
  if (!options.token) throw new Error('HABITS_API_TOKEN is required');
  const store = createHabitStore(options.dataRoot, options.profileRoot);
  const ai = createOpenAIHabits(options.openai);
  const dailyCalls = z.number().int().min(1).max(100).parse(options.dailyCalls ?? 20);
  return createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      const expected = Buffer.from(`Bearer ${options.token}`); const actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(401, 'Bearer token required');
      const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean);
      if (parts.length === 1 && parts[0] === 'limits' && req.method === 'GET') return reply(200, { openaiConfigured: ai.configured, model: ai.model, maxOutputTokens: ai.maxOutputTokens, maxAggregateCharacters: 6000, dailyAttemptLimit: dailyCalls, dollarBudgetEnforced: false });
      if (parts[0] !== 'users' || parts[2] !== 'habits' || parts.length > 5) throw new ApiError(404, 'Route not found');
      const id = userId.parse(parts[1]);
      if (parts.length === 3 && req.method === 'GET') return reply(200, await store.read(id));
      if (parts.length === 3 && req.method === 'POST') return reply(201, await store.saveGoal(id, await body(req)));
      if (parts[3] === 'suggestions' && parts.length === 4 && req.method === 'POST') {
        await store.read(id);
        const input = z.object({ source: z.enum(['rules', 'openai']).default('rules'), summary: summarySchema }).strict().parse(await body(req));
        if (input.source === 'rules') return reply(200, suggestHabits(input.summary));
        if (!ai.configured) throw new ApiError(503, 'OpenAI is not configured; use rules or set server-side credentials');
        await store.reserveCall(dailyCalls);
        try { return reply(200, await ai.suggest(input.summary)); }
        catch { throw new ApiError(502, 'OpenAI suggestions unavailable or invalid; the attempt counts toward the limit. No automatic retry.'); }
      }
      const goalId = userId.parse(parts[3]);
      if (parts.length === 4 && req.method === 'PUT') {
        const goal = goalSchema.parse(await body(req));
        if (goal.id !== goalId) throw new ApiError(400, 'Habit ID must match route');
        return reply(200, await store.saveGoal(id, goal, true));
      }
      if (parts.length === 5 && parts[4] === 'checkins' && req.method === 'POST') return reply(200, await store.checkin(id, goalId, await body(req)));
      throw new ApiError(405, 'Method not allowed');
    } catch (error) {
      if (error instanceof ApiError) return reply(error.status, { error: error.message });
      if (error instanceof z.ZodError) return reply(400, { error: 'Invalid request', issues: error.issues });
      reply(500, { error: 'Habit storage unavailable' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createHabitsApi({ token: process.env.HABITS_API_TOKEN ?? '', dataRoot: resolve(process.env.HABITS_DATA_DIR ?? 'data/runtime-habits'), profileRoot: resolve(process.env.PROFILE_DATA_DIR ?? 'data/users'), dailyCalls: Number(process.env.HABITS_DAILY_AI_CALLS ?? 20), openai: { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_HABITS_MODEL ?? 'gpt-6.2-sol', maxOutputTokens: Number(process.env.HABITS_MAX_OUTPUT_TOKENS ?? 1024) } });
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.HABITS_PORT ?? 3002);
  server.listen(port, '127.0.0.1', () => console.log(`Habits API: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
