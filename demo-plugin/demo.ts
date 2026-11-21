import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { answersSchema, answerValue, basicGroups, extraGroups, questionId, validateAnswers } from './intake.ts';
import type { Answers } from './intake.ts';

const people = {
  onboarding: { name: 'Laia', label: 'Getting started' },
  progress: { name: 'Marc', label: 'On the trail' },
  shortcuts: { name: 'Núria', label: 'Faster routes' },
  payoff: { name: 'Jordi', label: 'Debt-free home' },
};

export const personaSchema = z.enum(['onboarding', 'progress', 'shortcuts', 'payoff']);
type Persona = z.infer<typeof personaSchema>;

const termMonths = 240;
const bank = {
  currency: 'EUR', savings: 18400, income: 2900, spending: 2180, debtPayments: 0, discretionary: 280,
  insight: 'At the sample spending rate you have €720 left each month. Two fewer paid outings would free up another estimated €40.',
};
const initialTarget = 54000;

const opportunities = [
  { id: 'rule', category: 'Regulation', title: 'Compare a lower deposit route',
    detail: 'A fictional rule change reduces the upfront goal to €28,000. Your €28,000 reaches that goal. Sample rent is €1,150 and the modeled mortgage payment is €950, a €200 difference before ownership costs.',
    verify: 'Check the actual rule, lender eligibility, fees and total ownership costs.', target: 28000, extra: 0 },
  { id: 'job', category: 'Income', title: 'Hybrid job near Sabadell',
    detail: 'A sample job would add €250 per month after estimated commute and childcare.',
    verify: 'Confirm the offer, take-home pay and weekly commute.', target: initialTarget, extra: 250 },
  { id: 'rural', category: 'Rural program', title: 'Explore a lower-rent move to Solsona',
    detail: 'A fictional relocation program and lower rent could free up €230 per month after sample travel costs.',
    verify: 'Check official program status, eligibility, schools and transport.', target: initialTarget, extra: 230 },
  { id: 'listing', category: 'Listing', title: 'Compare a lower-cost home in Manresa',
    detail: 'A simulated portal or builder lead lowers the modeled upfront goal to €45,000. This illustrates an Idealista-style or builder alert.',
    verify: 'Check listing availability, fees, accessibility and train schedule.', target: 45000, extra: 0 },
  { id: 'friends', category: 'Community', title: 'Try a cheaper weekend plan',
    detail: 'Swap two paid outings for the sample first-buyer group’s park meetup and free up an estimated €40 per month.',
    verify: 'See if the habit fits your schedule and budget.', target: initialTarget, extra: 40 },
] as const;
const opportunityId = z.enum(['rule', 'job', 'rural', 'listing', 'friends']);
type Opportunity = z.infer<typeof opportunityId>;
const routeSteps: Record<Opportunity, { label: string; offset: number }> = {
  rule: { label: 'Review deposit rules', offset: 0 },
  listing: { label: 'Move to Manresa', offset: 8 },
  job: { label: 'Change jobs', offset: 4 },
  rural: { label: 'Move to Solsona', offset: 6 },
  friends: { label: 'Try cheaper outings', offset: 1 },
};
const habits = [
  { id: 'coffee', icon: '☕', title: 'Switch your coffee stop', badge: 'Coffee Saver', before: 20, after: 10, xp: 100,
    action: 'Buy your four coffees at the sample station café for €2.50 each instead of €5. Try the cheaper café on your next coffee run.' },
  { id: 'takeout', icon: '🍲', title: 'Cook once instead of ordering in', badge: 'Home Chef', before: 36, after: 22, xp: 85,
    action: 'Replace one €36 delivery meal each month with a €22 grocery basket. Put Friday on your calendar as the first cook-at-home night.' },
  { id: 'picnic', icon: '🧺', title: 'Swap a cinema trip for a park picnic', badge: 'Good Neighbor', before: 12, after: 0, xp: 100,
    action: 'Invite another first-time buyer to the free park picnic in place of one €12 cinema ticket this month.' },
] as const;
const habitId = z.enum(['coffee', 'takeout', 'picnic']);
type HabitId = z.infer<typeof habitId>;
const routeLetter: Record<Opportunity, string> = { rule: 'A', listing: 'B', job: 'C', rural: 'D', friends: 'E' };
const credits = {
  title: 'A place of your own',
  stats: [
    { label: 'Mortgage principal repaid', value: '€165,000' },
    { label: 'Repayment journey', value: '20 years' },
    { label: 'Remaining debt', value: '€0' },
  ],
  milestones: [
    { title: 'The first step', detail: 'Jordi set a savings goal and built an upfront fund.' },
    { title: 'Keys in hand', detail: 'He bought his home and began repaying the mortgage.' },
    { title: 'The finish line', detail: 'The last installment cleared. He owns the home outright.' },
  ],
  achievements: ['Trailblazer', 'Keys in Hand', 'Mortgage-Free'],
};

