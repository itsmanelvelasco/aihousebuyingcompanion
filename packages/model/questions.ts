import type { Policy } from '../contracts/places.ts';
import type { AnswerSpec, FactAnswer, Person } from '../contracts/planner.ts';

/**
 * The one question set of ReloCat: every fact that decides a person's plan, defined once.
 *
 * The workspace, the interviewer (guided and voice) and the chat all ask from this list, validate
 * with `validateAnswer`, store with `answerToInput` and try a what-if with `applyAnswer`. Nothing
 * here does money maths or screens a rule: which question is worth asking for the places compared
 * is the planner's job (`missingFacts` in `packages/planner/next-questions.ts`). This module is
 * plain data and pure functions with no runtime imports, so a browser bundle can include it.
 *
 * "I don't know" is an answer. It is `null` in the typed state, it is saved as an explicit `null`
 * input, and it never becomes zero, `false` or a guess.
 */

type PolicyId = Policy['id'];

export const questionIds = [
  'monthlyIncome',
  'monthlyExpenses',
  'purchaseSavings',
  'homeBudget',
  'floorArea',
  'primaryResidence',
  'birthDate',
  'children',
  'itpTransaction',
  'itpOccupancy',
  'childrenItpSchooling',
  'largeFamily',
  'singleParent',
  'disability65',
  'firstRuralMove',
  'childrenIrpfSchooling',
  'ownsHomeInSpain',
  'incomeWithinFiveIprem',
  'filing',
  'itpBuyerNetTaxBase',
  'itpFamilyNetTaxBase',
  'irpfNetTaxBase',
  'irpfIndividualNetTaxBase',
  'depositRate',
  'emergencyReserve',
] as const;
export type QuestionId = (typeof questionIds)[number];

/** A child as a person states it: a date of birth. An empty list of children means none. */
export type ChildAnswer = { birthDate: string };
/**
 * The typed value of an answer, in the unit it is stored in: integer cents for the plan's money,
 * euros for a tax base, a share (0.2) for a percentage, an ISO date, a list of children, or one
 * yes/no/unknown per child. `null` in place of a value is "I don't know".
 */
export type AnswerValue = boolean | number | string | ChildAnswer[] | (boolean | null)[];
/** Answers by question id: the state every surface keeps. A missing key was never answered. */
export type Answers = Partial<Record<QuestionId, AnswerValue | null>>;

/** A child of a person, wherever its age comes from. */
export type ChildFacts = {
  birthDate?: string;
  birthYear?: number;
  age?: number;
  inDesignatedSchool?: boolean | null;
  meetsItpSchooling?: boolean | null;
};

type Kind =
  | { type: 'boolean' }
  | { type: 'date' }
  | { type: 'money'; storedAs: 'cents' | 'eur'; min: number; max: number }
  | { type: 'number'; unit: string; min: number; max: number }
  | { type: 'percent'; min: number; max: number }
  | { type: 'choice'; options: { value: string; label: string }[] }
  | { type: 'children' }
  | { type: 'per_child'; flag: 'inDesignatedSchool' | 'meetsItpSchooling' };

export type Question = {
  id: QuestionId;
  /** `plan`: the figures a timeline needs. `household`: who buys and how. `tax`: figures from a tax return. */
  group: 'plan' | 'household' | 'tax';
  /** The input field the answer is saved to (`packages/contracts/inputs.ts`). */
  path: `${'finance' | 'housing' | 'eligibility'}.${string}`;
  label: string;
  question: string;
  /** Which measure the answer decides, in one sentence. */
  why: string;
  /** Where to find the answer, when that is not obvious. */
  help: string | null;
  /** Set for a sensitive fact: a short note on why it is asked and where it is kept. */
  sensitivity: string | null;
  kind: Kind;
  allowUnknown: boolean;
  /** The measures whose screening reads this fact (`householdChecks` in `packages/places/eligibility.ts`). */
  decides: PolicyId[];
  /** A question that can satisfy the same condition instead of this one (age or a qualifying child). */
  alternatives?: QuestionId[];
  /**
   * When a stored answer may stop holding: an `age` goes out of date with a birthday, a `tax_year`
   * figure belongs to one return, a `school_year` answer to one school year.
   */
  goesStale: 'never' | 'age' | 'tax_year' | 'school_year';
};

const kept =
  'It is stored only if you are signed in and save it; otherwise it stays in this estimate and is sent nowhere else.';
const familyNote = `About your family. It is used only to check the measures named here. ${kept}`;
const healthNote = `About health. It is used only to check this one tax rate, and no detail beyond yes or no is asked. ${kept}`;
const taxNote = `From your tax return. It is used only to compare with the limit of the measure. ${kept}`;
/**
 * Where the figure is on the return. The Agència Tributària's "Manual práctico de Renta 2025.
 * Deducciones autonómicas", Catalonia, states the limit of a Catalan deduction that uses this same
 * figure as "la suma de las bases imponibles general y del ahorro menos el mínimo personal y
 * familiar", computed as "suma de las casillas [0435] y [0460] menos el importe de la casilla
 * [0520] de la declaración". Read on 2026-11-22 at
 * https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/irpf-2025-deducciones-autonomicas/comunidad-autonoma-cataluna/alquiler-vivienda-habitual.html
 * The box numbers are those of the 2025 return (form 100) and are stated as such: they can change.
 */
