import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

const people = {
  onboarding: { name: 'Laia', label: 'Getting started' },
  progress: { name: 'Marc', label: 'On the trail' },
  shortcuts: { name: 'Núria', label: 'Faster routes' },
  payoff: { name: 'Jordi', label: 'Debt-free home' },
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
const intakeGroups = [
  { title: 'Tell me about the home you want', keys: ['town', 'bedrooms', 'household'] },
  { title: 'Give me the financial picture', keys: ['employment', 'income', 'spending', 'savings'] },
] as const;
const answerValue = z.union([z.string().trim().min(1).max(80), z.number().int().nonnegative().max(10_000_000)]);
const answersSchema = z.strictObject({
  town: answerValue.optional(), bedrooms: answerValue.optional(), household: answerValue.optional(),
  employment: answerValue.optional(), income: answerValue.optional(), spending: answerValue.optional(), savings: answerValue.optional(),
});
const termMonths = 240;
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
type Opportunity = z.infer<typeof opportunityId>;
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
});
export const updateSchema = z.object({
  runId: z.uuid(),
  action: z.enum(['answer', 'answer_batch', 'sample_bank', 'restart_persona', 'restart_all', 'join_quest',
    'switch_persona', 'read_inbox', 'preview_shortcut', 'choose_shortcut', 'keep_route', 'replay_payment', 'final_payment', 'show_credits', 'hide_credits', 'refresh_data', 'start_bank_runtime', 'stop_bank_runtime']),
  persona: personaSchema.optional(),
  question: questionId.optional(),
  answer: answerValue.optional(),
  answers: answersSchema.optional().describe('Every onboarding answer given this turn, as one object.'),
  opportunity: opportunityId.optional(),
});

function seed() {
  return {
    answers: {} as Partial<Record<QuestionId, string | number>>,
    bankConnected: false, joinedQuest: false, inboxRead: false,
    chosen: null as Opportunity | null,
    previewed: null as Opportunity | null,
    paid: true, creditsVisible: false,
  };
}
type Run = { persona: Persona; state: ReturnType<typeof seed>; revision: number; pairCode: string };
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

function routeTimeline(upfrontMonths: number | null) {
  return { upfrontMonths, termMonths, debtFreeMonths: upfrontMonths === null ? null : upfrontMonths + termMonths };
}

