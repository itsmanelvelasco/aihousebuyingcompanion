import { z } from 'zod';

const text = (label: string, prompt: string, example: string) => ({ label, prompt, example, kind: 'text' as const });
const count = (label: string, prompt: string, example: string, min: number, max: number) => ({
  label,
  prompt,
  example,
  kind: 'number' as const,
  min,
  max,
  money: false,
});
const money = (label: string, prompt: string, example: string) => ({
  ...count(label, prompt, example, 0, 10_000_000),
  money: true,
});

const fields = {
  town: text('Target town', 'Where would you like to buy?', 'Manresa'),
  bedrooms: count('Bedrooms', 'How many bedrooms do you need?', '2', 1, 12),
  household: count('Household size', 'How many people are in your household?', '3', 1, 12),
  employment: text('Employment', 'What is your employment situation?', 'Full-time employee'),
  income: money('Take-home income per month (€)', 'What is your monthly take-home income?', '2900'),
  spending: money(
    'Monthly expenses, before debt (€)',
    'What are your monthly living expenses including rent but excluding debt payments?',
    '2180',
  ),
  savings: money('Current savings (€)', 'How much have you already saved?', '18400'),
  currentTown: text('Where you live now', 'Which municipality do you live in now?', 'Barcelona'),
  budget: money('Maximum home price (€)', 'What is the maximum price you would pay for a home?', '180000'),
  homeSize: count('Minimum floor area (m²)', 'How much floor area do you need?', '85', 1, 1_000),
  dependants: count('Dependants', 'How many dependants do you have?', '1', 0, 12),
  rural: text('Rural preference', 'Are you open to a rural town?', 'Open to rural towns'),
  commuteTo: text('Work destination', 'Where would you commute to?', 'Barcelona Sants'),
  commuteTime: count('Maximum commute (minutes)', 'What is your longest acceptable one-way commute?', '50', 0, 300),
  transport: text('Transport preference', 'How do you want to travel?', 'Train, no car'),
  schoolStages: text('School stages needed', 'Which school stages do you need access to?', 'Primary and ESO'),
  debtPayments: money('Debt payments per month (€)', 'How much do you pay each month toward existing debt?', '100'),
  reserve: money('Emergency savings to keep (€)', 'How much cash do you want to reserve for emergencies?', '5000'),
  cashTarget: {
    ...money('Custom upfront cash goal (€)', 'Do you have a specific upfront cash target?', '54000'),
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

const question = (id: QuestionId) => ({ id, ...fields[id] });
export const basicGroups = [
  {
    title: 'Tell me about the home you want',
    questions: ['town', 'bedrooms', 'household'].map(id => question(id as QuestionId)),
  },
  {
    title: 'Give me the financial picture',
    questions: ['employment', 'income', 'spending', 'savings'].map(id => question(id as QuestionId)),
  },
];
export const extraGroups = [
  {
    title: 'Home and household',
    questions: ['currentTown', 'budget', 'homeSize', 'dependants', 'rural'].map(id => question(id as QuestionId)),
  },
  {
    title: 'Commute and schools',
    questions: ['commuteTo', 'commuteTime', 'transport', 'schoolStages'].map(id => question(id as QuestionId)),
  },
  {
    title: 'Debt and cash buffer',
    questions: ['debtPayments', 'reserve', 'cashTarget'].map(id => question(id as QuestionId)),
  },
];

export function validateAnswers(input: Answers): Answers {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      const id = questionId.parse(key);
      const field = fields[id];
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
