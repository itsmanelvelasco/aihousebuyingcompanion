import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const people = {
  onboarding: { name: 'Laia', label: 'Getting started' },
  progress: { name: 'Marc', label: 'On the trail' },
  shortcuts: { name: 'Núria', label: 'Faster routes' },
  payoff: { name: 'Jordi', label: 'Final payment' },
};

export const personaSchema = z.enum(['onboarding', 'progress', 'shortcuts', 'payoff']);
type Persona = z.infer<typeof personaSchema>;

const questions = [
  { id: 'town', prompt: 'Where would you like to buy?', example: 'Manresa', kind: 'text' },
  { id: 'bedrooms', prompt: 'How many bedrooms do you need?', example: '2', kind: 'number' },
  { id: 'household', prompt: 'How many people are in your household, including you?', example: '3', kind: 'number' },
  { id: 'employment', prompt: 'What is your employment situation?', example: 'Full-time employee', kind: 'text' },
  { id: 'income', prompt: 'What is your monthly take-home income in euros?', example: '2900', kind: 'number' },
  { id: 'spending', prompt: 'What are your monthly expenses, including rent and debt payments, in euros?', example: '2180', kind: 'number' },
  { id: 'savings', prompt: 'How much have you already saved, in euros?', example: '18400', kind: 'number' },
] as const;
const questionId = z.enum(['town', 'bedrooms', 'household', 'employment', 'income', 'spending', 'savings']);
type QuestionId = z.infer<typeof questionId>;
const bank = {
  currency: 'EUR', savings: 18400, income: 2900, spending: 2180, discretionary: 280,
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

export const openSchema = z.object({ runId: z.uuid().optional(), persona: personaSchema.optional() });
export const updateSchema = z.object({
  runId: z.uuid(),
  action: z.enum(['answer', 'sample_bank', 'restart_persona', 'restart_all', 'join_quest',
    'switch_persona', 'read_inbox', 'choose_shortcut', 'keep_route', 'final_payment']),
  persona: personaSchema.optional(),
  question: questionId.optional(),
  answer: z.union([z.string().trim().min(1).max(80), z.number().int().nonnegative().max(10_000_000)]).optional(),
  opportunity: opportunityId.optional(),
});

function seed() {
  return {
    answers: {} as Partial<Record<QuestionId, string | number>>,
    bankConnected: false, joinedQuest: false, inboxRead: false,
    chosen: null as z.infer<typeof opportunityId> | 'keep' | null,
    paid: false,
  };
}
type Run = { persona: Persona; state: ReturnType<typeof seed> };
const runs = new Map<string, Run>();

function getRun(id: string) {
  const run = runs.get(id);
  if (!run) throw new Error('This demo run expired. Open a new demo without a run ID.');
  return run;
}

function timeToGoal(saved: number, target: number, monthly: number) {
  if (saved >= target) return 0;
  return monthly > 0 ? Math.ceil((target - saved) / monthly) : null;
}

function getView(runId: string, message?: string) {
  const { persona, state } = getRun(runId);
  const person = people[persona];
  const choices = Object.entries(people).map(([id, info]) => ({ id, ...info }));
  const base = { runId, persona, person, choices, currency: 'EUR', simulated: true };
  if (persona === 'onboarding') {
    const next = questions.find(question => state.answers[question.id] === undefined) ?? null;
    const { income, spending, savings } = state.answers;
    const plan = typeof income === 'number' && typeof spending === 'number' && typeof savings === 'number'
      ? { monthly: income - spending, saved: savings, target: initialTarget, months: timeToGoal(savings, initialTarget, income - spending) }
      : null;
    return { ...base, answers: { ...state.answers }, next, totalQuestions: questions.length,
      bank: state.bankConnected ? bank : null, plan,
      message: message || (next ? `Ask Laia this one question: ${next.prompt}` : 'Laia’s demo intake is complete. Show her the plan.'),
    } as const;
  }
  if (persona === 'progress') {
    const xp = state.joinedQuest ? 450 : 350;
    return { ...base, progress: { saved: 32400, target: initialTarget, percent: 60, monthly: 900,
      months: timeToGoal(32400, initialTarget, 900), level: state.joinedQuest ? 4 : 3, xp, xpGoal: 550,
      checkpoint: state.joinedQuest ? 3 : 2,
      badges: state.joinedQuest ? ['Trailblazer', 'Steady Saver', 'Good Neighbor'] : ['Trailblazer', 'Steady Saver'],
      leaderboard: [{ name: 'Cami', xp: 505 }, { name: 'Sol', xp: 400 }, { name: 'Marc · You', xp }, { name: 'Nico', xp: 220 }]
        .sort((a, b) => b.xp - a.xp),
      joinedQuest: state.joinedQuest },
      message: message || 'Marc is at 60% of his upfront goal, saving €900 per month. His next quest is a free local meetup.',
    } as const;
  }
  if (persona === 'shortcuts') {
    const monthly = 800;
    const saved = 28000;
    const baseline = timeToGoal(saved, initialTarget, monthly)!;
    const inbox = opportunities.map(item => {
      const months = timeToGoal(saved, item.target, monthly + item.extra)!;
      return { ...item, months, fasterBy: baseline - months };
    });
    const unread = state.inboxRead ? 0 : inbox.length;
    return { ...base, unread, baseline, saved, inbox: state.inboxRead ? inbox : [], chosen: state.chosen,
      message: message || (unread
        ? `Núria has ${unread} unread route updates. Ask if she wants to read them now. Do not read them automatically.`
        : 'Núria’s shortcut inbox is open. Explain the assumptions and ask before changing her route.'),
    } as const;
  }
  return { ...base, payoff: { original: 165000, remaining: state.paid ? 0 : 620, percent: state.paid ? 100 : 99, paid: state.paid },
    message: message || (state.paid ? 'Jordi completed the simulated mortgage payoff.' : 'Jordi has one €620 payment left in this demo.'),
  } as const;
}
export type DemoView = ReturnType<typeof getView>;

export function openDemo({ runId, persona }: z.infer<typeof openSchema>) {
  if (runId) {
    const run = getRun(runId);
    if (persona) run.persona = persona;
    return getView(runId);
  }

  // Demo-only memory, bounded so a publicly reachable tunnel cannot grow it indefinitely.
  if (runs.size >= 200) {
    const oldest = runs.keys().next().value;
    if (oldest) runs.delete(oldest);
  }
  const id = randomUUID();
  runs.set(id, { persona: persona ?? 'onboarding', state: seed() });
  return getView(id);
}

export function updateDemo({ runId, action, persona: nextPersona, question, answer, opportunity }: z.infer<typeof updateSchema>) {
  const run = getRun(runId);
  const { persona, state } = run;
  let message: string | undefined;
  switch (action) {
    case 'switch_persona':
      if (!nextPersona) throw new Error('Choose one of the four demo personas.');
      run.persona = nextPersona;
      break;
    case 'answer': {
      if (persona !== 'onboarding') throw new Error('Open Laia’s onboarding first.');
      const next = questions.find(item => state.answers[item.id] === undefined);
      if (!next || question !== next.id || answer === undefined) throw new Error('Answer the current question shown on the board.');
      if (next.kind === 'text') {
        if (typeof answer !== 'string') throw new Error('Use a short text answer.');
      } else {
        const number = Number(answer);
        const minimum = next.id === 'bedrooms' || next.id === 'household' ? 1 : 0;
        const maximum = next.id === 'bedrooms' || next.id === 'household' ? 12 : 10_000_000;
        if (!Number.isInteger(number) || number < minimum || number > maximum) {
          throw new Error(`Use a whole number between ${minimum} and ${maximum}.`);
        }
        answer = number;
      }
      state.answers[next.id] = answer;
      break;
    }
    case 'sample_bank':
      if (persona !== 'onboarding') throw new Error('Open Laia’s onboarding first.');
      state.bankConnected = true;
      Object.assign(state.answers, { income: bank.income, spending: bank.spending, savings: bank.savings });
      break;
    case 'join_quest':
      if (persona !== 'progress') throw new Error('Open Marc’s progress first.');
      state.joinedQuest = true;
      message = 'Marc joined the sample park picnic and earned 100 XP and the Good Neighbor badge.';
      break;
    case 'read_inbox':
      if (persona !== 'shortcuts') throw new Error('Open Núria’s shortcuts first.');
      state.inboxRead = true;
      break;
    case 'choose_shortcut':
    case 'keep_route':
      if (persona !== 'shortcuts' || !state.inboxRead) throw new Error('Open Núria’s shortcut inbox first.');
      if (action === 'choose_shortcut' && !opportunity) throw new Error('Choose one of the five shortcut IDs.');
      state.chosen = action === 'keep_route' ? 'keep' : opportunity!;
      message = state.chosen === 'keep' ? 'Núria kept the current route.' : 'Núria switched the demo route. Real eligibility and costs would still need verification.';
      break;
    case 'final_payment':
      if (persona !== 'payoff') throw new Error('Open Jordi’s payoff first.');
      state.paid = true;
      break;
    case 'restart_persona': {
      const initial = seed();
      if (persona === 'onboarding') {
        state.answers = initial.answers;
        state.bankConnected = false;
      } else if (persona === 'progress') state.joinedQuest = false;
      else if (persona === 'shortcuts') {
        state.inboxRead = false;
        state.chosen = null;
      } else state.paid = false;
      break;
    }
    case 'restart_all':
      run.state = seed();
      break;
  }
  return getView(runId, message);
}
