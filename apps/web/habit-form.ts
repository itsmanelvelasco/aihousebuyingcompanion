import type { Habit, Person } from '../../packages/contracts/planner.ts';
import type { HabitDraft } from './client.ts';
import { eurosToCents } from './view-model.ts';

/**
 * "Add a habit": what the form holds, how it becomes the habit sent to `save_my_habit`, and how a
 * what-if habit joins the person sent to the planner. No money is summed here: the monthly saving
 * is the person's own figure, converted from euros to integer cents.
 */

export const habitCategories = [
  'housing',
  'food',
  'transport',
  'utilities',
  'subscriptions',
  'healthcare',
  'education',
  'debt',
  'other',
] as const satisfies readonly Habit['category'][];

export type HabitFields = {
  title: string;
  category: string;
  /** Whole or decimal euros as typed; empty means no monthly saving is assumed. */
  monthlySaving: string;
  status: string;
  startedOn: string;
};

export type HabitFormError = 'titleMissing' | 'titleLong' | 'savingInvalid' | 'startInvalid' | 'startFuture';

const isoDay = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read the form. A title is required; the saving is optional (empty stays `null`: nothing is
 * assumed) but a typed figure must be an amount; the start day cannot be after tomorrow, because a
 * habit that has not started is not active (one day of slack for the person's own calendar day).
 */
export function readHabitForm(
  fields: HabitFields,
  today: string,
): { ok: true; habit: HabitDraft } | { ok: false; error: HabitFormError } {
  const title = fields.title.trim();
  if (!title) return { ok: false, error: 'titleMissing' };
  if (title.length > 80) return { ok: false, error: 'titleLong' };
  const typed = fields.monthlySaving.trim();
  const saving = typed === '' ? null : (eurosToCents(typed) ?? Number.NaN);
  if (saving !== null && !(Number.isSafeInteger(saving) && saving >= 0)) return { ok: false, error: 'savingInvalid' };
  const startedOn = fields.startedOn.trim();
  if (startedOn !== '') {
    if (!isoDay.test(startedOn) || Number.isNaN(Date.parse(`${startedOn}T00:00:00Z`)))
      return { ok: false, error: 'startInvalid' };
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (startedOn > tomorrow) return { ok: false, error: 'startFuture' };
  }
  const category = (habitCategories as readonly string[]).includes(fields.category)
    ? (fields.category as Habit['category'])
    : 'other';
  return {
    ok: true,
    habit: {
      title,
      category,
      monthlySavingCents: saving,
      status: fields.status === 'paused' ? 'paused' : 'active',
      ...(startedOn ? { startedOn } : {}),
    },
  };
}

/** A habit that exists only in this estimate. Its id says so and cannot collide with a stored one. */
export function whatIfHabit(draft: HabitDraft, index: number): Habit {
  return {
    id: `what-if-habit-${index}`,
    title: draft.title,
    category: draft.category,
    monthlySavingCents: draft.monthlySavingCents,
    status: draft.status,
    adherence: null,
    ...(draft.startedOn ? { startedOn: draft.startedOn } : {}),
  };
}

export const isWhatIfHabit = (habit: Pick<Habit, 'id'>) => habit.id.startsWith('what-if-habit-');

/** The person sent to the planner with the what-if habits after the stored ones. Nothing is stored. */
export function withWhatIfHabits(person: Person, extra: Habit[]): Person {
  return extra.length ? { ...person, habits: [...person.habits, ...extra].slice(0, 20) } : person;
}
