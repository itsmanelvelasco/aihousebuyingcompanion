import type { Database } from './database.ts';

/** Queries for habit goals, their check-ins and the daily counter of paid AI calls. */

/** Scope of the daily counter of paid OpenAI habit suggestions in `ai_usage`. */
export const habitsUsageScope = 'openai-habits';

export type HabitGoal = {
  title: string;
  action: string;
  category: string;
  id: string;
  targetDaysPerWeek: number;
  plannedMonthlySavingCents: number | null;
  active: boolean;
};

export type HabitCheckin = { id: string; date: string; completed: boolean; note?: string; goalId: string };

type GoalRow = Omit<HabitGoal, 'active'> & { active: number };
type CheckinRow = { id: string; date: string; completed: number; note: string | null; goalId: string };

const goalColumns = `
  title, action, category, id, target_days_per_week AS targetDaysPerWeek,
  planned_monthly_saving_cents AS plannedMonthlySavingCents, active
`;
const checkinColumns = 'id, date, completed, note, goal_id AS goalId';

/** Rebuild a check-in as the API returns it: the optional note is absent, not null. */
function checkinFromRow(row: CheckinRow): HabitCheckin {
  return {
    id: row.id,
    date: row.date,
    completed: row.completed === 1,
    ...(row.note === null ? {} : { note: row.note }),
    goalId: row.goalId,
  };
}

/** A user's goals in the order they were created. */
export function listGoals(db: Database, userId: string): HabitGoal[] {
  return db
    .all<GoalRow>(`SELECT ${goalColumns} FROM habit_goals WHERE user_id = ? ORDER BY row_id`, userId)
    .map(row => ({ ...row, active: row.active === 1 }));
}

export function getGoal(db: Database, userId: string, goalId: string): HabitGoal | undefined {
  const row = db.get<GoalRow>(`SELECT ${goalColumns} FROM habit_goals WHERE user_id = ? AND id = ?`, userId, goalId);
  return row && { ...row, active: row.active === 1 };
}

export function insertGoal(db: Database, userId: string, goal: HabitGoal) {
  db.run(
    `
      INSERT INTO habit_goals
        (user_id, id, title, action, category, target_days_per_week, planned_monthly_saving_cents, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    userId,
    goal.id,
    goal.title,
    goal.action,
    goal.category,
    goal.targetDaysPerWeek,
    goal.plannedMonthlySavingCents,
    goal.active ? 1 : 0,
  );
}

/** Replace a goal in place, keeping its position and its check-ins. */
export function updateGoal(db: Database, userId: string, goal: HabitGoal) {
  db.run(
    `
      UPDATE habit_goals
      SET title = ?, action = ?, category = ?, target_days_per_week = ?, planned_monthly_saving_cents = ?,
          active = ?
      WHERE user_id = ? AND id = ?
    `,
    goal.title,
    goal.action,
    goal.category,
    goal.targetDaysPerWeek,
    goal.plannedMonthlySavingCents,
    goal.active ? 1 : 0,
    userId,
    goal.id,
  );
}

/** A user's check-ins in the order they were recorded. */
export function listCheckins(db: Database, userId: string) {
  return db
    .all<CheckinRow>(`SELECT ${checkinColumns} FROM habit_checkins WHERE user_id = ? ORDER BY row_id`, userId)
    .map(checkinFromRow);
}

export function getCheckin(db: Database, userId: string, checkinId: string) {
  const row = db.get<CheckinRow>(
    `SELECT ${checkinColumns} FROM habit_checkins WHERE user_id = ? AND id = ?`,
    userId,
    checkinId,
  );
  return row && checkinFromRow(row);
}

export function insertCheckin(db: Database, userId: string, checkin: HabitCheckin) {
  db.run(
    'INSERT INTO habit_checkins (user_id, id, goal_id, date, completed, note) VALUES (?, ?, ?, ?, ?, ?)',
    userId,
    checkin.id,
    checkin.goalId,
    checkin.date,
    checkin.completed ? 1 : 0,
    checkin.note ?? null,
  );
}

/** Attempts recorded for a scope on one day; 0 when there are none. */
export function usageAttempts(db: Database, scope: string, day: string) {
  return (
    db.get<{ attempts: number }>('SELECT attempts FROM ai_usage WHERE scope = ? AND day = ?', scope, day)?.attempts ?? 0
  );
}

/** Set the counter of one day and forget the scope's other days, so the table stays one row per scope. */
export function writeUsage(db: Database, scope: string, day: string, attempts: number) {
  db.run('DELETE FROM ai_usage WHERE scope = ? AND day <> ?', scope, day);
  db.run(
    `
      INSERT INTO ai_usage (scope, day, attempts) VALUES (?, ?, ?)
      ON CONFLICT (scope, day) DO UPDATE SET attempts = excluded.attempts
    `,
    scope,
    day,
    attempts,
  );
}