export const openSchema = z.object({
  runId: z.uuid().optional(),
  pairCode: z.string().trim().toUpperCase().regex(/^[A-F0-9]{8}$/).optional()
    .describe('Eight-character code printed on the live browser board. Use this to follow the same run.'),
  persona: personaSchema.optional(),
  newRun: z.boolean().optional().describe('Only use when explicitly asked for a separate rehearsal.'),
});
export const updateSchema = z.object({
  runId: z.uuid(),
  action: z.enum(['answer', 'answer_batch', 'sample_bank', 'restart_persona', 'restart_all', 'join_quest', 'adopt_habit', 'complete_habit',
    'switch_persona', 'read_inbox', 'preview_shortcut', 'choose_shortcut', 'keep_route', 'replay_payment', 'final_payment', 'show_credits', 'hide_credits', 'refresh_data', 'start_bank_runtime', 'stop_bank_runtime']),
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
    bankConnected: false, habitStatus: {} as Partial<Record<HabitId, 'adopted' | 'complete'>>, inboxRead: false,
    chosen: null as Opportunity | null,
    previewed: null as Opportunity | null,
    paid: true, creditsVisible: false,
  };
}
type Run = { persona: Persona; state: ReturnType<typeof seed>; revision: number; pairCode: string };
const runs = new Map<string, Run>();
let stageId: string | undefined;

function getRun(id: string) {
  const run = runs.get(id);
  if (!run) throw new Error('This run expired. Say ‘relo.cat, start’ to reopen the live board.');
  return run;
}

function timeToGoal(saved: number, target: number, monthly: number) {
  if (saved >= target) return 0;
  return monthly > 0 ? Math.ceil((target - saved) / monthly) : null;
}

function routeTimeline(upfrontMonths: number | null) {
  return { upfrontMonths, termMonths, debtFreeMonths: upfrontMonths === null ? null : upfrontMonths + termMonths };
}

