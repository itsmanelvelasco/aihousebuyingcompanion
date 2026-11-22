import { checkinSchema, goalSchema, stateSchema } from '../../packages/contracts/habits.ts';
import { safeId } from '../../packages/contracts/ids.ts';
import type { Database } from '../../packages/db/database.ts';
import {
  getCheckin,
  getGoal,
  habitsUsageScope,
  insertCheckin,
  insertGoal,
  listCheckins,
  listGoals,
  updateGoal,
  usageAttempts,
  writeUsage,
} from '../../packages/db/habits.ts';
import { ApiError } from '../../packages/http/server.ts';
import { requireUser } from '../../packages/profiles/store.ts';

/** Habit goals and check-ins of each user, and the daily AI attempt counter, in the runtime database. */
export function createHabitStore(db: Database) {
  function state(id: string) {
    return stateSchema.parse({
      schemaVersion: 1,
      synthetic: true,
      userId: id,
      goals: listGoals(db, id),
      checkins: listCheckins(db, id),
    });
  }
  async function read(id: string) {
    requireUser(db, id);
    return db.transaction(() => state(id));
  }
  /** Run one change for an existing user in a transaction and check the limits of the whole state. */
  function mutate<T>(id: string, change: () => T) {
    return db.transaction(() => {
      requireUser(db, id);
      const result = change();
      // At most 20 goals and 1000 check-ins; a change beyond that is rolled back.
      state(id);
      return result;
    });
  }
  return {
    read,
    async saveGoal(id: string, value: unknown, replace = false) {
      const goal = goalSchema.parse(value);
      return mutate(id, () => {
        const existing = getGoal(db, id, goal.id);
        if (!replace && existing) throw new ApiError(409, 'Habit already exists');
        if (replace && !existing) throw new ApiError(404, 'Habit not found');
        if (existing) updateGoal(db, id, goal);
        else insertGoal(db, id, goal);
        return goal;
      });
    },
    async checkin(id: string, goalId: string, value: unknown) {
      safeId.parse(goalId);
      const checkin = checkinSchema.parse(value);
      return mutate(id, () => {
        const goal = getGoal(db, id, goalId);
        if (!goal) throw new ApiError(404, 'Habit not found');
        if (!goal.active) throw new ApiError(409, 'Habit is inactive');
        const entry = { ...checkin, goalId };
        const previous = getCheckin(db, id, checkin.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
          throw new ApiError(409, 'Check-in ID conflict');
        if (!previous) insertCheckin(db, id, entry);
        return { inserted: !previous, checkin: entry };
      });
    },
    /** Count one paid attempt for `date`, or refuse it (429) when the day's limit is used up. */
    async reserveCall(limit: number, date = new Date().toISOString().slice(0, 10)) {
      return db.transaction(() => {
        const attempts = usageAttempts(db, habitsUsageScope, date);
        if (attempts >= limit) throw new ApiError(429, 'Daily OpenAI attempt limit reached');
        writeUsage(db, habitsUsageScope, date, attempts + 1);
        return { date, attempts: attempts + 1 };
      });
    },
  };
}
