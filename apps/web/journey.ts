import type { PlanResult } from '../../packages/contracts/planner.ts';
import { formatDuration } from './format.ts';

/**
 * The journey as a trail of seven checkpoints, read from what the planner and the bank feed
 * returned. Nothing is scored or invented: a checkpoint is reached only when the data behind it
 * exists, and a checkpoint that cannot be judged yet says so instead of counting as missed.
 */

export const journeyStepIds = [
  'step-profile',
  'step-money',
  'step-bank',
  'step-places',
  'step-aid',
  'step-habits',
  'step-ready',
] as const;
export type JourneyStepId = (typeof journeyStepIds)[number];

/**
 * - `done`: the data that reaches this checkpoint is there.
 * - `current`: the first checkpoint not reached yet; the one to work on.
 * - `ahead`: not reached, after the current one.
 * - `unknown`: cannot be judged with what is on screen (no plan yet, or the bank feed has not answered).
 */
export type JourneyStepState = 'done' | 'current' | 'ahead' | 'unknown';

export type JourneyStep = {
  id: JourneyStepId;
  title: string;
  state: JourneyStepState;
  /** What reaching it means, or what is still needed, in one sentence. */
  detail: string;
};

export type Journey = {
  steps: JourneyStep[];
  reached: number;
  total: number;
  /** The checkpoint to work on, or null when every one is reached or nothing can be judged. */
  current: JourneyStep | null;
};

export type JourneyInput = {
  /** The plan on screen, or null while there is none (nobody selected, loading, or an error). */
  result: PlanResult | null;
  /** How many places are being compared. */
  placeCount: number;
  /**
   * Booked bank movements behind the cash-flow summary: a count, or null when no summary has been
   * read (no stored person, the feed is still connecting, or it failed).
   */
  bankMovements: number | null;
  /** True only when every movement behind that summary is fictional; null when unknown. */
  bankSynthetic: boolean | null;
};

type Verdict = { reached: boolean | null; detail: string };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function verdicts(input: JourneyInput): Record<JourneyStepId, Verdict> {
  const { result, placeCount, bankMovements, bankSynthetic } = input;
  const questions = result?.nextQuestions ?? null;
  const open = (kinds: string[]) =>
    questions?.filter(question => question.state !== 'said_unknown' && kinds.includes(question.effect.kind)) ?? [];
  const required = open(['required']);
  const deciding = open(['benefit', 'baseline']);
  // Null when the plan does not list its known facts (an older result, a fixture).
  const known = result?.knownFacts?.length ?? null;
  const activeHabits = result?.person.habits.filter(habit => habit.status === 'active').length ?? 0;
  const plans = result?.plans ?? [];
  const reachedPlan = plans.find(plan => plan.status === 'target_reached');
  const months = plans.flatMap(plan => (plan.withPlaceBenefits?.months != null ? [plan.withPlaceBenefits.months] : []));
  const shortest = months.length ? Math.min(...months) : null;

  return {
    'step-profile': !result
      ? { reached: null, detail: 'Choose whose plan to show, or type a few figures to start.' }
      : known === null
        ? { reached: true, detail: 'A household is on screen.' }
        : known > 0
          ? { reached: true, detail: `${plural(known, 'fact')} about the household on record.` }
          : {
              reached: false,
              detail: 'Nothing is known about the household yet. Answer the first question to set off.',
            },
    'step-money': !result
      ? { reached: null, detail: 'Income, spending and savings are needed for a timeline.' }
      : questions === null
        ? { reached: null, detail: 'This plan does not say which figures are missing.' }
        : required.length === 0
          ? { reached: true, detail: 'The figures a timeline needs are all there.' }
          : {
              reached: false,
              detail: `Still needed for a timeline: ${required
                .slice(0, 3)
                .map(question => question.label.toLowerCase())
                .join(', ')}.`,
            },
    'step-bank':
      bankMovements === null
        ? { reached: null, detail: 'Optional: bank movements replace declared figures with observed ones.' }
        : bankMovements > 0
          ? {
              reached: true,
              detail: `${plural(bankMovements, 'booked movement')} behind the last three months${
                bankSynthetic === true ? ', from a fictional bank feed' : ''
              }.`,
            }
          : { reached: false, detail: 'No bank movements yet. Connect a bank or import a statement.' },
    'step-places':
      placeCount >= 2
        ? { reached: true, detail: `${plural(placeCount, 'place')} side by side.` }
        : placeCount === 1
          ? { reached: false, detail: 'One place so far. Add another to compare what each offers.' }
          : { reached: false, detail: 'Add two or more places to compare what each offers.' },
    'step-aid': !result
      ? { reached: null, detail: 'Aid and tax reliefs are screened once there is a plan.' }
      : questions === null
        ? { reached: null, detail: 'This plan does not say which facts are still undecided.' }
        : placeCount === 0
          ? { reached: false, detail: 'Aid depends on the place. Add a place first.' }
          : deciding.length === 0
            ? { reached: true, detail: 'Every fact that decides a measure here has an answer.' }
            : {
                reached: false,
                detail: `${plural(deciding.length, 'answer')} could still change the aid or the tax. Next: ${deciding[0].label.toLowerCase()}.`,
              },
    'step-habits': !result
      ? { reached: null, detail: 'Habits change how much is saved each month.' }
      : activeHabits > 0
        ? { reached: true, detail: `${plural(activeHabits, 'active habit')}.` }
        : { reached: false, detail: 'No active habit yet. Switch one on to see what it changes.' },
    'step-ready': !result
      ? { reached: null, detail: 'The last checkpoint: the upfront cash is covered.' }
      : reachedPlan
        ? { reached: true, detail: `The upfront cash is covered in ${reachedPlan.place.name}.` }
        : shortest !== null
          ? { reached: false, detail: `${formatDuration(shortest)} to go at the shortest timeline on screen.` }
          : { reached: false, detail: 'No finite timeline yet, so the distance to this checkpoint is unknown.' },
  };
}

const titles: Record<JourneyStepId, string> = {
  'step-profile': 'About you',
  'step-money': 'Your money',
  'step-bank': 'Your bank',
  'step-places': 'Compare places',
  'step-aid': 'Aid and tax',
  'step-habits': 'Saving habits',
  'step-ready': 'Ready to buy',
};

export function journey(input: JourneyInput): Journey {
  const verdict = verdicts(input);
  // The first checkpoint that is known not to be reached is the one to work on.
  const currentId = journeyStepIds.find(id => verdict[id].reached === false) ?? null;
  const steps = journeyStepIds.map(id => {
    const { reached, detail } = verdict[id];
    const state: JourneyStepState =
      reached === true ? 'done' : reached === null ? 'unknown' : id === currentId ? 'current' : 'ahead';
    return { id, title: titles[id], state, detail };
  });
  return {
    steps,
    reached: steps.filter(step => step.state === 'done').length,
    total: steps.length,
    current: steps.find(step => step.state === 'current') ?? null,
  };
}
