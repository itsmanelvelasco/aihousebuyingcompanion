import { common } from '../../packages/i18n/common.ts';
import { createFormat } from '../../packages/i18n/format.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { scenes } from './scenes.messages.ts';

/**
 * The scripted scenes in one language, with their sample amounts filled in. Pure: the server
 * builds its English view from it (`demo.ts`) and the widget reads the same ids in the language
 * the person chose (`widget.ts`), so the two never disagree on a figure.
 *
 * Amounts are whole euros, as the scripted demo keeps them.
 */
export const personaIds = ['onboarding', 'progress', 'shortcuts', 'payoff'] as const;
export const opportunityIds = ['rule', 'job', 'rural', 'listing', 'friends'] as const;
export const habitIds = ['coffee', 'takeout', 'picnic'] as const;
export type PersonaId = (typeof personaIds)[number];
export type OpportunityId = (typeof opportunityIds)[number];
export type HabitId = (typeof habitIds)[number];

/** The invented figures the scenes talk about. */
export const figures = {
  termMonths: 240,
  initialTarget: 54000,
  bank: { savings: 18400, income: 2900, spending: 2180, debtPayments: 0, discretionary: 280, outingsSaving: 40 },
  shortcuts: { monthly: 800, saved: 28000 },
  opportunities: {
    rule: { target: 28000, extra: 0, rent: 1150, payment: 950 },
    job: { target: 54000, extra: 250 },
    rural: { target: 54000, extra: 230 },
    listing: { target: 45000, extra: 0 },
    friends: { target: 54000, extra: 40 },
  },
  habits: {
    coffee: { before: 20, after: 10, xp: 100, price: 2.5, usual: 5 },
    takeout: { before: 36, after: 22, xp: 85 },
    picnic: { before: 12, after: 0, xp: 100 },
  },
  payoff: { original: 165000, installment: 620 },
} as const;

export type FinanceNote = 'customGoal' | 'budgetShare' | 'sampleGoal' | 'reserve' | 'unreportedDebt';
const milestones = ['first', 'keys', 'finish'] as const;

export function sceneText(locale: Locale = 'en') {
  const t = translator(scenes, locale);
  const shared = translator(common, locale);
  const format = createFormat(locale);
  /** Whole euros of the script as money. */
  const euros = (amount: number) => format.euros(Math.round(amount * 100));
  const { bank, opportunities, habits, shortcuts, payoff } = figures;

  const opportunityValues: Record<OpportunityId, Record<string, string>> = {
    rule: {
      goal: euros(opportunities.rule.target),
      saved: euros(shortcuts.saved),
      rent: euros(opportunities.rule.rent),
      payment: euros(opportunities.rule.payment),
      difference: euros(opportunities.rule.rent - opportunities.rule.payment),
    },
    job: { extra: euros(opportunities.job.extra) },
    rural: { extra: euros(opportunities.rural.extra) },
    listing: { goal: euros(opportunities.listing.target) },
    friends: { extra: euros(opportunities.friends.extra) },
  };
  const habitValues: Record<HabitId, Record<string, string>> = {
    coffee: { price: format.eurosExact(habits.coffee.price * 100), usual: euros(habits.coffee.usual) },
    takeout: { before: euros(habits.takeout.before), after: euros(habits.takeout.after) },
    picnic: { before: euros(habits.picnic.before) },
  };

  return {
    personaLabel: (id: PersonaId) => t(`persona.${id}`),
    groupTitle: (id: 'home' | 'finances' | 'household' | 'commute' | 'buffer') => t(`group.${id}`),
    /** The label of an intake field in the form; an id the script does not know is shown as it is. */
    fieldLabel: (id: string) => (`field.${id}` in scenes.en ? t(`field.${id}` as 'field.town') : id),
    /** The label of a saved answer in the summary list. */
    factLabel: (id: string) =>
      `fact.${id}` in scenes.en
        ? t(`fact.${id}` as 'fact.income')
        : `field.${id}` in scenes.en
          ? t(`field.${id}` as 'field.town')
          : id,
    /** A translated example answer, or null when the example is a number or a place name. */
    example: (id: string) => (`example.${id}` in scenes.en ? t(`example.${id}` as 'example.rural') : null),
    bankInsight: t('bank.insight', {
      left: euros(bank.income - bank.spending),
      extra: euros(bank.outingsSaving),
    }),
    financeNote: (id: FinanceNote) => t(`note.${id}`, { goal: euros(figures.initialTarget) }),
    opportunity: (id: OpportunityId) => ({
      title: t(`opportunity.${id}.title`),
      detail: t(`opportunity.${id}.detail`, opportunityValues[id]),
      verify: t(`opportunity.${id}.verify`),
    }),
    step: (id: OpportunityId) => t(`step.${id}`),
    habit: (id: HabitId) => ({
      title: t(`habit.${id}.title`),
      badge: t(`habit.${id}.badge`),
      action: t(`habit.${id}.action`, habitValues[id]),
    }),
    /** The badges a saver holds: the two everybody starts with, then one per completed quest. */
    badges: (completed: readonly HabitId[]) => [
      t('badge.trailblazer'),
      t('badge.steadySaver'),
      ...completed.map(id => t(`habit.${id}.badge`)),
    ],
    coach: (completed: number, estimate: number) =>
      completed
        ? {
            headline: t('coach.habits.headline'),
            milestone: t('coach.habits.milestone', { count: completed, amount: euros(estimate) }),
          }
        : { headline: t('coach.start.headline'), milestone: t('coach.start.milestone') },
    you: t('leaderboard.you'),
    credits: {
      title: t('credits.title'),
      stats: [
        { label: t('credits.stat.principal'), value: euros(payoff.original) },
        { label: t('credits.stat.journey'), value: shared('years', { count: figures.termMonths / 12 }) },
        { label: t('credits.stat.remaining'), value: euros(0) },
      ],
      milestones: milestones.map(id => ({
        title: t(`credits.milestone.${id}.title`),
        detail: t(`credits.milestone.${id}.detail`),
      })),
      achievements: [t('badge.trailblazer'), t('badge.keysInHand'), t('badge.mortgageFree')],
    },
  };
}
