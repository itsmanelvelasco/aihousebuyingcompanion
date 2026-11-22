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
import { personIsSynthetic } from '../../packages/db/profiles.ts';
import { ApiError } from '../../packages/http/server.ts';
import { requireUser } from '../../packages/profiles/store.ts';

/**
 * Habit goals and check-ins of each user, and the daily AI attempt counter, in the runtime database.
 *
 * When a habit started (`startedOn`) decides whether the planner may add it on top of spending
 * observed in bank movements, so the store keeps it:
 * - a goal created active starts on the day it is created, unless the request states a day;
 * - a goal switched back on starts on that day, unless the request states a day other than the stored one;
 * - any other replacement keeps the stored day when the request does not state one;
 * - a day more than one day ahead is refused, because a habit that has not started is not active.
 */
export function createHabitStore(db: Database, clock: () => Date = () => new Date()) {
  const today = () => clock().toISOString().slice(0, 10);
  function state(id: string) {
    return stateSchema.parse({
      schemaVersion: 1,
      // Goals and check-ins are the person's own: fictional for a demo persona, real otherwise.
      synthetic: personIsSynthetic(db, id),
      userId: id,
      goals: listGoals(db, id),
      checkins: listCheckins(db, id),
    });
  }
  async function read(id: string) {
    requireUser(db, id);
    return db.read(() => state(id));
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
      const submitted = goalSchema.parse(value);
      // One day of slack: the person's calendar day can be ahead of the server's (UTC).
      const latest = new Date(clock().getTime() + 86_400_000).toISOString().slice(0, 10);
      if (submitted.startedOn !== null && submitted.startedOn > latest)
        throw new ApiError(400, 'startedOn must not be in the future');
      return mutate(id, () => {
        const existing = getGoal(db, id, submitted.id);
        if (!replace && existing) throw new ApiError(409, 'Habit already exists');
        if (replace && !existing) throw new ApiError(404, 'Habit not found');
        const reactivated = existing !== undefined && !existing.active && submitted.active;
        const stated = submitted.startedOn;
        const startedOn = !existing
          ? (stated ?? (submitted.active ? today() : null))
          : reactivated
            ? stated !== null && stated !== existing.startedOn
              ? stated
              : today()
            : (stated ?? existing.startedOn);
        const goal = { ...submitted, startedOn };
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
