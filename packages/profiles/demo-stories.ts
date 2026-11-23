import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { goalSchema } from '../contracts/habits.ts';
import { safeId } from '../contracts/ids.ts';
import { inputSchema } from '../contracts/inputs.ts';
import { accountIdOfUser } from '../db/auth.ts';
import type { Database } from '../db/database.ts';
import { getGoal, insertGoal, updateGoal } from '../db/habits.ts';
import { getInput, insertInput, updateInput } from '../db/inputs.ts';
import { userExists } from '../db/profiles.ts';

/**
 * The story of a demo persona: the answers it "confirmed" (`demo-inputs.json`) and its saving
 * habits (`demo-habits.json`), next to its three profile documents in `data/users/<id>/`.
 * The server seeds them at start (`seedDemoStories`); `npm run db:reseed-demo` also refreshes them.
 */
const storyInputs = z
  .object({
    schemaVersion: z.literal(1),
    synthetic: z.literal(true),
    userId: safeId,
    inputs: z.array(inputSchema.refine(input => input.synthetic, 'a demo answer must be marked synthetic')).max(20),
  })
  .strict();
const storyHabits = z
  .object({
    schemaVersion: z.literal(1),
    synthetic: z.literal(true),
    userId: safeId,
    goals: z.array(goalSchema).max(20),
    checkins: z.array(z.never()).max(0),
  })
  .strict();
export type Story = { inputs: z.infer<typeof storyInputs>['inputs']; goals: z.infer<typeof goalSchema>[] };

/** A story file of a persona, or `undefined` when the fixture has none. Anything else it cannot read throws. */
async function storyFile(fixtures: string, id: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(fixtures, id, `${name}.json`), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readStory(fixtures: string, id: string): Promise<Story> {
  const inputs = await storyFile(fixtures, id, 'demo-inputs');
  const habits = await storyFile(fixtures, id, 'demo-habits');
  const answers = inputs === undefined ? null : storyInputs.parse(inputs);
  const goals = habits === undefined ? null : storyHabits.parse(habits);
  if ((answers && answers.userId !== id) || (goals && goals.userId !== id))
    throw new Error('a story file names another persona');
  return { inputs: answers?.inputs ?? [], goals: goals?.goals ?? [] };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Write one persona's story by the ids of its records; returns whether anything differed. Call it in a transaction. */
export function writeStory(db: Database, id: string, story: Story, dryRun: boolean) {
  let changed = false;
  for (const input of story.inputs) {
    const stored = getInput(db, id, input.id);
    if (stored && same(stored, input)) continue;
    changed = true;
    if (dryRun) continue;
    if (stored) updateInput(db, id, input);
    else insertInput(db, id, input);
  }
  for (const goal of story.goals) {
    const stored = getGoal(db, id, goal.id);
    if (stored && same(stored, goal)) continue;
    changed = true;
    if (dryRun) continue;
    if (stored) updateGoal(db, id, goal);
    else insertGoal(db, id, goal);
  }
  return changed;
}

/**
 * Give the demo personas the story their fixture tells: the answers they "confirmed"
 * (`demo-inputs.json`, into the shared inputs) and their saving habits (`demo-habits.json`, into the
 * habits store). Without it a persona has only its three profile documents, nothing is confirmed
 * and no habit exists, so the public demo shows the same timeline three times.
 *
 * Safe to call at every start of the server, after the fixtures were copied: a record that is
 * already there and equal is left alone, records with other ids are never touched, a persona that
 * does not exist is skipped, and an id that belongs to an account is a person and is never written.
 * Every record is fictional and says so (`synthetic: true`).
 */
export async function seedDemoStories(
  db: Database,
  options: { fixtures: string; ids: string[]; dryRun?: boolean },
): Promise<{ written: string[]; unchanged: string[]; skipped: { id: string; reason: string }[] }> {
  const outcome = {
    written: [] as string[],
    unchanged: [] as string[],
    skipped: [] as { id: string; reason: string }[],
  };
  const ready: { id: string; story: Story }[] = [];
  for (const id of options.ids) {
    if (!safeId.safeParse(id).success) {
      outcome.skipped.push({ id, reason: 'not a valid id' });
      continue;
    }
    try {
      ready.push({ id, story: await readStory(options.fixtures, id) });
    } catch (error) {
      outcome.skipped.push({ id, reason: error instanceof z.ZodError ? 'invalid story file' : String(error) });
    }
  }
  db.transaction(() => {
    for (const { id, story } of ready) {
      if (accountIdOfUser(db, id) !== undefined) {
        outcome.skipped.push({ id, reason: 'belongs to an account; a person is never overwritten' });
        continue;
      }
      if (!userExists(db, id)) {
        outcome.skipped.push({ id, reason: 'no such persona in the database' });
        continue;
      }
      (writeStory(db, id, story, options.dryRun === true) ? outcome.written : outcome.unchanged).push(id);
    }
  });
  return outcome;
}
