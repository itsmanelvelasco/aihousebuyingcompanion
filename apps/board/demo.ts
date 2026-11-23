import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  boardRunIdByPairCode,
  getBoardRun,
  insertBoardRun,
  pairCodeTaken,
  sharedBoardRunId,
  updateBoardRun,
} from '../../packages/db/board.ts';
import type { Database } from '../../packages/db/database.ts';
import { monthsToTarget } from '../../packages/finance/savings.ts';
import type { Answers } from './intake.ts';
import { answersSchema, answerValue, basicGroups, extraGroups, questionId, validateAnswers } from './intake.ts';
import type { FinanceNote } from './scenes.ts';
import { figures, habitIds, opportunityIds, sceneText } from './scenes.ts';

/**
 * The scripted scenes. Their wording lives in `scenes.messages.ts`; the server writes it in English,
 * which is what the model reads, and the widget shows the same ids in the person's language.
 */
const english = sceneText('en');
const people = {
  onboarding: { name: 'Laia', label: english.personaLabel('onboarding') },
  progress: { name: 'Marc', label: english.personaLabel('progress') },
  shortcuts: { name: 'Núria', label: english.personaLabel('shortcuts') },
  payoff: { name: 'Jordi', label: english.personaLabel('payoff') },
};

export const personaSchema = z.enum(['onboarding', 'progress', 'shortcuts', 'payoff']);
type Persona = z.infer<typeof personaSchema>;

const { termMonths, initialTarget } = figures;
const bank = {
  currency: 'EUR',
  savings: figures.bank.savings,
  income: figures.bank.income,
  spending: figures.bank.spending,
  debtPayments: figures.bank.debtPayments,
  discretionary: figures.bank.discretionary,
  insight: english.bankInsight,
};

/** Model-facing grouping of a route; the board does not show it. */
const opportunityCategory = {
  rule: 'Regulation',
  job: 'Income',
  rural: 'Rural program',
  listing: 'Listing',
  friends: 'Community',
} as const;
const opportunities = opportunityIds.map(id => {
  const { title, detail, verify } = english.opportunity(id);
  const { target, extra } = figures.opportunities[id];
  return { id, category: opportunityCategory[id], title, detail, verify, target, extra };
});
const opportunityId = z.enum(opportunityIds);
type Opportunity = z.infer<typeof opportunityId>;
const routeSteps: Record<Opportunity, { label: string; offset: number }> = {
  rule: { label: english.step('rule'), offset: 0 },
  listing: { label: english.step('listing'), offset: 8 },
  job: { label: english.step('job'), offset: 4 },
  rural: { label: english.step('rural'), offset: 6 },
  friends: { label: english.step('friends'), offset: 1 },
};
const habitIcons = { coffee: '☕', takeout: '🍲', picnic: '🧺' } as const;
const habits = habitIds.map(id => {
  const { title, badge, action } = english.habit(id);
  const { before, after, xp } = figures.habits[id];
  return { id, icon: habitIcons[id], title, badge, before, after, xp, action };
});
const habitId = z.enum(habitIds);
type HabitId = z.infer<typeof habitId>;
const routeLetter: Record<Opportunity, string> = { rule: 'A', listing: 'B', job: 'C', rural: 'D', friends: 'E' };
const credits = english.credits;

export const openSchema = z.object({
  runId: z.uuid().optional(),
  pairCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-F0-9]{8}$/)
    .optional()
    .describe('Eight-character code printed on the live browser board. Use this to follow the same run.'),
  persona: personaSchema.optional(),
  newRun: z.boolean().optional().describe('Only use when explicitly asked for a separate rehearsal.'),
});
export const updateSchema = z.object({
  runId: z.uuid(),
  action: z.enum([
    'answer',
    'answer_batch',
    'sample_bank',
    'restart_persona',
    'restart_all',
    'join_quest',
    'adopt_habit',
    'complete_habit',
    'switch_persona',
    'read_inbox',
    'preview_shortcut',
    'choose_shortcut',
    'keep_route',
    'replay_payment',
    'final_payment',
    'show_credits',
    'hide_credits',
    'refresh_data',
    'start_bank_runtime',
    'stop_bank_runtime',
  ]),
  persona: personaSchema.optional(),
  question: questionId.optional(),
  answer: answerValue.optional(),
  answers: answersSchema.optional().describe('Every onboarding answer given this turn, as one object.'),
  opportunity: opportunityId.optional(),
  habit: habitId.optional(),
});