export function getView(runId: string, message?: string) {
  const { persona, state, revision, pairCode } = getRun(runId);
  const person = people[persona];
  const choices = Object.entries(people).map(([id, info]) => ({ id, ...info }));
  const base = {
    runId, revision, pairCode, persona, person, choices, currency: 'EUR', simulated: true,
    goal: 'Own the home outright, with no mortgage or other demo debt.',
  };
  if (persona === 'onboarding') {
    const group = intakeGroups.map(({ title, keys }) => ({
      title, questions: questions.filter(question =>
        keys.some(key => key === question.id) && state.answers[question.id] === undefined),
    })).find(group => group.questions.length) ?? null;
    const { income, spending, savings } = state.answers;
    const plan = typeof income === 'number' && typeof spending === 'number' && typeof savings === 'number'
      ? { monthly: income - spending, saved: savings, target: initialTarget, ...routeTimeline(timeToGoal(savings, initialTarget, income - spending)) }
      : null;
    return { ...base, answers: { ...state.answers }, group, totalQuestions: questions.length,
      bank: state.bankConnected ? bank : null, plan,
      message: message || (group
        ? `${group.title}. Ask for these in one natural prompt: ${group.questions.map(question => question.prompt).join(' ')}`
        : 'Laia’s intake is complete. Show the upfront milestone and the full path to debt-free homeownership.'),
    } as const;
  }
  if (persona === 'progress') {
    const xp = state.joinedQuest ? 450 : 350;
    const coach = state.joinedQuest
      ? { headline: 'Level up! Good Neighbor unlocked.', milestone: 'You earned 100 XP and moved from third to second place.', next: 'Keep your savings streak going for another month.' }
      : { headline: 'Marc, you’re past halfway!', milestone: 'Four months on a savings streak earned you the Steady Saver badge.', next: 'Join the first buyers’ picnic to reach Level 4 and earn Good Neighbor.' };
    return { ...base, progress: { saved: 32400, target: initialTarget, percent: 60, monthly: 900,
      ...routeTimeline(timeToGoal(32400, initialTarget, 900)), level: state.joinedQuest ? 4 : 3, xp, xpGoal: 550,
      checkpoint: state.joinedQuest ? 2 : 1, streak: 4, rank: state.joinedQuest ? 2 : 3, coach,
      badges: state.joinedQuest ? ['Trailblazer', 'Steady Saver', 'Good Neighbor'] : ['Trailblazer', 'Steady Saver'],
      leaderboard: [{ name: 'Cami', xp: 505 }, { name: 'Sol', xp: 400 }, { name: 'Marc · You', xp }, { name: 'Nico', xp: 220 }]
        .sort((a, b) => b.xp - a.xp),
      joinedQuest: state.joinedQuest },
      message: message || `${coach.headline} ${coach.milestone} ${coach.next}`,
    } as const;
  }
  if (persona === 'shortcuts') {
    const monthly = 800;
    const saved = 28000;
    const baseline = timeToGoal(saved, initialTarget, monthly)!;
    const inbox = opportunities.map(item => {
      const months = timeToGoal(saved, item.target, monthly + item.extra)!;
      return { ...item, letter: routeLetter[item.id], ...routeTimeline(months), fasterBy: baseline - months };
    }).sort((a, b) => a.letter.localeCompare(b.letter));
    const unread = state.inboxRead ? 0 : inbox.length;
    const preview = inbox.find(item => item.id === state.previewed);
    const currentRoute = inbox.find(item => item.id === state.chosen);
    return { ...base, unread, baseline: routeTimeline(baseline), saved, inbox: state.inboxRead ? inbox : [],
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

export function openDemo({ runId, pairCode, persona }: z.infer<typeof openSchema>) {
  if (pairCode) {
    runId = [...runs].find(([, run]) => run.pairCode === pairCode)?.[0];
    if (!runId) throw new Error('That board code is no longer active. Open the live board and use its current code.');
  }
  if (runId) {
    const run = getRun(runId);
    if (persona && persona !== run.persona) {
      run.persona = persona;
      run.revision += 1;
    }
    return getView(runId);
  }

  // Demo-only memory, bounded so a publicly reachable tunnel cannot grow it indefinitely.
  if (runs.size >= 200) {
    const oldest = runs.keys().next().value;
    if (oldest) runs.delete(oldest);
  }
  const id = randomUUID();
  let code: string;
  do { code = randomBytes(4).toString('hex').toUpperCase(); }
  while ([...runs.values()].some(run => run.pairCode === code));
  runs.set(id, { persona: persona ?? 'onboarding', state: seed(), revision: 0, pairCode: code });
  return getView(id);
}

function validatedAnswer(question: QuestionId, answer: string | number) {
  if (question === 'town' || question === 'employment') {
    if (typeof answer !== 'string') throw new Error(`${question} needs a short text answer.`);
    return answer;
  }
  const number = Number(answer);
  const isCount = question === 'bedrooms' || question === 'household';
  const minimum = isCount ? 1 : 0;
  const maximum = isCount ? 12 : 10_000_000;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${question} needs a whole number between ${minimum} and ${maximum}.`);
  }
  return number;
}

export function updateDemo({ runId, action, persona: nextPersona, question, answer, answers, opportunity }: z.infer<typeof updateSchema>) {
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
      const validated = Object.entries(fields).map(([key, value]) => {
        const id = questionId.parse(key);
        return [id, validatedAnswer(id, answerValue.parse(value))] as const;
      });
      for (const [id, value] of validated) state.answers[id] = value;
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
      message = 'Level up, Marc! You earned 100 XP, unlocked Good Neighbor, and jumped to second place.';
      break;
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
      } else if (persona === 'progress') state.joinedQuest = false;
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
