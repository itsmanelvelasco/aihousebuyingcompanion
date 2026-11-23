import type { Policy } from '../contracts/places.ts';
import type { AnswerSpec, FactAnswer, Person } from '../contracts/planner.ts';
import { defaultLocale, type Locale } from '../i18n/locales.ts';
import { type MessageValues, translator } from '../i18n/messages.ts';
import { wording } from '../places/wording.ts';
import { answerMessages, questionMessages } from './questions.messages.ts';

/**
 * The one question set of ReloCat: every fact that decides a person's plan, defined once.
 *
 * The workspace, the interviewer (guided and voice) and the chat all ask from this list, validate
 * with `validateAnswer`, store with `answerToInput` and try a what-if with `applyAnswer`. Nothing
 * here does money maths or screens a rule: which question is worth asking for the places compared
 * is the planner's job (`missingFacts` in `packages/planner/next-questions.ts`). This module is
 * plain data and pure functions; its only runtime imports are the message catalogs and the pure
 * formatters of `packages/i18n`, so a browser bundle can include it.
 *
 * The words of a question depend on the language (`questionsIn`, `questionById(id, locale)`); its
 * id, input path, answer kind and the measures it decides do not. English is the default everywhere.
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

/**
 * A question without its words: what it decides, where it is stored and how it is answered. The
 * words are in `questions.messages.ts`, one set per language, under `<id>.label`, `.question`,
 * `.why` and `.help`.
 *
 * Where the tax base is on the return (`help.taxBase`): the Agència Tributària's "Manual práctico
 * de Renta 2025. Deducciones autonómicas", Catalonia, states the limit of a Catalan deduction that
 * uses this same figure as "la suma de las bases imponibles general y del ahorro menos el mínimo
 * personal y familiar", computed as "suma de las casillas [0435] y [0460] menos el importe de la
 * casilla [0520] de la declaración". Read on 2026-11-22 at
 * https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/irpf-2025-deducciones-autonomicas/comunidad-autonoma-cataluna/alquiler-vivienda-habitual.html
 * The box numbers are those of the 2025 return (form 100) and are stated as such: they can change.
 */
type Shape = Omit<Question, 'label' | 'question' | 'why' | 'help' | 'sensitivity' | 'kind'> & {
  /** `own`: the question's own help text; `taxBase` and `schooling`: a help text several questions share. */
  help?: 'own' | 'taxBase' | 'schooling';
  /** Which note is said before a sensitive question. */
  sensitivity?: 'family' | 'health' | 'tax';
  kind: Exclude<Kind, { type: 'choice' }> | { type: 'choice'; options: string[] };
};
const euros = { type: 'money', storedAs: 'cents', min: 0, max: 50_000_000 } as const;
const taxBase = { type: 'money', storedAs: 'eur', min: -1_000_000, max: 10_000_000 } as const;
const generalRates: PolicyId[] = ['itp_young_buyer', 'itp_large_family', 'itp_single_parent', 'itp_disability'];

