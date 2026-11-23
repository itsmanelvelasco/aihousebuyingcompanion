import type { PlacePlan, PlanResult } from '../../packages/contracts/planner.ts';
import { createFormat } from '../../packages/i18n/format.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { interview } from './messages.ts';

/**
 * What the interview page shows of the plan. Pure: no DOM and no arithmetic. Every figure is read
 * from the result of `plan_home_savings`; this file only chooses which sentences to show.
 */

/** The place whose plan is presented: the shortest finite timeline, else the first place compared. */
export function bestPlan(result: PlanResult): PlacePlan | null {
  return result.plans.find(plan => plan.withPlaceBenefits?.months != null) ?? result.plans[0] ?? null;
}

export type PlanView = {
  /** The shortest timeline, or why there is none. */
  headline: string;
  /** Upfront cash and monthly saving behind the headline, when a timeline exists. */
  figures: string | null;
  /** What the estimate assumes, as the planner states it. */
  assumes: string[];
  /** Aid counted in the timeline. */
  counted: string[];
  /** Aid shown but not counted until its conditions are verified, each with the question that would verify it. */
  awaiting: string[];
  /** The question worth answering next, with what it could change. */
  nextQuestion: string | null;
  limitations: string[];
  disclaimer: string;
};

/** The plan in sentences of the page's language. */
export function planView(result: PlanResult, locale: Locale = 'en'): PlanView {
  const t = translator(interview, locale);
  const format = createFormat(locale);
  const best = bestPlan(result);
  const open = (result.nextQuestions ?? []).filter(question => question.state !== 'said_unknown');
  const next = open[0];
  const nextQuestion = next ? [next.question, next.effect.text].filter(Boolean).join(' ') : null;
  const disclaimer = t('plan.disclaimer');
  if (!best) {
    // No town chosen: what the planner says the person needs anywhere in Catalonia, and the question that chooses one.
    const anywhere = result.withoutPlace;
    const timeline = anywhere?.withHabits ?? anywhere?.baseline ?? null;
    return {
      headline:
        timeline?.months == null
          ? t('plan.noPlace')
          : t('plan.anywhere', { duration: format.duration(timeline.months) }),
      figures: timeline
        ? t('plan.figures', {
            cash: format.eurosAuto(timeline.upfrontCashCents),
            monthly: format.eurosAuto(timeline.monthlySavingsCents),
          })
        : null,
      assumes: anywhere?.assumptions ?? [],
      counted: [],
      awaiting: [],
      nextQuestion: nextQuestion ?? result.placeQuestion?.question ?? null,
      limitations: result.limitations,
      disclaimer,
    };
  }
  const place = best.place.name;
  const timeline = best.withPlaceBenefits;
  const months = timeline?.months ?? null;
  const headline =
    best.status === 'target_reached'
      ? t('plan.reached', { place })
      : best.status === 'no_positive_savings'
        ? t('plan.noSavings', { place })
        : best.status === 'beyond_horizon'
          ? t('plan.beyond', { place })
          : months === null
            ? t('plan.insufficient', { place })
            : best.monthsSavedByPlace != null && best.monthsSavedByPlace > 0
              ? t('plan.monthsSooner', {
                  duration: format.duration(months),
                  place,
                  sooner: format.duration(best.monthsSavedByPlace),
                })
              : t('plan.months', { duration: format.duration(months), place });
  const counted: string[] = [];
  const awaiting: string[] = [];
  for (const benefit of best.benefits) {
    if (benefit.counted)
      counted.push(
        benefit.amountCents === null
          ? t('plan.aidCountedNoAmount', { title: benefit.title })
          : t('plan.aidCounted', { title: benefit.title, amount: format.eurosAuto(benefit.amountCents) }),
      );
    else if (benefit.eligibilityStatus === 'needs_verification') {
      const verify = open.find(question => question.effect.policyIds.includes(benefit.policyId));
      awaiting.push(
        verify
          ? t('plan.aidAwaiting', { title: benefit.title, question: verify.question })
          : t('plan.aidAwaitingNoQuestion', { title: benefit.title }),
      );
    }
  }
  return {
    headline,
    figures: timeline
      ? t('plan.figures', {
          cash: format.eurosAuto(timeline.upfrontCashCents),
          monthly: format.eurosAuto(timeline.monthlySavingsCents),
        })
      : null,
    assumes: best.assumptions,
    counted,
    awaiting,
    nextQuestion,
    limitations: result.limitations,
    disclaimer,
  };
}

/**
 * The same plan for the voice model: plain fields it reads aloud. Titles, assumptions and questions
 * are the planner's own sentences, already in the person's language; amounts are euros.
 */
