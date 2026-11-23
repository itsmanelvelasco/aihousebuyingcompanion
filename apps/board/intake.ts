import { z } from 'zod';
import { sceneText } from './scenes.ts';

/** The English labels, as the model and the validation errors read them; the widget shows its own language. */
const english = sceneText('en');

const text = (prompt: string, example: string) => ({ prompt, example, kind: 'text' as const });
const count = (prompt: string, example: string, min: number, max: number) => ({
  prompt,
  example,
  kind: 'number' as const,
  min,
  max,
  money: false,
});
const money = (prompt: string, example: string) => ({
  ...count(prompt, example, 0, 10_000_000),
  money: true,
});

const fields = {
  town: text('Where would you like to buy?', 'Manresa'),
  bedrooms: count('How many bedrooms do you need?', '2', 1, 12),
  household: count('How many people are in your household?', '3', 1, 12),
  employment: text('What is your employment situation?', 'Full-time employee'),
  income: money('What is your monthly take-home income?', '2900'),
  spending: money('What are your monthly living expenses including rent but excluding debt payments?', '2180'),
  savings: money('How much have you already saved?', '18400'),
  currentTown: text('Which municipality do you live in now?', 'Barcelona'),
  budget: money('What is the maximum price you would pay for a home?', '180000'),
  homeSize: count('How much floor area do you need?', '85', 1, 1_000),
  dependants: count('How many dependants do you have?', '1', 0, 12),
  rural: text('Are you open to a rural town?', 'Open to rural towns'),
  commuteTo: text('Where would you commute to?', 'Barcelona Sants'),
  commuteTime: count('What is your longest acceptable one-way commute?', '50', 0, 300),
  transport: text('How do you want to travel?', 'Train, no car'),
  schoolStages: text('Which school stages do you need access to?', 'Primary and ESO'),
  debtPayments: money('How much do you pay each month toward existing debt?', '100'),
  reserve: money('How much cash do you want to reserve for emergencies?', '5000'),
  cashTarget: {
    ...money('Do you have a specific upfront cash target?', '54000'),
    min: 1,
  },
};

export type QuestionId = keyof typeof fields;
export const questionId = z.enum(Object.keys(fields) as [QuestionId, ...QuestionId[]]);
export const answerValue = z.union([z.string().trim().min(1).max(80), z.number().int().nonnegative().max(10_000_000)]);
export const answersSchema = z.strictObject(
  Object.fromEntries(Object.keys(fields).map(id => [id, answerValue.optional()])) as Record<
    QuestionId,
    z.ZodOptional<typeof answerValue>
  >,
);
export type Answers = Partial<Record<QuestionId, string | number>>;

const question = (id: QuestionId) => ({ id, label: english.fieldLabel(id), ...fields[id] });
export const basicGroups = [
  {
    id: 'home' as const,
    title: english.groupTitle('home'),
    questions: ['town', 'bedrooms', 'household'].map(id => question(id as QuestionId)),
  },
  {
    id: 'finances' as const,
    title: english.groupTitle('finances'),
    questions: ['employment', 'income', 'spending', 'savings'].map(id => question(id as QuestionId)),
  },
];
export const extraGroups = [
  {
    id: 'household' as const,
    title: english.groupTitle('household'),
    questions: ['currentTown', 'budget', 'homeSize', 'dependants', 'rural'].map(id => question(id as QuestionId)),
  },
  {
    id: 'commute' as const,
    title: english.groupTitle('commute'),
    questions: ['commuteTo', 'commuteTime', 'transport', 'schoolStages'].map(id => question(id as QuestionId)),
  },
  {
    id: 'buffer' as const,
    title: english.groupTitle('buffer'),
    questions: ['debtPayments', 'reserve', 'cashTarget'].map(id => question(id as QuestionId)),
  },
];

export function validateAnswers(input: Answers): Answers {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      const id = questionId.parse(key);
      const field = question(id);
      const answer = answerValue.parse(value);
      if (field.kind === 'text') {
        if (typeof answer !== 'string') throw new Error(`${field.label} needs a short text answer.`);
        return [id, answer];
      }
      const number = Number(answer);
      if (!Number.isInteger(number) || number < field.min || number > field.max) {
        throw new Error(`${field.label} needs a whole number between ${field.min} and ${field.max}.`);
      }
      return [id, number];
    }),
  );
}