function seed() {
  return {
    answers: {} as Answers,
    bankConnected: false,
    habitStatus: {} as Partial<Record<HabitId, 'adopted' | 'complete'>>,
    inboxRead: false,
    chosen: null as Opportunity | null,
    previewed: null as Opportunity | null,
    paid: true,
    creditsVisible: false,
  };
}
type Run = { persona: Persona; state: ReturnType<typeof seed>; revision: number; pairCode: string };

/** Where runs are kept: this process's memory, or the runtime database so a restart keeps them. */
type RunStore = {
  get(id: string): Run | undefined;
  idByPairCode(pairCode: string): string | undefined;
  pairCodeTaken(pairCode: string): boolean;
  /** The shared board everybody follows, when one exists. */
  stageId(): string | undefined;
  add(id: string, run: Run, shared: boolean): void;
  /** Keep the changes an action made to a run. */
  save(id: string, run: Run): void;
};

/** Runs kept at once; the oldest rehearsal makes room, so a public tunnel cannot grow the store forever. */
const maxRuns = 2000;
/** A rehearsal nobody touched for this long expires. The shared board does not. */
const runTtlMs = 30 * 24 * 60 * 60 * 1000;

/** Demo-only memory: runs end with the process. Used when no database is configured. */
function memoryRuns(): RunStore {
  const runs = new Map<string, Run>();
  let stage: string | undefined;
  return {
    get: id => runs.get(id),
    idByPairCode: pairCode => [...runs].find(([, run]) => run.pairCode === pairCode)?.[0],
    pairCodeTaken: pairCode => [...runs.values()].some(run => run.pairCode === pairCode),
    stageId: () => stage,
    add(id, run, shared) {
      if (runs.size >= maxRuns) {
        const oldest = [...runs.keys()].find(key => key !== stage);
        if (oldest) runs.delete(oldest);
      }
      runs.set(id, run);
      if (shared) stage = id;
    },
    save(id, run) {
      runs.set(id, run);
    },
  };
}

/** Runs in the `board_runs` table. Every read returns a fresh copy; `save` writes it back. */
function databaseRuns(db: Database, clock: () => Date): RunStore {
  const times = () => {
    const now = clock();
    return { now: now.toISOString(), expiresAt: new Date(now.getTime() + runTtlMs).toISOString() };
  };
  return {
    get(id) {
      const stored = getBoardRun(db, id, clock().toISOString());
      const persona = personaSchema.safeParse(stored?.persona);
      if (!stored || !persona.success) return undefined;
      // Fields added to the scene state since the run was stored take their initial value.
      const state = { ...seed(), ...(stored.state as Partial<ReturnType<typeof seed>>) };
      return { persona: persona.data, state, revision: stored.revision, pairCode: stored.pairCode };
    },
    idByPairCode: pairCode => boardRunIdByPairCode(db, pairCode, clock().toISOString()),
    pairCodeTaken: pairCode => pairCodeTaken(db, pairCode),
    stageId: () => sharedBoardRunId(db),
    add(id, run, shared) {
      insertBoardRun(db, { id, ...run, shared }, times(), maxRuns);
    },
    save(id, run) {
      updateBoardRun(db, { id, ...run }, times());
    },
  };
}

let runs: RunStore = memoryRuns();

/**
 * Keep board runs in the runtime database, so a restart keeps the shared board and its rehearsals.
 * Pass null to return to a fresh in-memory store, which is also the default: the scripted board
 * needs no database.
 */
export function persistDemoRuns(db: Database | null, clock: () => Date = () => new Date()) {
  runs = db ? databaseRuns(db, clock) : memoryRuns();
}

function getRun(id: string) {
  const run = runs.get(id);
  if (!run) throw new Error('This run expired. Say ‘ReloCat, start’ to reopen the live board.');
  return run;
}

const timeToGoal = (saved: number, target: number, monthly: number) => monthsToTarget(target - saved, monthly);

