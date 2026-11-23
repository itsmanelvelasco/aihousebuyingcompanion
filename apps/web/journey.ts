import type { PlanResult } from '../../packages/contracts/planner.ts';
import { defaultLocale, type Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { formatDuration } from './format.ts';
import { journeyMessages } from './messages/journey.messages.ts';

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

function verdicts(input: JourneyInput, locale: Locale): Record<JourneyStepId, Verdict> {
  const t = translator(journeyMessages, locale);
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
  // A question's label is the server's text, already in the language the plan was asked in.
  const lower = (label: string) => label.toLocaleLowerCase(locale);

  return {
    'step-profile': !result
      ? { reached: null, detail: t('profileChoose') }
      : known === null
        ? { reached: true, detail: t('profileOnScreen') }
        : known > 0
          ? { reached: true, detail: t('profileFacts', { count: known }) }
          : { reached: false, detail: t('profileNothing') },
    'step-money': !result
      ? { reached: null, detail: t('moneyNeeded') }
      : questions === null
        ? { reached: null, detail: t('moneyNotSaid') }
        : required.length === 0
          ? { reached: true, detail: t('moneyAllThere') }
          : {
              reached: false,
              detail: t('moneyStill', {
                items: required
                  .slice(0, 3)
                  .map(question => lower(question.label))
                  .join(', '),
              }),
            },
    'step-bank':
      bankMovements === null
        ? { reached: null, detail: t('bankOptional') }
        : bankMovements > 0
          ? {
              reached: true,
              detail: t(bankSynthetic === true ? 'bankMovementsFictional' : 'bankMovements', { count: bankMovements }),
            }
          : { reached: false, detail: t('bankNone') },
    'step-places':
      placeCount >= 2
        ? { reached: true, detail: t('placesMany', { count: placeCount }) }
        : placeCount === 1
          ? { reached: false, detail: t('placesOne') }
          : { reached: false, detail: t('placesNone') },
    'step-aid': !result
      ? { reached: null, detail: t('aidLater') }
      : questions === null
        ? { reached: null, detail: t('aidNotSaid') }
        : placeCount === 0
          ? { reached: false, detail: t('aidNoPlace') }
          : deciding.length === 0
            ? { reached: true, detail: t('aidAllAnswered') }
            : { reached: false, detail: t('aidOpen', { count: deciding.length, next: lower(deciding[0].label) }) },
    'step-habits': !result
      ? { reached: null, detail: t('habitsLater') }
      : activeHabits > 0
        ? { reached: true, detail: t('habitsActive', { count: activeHabits }) }
        : { reached: false, detail: t('habitsNone') },
    'step-ready': !result
      ? { reached: null, detail: t('readyLater') }
      : reachedPlan
        ? { reached: true, detail: t('readyCovered', { place: reachedPlan.place.name }) }
        : shortest !== null
          ? { reached: false, detail: t('readyToGo', { duration: formatDuration(shortest, locale) }) }
          : { reached: false, detail: t('readyUnknown') },
  };
}

const titles = {
  'step-profile': 'titleProfile',
  'step-money': 'titleMoney',
  'step-bank': 'titleBank',
  'step-places': 'titlePlaces',
  'step-aid': 'titleAid',
  'step-habits': 'titleHabits',
  'step-ready': 'titleReady',
} as const;

/** The trail in one language; English when none is stated. */
export function journey(input: JourneyInput, locale: Locale = defaultLocale): Journey {
  const t = translator(journeyMessages, locale);
  const verdict = verdicts(input, locale);
  // The first checkpoint that is known not to be reached is the one to work on.
  const currentId = journeyStepIds.find(id => verdict[id].reached === false) ?? null;
  const steps = journeyStepIds.map(id => {
    const { reached, detail } = verdict[id];
    const state: JourneyStepState =
      reached === true ? 'done' : reached === null ? 'unknown' : id === currentId ? 'current' : 'ahead';
    return { id, title: t(titles[id]), state, detail };
  });
  return {
    steps,
    reached: steps.filter(step => step.state === 'done').length,
    total: steps.length,
    current: steps.find(step => step.state === 'current') ?? null,
  };
}