export function getView(runId: string, message?: string) {
  const { persona, state, revision, pairCode } = getRun(runId);
  const person = people[persona];
  const choices = Object.entries(people).map(([id, info]) => ({ id, ...info }));
  const base = {
    runId, revision, pairCode, sharedBoard: runId === stageId, persona, person, choices, currency: 'EUR', simulated: true,
    goal: 'Own the home outright, with no mortgage or other demo debt.',
  };
  if (persona === 'onboarding') {
    const group = basicGroups.map(({ title, questions }) => ({
      title, questions: questions.filter(question => state.answers[question.id] === undefined),
    })).find(group => group.questions.length) ?? null;
    const { income, spending, savings, debtPayments, reserve, cashTarget, budget } = state.answers;
    let plan = null;
    if (typeof income === 'number' && typeof spending === 'number' && typeof savings === 'number') {
      const monthly = income - spending - (typeof debtPayments === 'number' ? debtPayments : 0);
      const emergencyReserve = typeof reserve === 'number' ? reserve : 0;
      const available = Math.max(0, savings - emergencyReserve);
      const target = typeof cashTarget === 'number' ? cashTarget
        : typeof budget === 'number' && budget > 0 ? Math.ceil(budget * .3) : initialTarget;
      plan = { monthly, saved: available, target, ...routeTimeline(timeToGoal(available, target, monthly)) };
    }
    const basicQuestions = basicGroups.flatMap(group => group.questions);
    return { ...base, answers: { ...state.answers }, group, extraGroups, totalQuestions: basicQuestions.length,
      answeredBasic: basicQuestions.filter(question => state.answers[question.id] !== undefined).length,
      financeNote: [
        typeof cashTarget === 'number' ? 'Uses your custom upfront goal.'
          : typeof budget === 'number' && budget > 0 ? 'Models 30% of the purchase budget for deposit and buying costs.'
          : 'Uses the €54,000 sample upfront goal.',
        typeof reserve === 'number' ? 'Your emergency reserve stays out of the buying fund.' : '',
        typeof debtPayments === 'number' ? '' : 'Monthly saving is before any unreported debt payments.',
      ].filter(Boolean).join(' '),
      bank: state.bankConnected ? bank : null, plan,
      message: message || (group
        ? `${group.title}. Ask for these in one natural prompt: ${group.questions.map(question => question.prompt).join(' ')}`
        : 'Laia’s core details are saved. Offer to refine the plan with home size, price, commute, school, rural preferences, debt and emergency savings.'),
    } as const;
  }
  if (persona === 'progress') {
    const quests = habits.map(habit => ({
      ...habit, status: state.habitStatus[habit.id] ?? 'available', saving: habit.before - habit.after,
    }));
    const completed = quests.filter(quest => quest.status === 'complete');
    const next = quests.find(quest => quest.status !== 'complete');
    const xp = completed.reduce((total, quest) => total + quest.xp, 350);
    const estimate = completed.reduce((total, quest) => total + quest.saving, 0);
    const leaderboard = [{ name: 'Cami', xp: 505 }, { name: 'Sol', xp: 400 }, { name: 'Marc · You', xp }, { name: 'Nico', xp: 220 }]
      .sort((a, b) => b.xp - a.xp);
    const coach = {
      headline: completed.length ? 'You’re building habits that stick.' : 'Marc, you’re past halfway!',
      milestone: completed.length ? `${completed.length} quests checked off. Keep them up to free up €${estimate} a month.`
        : 'You’ve saved four months in a row. Your next quest could make each month count a little more.',
      next: next ? `${next.title}. ${next.action} That can free up €${next.saving} a month.` : 'Keep the new habits going for another month.',
    };
    return { ...base, progress: { saved: 32400, target: initialTarget, percent: 60, monthly: 900,
      ...routeTimeline(timeToGoal(32400, initialTarget, 900)), level: 3 + completed.length, xp, xpGoal: 650,
      checkpoint: completed.length ? 2 : 1, streak: 4, rank: 1 + leaderboard.findIndex(person => person.name === 'Marc · You'), coach,
      badges: ['Trailblazer', 'Steady Saver', ...completed.map(quest => quest.badge)],
      leaderboard, quests, estimate },
      message: message || `${coach.headline} ${coach.milestone} ${coach.next}`,
    } as const;
  }
  if (persona === 'shortcuts') {
    const monthly = 800;
    const saved = 28000;
    const baseline = timeToGoal(saved, initialTarget, monthly)!;
    const inbox = opportunities.map(item => {
      const months = timeToGoal(saved, item.target, monthly + item.extra)!;
      return { ...item, letter: routeLetter[item.id], ...routeTimeline(months), fasterBy: baseline - months,
        waypoint: { ...routeSteps[item.id], offset: Math.min(months, routeSteps[item.id].offset) } };
    }).sort((a, b) => a.letter.localeCompare(b.letter));
    const unread = state.inboxRead ? 0 : inbox.length;
    const preview = inbox.find(item => item.id === state.previewed);
    const currentRoute = inbox.find(item => item.id === state.chosen);
    return { ...base, unread, baseline: routeTimeline(baseline), pastMonths: 24, saved, inbox: state.inboxRead ? inbox : [],
      chosen: state.chosen, previewed: state.previewed,
      message: message || (unread
        ? `Núria has ${unread} unread route updates. Ask if she wants to see the alternatives.`
        : preview
          ? `Previewing Route ${preview.letter}: ${preview.title}, ${preview.fasterBy} months sooner. Ask whether to switch or keep the active route.`
          : currentRoute
            ? `Route ${currentRoute.letter} is active, ${currentRoute.fasterBy} months sooner than the original plan.`
            : `Three routes could get you there sooner. ${inbox.slice(0, 3).map(item =>
              `Route ${item.letter}: ${item.title}, ${item.fasterBy} months faster.`).join(' ')} Which would you like to preview?`),
    } as const;
  }
  return { ...base, payoff: {
    original: 165000, remaining: state.paid ? 0 : 620, otherDebt: 0, percent: state.paid ? 100 : 99, paid: state.paid,
  }, credits: state.paid && state.creditsVisible ? credits : null,
    message: message || (state.paid
      ? state.creditsVisible
        ? 'Roll the credits: Jordi repaid €165,000 over 20 years and earned Trailblazer, Keys in Hand and Mortgage-Free. Final balance: €0.'
        : 'You did it, Jordi! The home is yours outright. Want to see the credits?'
      : 'One €620 installment to go on the replay.'),
  } as const;
}
export type DemoView = ReturnType<typeof getView>;

export function openDemo({ runId, pairCode, persona, newRun }: z.infer<typeof openSchema>) {
  if (pairCode) {
    runId = [...runs].find(([, run]) => run.pairCode === pairCode)?.[0];
    if (!runId) throw new Error('That board code expired. Say ‘relo.cat, start’ to open the live board without a code.');
  }
  const existing = runId ?? (newRun ? undefined : stageId);
  if (existing) {
    const run = getRun(existing);
    if (persona && persona !== run.persona) {
      run.persona = persona;
      run.revision += 1;
    }
    return getView(existing);
  }

  // Demo-only memory, bounded so a publicly reachable tunnel cannot grow it indefinitely.
  if (runs.size >= 200) {
    const oldest = [...runs.keys()].find(id => id !== stageId);
    if (oldest) runs.delete(oldest);
  }
  const id = randomUUID();
  let code: string;
  do { code = randomBytes(4).toString('hex').toUpperCase(); }
  while ([...runs.values()].some(run => run.pairCode === code));
  runs.set(id, { persona: persona ?? 'onboarding', state: seed(), revision: 0, pairCode: code });
  if (!newRun) stageId = id;
  return getView(id);
}

export function updateDemo({ runId, action, persona: nextPersona, question, answer, answers, opportunity, habit }: z.infer<typeof updateSchema>) {
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
      Object.assign(state.answers, { income: bank.income, spending: bank.spending, savings: bank.savings, debtPayments: bank.debtPayments });
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
  return getView(runId, message);
}