function routeTimeline(upfrontMonths: number | null) {
  return { upfrontMonths, termMonths, debtFreeMonths: upfrontMonths === null ? null : upfrontMonths + termMonths };
}

export function getView(runId: string, message?: string) {
  const { persona, state, revision, pairCode } = getRun(runId);
  const person = people[persona];
  const choices = Object.entries(people).map(([id, info]) => ({ id, ...info }));
  const base = {
    runId,
    revision,
    pairCode,
    sharedBoard: runId === runs.stageId(),
    persona,
    person,
    choices,
    currency: 'EUR',
    simulated: true,
    goal: 'Own the home outright, with no mortgage or other demo debt.',
  };
  if (persona === 'onboarding') {
    const group =
      basicGroups
        .map(({ id, title, questions }) => ({
          id,
          title,
          questions: questions.filter(question => state.answers[question.id] === undefined),
        }))
        .find(group => group.questions.length) ?? null;
    const { income, spending, savings, debtPayments, reserve, cashTarget, budget } = state.answers;
    let plan = null;
    if (typeof income === 'number' && typeof spending === 'number' && typeof savings === 'number') {
      const monthly = income - spending - (typeof debtPayments === 'number' ? debtPayments : 0);
      const emergencyReserve = typeof reserve === 'number' ? reserve : 0;
      const available = Math.max(0, savings - emergencyReserve);
      const target =
        typeof cashTarget === 'number'
          ? cashTarget
          : typeof budget === 'number' && budget > 0
            ? Math.ceil(budget * 0.3)
            : initialTarget;
      plan = { monthly, saved: available, target, ...routeTimeline(timeToGoal(available, target, monthly)) };
    }
    const basicQuestions = basicGroups.flatMap(group => group.questions);
    const financeNotes: FinanceNote[] = [
      typeof cashTarget === 'number'
        ? 'customGoal'
        : typeof budget === 'number' && budget > 0
          ? 'budgetShare'
          : 'sampleGoal',
      ...(typeof reserve === 'number' ? (['reserve'] as const) : []),
      ...(typeof debtPayments === 'number' ? [] : (['unreportedDebt'] as const)),
    ];
    return {
      ...base,
      answers: { ...state.answers },
      group,
      extraGroups,
      totalQuestions: basicQuestions.length,
      answeredBasic: basicQuestions.filter(question => state.answers[question.id] !== undefined).length,
      financeNote: financeNotes.map(english.financeNote).join(' '),
      // The same notes by id, for the widget to show in the person's language.
      financeNotes,
      bank: state.bankConnected ? bank : null,
      plan,
      message:
        message ||
        (group
          ? `${group.title}. Ask for these in one natural prompt: ${group.questions.map(question => question.prompt).join(' ')}`
          : 'Laia’s core details are saved. Offer to refine the plan with home size, price, commute, school, rural preferences, debt and emergency savings.'),
    } as const;
  }
  if (persona === 'progress') {
    const quests = habits.map(habit => ({
      ...habit,
      status: state.habitStatus[habit.id] ?? 'available',
      saving: habit.before - habit.after,
    }));
    const completed = quests.filter(quest => quest.status === 'complete');
    const next = quests.find(quest => quest.status !== 'complete');
    const xp = completed.reduce((total, quest) => total + quest.xp, 350);
    const estimate = completed.reduce((total, quest) => total + quest.saving, 0);
    const leaderboard = [
      { name: 'Cami', xp: 505 },
      { name: 'Sol', xp: 400 },
      { name: english.you, xp },
      { name: 'Nico', xp: 220 },
    ].sort((a, b) => b.xp - a.xp);
    const coach = {
      ...english.coach(completed.length, estimate),
      next: next
        ? `${next.title}. ${next.action} That can free up €${next.saving} a month.`
        : 'Keep the new habits going for another month.',
    };
    return {
      ...base,
      progress: {
        saved: 32400,
        target: initialTarget,
        percent: 60,
        monthly: 900,
        ...routeTimeline(timeToGoal(32400, initialTarget, 900)),
        level: 3 + completed.length,
        xp,
        xpGoal: 650,
        checkpoint: completed.length ? 2 : 1,
        streak: 4,
        rank: 1 + leaderboard.findIndex(person => person.name === english.you),
        coach,
        badges: english.badges(completed.map(quest => quest.id)),
        leaderboard,
        quests,
        estimate,
      },
      message: message || `${coach.headline} ${coach.milestone} ${coach.next}`,
    } as const;
  }
  if (persona === 'shortcuts') {
    const { monthly, saved } = figures.shortcuts;
    const baseline = timeToGoal(saved, initialTarget, monthly)!;
    const inbox = opportunities
      .map(item => {
        const months = timeToGoal(saved, item.target, monthly + item.extra)!;
        return {
          ...item,
          letter: routeLetter[item.id],
          ...routeTimeline(months),
          fasterBy: baseline - months,
          waypoint: { ...routeSteps[item.id], offset: Math.min(months, routeSteps[item.id].offset) },
        };
      })
      .sort((a, b) => a.letter.localeCompare(b.letter));
    const unread = state.inboxRead ? 0 : inbox.length;
    const preview = inbox.find(item => item.id === state.previewed);
    const currentRoute = inbox.find(item => item.id === state.chosen);
    return {
      ...base,
      unread,
      baseline: routeTimeline(baseline),
      pastMonths: 24,
      saved,
      monthly,
      target: initialTarget,
      inbox: state.inboxRead ? inbox : [],
      chosen: state.chosen,
      previewed: state.previewed,
      message:
        message ||
        (unread
          ? `Núria has ${unread} unread route updates. Ask if she wants to see the alternatives.`
          : preview
            ? `Previewing Route ${preview.letter}: ${preview.title}, ${preview.fasterBy} months sooner. Ask whether to switch or keep the active route.`
            : currentRoute
              ? `Route ${currentRoute.letter} is active, ${currentRoute.fasterBy} months sooner than the original plan.`
              : `Three routes could get you there sooner. ${inbox
                  .slice(0, 3)
                  .map(item => `Route ${item.letter}: ${item.title}, ${item.fasterBy} months faster.`)
                  .join(' ')} Which would you like to preview?`),
    } as const;
  }
  return {
    ...base,
    payoff: {
      original: figures.payoff.original,
      remaining: state.paid ? 0 : figures.payoff.installment,
      otherDebt: 0,
      percent: state.paid ? 100 : 99,
      paid: state.paid,
    },
    credits: state.paid && state.creditsVisible ? credits : null,
    message:
      message ||
      (state.paid
        ? state.creditsVisible
          ? 'Roll the credits: Jordi repaid €165,000 over 20 years and earned Trailblazer, Keys in Hand and Mortgage-Free. Final balance: €0.'
          : 'You did it, Jordi! The home is yours outright. Want to see the credits?'
        : 'One €620 installment to go on the replay.'),
  } as const;
}
export type DemoView = ReturnType<typeof getView>;