/** The question set without its words, in the order it is asked. */
const shapes: readonly Shape[] = [
  {
    id: 'monthlyIncome',
    group: 'plan',
    path: 'finance.monthlyIncomeCents',
    kind: euros,
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'monthlyExpenses',
    group: 'plan',
    path: 'finance.monthlyExpensesCents',
    kind: euros,
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'purchaseSavings',
    group: 'plan',
    path: 'finance.currentSavingsCents',
    kind: euros,
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'homeBudget',
    group: 'plan',
    path: 'housing.budgetCents',
    help: 'own',
    kind: { type: 'money', storedAs: 'cents', min: 1, max: 50_000_000 },
    allowUnknown: true,
    decides: ['youth_purchase_small_town'],
    goesStale: 'never',
  },
  {
    id: 'floorArea',
    group: 'plan',
    path: 'housing.homeSizeM2',
    kind: { type: 'number', unit: 'm²', min: 10, max: 2000 },
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'primaryResidence',
    group: 'household',
    path: 'eligibility.primaryResidence',
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
    sensitivity: 'family',
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
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_buy', 'itp_rehab_buy', ...generalRates],
    goesStale: 'never',
  },
  {
    id: 'itpOccupancy',
    group: 'household',
    path: 'eligibility.satisfiesItpOccupancyRules',
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_buy', ...generalRates],
    goesStale: 'never',
  },
  {
    id: 'childrenItpSchooling',
    group: 'household',
    path: 'eligibility.children',
    help: 'schooling',
    sensitivity: 'family',
    kind: { type: 'per_child', flag: 'meetsItpSchooling' },
    allowUnknown: true,
    decides: ['itp_buy'],
    goesStale: 'school_year',
  },
  {
    id: 'largeFamily',
    group: 'household',
    path: 'eligibility.largeFamily',
    sensitivity: 'family',
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_large_family'],
    goesStale: 'never',
  },
  {
    id: 'singleParent',
    group: 'household',
    path: 'eligibility.singleParent',
    sensitivity: 'family',
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_single_parent', 'irpf_move'],
    goesStale: 'never',
  },
  {
    id: 'disability65',
    group: 'household',
    path: 'eligibility.disability65',
    sensitivity: 'health',
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['itp_disability'],
    goesStale: 'never',
  },
  {
    id: 'firstRuralMove',
    group: 'household',
    path: 'eligibility.firstRuralMove',
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['irpf_move'],
    goesStale: 'never',
  },
  {
    id: 'childrenIrpfSchooling',
    group: 'household',
    path: 'eligibility.children',
    help: 'schooling',
    sensitivity: 'family',
    kind: { type: 'per_child', flag: 'inDesignatedSchool' },
    allowUnknown: true,
    decides: ['irpf_buy', 'irpf_move', 'irpf_rent'],
    goesStale: 'school_year',
  },
  {
    id: 'ownsHomeInSpain',
    group: 'household',
    path: 'eligibility.ownsHomeInSpain',
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['youth_purchase_small_town'],
    goesStale: 'never',
  },
  {
    id: 'incomeWithinFiveIprem',
    group: 'household',
    path: 'eligibility.incomeWithinFiveIprem',
    help: 'own',
    kind: { type: 'boolean' },
    allowUnknown: true,
    decides: ['youth_purchase_small_town'],
    goesStale: 'tax_year',
  },
  {
    id: 'filing',
    group: 'tax',
    path: 'eligibility.filing',
    kind: {
      type: 'choice',
      options: ['individual', 'joint'],
    },
    allowUnknown: true,
    decides: ['irpf_move', 'irpf_rent'],
    goesStale: 'tax_year',
  },
  {
    id: 'itpBuyerNetTaxBase',
    group: 'tax',
    path: 'eligibility.itpBuyerNetTaxBaseEur',
    help: 'taxBase',
    sensitivity: 'tax',
    kind: taxBase,
    allowUnknown: true,
    decides: ['itp_young_buyer', 'itp_rehab_buy'],
    goesStale: 'tax_year',
  },
  {
    id: 'itpFamilyNetTaxBase',
    group: 'tax',
    path: 'eligibility.itpFamilyNetTaxBaseEur',
    help: 'own',
    sensitivity: 'tax',
    kind: taxBase,
    allowUnknown: true,
    decides: ['itp_buy', 'itp_large_family', 'itp_single_parent', 'itp_disability'],
    goesStale: 'tax_year',
  },
  {
    id: 'irpfNetTaxBase',
    group: 'tax',
    path: 'eligibility.irpfNetTaxBaseEur',
    help: 'own',
    sensitivity: 'tax',
    kind: taxBase,
    allowUnknown: true,
    decides: ['irpf_move', 'irpf_rent'],
    goesStale: 'tax_year',
  },
  {
    id: 'irpfIndividualNetTaxBase',
    group: 'tax',
    path: 'eligibility.irpfIndividualNetTaxBaseEur',
    help: 'taxBase',
    sensitivity: 'tax',
    kind: taxBase,
    allowUnknown: true,
    decides: ['irpf_buy', 'irpf_renovate'],
    goesStale: 'tax_year',
  },
  {
    id: 'depositRate',
    group: 'plan',
    path: 'housing.depositRate',
    kind: { type: 'percent', min: 0, max: 100 },
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
  {
    id: 'emergencyReserve',
    group: 'plan',
    path: 'finance.emergencyReserveCents',
    kind: euros,
    allowUnknown: false,
    decides: [],
    goesStale: 'never',
  },
];

type QuestionMessage = keyof (typeof questionMessages)['en'];
type AnswerMessage = keyof (typeof answerMessages)['en'];
const say = (locale: Locale) =>
  translator(answerMessages, locale) as (key: AnswerMessage, values?: MessageValues) => string;

function worded(shape: Shape, locale: Locale): Question {
  const t = translator(questionMessages, locale);
  const text = (part: string, values?: MessageValues) => t(`${shape.id}.${part}` as QuestionMessage, values);
  const { id, group, path, help, sensitivity, kind, ...rest } = shape;
  return {
    id,
    group,
    path,
    label: text('label'),
    question: text('question'),
    why: text('why'),
    help: help === undefined ? null : help === 'own' ? text('help', { taxBase: t('help.taxBase') }) : t(`help.${help}`),
    sensitivity: sensitivity === undefined ? null : t(`sensitivity.${sensitivity}`),
    kind:
      kind.type === 'choice'
        ? { type: 'choice', options: kind.options.map(value => ({ value, label: text(`option.${value}`) })) }
        : kind,
    ...rest,
  };
}

const worlds = new Map<Locale, { list: readonly Question[]; byId: Map<QuestionId, Question> }>();
function inLocale(locale: Locale) {
  let world = worlds.get(locale);
  if (!world) {
    const list = shapes.map(shape => worded(shape, locale));
    world = { list, byId: new Map(list.map(question => [question.id, question])) };
    worlds.set(locale, world);
  }
  return world;
}

/** The question set in one language, in the order it is asked when nothing ranks one question above another. */
export const questionsIn = (locale: Locale = defaultLocale): readonly Question[] => inLocale(locale).list;

/** The question set in English: the same objects as `questionsIn('en')`. */
export const questions: readonly Question[] = questionsIn(defaultLocale);

export const isQuestionId = (value: string): value is QuestionId =>
  inLocale(defaultLocale).byId.has(value as QuestionId);

/** One question, worded in `locale`. Everything but the words is the same in every language. */
export function questionById(id: QuestionId, locale: Locale = defaultLocale): Question {
  const question = inLocale(locale).byId.get(id);
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

/** A child in words: with its position ("Child 2 (born 2015-05-05, aged 11)") or, for a list, without it. */
function describeChild(child: ChildFacts, index: number, day: string, locale: Locale, numbered = true) {
  const t = say(locale);
  const age = childAgeOn(child, day);
  const number = index + 1;
  if (age === null) return numbered ? t('childAgeUnknown', { number }) : t('ageUnknown');
  if (child.birthDate) {
    const born = wording(locale).date(child.birthDate);
    return numbered ? t('childBornOn', { number, born, age }) : t('bornOn', { born, age });
  }
  if (child.birthYear)
    return numbered
      ? t('childBornIn', { number, year: child.birthYear, age })
      : t('bornIn', { year: child.birthYear, age });
  return numbered ? t('childAged', { number, age }) : t('aged', { age });
}

/**
 * How a question is answered for this person today: the shape every surface renders its control
 * from. The labels of the options and of the children are in the language of `locale`.
 */
export function answerSpecFor(
  question: Question,
  person: Person | null,
  day: string,
  locale: Locale = defaultLocale,
): AnswerSpec {
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
              label: describeChild((childrenOf(person) ?? [])[index], index, day, locale),
            }))
          : [],
      };
    case 'choice':
      return questionById(question.id, locale).kind as AnswerSpec;
    default:
      return kind;
  }
}