export function planForVoice(result: PlanResult) {
  const best = bestPlan(result);
  const open = (result.nextQuestions ?? []).filter(question => question.state !== 'said_unknown');
  const euros = (cents: number | null | undefined) => (cents == null ? null : cents / 100);
  return {
    source: 'plan_home_savings',
    place: best?.place.name ?? null,
    status: best?.status ?? 'no_place_chosen',
    shortestTimelineMonths: best?.withPlaceBenefits?.months ?? null,
    monthsWithoutPlaceBenefits: best?.withHabits?.months ?? best?.baseline?.months ?? null,
    upfrontCashEur: euros(best?.withPlaceBenefits?.upfrontCashCents),
    monthlySavingsEur: euros(best?.withPlaceBenefits?.monthlySavingsCents),
    assumes: best?.assumptions ?? [],
    aidCounted: (best?.benefits ?? [])
      .filter(benefit => benefit.counted)
      .map(benefit => ({ title: benefit.title, amountEur: euros(benefit.amountCents) })),
    aidAwaitingVerification: (best?.benefits ?? [])
      .filter(benefit => !benefit.counted && benefit.eligibilityStatus === 'needs_verification')
      .map(benefit => ({
        title: benefit.title,
        worthIfItAppliesEur: euros(benefit.nominalAmountCents),
        verifiedByAsking: open.find(question => question.effect.policyIds.includes(benefit.policyId))?.question ?? null,
      })),
    /** Only while no town is chosen: the planner's figures for anywhere in Catalonia, with no benefit of a place. */
    withoutATown: result.withoutPlace
      ? {
          status: result.withoutPlace.status,
          months: (result.withoutPlace.withHabits ?? result.withoutPlace.baseline)?.months ?? null,
          upfrontCashEur: euros((result.withoutPlace.withHabits ?? result.withoutPlace.baseline)?.upfrontCashCents),
          assumes: result.withoutPlace.assumptions,
        }
      : null,
    townQuestion: result.placeQuestion?.question ?? null,
    ownCashTargetEur: euros(best?.upfrontTarget?.statedCents ?? result.withoutPlace?.upfrontTarget?.statedCents),
    otherPlaces: result.plans
      .filter(plan => plan !== best)
      .map(plan => ({ place: plan.place.name, status: plan.status, months: plan.withPlaceBenefits?.months ?? null })),
    nextQuestion: open[0] ? { question: open[0].question, why: open[0].why, effect: open[0].effect.text } : null,
    missing: best?.dataMissing ?? [],
    limitations: result.limitations,
    note: 'An arithmetic estimate on the figures given: not mortgage approval, and no aid is guaranteed.',
  };
}

/** The workspace with the same places and language. Relative, so it works under any mount point. */
export function workspaceLink(codes: readonly string[], locale: Locale, base = '../workspace') {
  const query = new URLSearchParams();
  // Commas stay readable: the workspace reads `towns=250404,251207`.
  if (codes.length) query.set('towns', codes.join(','));
  query.set('lang', locale);
  return `${base}?${query.toString().replaceAll('%2C', ',')}`;
}

// ------------------------------------------------------------------ trail

/**
 * The seven checkpoints: the ids of the workspace's trail and of their illustrations
 * (`stepImageIds` in `packages/ui/images.manifest.ts`). Listed here so the browser bundle does not carry
 * the image manifest; `tests/interviewer-voice.test.ts` checks the two lists are the same.
 */
export const trailStepIds = [
  'step-profile',
  'step-money',
  'step-bank',
  'step-places',
  'step-aid',
  'step-habits',
  'step-ready',
] as const;
export type TrailStepId = (typeof trailStepIds)[number];
/** `unknown`: cannot be judged with what the page has (no plan yet). */
export type TrailState = 'done' | 'current' | 'ahead' | 'unknown';
export type Trail = {
  steps: { id: TrailStepId; title: string; state: TrailState }[];
  reached: number;
  total: number;
  /** The checkpoint to work on; null when every one is reached or none can be judged. */
  current: { id: TrailStepId; title: string } | null;
};

export type TrailInput = {
  /** The plan the page has, or null while there is none. */
  result: PlanResult | null;
  /** How many places are chosen. */
  placeCount: number;
  /** Bank movements behind the figures: a count, or null when there is no statement. */
  bankMovements: number | null;
  /** Without a plan: how many answers the page holds and whether income, spending and savings are among them. */
  local: { answered: number; moneyComplete: boolean };
};

/**
 * The trail of checkpoints, judged with the same rules as the workspace (`apps/web/journey.ts`):
 * a checkpoint is reached only when the data behind it exists, and one that cannot be judged is
 * `unknown`, not missed.
 */
export function trail(input: TrailInput, locale: Locale = 'en'): Trail {
  const t = translator(interview, locale);
  const { result, placeCount, bankMovements, local } = input;
  const questions = result?.nextQuestions ?? null;
  const open = (kinds: string[]) =>
    questions?.filter(question => question.state !== 'said_unknown' && kinds.includes(question.effect.kind)) ?? [];
  const known = result?.knownFacts?.length ?? null;
  const reached: Record<TrailStepId, boolean | null> = {
    'step-profile': result ? known === null || known > 0 : local.answered > 0,
    'step-money': result ? (questions === null ? null : open(['required']).length === 0) : local.moneyComplete,
    'step-bank':
      bankMovements !== null
        ? bankMovements > 0
        : result && result.person.finances.basis !== 'declared' && result.person.finances.basis !== 'unknown'
          ? true
          : null,
    'step-places': placeCount >= 2,
    'step-aid': !result || questions === null ? null : placeCount > 0 && open(['benefit', 'baseline']).length === 0,
    'step-habits': result ? result.person.habits.some(habit => habit.status === 'active') : null,
    'step-ready': result ? result.plans.some(plan => plan.status === 'target_reached') : null,
  };
  const currentId = trailStepIds.find(id => reached[id] === false) ?? null;
  const steps = trailStepIds.map(id => ({
    id,
    title: t(`trail.${id}`),
    state: (reached[id] === true
      ? 'done'
      : reached[id] === null
        ? 'unknown'
        : id === currentId
          ? 'current'
          : 'ahead') as TrailState,
  }));
  const current = steps.find(step => step.state === 'current');
  return {
    steps,
    reached: steps.filter(step => step.state === 'done').length,
    total: steps.length,
    current: current ? { id: current.id, title: current.title } : null,
  };
}