/** Whether a shared board exists right now, so a caller can tell if opening without a run creates one. */
export function hasSharedBoard() {
  return runs.stageId() !== undefined;
}

/**
 * Open a run. With `shared` (a local convenience) a call without a run joins the one board everybody
 * follows; without it every such call starts a private run that only its holder can address.
 */
export function openDemo(
  { runId, pairCode, persona, newRun }: z.infer<typeof openSchema>,
  { shared = true }: { shared?: boolean } = {},
) {
  if (pairCode) {
    runId = runs.idByPairCode(pairCode);
    if (!runId) throw new Error('That board code expired. Say ‘ReloCat, start’ to open the live board without a code.');
  }
  const existing = runId ?? (newRun || !shared ? undefined : runs.stageId());
  if (existing) {
    const run = getRun(existing);
    if (persona && persona !== run.persona) {
      run.persona = persona;
      run.revision += 1;
      runs.save(existing, run);
    }
    return getView(existing);
  }

  const id = randomUUID();
  let code: string;
  do {
    code = randomBytes(4).toString('hex').toUpperCase();
  } while (runs.pairCodeTaken(code));
  // With sharing on, a run opened without `newRun` becomes the shared board; the store keeps itself bounded.
  runs.add(id, { persona: persona ?? 'onboarding', state: seed(), revision: 0, pairCode: code }, shared && !newRun);
  return getView(id);
}

