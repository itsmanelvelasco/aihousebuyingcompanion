import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, createStore, userId } from '../profile-api/store.ts';
import { goalSchema, checkinSchema, stateSchema } from './contracts.ts';

export function createHabitStore(root: string, profileRoot: string) {
  const profiles = createStore(profileRoot);
  const queues = new Map<string, Promise<unknown>>();
  async function read(id: string) {
    userId.parse(id); await profiles.read(id, 'details');
    try { return stateSchema.parse(JSON.parse(await readFile(join(root, 'users', `${id}.json`), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return stateSchema.parse({ schemaVersion: 1, synthetic: true, userId: id, goals: [], checkins: [] });
    }
  }
  async function write(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  async function serial<T>(key: string, operation: () => Promise<T>) {
    const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(key, pending);
    try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
  }
  return {
    read,
    async saveGoal(id: string, value: unknown, replace = false) {
      const goal = goalSchema.parse(value);
      return serial(id, async () => {
        const state = await read(id);
        const index = state.goals.findIndex(item => item.id === goal.id);
        if (!replace && index >= 0) throw new ApiError(409, 'Habit already exists');
        if (replace && index < 0) throw new ApiError(404, 'Habit not found');
        if (index < 0) state.goals.push(goal); else state.goals[index] = goal;
        stateSchema.parse(state); await write(join(root, 'users', `${id}.json`), state); return goal;
      });
    },
    async checkin(id: string, goalId: string, value: unknown) {
      userId.parse(goalId); const checkin = checkinSchema.parse(value);
      return serial(id, async () => {
        const state = await read(id);
        const goal = state.goals.find(item => item.id === goalId);
        if (!goal) throw new ApiError(404, 'Habit not found');
        if (!goal.active) throw new ApiError(409, 'Habit is inactive');
        const entry = { ...checkin, goalId };
        const previous = state.checkins.find(item => item.id === checkin.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new ApiError(409, 'Check-in ID conflict');
        if (!previous) state.checkins.push(entry);
        stateSchema.parse(state); await write(join(root, 'users', `${id}.json`), state); return { inserted: !previous, checkin: entry };
      });
    },
    async reserveCall(limit: number, date = new Date().toISOString().slice(0, 10)) {
      return serial(':usage', async () => {
        await mkdir(root, { recursive: true });
        const path = join(root, 'openai-usage.json');
        const schema = z.object({ date: z.iso.date(), attempts: z.number().int().nonnegative() }).strict();
        let usage = { date, attempts: 0 };
        try { const saved = schema.parse(JSON.parse(await readFile(path, 'utf8'))); if (saved.date === date) usage = saved; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (usage.attempts >= limit) throw new ApiError(429, 'Daily OpenAI attempt limit reached');
        usage.attempts++; await write(path, usage); return usage;
      });
    }
  };
}