const taxBaseHelp =
  'This is not your salary. It is the general tax base plus the savings tax base, less the personal and family minimum. On the 2025 income tax return (Renta 2025, form 100) the Agència Tributària computes it as box 0435 plus box 0460 minus box 0520. Box numbers can change from one year to the next, so check the labels: base imponible general, base imponible del ahorro, mínimo personal y familiar. If you are not sure, choose “I don’t know”.';
const euros = { type: 'money', storedAs: 'cents', min: 0, max: 50_000_000 } as const;
const taxBase = { type: 'money', storedAs: 'eur', min: -1_000_000, max: 10_000_000 } as const;
const generalRates: PolicyId[] = ['itp_young_buyer', 'itp_large_family', 'itp_single_parent', 'itp_disability'];

/** The question set, in the order it is asked when nothing ranks one question above another. */
export const questions: readonly Question[] = [
  {
    id: 'monthlyIncome',
    group: 'plan',
    path: 'finance.monthlyIncomeCents',
    label: 'Monthly income',
    question: 'How much money comes into your household in a typical month, after tax?',
    why: 'The plan saves what is left of your income after your spending each month.',
    help: null,
    sensitivity: null,
    kind: euros,
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'monthlyExpenses',
    group: 'plan',
    path: 'finance.monthlyExpensesCents',
    label: 'Monthly spending',
    question: 'How much does your household spend in a typical month, with rent, bills and debt payments included?',
    why: 'The plan saves what is left of your income after your spending each month.',
    help: null,
    sensitivity: null,
    kind: euros,
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'purchaseSavings',
    group: 'plan',
    path: 'finance.currentSavingsCents',
    label: 'Savings for the purchase',
    question: 'How much have you already saved that you would spend on buying the home?',
    why: 'It is the starting point of the timeline. A bank balance is never assumed to be available for the purchase.',
    help: null,
    sensitivity: null,
    kind: euros,
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'homeBudget',
    group: 'plan',
    path: 'housing.budgetCents',
    label: 'Home budget',
    question: 'What is the most you would pay for the home?',
    why: 'The deposit, the transfer tax and the purchase fees are all shares of the price.',
    help: 'If you do not have a figure, choose “I don’t know”: the plan can price a home of a given size from each town’s average instead.',
    sensitivity: null,
    kind: { type: 'money', storedAs: 'cents', min: 1, max: 50_000_000 },
    allowUnknown: true,
    decides: ['youth_purchase_small_town'],
    goesStale: 'never',
  },
  {
    id: 'floorArea',
    group: 'plan',
    path: 'housing.homeSizeM2',
    label: 'Home size',
    question: 'How large a home are you looking for, in square metres?',
    why: 'Without a budget, the price is this floor area times the average price per square metre of each town.',
    help: null,
    sensitivity: null,
    kind: { type: 'number', unit: 'm²', min: 10, max: 2000 },
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'primaryResidence',
    group: 'household',
    path: 'eligibility.primaryResidence',
    label: 'Main home',
    question: 'Will the home you buy be the one you live in, your main home?',
    why: 'Every reduced transfer-tax rate, the rural deductions and the aid for young buyers are for the home you live in.',
    help: null,
    sensitivity: null,
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: [
      'itp_buy',
      'itp_rehab_buy',
      ...generalRates,
      'irpf_move',
      'irpf_buy',
      'irpf_rent',
      'youth_purchase_small_town',
    ],
    goesStale: 'never',
  },
  {
    id: 'birthDate',
    group: 'household',
    path: 'eligibility.birthDate',
    label: 'Date of birth',
    question: 'What is your date of birth?',
    why: 'A buyer aged 35 or younger pays 5% transfer tax instead of the general rate anywhere in Catalonia, and some aids and deductions have the same age limit. Your age is worked out for the day you could buy, so it does not go out of date.',
    help: null,
    sensitivity: null,
    kind: { type: 'date' },
    allowUnknown: false,
    decides: ['itp_young_buyer', 'youth_purchase_small_town', 'irpf_move', 'irpf_rent'],
    alternatives: ['children'],
    goesStale: 'age',
  },
  {
    id: 'children',
    group: 'household',
    path: 'eligibility.children',
    label: 'Children',
    question: 'Do children who depend on you live with you? Give the date of birth of each one, or say there are none.',
    why: 'The reduced transfer tax of a rural municipality (4% or 3%) and the rural income-tax deductions are for households with a child aged 16 or younger.',
    help: null,
    sensitivity: familyNote,
    kind: { type: 'children' },
    allowUnknown: false,
    decides: ['itp_buy', 'irpf_buy', 'irpf_move', 'irpf_rent'],
    alternatives: ['birthDate'],
    goesStale: 'age',
  },
  {
    id: 'itpTransaction',
    group: 'household',
    path: 'eligibility.itpTransaction',
    label: 'Purchase subject to transfer tax',
    question:
      'Will the purchase pay transfer tax (ITP)? That is the case for most resale homes; a new build sold by its developer pays VAT instead.',
    why: 'The reduced rates are rates of the transfer tax, so none of them applies to a purchase that pays VAT.',
    help: null,
    sensitivity: null,
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_buy', 'itp_rehab_buy', ...generalRates],
    goesStale: 'never',
  },
  {
    id: 'itpOccupancy',
    group: 'household',
    path: 'eligibility.satisfiesItpOccupancyRules',
    label: 'Moving in and staying',
    question: 'Will you move in within twelve months of buying and keep it as your main home for at least three years?',
    why: 'A reduced transfer-tax rate is provisional: it is kept only if those two deadlines are met, or an exception in the law applies.',
    help: null,
    sensitivity: null,
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_buy', ...generalRates],
    goesStale: 'never',
  },
  {
    id: 'childrenItpSchooling',
    group: 'household',
    path: 'eligibility.children',
    label: 'Schooling for the rural transfer tax',
    question:
      'For each child aged 4 to 16: will the child meet the schooling conditions of the rural transfer-tax rate (the place of the school, the timing and staying enrolled)?',
    why: 'The reduced transfer tax of a rural municipality needs a child aged 16 or younger who meets its schooling conditions; children aged 3 or younger are exempt.',
    help: 'The Catalan Tax Agency sets the exact conditions. If you have not checked them yet, choose “I don’t know” and confirm with the agency.',
    sensitivity: familyNote,
    kind: { type: 'per_child', flag: 'meetsItpSchooling' },
    allowUnknown: true,
    decides: ['itp_buy'],
    goesStale: 'school_year',
  },
  {
    id: 'largeFamily',
    group: 'household',
    path: 'eligibility.largeFamily',
    label: 'Large family',
    question: 'Does your family hold the official large-family title (família nombrosa)?',
    why: 'A recognised large family pays 5% transfer tax on its main home anywhere in Catalonia.',
    help: null,
    sensitivity: familyNote,
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_large_family'],
    goesStale: 'never',
  },
  {
    id: 'singleParent',
    group: 'household',
    path: 'eligibility.singleParent',
    label: 'Single-parent family',
    question: 'Does your family hold the official single-parent family title (família monoparental)?',
    why: 'A recognised single-parent family pays 5% transfer tax on its main home anywhere in Catalonia, and its deduction for moving to a rural municipality is doubled.',
    help: null,
    sensitivity: familyNote,
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_single_parent', 'irpf_move'],
    goesStale: 'never',
  },
  {
    id: 'disability65',
    group: 'household',
    path: 'eligibility.disability65',
    label: 'Disability of 65% or more',
    question: 'Do you, or a member of your family unit, have a recognised disability of 65% or more?',
    why: 'A household with a recognised disability of 65% or more pays 5% transfer tax on its main home anywhere in Catalonia.',
    help: null,
    sensitivity: healthNote,
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_disability'],
    goesStale: 'never',
  },
  {
    id: 'firstRuralMove',
    group: 'household',
    path: 'eligibility.firstRuralMove',
    label: 'First move to a rural municipality',
    question: 'Would this be the first time you move your home to a rural municipality?',
    why: 'The income-tax deduction for moving to a rural municipality (€750, or €1,000 in a special-attention one) is for a first move.',
    help: null,
    sensitivity: null,
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['irpf_move'],
    goesStale: 'never',
  },
  {
    id: 'childrenIrpfSchooling',
    group: 'household',
    path: 'eligibility.children',
    label: 'Schooling for the rural income-tax deductions',
    question:
      'For each child aged 4 to 16: will the child go to school in the educational zone of the new home, or in the school assigned to it?',
    why: 'The rural income-tax deductions count a child aged 16 or younger who meets their schooling rule; children aged 3 or younger are exempt.',
    help: 'The Catalan Tax Agency sets the exact conditions. If you have not checked them yet, choose “I don’t know” and confirm with the agency.',
    sensitivity: familyNote,
    kind: { type: 'per_child', flag: 'inDesignatedSchool' },
    allowUnknown: true,
    decides: ['irpf_buy', 'irpf_move', 'irpf_rent'],
    goesStale: 'school_year',
  },
  {
    id: 'ownsHomeInSpain',
    group: 'household',
    path: 'eligibility.ownsHomeInSpain',
    label: 'Another home in Spain',
    question: 'Do you own another home in Spain, or hold a usufruct over one?',
    why: 'The state aid for buyers aged 35 or younger in small towns is not for people who already own a home in Spain, unless an official exception applies.',
    help: null,
    sensitivity: null,
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['youth_purchase_small_town'],
    goesStale: 'never',
  },
  {
    id: 'incomeWithinFiveIprem',
    group: 'household',
    path: 'eligibility.incomeWithinFiveIprem',
    label: 'Income within five times IPREM',
    question:
      'Is your yearly income at most five times the IPREM, the public income index (5.5 or 6 times with a recognised disability)?',
    why: 'The state aid for buyers aged 35 or younger in small towns has that income ceiling.',
    help: 'The IPREM is set each year in the State Budget, and the call for the aid states the limit in euros. If you have not compared your income with it, choose “I don’t know”.',
    sensitivity: null,
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['youth_purchase_small_town'],
    goesStale: 'tax_year',
  },
  {
    id: 'filing',
    group: 'tax',
    path: 'eligibility.filing',
    label: 'Type of tax return',
    question: 'Do you file your income tax return on your own, or jointly with your family unit?',
    why: 'The rural deductions for moving and for renting have an income limit that depends on it: €30,000 on an individual return, €45,000 on a joint one.',
    help: null,
    sensitivity: null,
    kind: {
      type: 'choice',
      options: [
        { value: 'individual', label: 'On my own (individual)' },
        { value: 'joint', label: 'Jointly' },
      ],
    },
    allowUnknown: true,
    decides: ['irpf_move', 'irpf_rent'],
    goesStale: 'tax_year',
  },
  {
    id: 'itpBuyerNetTaxBase',
    group: 'tax',
    path: 'eligibility.itpBuyerNetTaxBaseEur',
    label: 'Your own tax base',
    question: 'From your last income tax return: what was your own tax base, in euros?',
    why: 'The 5% transfer tax for buyers aged 35 or younger applies only if this figure is at most €36,000.',
    help: taxBaseHelp,
    sensitivity: taxNote,
    kind: taxBase,
    allowUnknown: true,
    decides: ['itp_young_buyer', 'itp_rehab_buy'],
    goesStale: 'tax_year',
  },
  {
    id: 'itpFamilyNetTaxBase',
    group: 'tax',
    path: 'eligibility.itpFamilyNetTaxBaseEur',
    label: 'Your family’s tax bases',
    question:
      'From the last income tax returns of your family unit: what do the tax bases of all its members add up to, in euros?',
    why: 'The rural reduced transfer tax and the 5% rates for large families, single-parent families and disability apply only if this total is at most €36,000 (more for some large and single-parent families).',
    help: `Add the figure of each member who files a return. ${taxBaseHelp}`,
    sensitivity: taxNote,
    kind: taxBase,
    allowUnknown: true,
    decides: ['itp_buy', 'itp_large_family', 'itp_single_parent', 'itp_disability'],
    goesStale: 'tax_year',
  },
  {
    id: 'irpfNetTaxBase',
    group: 'tax',
    path: 'eligibility.irpfNetTaxBaseEur',
    label: 'Tax base of your return',
    question:
      'From your last income tax return: what was the tax base, in euros? Use the joint figure if you file jointly.',
    why: 'The rural deductions for moving and for renting apply only if this figure is at most €30,000 on an individual return or €45,000 on a joint one.',
    help: `${taxBaseHelp} The deduction looks at the return of the year of the move, so last year’s figure is an indication.`,
    sensitivity: taxNote,
    kind: taxBase,
    allowUnknown: true,
    decides: ['irpf_move', 'irpf_rent'],
    goesStale: 'tax_year',
  },
  {
    id: 'irpfIndividualNetTaxBase',
    group: 'tax',
    path: 'eligibility.irpfIndividualNetTaxBaseEur',
    label: 'Your individually computed tax base',
    question:
      'From your last income tax return: what was your own tax base computed individually, in euros, even if you file jointly?',
    why: 'The rural income-tax deduction for buying a main home applies only if this figure is at most €36,000.',
    help: taxBaseHelp,
    sensitivity: taxNote,
    kind: taxBase,
    allowUnknown: true,
    decides: ['irpf_buy', 'irpf_renovate'],
    goesStale: 'tax_year',
  },
  {
    id: 'depositRate',
    group: 'plan',
    path: 'housing.depositRate',
    label: 'Deposit',
    question: 'What share of the price would you pay upfront as a deposit, in percent?',
    why: 'The deposit is the largest part of the upfront cash. Until you say otherwise the plan assumes 20%.',
    help: null,
    sensitivity: null,
    kind: { type: 'percent', min: 0, max: 100 },
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'emergencyReserve',
    group: 'plan',
    path: 'finance.emergencyReserveCents',
    label: 'Emergency reserve',
    question:
      'How much of your savings do you want to keep aside and not spend on the purchase? Zero is a valid answer.',
    why: 'The plan takes this reserve off your savings before counting them. Until you say otherwise it sets nothing aside.',
    help: null,
    sensitivity: null,
    kind: euros,
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
];

const byId = new Map(questions.map(question => [question.id, question]));
export const isQuestionId = (value: string): value is QuestionId => byId.has(value as QuestionId);

export function questionById(id: QuestionId): Question {
  const question = byId.get(id);
  if (!question) throw new Error(`Unknown question ${id}`);
  return question;
}

/** The household field of an eligibility question, such as `itpBuyerNetTaxBaseEur`. */
export const fieldOf = (question: Question) => question.path.slice(question.path.indexOf('.') + 1);

// ------------------------------------------------------------------ dates

const isoDay = /^\d{4}-\d{2}-\d{2}$/;
function validDay(value: string) {
  if (!isoDay.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Whole years between a date of birth and a day. A person born on 29 February has a birthday on 1 March in other years. */
export function ageOn(birthDate: string, day: string): number {
  const [birthYear, birthMonthDay] = [Number(birthDate.slice(0, 4)), birthDate.slice(5)];
  const [year, monthDay] = [Number(day.slice(0, 4)), day.slice(5)];
  return year - birthYear - (monthDay < birthMonthDay ? 1 : 0);
}

/**
 * The age of a child on a day. From a date of birth it is exact. From a birth year alone the
 * birthday is open, so it is the age the child reaches during that calendar year: the cautious
 * reading of a rule with an upper age limit. A plain age is taken as stated.
 */
export function childAgeOn(child: ChildFacts, day: string): number | null {
  if (child.birthDate !== undefined) return Math.max(0, ageOn(child.birthDate, day));
  if (child.birthYear !== undefined) return Math.max(0, Number(day.slice(0, 4)) - child.birthYear);
  return child.age ?? null;
}

// ----------------------------------------------------- reading a person

/** The children of a person as they were stated: dates of birth when the person has them, else ages. */
export function childrenOf(person: Pick<Person, 'born' | 'household'>): ChildFacts[] | undefined {
  return person.born?.children ?? person.household?.children;
}

/** Positions of the children a schooling answer is about: those aged 16 or younger on `day`. */
export function schoolAgeChildren(person: Pick<Person, 'born' | 'household'>, day: string): number[] {
  return (childrenOf(person) ?? []).flatMap((child, index) => {
    const age = childAgeOn(child, day);
    return age !== null && age <= 16 ? [index] : [];
  });
}

/**
 * The value a person already holds for a question, in the unit of an answer; `undefined` when the
 * person holds none. An emergency reserve of zero and the default deposit count as held only when
 * `person.answers` says somebody stated them: they are also what the plan assumes in silence.
 */
export function heldValue(person: Person, id: QuestionId, day: string): AnswerValue | undefined {
  const { finances, home, household } = person;
  const stated = person.answers?.[id]?.status === 'known';
  const orUndefined = <T>(value: T | null | undefined) => (value === null || value === undefined ? undefined : value);
  switch (id) {
    case 'monthlyIncome':
      return orUndefined(finances.monthlyIncomeCents);
    case 'monthlyExpenses':
      return orUndefined(finances.monthlyExpensesCents);
    case 'purchaseSavings':
      return orUndefined(finances.currentSavingsCents);
    case 'emergencyReserve':
      return stated || finances.emergencyReserveCents > 0 ? finances.emergencyReserveCents : undefined;
    case 'homeBudget':
      return orUndefined(home.budgetCents);
    case 'floorArea':
      return orUndefined(home.floorAreaM2);
    case 'depositRate':
      return stated || home.depositRate !== 0.2 ? home.depositRate : undefined;
    case 'birthDate':
      return person.born?.self ?? household?.age;
    case 'children':
      // As stated: dates of birth when the person has them, plain ages otherwise.
      return childrenOf(person) as AnswerValue | undefined;
    case 'childrenItpSchooling':
    case 'childrenIrpfSchooling': {
      const kind = questionById(id).kind as Extract<Kind, { type: 'per_child' }>;
      const children = childrenOf(person);
      const asked = schoolAgeChildren(person, day);
      if (!children || !asked.length) return undefined;
      const flags = asked.map(index => children[index][kind.flag] ?? null);
      return flags.every(flag => flag !== null) ? flags : undefined;
    }
    default:
      return orUndefined(
        (household as Record<string, unknown> | undefined)?.[fieldOf(questionById(id))] as AnswerValue | undefined,
      );
  }
}

export type FactState = 'known' | 'missing' | FactAnswer['status'];

/** Whether a question is answered for a person, and if not, why not. */
export function stateOf(person: Person, id: QuestionId, day: string): FactState {
  if (heldValue(person, id, day) !== undefined) return 'known';
  const status = person.answers?.[id]?.status;
  return status && status !== 'known' ? status : 'missing';
}

/**
 * Whether a question makes sense to ask this person at all, whatever the places compared:
 * - the floor area only when there is no budget (a budget is the price);
 * - a child's schooling only when the person has a child aged 16 or younger.
 * Whether a tax base or a family status can matter for the places compared is not decided here:
 * that needs the rules of each place, and `missingFacts` asks the planner.
 */
export function appliesTo(person: Person, id: QuestionId, day: string): boolean {
  switch (id) {
    case 'floorArea':
      return person.home.budgetCents === null;
    case 'childrenItpSchooling':
    case 'childrenIrpfSchooling':
      return schoolAgeChildren(person, day).length > 0;
    default:
      return true;
  }
}

// ------------------------------------------------------------ answering

function describeChild(child: ChildFacts, index: number, day: string) {
  const age = childAgeOn(child, day);
  const born = child.birthDate ? `born ${child.birthDate}` : child.birthYear ? `born in ${child.birthYear}` : null;
  const aged = age === null ? null : `aged ${age}`;
  return `Child ${index + 1} (${[born, aged].filter(Boolean).join(', ') || 'age unknown'})`;
}

/** How a question is answered for this person today: the shape every surface renders its control from. */
export function answerSpecFor(question: Question, person: Person | null, day: string): AnswerSpec {
  const { kind } = question;
  switch (kind.type) {
    case 'date':
      return { type: 'date', min: `${Number(day.slice(0, 4)) - 120}-01-01`, max: day };
    case 'children':
      return { type: 'children', max: 12 };
    case 'per_child':
      return {
        type: 'per_child',
        children: person
          ? schoolAgeChildren(person, day).map(index => ({
              index,
              label: describeChild((childrenOf(person) ?? [])[index], index, day),
            }))
          : [],
      };
    default:
      return kind;
  }
}

/**
 * Check a typed answer. Returns a message for the person, to show next to the field, or null when
 * the answer is acceptable. `null` (I don't know) is acceptable only where the question allows it.
 */
export function validateAnswer(
  id: QuestionId,
  value: unknown,
  context: { today: string; childCount?: number },
): string | null {
  const question = questionById(id);
  const { kind } = question;
  if (value === undefined) return 'Give an answer first.';
  if (value === null)
    return question.allowUnknown ? null : 'This one needs a value: the plan cannot use “I don’t know” here.';
  switch (kind.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Choose yes or no.';
    case 'date':
      if (typeof value !== 'string' || !validDay(value)) return 'Enter the full date: day, month and year.';
      if (value > context.today) return 'The date cannot be in the future.';
      if (ageOn(value, context.today) > 120) return 'That date is more than 120 years ago.';
      return null;
    case 'money': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter an amount in euros, digits only.';
      if (kind.storedAs === 'cents' && !Number.isSafeInteger(value)) return 'Enter an amount in euros and cents.';
      const [min, max] = kind.storedAs === 'cents' ? [kind.min * 100, kind.max * 100] : [kind.min, kind.max];
      if (value < min) return kind.min === 0 ? 'The amount cannot be negative.' : `Enter at least €${kind.min}.`;
      return value > max ? `Enter at most €${kind.max.toLocaleString('en-GB')}.` : null;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `Enter a number of ${kind.unit}.`;
      return value < kind.min || value > kind.max ? `Enter between ${kind.min} and ${kind.max} ${kind.unit}.` : null;
    case 'percent':
      // Stored as a share: 20% is 0.2.
      return typeof value === 'number' && value >= kind.min / 100 && value <= kind.max / 100
        ? null
        : `Enter a percentage between ${kind.min} and ${kind.max}.`;
    case 'choice':
      return kind.options.some(option => option.value === value) ? null : 'Choose one of the options.';
    case 'children': {
      if (!Array.isArray(value)) return 'List the children, or say there are none.';
      if (value.length > 12) return 'List at most 12 children.';
      for (const [index, child] of value.entries()) {
        const birthDate = (child as ChildAnswer | null)?.birthDate;
        if (typeof birthDate !== 'string' || !validDay(birthDate))
          return `Enter the full date of birth of child ${index + 1}: day, month and year.`;
        if (birthDate > context.today) return `The date of birth of child ${index + 1} cannot be in the future.`;
        if (ageOn(birthDate, context.today) > 120) return `The date of birth of child ${index + 1} is too long ago.`;
      }
      return null;
    }
    case 'per_child':
      if (!Array.isArray(value) || value.some(flag => flag !== null && typeof flag !== 'boolean'))
        return 'Answer yes, no or “I don’t know” for each child.';
      return context.childCount !== undefined && value.length !== context.childCount
        ? 'Answer for each child listed.'
        : null;
  }
}

/**
 * Turn what a person typed into a typed value: euros into the stored unit, a percentage into a
 * share. Returns `undefined` for text that is not a number. The only arithmetic is the change of unit.
 */
export function parseTyped(id: QuestionId, text: string): AnswerValue | undefined {
  const { kind } = questionById(id);
  const trimmed = text.trim();
  if (kind.type === 'date' || kind.type === 'choice') return trimmed || undefined;
  if (kind.type !== 'money' && kind.type !== 'number' && kind.type !== 'percent') return undefined;
  // "1.234,50", "1,234.50" and "1234.5" are all read; a single separator followed by three digits is thousands.
  const digits = trimmed.replace(/[€\s%]/g, '');
  if (!/^-?\d[\d.,]*$/.test(digits)) return undefined;
  const lastSeparator = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'));
  const decimals = lastSeparator < 0 ? 0 : digits.length - lastSeparator - 1;
  const separators = digits.replace(/[^.,]/g, '').length;
  const hasDecimals = lastSeparator >= 0 && decimals !== 3 && decimals <= 2;
  const grouped = lastSeparator >= 0 && !hasDecimals && (decimals === 3 || separators > 1);
  if (lastSeparator >= 0 && !hasDecimals && !grouped) return undefined;
  const whole = hasDecimals ? digits.slice(0, lastSeparator) : digits;
  const number = Number(`${whole.replace(/[.,]/g, '')}${hasDecimals ? `.${digits.slice(lastSeparator + 1)}` : ''}`);
  if (!Number.isFinite(number)) return undefined;
  if (kind.type === 'money') return kind.storedAs === 'cents' ? Math.round(number * 100) : number;
  return kind.type === 'percent' ? Math.round(number * 100) / 10_000 : number;
}

const euroText = (eur: number) => `€${eur.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;

/** An answer in words, for a list of what is known and for the candidates of a conflict. */
export function describeAnswer(id: QuestionId, value: unknown, day: string): string {
  const { kind } = questionById(id);
  if (value === null || value === undefined) return 'I don’t know';
  switch (kind.type) {
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'date':
      // A stored age instead of a date of birth is shown as what it is.
      return typeof value === 'number'
        ? `Age ${value}, as stated`
        : `Born ${String(value)}: ${ageOn(String(value), day)} on ${day}`;
    case 'money':
      return typeof value === 'number' ? euroText(kind.storedAs === 'cents' ? value / 100 : value) : String(value);
    case 'number':
      return `${String(value)} ${kind.unit}`;
    case 'percent':
      return typeof value === 'number' ? `${Math.round(value * 10_000) / 100}%` : String(value);
    case 'choice':
      return kind.options.find(option => option.value === value)?.label ?? String(value);
    case 'children': {
      if (!Array.isArray(value)) return String(value);
      if (!value.length) return 'No children';
      return (value as ChildFacts[])
        .map((child, index) => describeChild(child, index, day).replace(/^Child \d+ \((.*)\)$/, '$1'))
        .join('; ');
    }
    case 'per_child':
      if (!Array.isArray(value)) return String(value);
      // A stored list of children carries the flag on each child.
      return (value as unknown[])
        .map(entry => (entry !== null && typeof entry === 'object' ? (entry as ChildFacts)[kind.flag] : entry))
        .map(flag => (flag === true ? 'yes' : flag === false ? 'no' : 'not known'))
        .join(', ');
  }
}

// ------------------------------------------------- storing and trying

type InputData = Record<string, Record<string, unknown>>;

/** The children of a person as input records, with the flags of one schooling answer written in. */
function childrenWithFlags(
  children: ChildFacts[],
  asked: number[],
  flag: 'inDesignatedSchool' | 'meetsItpSchooling',
  answers: (boolean | null)[] | null,
) {
  return children.map((child, index) => {
    const position = asked.indexOf(index);
    return position < 0 ? child : { ...child, [flag]: answers === null ? null : (answers[position] ?? null) };
  });
}

/**
 * The input record for one answer: the `data` of `save_my_inputs`. `null` is written as an explicit
 * unknown. A schooling answer rewrites the list of children, because the flags live on each child;
 * it needs the person the answer is about and the plan date that decided which children were asked.
 */
export function answerToInput(
  id: QuestionId,
  value: AnswerValue | null,
  about?: { person: Person; day: string },
): InputData {
  const question = questionById(id);
  const [group, field] = [question.path.slice(0, question.path.indexOf('.')), fieldOf(question)];
  if (question.kind.type !== 'per_child') return { [group]: { [field]: value } };
  if (!about) throw new Error('A schooling answer needs the person it is about.');
  const children = childrenOf(about.person) ?? [];
  const asked = schoolAgeChildren(about.person, about.day);
  return {
    [group]: { [field]: childrenWithFlags(children, asked, question.kind.flag, value as (boolean | null)[] | null) },
  };
}

/** The summary basis once one monthly figure is typed in: declared, or mixed next to a bank figure. */
function declared(person: Person): Pick<Person['finances'], 'basis'> {
  const { basis } = person.finances;
  return { basis: basis === 'unknown' || basis === 'declared' ? 'declared' : 'mixed' };
}

/**
 * The same person with one answer applied, for an estimate that stores nothing. The answer is placed
 * where the planner reads it; no age is computed and no amount is derived here. "I don't know"
 * leaves the fact unknown and records that it was asked.
 */
export function applyAnswer(
  person: Person,
  id: QuestionId,
  value: AnswerValue | null,
  when: { day: string; observedAt?: string },
): Person {
  const question = questionById(id);
  const answers: Person['answers'] = {
    ...person.answers,
    [id]: {
      // A schooling answer that is unknown for one child leaves the question open for that child.
      status: value === null || (Array.isArray(value) && value.some(item => item === null)) ? 'said_unknown' : 'known',
      source: 'what_if',
      observedAt: when.observedAt ?? when.day,
    },
  };
  const next: Person = { ...person, answers };
  const household = { ...person.household } as Record<string, unknown>;
  const withHousehold = (): Person => ({ ...next, household: household as Person['household'] });
  const field = fieldOf(question);
  if (question.kind.type === 'per_child') {
    const flag = question.kind.flag;
    const asked = schoolAgeChildren(person, when.day);
    // A flag that is not known is left off: the screening then keeps the measure unverified.
    const write = (children: ChildFacts[]) =>
      childrenWithFlags(children, asked, flag, value as (boolean | null)[] | null).map(child => {
        const { [flag]: answer, ...rest } = child;
        return answer === null || answer === undefined ? rest : { ...rest, [flag]: answer };
      });
    if (person.born?.children)
      return { ...next, born: { ...person.born, children: write(person.born.children) as never } };
    household.children = write(person.household?.children ?? []);
    return withHousehold();
  }
  if (value === null) {
    // Asked and not known: any earlier value of the same fact no longer stands.
    if (id === 'birthDate') {
      delete household.age;
      return { ...withHousehold(), born: person.born ? { ...person.born, self: undefined } : undefined };
    }
    if (question.path.startsWith('eligibility.')) {
      delete household[field];
      return withHousehold();
    }
    return id === 'homeBudget' ? { ...next, home: { ...person.home, budgetCents: null } } : next;
  }
  switch (id) {
    case 'monthlyIncome':
      return {
        ...next,
        finances: {
          ...person.finances,
          ...declared(person),
          monthlyIncomeCents: value as number,
          incomeBasis: 'declared',
        },
      };
    case 'monthlyExpenses':
      return {
        ...next,
        finances: {
          ...person.finances,
          ...declared(person),
          monthlyExpensesCents: value as number,
          expensesBasis: 'declared',
        },
      };
    case 'purchaseSavings':
      return { ...next, finances: { ...person.finances, currentSavingsCents: value as number } };
    case 'emergencyReserve':
      return { ...next, finances: { ...person.finances, emergencyReserveCents: value as number } };
    case 'homeBudget':
      return { ...next, home: { ...person.home, budgetCents: value as number } };
    case 'floorArea':
      return { ...next, home: { ...person.home, floorAreaM2: value as number } };
    case 'depositRate':
      return { ...next, home: { ...person.home, depositRate: value as number } };
    case 'birthDate':
      // The date replaces a stated age: the planner derives the age from it.
      delete household.age;
      return { ...withHousehold(), born: { ...person.born, self: value as string } };
    case 'children':
      delete household.children;
      return {
        ...withHousehold(),
        born: { ...person.born, children: (value as ChildAnswer[]).map(child => ({ birthDate: child.birthDate })) },
      };
    default:
      household[field] = value;
      return withHousehold();
  }
}

/** A person nobody has said anything about: the starting point of an anonymous estimate. */
export function blankPerson(id = 'what-if'): Person {
  return {
    id,
    displayName: 'What-if estimate',
    synthetic: false,
    householdSize: null,
    currentMunicipalityCode: null,
    finances: {
      monthlyIncomeCents: null,
      monthlyExpensesCents: null,
      currentSavingsCents: null,
      emergencyReserveCents: 0,
      basis: 'unknown',
      asOf: null,
    },
    home: { floorAreaM2: null, budgetCents: null, depositRate: 0.2 },
    habits: [],
  };
}

// ------------------------------------------------------- asking in order

/**
 * The next questions to ask when no plan can rank them (the interviewer has no places to compare):
 * the set in its own order, without what is already answered and without what cannot apply given
 * the answers so far (`appliesTo`). With places, ask in the order of the plan's `nextQuestions`.
 */
export function unansweredInOrder(answers: Answers, day: string, skip: readonly QuestionId[] = []): Question[] {
  let person = blankPerson();
  for (const id of questionIds) {
    const value = answers[id];
    if (value === undefined) continue;
    // A schooling answer is applied after the children it is about.
    if (questionById(id).kind.type !== 'per_child') person = applyAnswer(person, id, value, { day });
  }
  for (const id of ['childrenItpSchooling', 'childrenIrpfSchooling'] as const) {
    const value = answers[id];
    if (value !== undefined && schoolAgeChildren(person, day).length) person = applyAnswer(person, id, value, { day });
  }
  return questions.filter(
    question =>
      !skip.includes(question.id) && answers[question.id] === undefined && appliesTo(person, question.id, day),
  );
}

/** The person an anonymous set of answers describes, for a what-if plan. Nothing is stored. */
export function personFromAnswers(answers: Answers, day: string, base: Person = blankPerson()): Person {
  let person = base;
  const later: QuestionId[] = [];
  for (const id of questionIds) {
    const value = answers[id];
    if (value === undefined) continue;
    if (questionById(id).kind.type === 'per_child') later.push(id);
    else person = applyAnswer(person, id, value, { day });
  }
  for (const id of later) {
    const value = answers[id] as AnswerValue | null;
    if (schoolAgeChildren(person, day).length) person = applyAnswer(person, id, value, { day });
  }
  return person;
}

/**
 * Every answer of a set as one input record (`data` of `save_my_inputs`). "I don't know" is written
 * as `null`, and so is a schooling answer that is not known for one child. The children carry their
 * schooling flags, so the list is written once, with both answers in it.
 */
export function answersToInput(answers: Answers, day: string): InputData {
  const data: InputData = {};
  const person = personFromAnswers(answers, day);
  for (const id of questionIds) {
    const value = answers[id];
    if (value === undefined || questionById(id).kind.type === 'per_child') continue;
    for (const [group, fields] of Object.entries(answerToInput(id, value))) data[group] = { ...data[group], ...fields };
  }
  const children = answers.children;
  if (Array.isArray(children) && children.length) {
    let listed: ChildFacts[] = (children as ChildAnswer[]).map(child => ({ birthDate: child.birthDate }));
    const asked = schoolAgeChildren(person, day);
    for (const id of ['childrenItpSchooling', 'childrenIrpfSchooling'] as const) {
      const value = answers[id];
      const kind = questionById(id).kind;
      if (value === undefined || kind.type !== 'per_child' || !asked.length) continue;
      listed = childrenWithFlags(listed, asked, kind.flag, value as (boolean | null)[] | null);
    }
    data.eligibility = { ...data.eligibility, children: listed };
  }
  return data;
}