export function updateDemo({
  runId,
  action,
  persona: nextPersona,
  question,
  answer,
  answers,
  opportunity,
  habit,
}: z.infer<typeof updateSchema>) {
  const run = getRun(runId);
  const { persona, state } = run;
  let message: string | undefined;
  switch (action) {
    case 'switch_persona':
      if (!nextPersona) throw new Error('Choose one of the four demo personas.');
      run.persona = nextPersona;
      break;
    case 'answer':
    case 'answer_batch': {
      if (persona !== 'onboarding') throw new Error('Open Laia’s onboarding first.');
      const fields = action === 'answer' && question && answer !== undefined ? { [question]: answer } : answers;
      if (!fields || !Object.keys(fields).length) throw new Error('Provide the answers the user gave.');
      Object.assign(state.answers, validateAnswers(fields));
      break;
    }
    case 'sample_bank':
      if (persona !== 'onboarding') throw new Error('Open Laia’s onboarding first.');
      state.bankConnected = true;
      Object.assign(state.answers, {
        income: bank.income,
        spending: bank.spending,
        savings: bank.savings,
        debtPayments: bank.debtPayments,
      });
      break;
    case 'join_quest':
    case 'adopt_habit':
    case 'complete_habit': {
      if (persona !== 'progress') throw new Error('Open Marc’s progress first.');
      const quest = habits.find(item => item.id === (action === 'join_quest' ? 'picnic' : habit));
      if (!quest) throw new Error('Choose a habit quest first.');
      if (action === 'adopt_habit') {
        state.habitStatus[quest.id] ??= 'adopted';
        message = `Quest accepted: ${quest.title}. Check in once you’ve tried it.`;
      } else if (state.habitStatus[quest.id] === 'complete') {
        message = `${quest.title} is already checked off.`;
      } else {
        if (action === 'complete_habit' && state.habitStatus[quest.id] !== 'adopted') {
          throw new Error('Accept this quest before checking in.');
        }
        state.habitStatus[quest.id] = 'complete';
        message = `Level up, Marc! You earned ${quest.xp} XP and unlocked ${quest.badge}.`;
      }
      break;
    }
    case 'read_inbox':
      if (persona !== 'shortcuts') throw new Error('Open Núria’s shortcuts first.');
      state.inboxRead = true;
      break;
    case 'preview_shortcut':
      if (persona !== 'shortcuts' || !state.inboxRead) throw new Error('Open Núria’s route alternatives first.');
      state.previewed = opportunity ?? null;
      break;
    case 'choose_shortcut':
    case 'keep_route':
      if (persona !== 'shortcuts' || !state.inboxRead) throw new Error('Open Núria’s shortcut inbox first.');
      if (action === 'choose_shortcut') {
        const confirmed = opportunity ?? state.previewed;
        if (!confirmed) throw new Error('Preview or name a route to switch to.');
        state.chosen = confirmed;
        message = `Route ${routeLetter[confirmed]} is now active. Dot has a new path to the finish.`;
      } else {
        // Dismiss the comparison without discarding a route accepted earlier.
        message = 'Your current route is unchanged.';
      }
      state.previewed = null;
      break;
    case 'replay_payment':
      if (persona !== 'payoff') throw new Error('Open Jordi’s finish first.');
      state.paid = false;
      state.creditsVisible = false;
      break;
    case 'final_payment':
      if (persona !== 'payoff') throw new Error('Open Jordi’s payoff first.');
      state.paid = true;
      break;
    case 'show_credits':
    case 'hide_credits':
      if (persona !== 'payoff' || !state.paid) throw new Error('Finish Jordi’s journey before rolling the credits.');
      state.creditsVisible = action === 'show_credits';
      break;
    case 'restart_persona': {
      const initial = seed();
      if (persona === 'onboarding') {
        state.answers = initial.answers;
        state.bankConnected = false;
      } else if (persona === 'progress') state.habitStatus = initial.habitStatus;
      else if (persona === 'shortcuts') {
        state.inboxRead = false;
        state.chosen = null;
        state.previewed = null;
      } else {
        state.paid = initial.paid;
        state.creditsVisible = false;
      }
      break;
    }
    case 'restart_all':
      run.state = seed();
      break;
  }
  run.revision += 1;
  runs.save(runId, run);
  return getView(runId, message);
}