/**
 * Check a typed answer. Returns a message for the person, to show next to the field, or null when
 * the answer is acceptable. `null` (I don't know) is acceptable only where the question allows it.
 * The message is in the language of `locale`; whether an answer is acceptable never depends on it.
 */
export function validateAnswer(
  id: QuestionId,
  value: unknown,
  context: { today: string; childCount?: number },
  locale: Locale = defaultLocale,
): string | null {
  const question = questionById(id);
  const { kind } = question;
  const t = say(locale);
  const write = wording(locale);
  if (value === undefined) return t('giveAnswer');
  if (value === null) return question.allowUnknown ? null : t('needsValue');
  switch (kind.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : t('yesOrNo');
    case 'date':
      if (typeof value !== 'string' || !validDay(value)) return t('fullDate');
      if (value > context.today) return t('dateInFuture');
      if (ageOn(value, context.today) > 120) return t('dateTooOld');
      return null;
    case 'money': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('amountDigits');
      if (kind.storedAs === 'cents' && !Number.isSafeInteger(value)) return t('amountCents');
      const [min, max] = kind.storedAs === 'cents' ? [kind.min * 100, kind.max * 100] : [kind.min, kind.max];
      if (value < min)
        return kind.min === 0
          ? t('amountNegative')
          : t('amountAtLeast', { amount: write.euros(kind.min * 100, `€${kind.min}`) });
      return value > max
        ? t('amountAtMost', { amount: write.euros(kind.max * 100, `€${kind.max.toLocaleString('en-GB')}`) })
        : null;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('numberOf', { unit: kind.unit });
      return value < kind.min || value > kind.max
        ? t('numberBetween', { min: write.number(kind.min), max: write.number(kind.max), unit: kind.unit })
        : null;
    case 'percent':
      // Stored as a share: 20% is 0.2.
      return typeof value === 'number' && value >= kind.min / 100 && value <= kind.max / 100
        ? null
        : t('percentBetween', { min: kind.min, max: kind.max });
    case 'choice':
      return kind.options.some(option => option.value === value) ? null : t('chooseOption');
    case 'children': {
      if (!Array.isArray(value)) return t('listChildren');
      if (value.length > 12) return t('tooManyChildren');
      for (const [index, child] of value.entries()) {
        const birthDate = (child as ChildAnswer | null)?.birthDate;
        const number = index + 1;
        if (typeof birthDate !== 'string' || !validDay(birthDate)) return t('childFullDate', { number });
        if (birthDate > context.today) return t('childDateInFuture', { number });
        if (ageOn(birthDate, context.today) > 120) return t('childDateTooOld', { number });
      }
      return null;
    }
    case 'per_child':
      if (!Array.isArray(value) || value.some(flag => flag !== null && typeof flag !== 'boolean')) return t('perChild');
      return context.childCount !== undefined && value.length !== context.childCount ? t('eachChildListed') : null;
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

/**
 * An answer in words, for a list of what is known and for the candidates of a conflict. English
 * keeps its plain forms (ISO dates, `€1,234.5`); Catalan and Spanish write amounts and dates as
 * the language does.
 */
export function describeAnswer(id: QuestionId, value: unknown, day: string, locale: Locale = defaultLocale): string {
  const { kind } = questionById(id, locale);
  const t = say(locale);
  const write = wording(locale);
  if (value === null || value === undefined) return t('dontKnow');
  switch (kind.type) {
    case 'boolean':
      return value === true ? t('yes') : value === false ? t('no') : String(value);
    case 'date':
      // A stored age instead of a date of birth is shown as what it is.
      return typeof value === 'number'
        ? t('ageAsStated', { age: value })
        : t('bornAgeOn', {
            born: write.date(String(value)),
            age: ageOn(String(value), day),
            day: write.date(day),
          });
    case 'money': {
      if (typeof value !== 'number') return String(value);
      const eur = kind.storedAs === 'cents' ? value / 100 : value;
      return write.euros(Math.round(eur * 100), `€${eur.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`);
    }
    case 'number':
      return `${typeof value === 'number' ? write.number(value) : String(value)} ${kind.unit}`;
    case 'percent':
      return typeof value === 'number' ? write.percent(value) : String(value);
    case 'choice':
      return kind.options.find(option => option.value === value)?.label ?? String(value);
    case 'children': {
      if (!Array.isArray(value)) return String(value);
      if (!value.length) return t('noChildren');
      return (value as ChildFacts[]).map((child, index) => describeChild(child, index, day, locale, false)).join('; ');
    }
    case 'per_child':
      if (!Array.isArray(value)) return String(value);
      // A stored list of children carries the flag on each child.
      return (value as unknown[])
        .map(entry => (entry !== null && typeof entry === 'object' ? (entry as ChildFacts)[kind.flag] : entry))
        .map(flag => (flag === true ? t('flagYes') : flag === false ? t('flagNo') : t('flagUnknown')))
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

/**
 * A person nobody has said anything about: the starting point of an anonymous estimate. Its display
 * name is in the language of `locale`; it is never stored.
 */
export function blankPerson(id = 'what-if', locale: Locale = defaultLocale): Person {
  return {
    id,
    displayName: say(locale)('whatIf'),
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
