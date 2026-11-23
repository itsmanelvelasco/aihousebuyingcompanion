import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { nextQuestionsResult, registerPlannerTools } from '../apps/mcp-server/planner-tools.ts';
import { createToolClient, httpCallTool } from '../apps/web/client.ts';
import { conflictSources, planChanges } from '../apps/web/view-model.ts';
import type { AppInput } from '../packages/contracts/inputs.ts';
import { inputSchema, resolveInputs } from '../packages/contracts/inputs.ts';
import type { NextQuestion, Person, PlacePlan, PlanResult } from '../packages/contracts/planner.ts';
import { planResult } from '../packages/contracts/planner.ts';
import { buildPerson } from '../packages/model/person.ts';
import { buildPlace } from '../packages/model/place.ts';
import type { Answers, AnswerValue, QuestionId } from '../packages/model/questions.ts';
import {
  ageOn,
  answersToInput,
  answerToInput,
  appliesTo,
  applyAnswer,
  blankPerson,
  childAgeOn,
  parseTyped,
  personFromAnswers,
  questionById,
  questionIds,
  questions,
  unansweredInOrder,
  validateAnswer,
} from '../packages/model/questions.ts';
import { loadData } from '../packages/places/data.ts';
import { missingFacts } from '../packages/planner/next-questions.ts';
import { planForPlaces } from '../packages/planner/plan.ts';
import { Browser, mcp, startApp } from './support/app.ts';

const asOf = '2026-11-22';
const talarn = '252154'; // rural: the reduced transfer tax of a rural municipality can apply
const balaguer = '250404'; // not rural, more than 10,000 residents
const { snapshot, policies } = loadData();
const place = (code: string) => buildPlace(snapshot, code);
const both = [place(talarn), place(balaguer)];

const plan = (person: Person, places = both, day = asOf) => planForPlaces(person, places, policies, undefined, day);
const of = (result: PlanResult, code: string) => {
  const found = result.plans.find(item => item.place.municipalityCode === code);
  assert(found, `no plan for ${code}`);
  return found;
};
const benefit = (item: PlacePlan, id: string) => {
  const found = item.benefits.find(entry => entry.policyId === id);
  assert(found, `no benefit ${id}`);
  return found;
};
const ids = (list: NextQuestion[] | undefined) => (list ?? []).map(question => question.id);
const asked = (result: PlanResult, id: string) => (result.nextQuestions ?? []).find(question => question.id === id);

/** Someone with the figures a timeline needs and nothing else: 22 months in Talarn, 18 in Balaguer. */
const basics: Answers = { monthlyIncome: 320_000, monthlyExpenses: 230_000, purchaseSavings: 1_000_000, floorArea: 90 };
/** Every fact the rural reduced transfer tax needs, all favourable. */
const ruralRate: Answers = {
  primaryResidence: true,
  children: [{ birthDate: '2019-04-02' }],
  itpTransaction: true,
  itpOccupancy: true,
  childrenItpSchooling: [true],
  itpFamilyNetTaxBase: 28_000,
};
/** Every question of the set answered, in favour of every measure the set can decide. */
const everything: Answers = {
  ...basics,
  ...ruralRate,
  birthDate: '1996-01-10',
  largeFamily: true,
  singleParent: true,
  disability65: true,
  firstRuralMove: true,
  childrenIrpfSchooling: [true],
  ownsHomeInSpain: false,
  incomeWithinFiveIprem: true,
  filing: 'individual',
  itpBuyerNetTaxBase: 20_000,
  irpfNetTaxBase: 20_000,
  irpfIndividualNetTaxBase: 20_000,
  depositRate: 0.2,
  emergencyReserve: 0,
};
const who = (answers: Answers) => personFromAnswers(answers, asOf);

// ------------------------------------------------------------ the set

test('every question saves to a field of the input contract, and “I don’t know” is an explicit null', () => {
  assert.equal(new Set(questionIds).size, questions.length);
  assert.deepEqual(
    questions.map(question => question.id),
    [...questionIds],
  );
  const person = who(everything);
  const record = (data: AppInput['data']) =>
    inputSchema.parse({
      id: 'check',
      source: 'manual',
      observedAt: '2026-11-22T10:00:00Z',
      confirmed: true,
      synthetic: false,
      data,
    });
  for (const question of questions) {
    const value = (question.id === 'homeBudget' ? 15_000_000 : everything[question.id]) as AnswerValue;
    assert.notEqual(value, undefined, `${question.id} has a sample answer`);
    assert.equal(validateAnswer(question.id, value, { today: asOf, childCount: 1 }), null, question.id);
    const stored = record(answerToInput(question.id, value, { person, day: asOf }) as AppInput['data']);
    const [group, field] = question.path.split('.');
    assert.notEqual((stored.data as Record<string, Record<string, unknown>>)[group]?.[field], undefined, question.path);
    // Every question carries the words a person needs: what is asked and why.
    assert(question.question.length > 15 && question.why.length > 20, question.id);
    if (!question.allowUnknown) {
      assert.match(validateAnswer(question.id, null, { today: asOf }) ?? '', /cannot use/);
      continue;
    }
    const unknown = record(answerToInput(question.id, null, { person, day: asOf }) as AppInput['data']);
    const saved = (unknown.data as Record<string, Record<string, unknown>>)[group][field];
    if (question.kind.type === 'per_child')
      assert.deepEqual(
        (saved as Record<string, unknown>[]).map(child => child[(question.kind as { flag: string }).flag]),
        [null],
      );
    else assert.equal(saved, null, `${question.id} stores null, never zero`);
  }
  // Sensitive facts say why they are asked and where they are kept; tax bases say where the figure is.
  for (const id of ['disability65', 'largeFamily', 'singleParent', 'itpBuyerNetTaxBase', 'children'] as const)
    assert.match(questionById(id).sensitivity ?? '', /stored only if you are signed in/);
  for (const id of [
    'itpBuyerNetTaxBase',
    'itpFamilyNetTaxBase',
    'irpfNetTaxBase',
    'irpfIndividualNetTaxBase',
  ] as const) {
    const question = questionById(id);
    assert.match(question.help ?? '', /not your salary/);
    assert.match(question.help ?? '', /box 0435 plus box 0460 minus box 0520/);
    assert.match(question.help ?? '', /I don’t know/);
    assert.equal(question.allowUnknown, true);
  }
});

test('answers are validated with messages a person can act on', () => {
  const check = (id: QuestionId, value: unknown, childCount?: number) =>
    validateAnswer(id, value, { today: asOf, ...(childCount === undefined ? {} : { childCount }) });
  assert.equal(check('birthDate', '1994-03-02'), null);
  assert.match(check('birthDate', '2030-01-01') ?? '', /future/);
  assert.match(check('birthDate', '1994-02-30') ?? '', /full date/);
  assert.match(check('birthDate', '1850-01-01') ?? '', /120 years/);
  assert.match(check('birthDate', null) ?? '', /needs a value/);
  assert.equal(check('children', []), null);
  assert.match(check('children', [{ birthDate: 'soon' }]) ?? '', /child 1/);
  assert.match(check('monthlyIncome', -100) ?? '', /negative/);
  assert.equal(check('emergencyReserve', 0), null, 'a reserve of zero is an answer');
  assert.match(check('homeBudget', 0) ?? '', /at least/);
  assert.equal(check('itpBuyerNetTaxBase', null), null);
  assert.equal(check('itpBuyerNetTaxBase', 0), null, 'a tax base of zero is a real figure when the person states it');
  assert.match(check('depositRate', 20) ?? '', /percentage/);
  assert.equal(check('depositRate', 0.2), null);
  assert.match(check('filing', 'married') ?? '', /options/);
  assert.match(check('childrenItpSchooling', [true], 2) ?? '', /each child/);
  assert.equal(check('childrenItpSchooling', [true, null], 2), null);
  assert.match(check('primaryResidence', 'yes') ?? '', /yes or no/);
  // Typed text becomes the stored unit: cents for the plan's money, euros for a tax base, a share for a percentage.
  assert.equal(parseTyped('monthlyIncome', '3.200'), 320_000);
  assert.equal(parseTyped('monthlyIncome', '3200,50'), 320_050);
  assert.equal(parseTyped('monthlyIncome', '1,234.5 €'), 123_450);
  assert.equal(parseTyped('itpBuyerNetTaxBase', '28000'), 28_000);
  assert.equal(parseTyped('depositRate', '20%'), 0.2);
  assert.equal(parseTyped('floorArea', '85'), 85);
  assert.equal(parseTyped('monthlyIncome', 'about three thousand'), undefined);
  assert.equal(parseTyped('monthlyIncome', ''), undefined);
});

test('an age is derived from the date of birth on the day it is needed, never stored', () => {
  assert.equal(ageOn('1990-11-22', '2026-11-22'), 36);
  assert.equal(ageOn('1990-11-23', '2026-11-22'), 35);
  assert.equal(ageOn('1992-02-29', '2027-02-28'), 34);
  assert.equal(ageOn('1992-02-29', '2027-03-01'), 35);
  assert.equal(childAgeOn({ birthDate: '2019-04-02' }, asOf), 7);
  // A birth year alone leaves the birthday open: the age reached during the plan year, the cautious reading.
  assert.equal(childAgeOn({ birthYear: 2010 }, asOf), 16);
  assert.equal(childAgeOn({ age: 5 }, asOf), 5);

  const person = who({ ...basics, birthDate: '1990-11-23', children: [{ birthDate: '2019-04-02' }] });
  assert.equal(person.household?.age, undefined, 'the what-if person carries the date, not an age');
  const today = plan(person);
  assert.deepEqual([today.person.household?.age, today.person.household?.children], [35, [{ age: 7 }]]);
  // The same stored person a year later is a year older, with nothing saved in between.
  const later = plan(person, both, '2027-11-23');
  assert.deepEqual([later.person.household?.age, later.person.household?.children?.[0].age], [37, 8]);
  // An inline person can still state a plain age, and a date of birth wins over one.
  const stated = plan({ ...who(basics), household: { age: 41 } });
  assert.equal(stated.person.household?.age, 41);
  const bothGiven = plan({ ...who(basics), household: { age: 20 }, born: { self: '1980-01-01' } });
  assert.equal(bothGiven.person.household?.age, 46);

  // With a date of birth the age on the day of the purchase is exact: 35 today, 36 by the time the cash is there.
  const young = who({
    ...basics,
    primaryResidence: true,
    itpTransaction: true,
    itpOccupancy: true,
    itpBuyerNetTaxBase: 20_000,
  });
  const turning = plan({ ...young, born: { self: '1990-12-15' } }, [place(balaguer)]);
  const rate = benefit(of(turning, balaguer), 'itp_young_buyer');
  assert.equal(rate.eligibilityStatus, 'ineligible');
  assert.match(rate.explanation, /By then you would be 3[67]\./);
  assert.doesNotMatch(rate.explanation, / or 3\d/);
  // A stated age cannot say when the birthday is, so the same limit is left unverified.
  const vague = plan({ ...young, household: { ...young.household, age: 35 } }, [place(balaguer)]);
  assert.notEqual(benefit(of(vague, balaguer), 'itp_young_buyer').eligibilityStatus, 'eligible');
});

// ---------------------------------------------------------- applicability

test('a question is asked only when it can apply to the person', () => {
  const empty = blankPerson();
  // Schooling is not asked without children, nor when every child is older than 16.
  assert.equal(appliesTo(empty, 'childrenItpSchooling', asOf), false);
  assert.equal(appliesTo(who({ children: [] }), 'childrenItpSchooling', asOf), false);
  assert.equal(appliesTo(who({ children: [{ birthDate: '2005-01-01' }] }), 'childrenIrpfSchooling', asOf), false);
  assert.equal(appliesTo(who({ children: [{ birthDate: '2019-04-02' }] }), 'childrenItpSchooling', asOf), true);
  // The floor area prices the home only when there is no budget.
  assert.equal(appliesTo(who({ homeBudget: 15_000_000 }), 'floorArea', asOf), false);
  assert.equal(appliesTo(empty, 'floorArea', asOf), true);

  // Without a plan to rank them, the set is asked in its own order, skipping what cannot apply.
  const order = (answers: Answers) => unansweredInOrder(answers, asOf).map(question => question.id);
  assert.deepEqual(order({}).slice(0, 6), [
    'monthlyIncome',
    'monthlyExpenses',
    'purchaseSavings',
    'homeBudget',
    'floorArea',
    'primaryResidence',
  ]);
  assert(!order({}).includes('childrenItpSchooling'));
  assert(!order({ homeBudget: 15_000_000 }).includes('floorArea'));
  assert(order({ homeBudget: null }).includes('floorArea'), 'not knowing a budget leads to the size question');
  assert(!order({ children: [] }).includes('childrenIrpfSchooling'));
  const withChild = order({ children: [{ birthDate: '2019-04-02' }] });
  assert(withChild.includes('childrenItpSchooling') && withChild.includes('childrenIrpfSchooling'));
  assert(!withChild.includes('children'), 'an answered question is not asked again');
  assert(!order({ itpBuyerNetTaxBase: null }).includes('itpBuyerNetTaxBase'), '“I don’t know” is an answer');
  assert.deepEqual(order(everything), ['homeBudget']);
});

test('what is asked depends on the places compared: a rural tax base is not asked for a city', () => {
  const person = who(basics);
  const city = plan(person, [place(balaguer)]);
  const rural = plan(person, [place(talarn)]);
  // In Balaguer only the rates that apply anywhere in Catalonia can change the plan.
  for (const id of ['children', 'childrenItpSchooling', 'firstRuralMove', 'filing', 'irpfNetTaxBase'])
    assert.equal(asked(city, id), undefined, `${id} is not asked for a city`);
  assert(asked(city, 'birthDate') && asked(city, 'itpBuyerNetTaxBase') && asked(city, 'largeFamily'));
  // In a rural municipality the children decide the 4% rate, so they are asked, and first.
  assert.deepEqual(asked(rural, 'children')?.effect.policyIds.includes('itp_buy'), true);
  assert(asked(rural, 'firstRuralMove') && asked(rural, 'irpfNetTaxBase'));
  // A fact that only serves a measure this plan can never count is never asked.
  for (const result of [city, rural]) {
    assert.equal(asked(result, 'irpfIndividualNetTaxBase'), undefined, 'the deduction arrives after the purchase');
    assert.equal(asked(result, 'ownsHomeInSpain'), undefined, 'the aid has no call, so it is never counted');
    assert.equal(asked(result, 'incomeWithinFiveIprem'), undefined);
  }
  // With the child's schooling still open, the child's own question appears once there is a child of that age.
  const parent = plan(who({ ...basics, children: [{ birthDate: '2019-04-02' }] }), [place(talarn)]);
  const schooling = asked(parent, 'childrenItpSchooling');
  assert.deepEqual(schooling?.answer, {
    type: 'per_child',
    children: [{ index: 0, label: 'Child 1 (born 2019-04-02, aged 7)' }],
  });
  assert.equal(asked(parent, 'children'), undefined);
  const noChildren = plan(who({ ...basics, children: [] }), [place(talarn)]);
  assert.equal(asked(noChildren, 'childrenItpSchooling'), undefined);
  assert.equal(asked(noChildren, 'itpFamilyNetTaxBase')?.effect.policyIds.includes('itp_buy'), false);
});

// ----------------------------------------------------------------- ranking

test('missing figures come first, then facts by what they could change, then the plan’s defaults', () => {
  const nothing = plan(blankPerson());
  assert.deepEqual(ids(nothing.nextQuestions), [
    'monthlyIncome',
    'monthlyExpenses',
    'purchaseSavings',
    'homeBudget',
    'floorArea',
    'depositRate',
    'emergencyReserve',
  ]);
  assert(nothing.nextQuestions?.slice(0, 5).every(question => question.effect.kind === 'required'));
  assert.deepEqual(nothing.knownFacts, []);

  const start = plan(who(basics));
  const list = start.nextQuestions ?? [];
  assert.deepEqual([of(start, talarn).baseline?.months, of(start, talarn).withPlaceBenefits?.months], [22, 22]);
  // The most valuable question first: the facts of the 4% rural rate, worth 6 months in Talarn.
  assert.deepEqual(
    list.slice(0, 5).map(question => [question.id, question.effect.months, question.effect.placeName]),
    [
      ['primaryResidence', 6, 'Talarn'],
      ['children', 6, 'Talarn'],
      ['itpTransaction', 6, 'Talarn'],
      ['itpOccupancy', 6, 'Talarn'],
      ['itpFamilyNetTaxBase', 6, 'Talarn'],
    ],
  );
  assert.match(
    list[0].effect.text,
    /^Could shorten the wait by up to 6 months in Talarn and lower the upfront cash by up to €5,472/,
  );
  assert.match(list[0].effect.text, /It also depends on: children, purchase subject to transfer tax/);
  // Never ascending: months at stake, then cash, among the facts that decide a measure.
  const deciding = list.filter(question => question.effect.kind === 'benefit');
  for (let index = 1; index < deciding.length; index++)
    assert((deciding[index - 1].effect.months ?? 0) >= (deciding[index].effect.months ?? 0), deciding[index].id);
  // The 5% rates that apply anywhere are worth 5 months here, the moving deduction 2.
  assert.deepEqual(
    ['birthDate', 'largeFamily', 'disability65', 'firstRuralMove'].map(id => asked(start, id)?.effect.months),
    [5, 5, 5, 2],
  );
  assert.deepEqual(asked(start, 'firstRuralMove')?.effect.policyIds, ['irpf_move']);
  // The defaults the plan is assuming come last.
  assert.deepEqual(ids(list).slice(-2), ['depositRate', 'emergencyReserve']);
  assert(list.slice(-2).every(question => question.effect.kind === 'assumption'));
  // The public function returns the same list.
  assert.deepEqual(missingFacts(who(basics), both, policies, asOf), list);
  // The assumed answers never reach the plan itself.
  assert.equal(start.person.household, undefined);
  assert(of(start, talarn).benefits.every(item => !item.counted));
});

test('answering the facts of a measure moves it from unverified to counted, and the months follow', () => {
  let person = who(basics);
  const steps: [QuestionId, AnswerValue, number][] = [
    ['primaryResidence', true, 22],
    ['children', [{ birthDate: '2019-04-02' }], 22],
    ['itpTransaction', true, 22],
    ['itpOccupancy', true, 22],
    ['childrenItpSchooling', [true], 22],
    ['itpFamilyNetTaxBase', 28_000, 16],
  ];
  for (const [id, value, months] of steps) {
    const before = plan(person);
    assert(asked(before, id), `${id} is asked before it is answered`);
    assert.equal(benefit(of(before, talarn), 'itp_buy').eligibilityStatus, 'needs_verification');
    person = applyAnswer(person, id, value, { day: asOf });
    const after = plan(person);
    assert.equal(asked(after, id), undefined, `${id} is not asked once answered`);
    assert.equal(of(after, talarn).withPlaceBenefits?.months, months);
  }
  const done = plan(person);
  const rate = benefit(of(done, talarn), 'itp_buy');
  assert.deepEqual([rate.eligibilityStatus, rate.counted], ['eligible', true]);
  assert.match(rate.explanation, /Counted: lowers the upfront cash needed by €5,471\.66/);
  assert.deepEqual([of(done, talarn).baseline?.months, of(done, talarn).monthsSavedByPlace], [22, 6]);
  // The plan says which facts it relied on and where each came from.
  const relied = of(done, talarn).assumptions.at(-1) ?? '';
  assert.match(
    relied,
    /^Facts about you this plan relied on: main home: Yes \(this estimate only, not saved, given 2026-11-22\)/,
  );
  assert.match(relied, /your family’s tax bases: €28,000/);
  assert.deepEqual(
    done.knownFacts?.find(fact => fact.id === 'children'),
    {
      id: 'children',
      inputPath: 'eligibility.children',
      label: 'Children',
      value: 'born 2019-04-02, aged 7',
      source: 'what_if',
      observedAt: asOf,
      confirmed: null,
      usedByPlan: true,
      stale: null,
    },
  );
  // What changed, in the planner's own figures, for the workspace to show.
  const before = plan(who({ ...basics, ...ruralRate, itpFamilyNetTaxBase: undefined }));
  assert.deepEqual(planChanges(before, done), [
    {
      place: 'Talarn',
      lines: [
        'Counted now: Reduced ITP on a rural primary-home purchase (TMR / TEA).',
        'The wait is now 1 year 4 months; it was 1 year 10 months.',
      ],
    },
  ]);
  // An unfavourable answer settles it the other way, with the reason.
  const elsewhere = plan(applyAnswer(person, 'primaryResidence', false, { day: asOf }));
  const refused = benefit(of(elsewhere, talarn), 'itp_buy');
  assert.deepEqual([refused.eligibilityStatus, refused.counted], ['ineligible', false]);
  assert.match(refused.explanation, /criteria not met: The property is or will be the habitual residence/);
  assert.equal(of(elsewhere, talarn).withPlaceBenefits?.months, 22);
  assert.equal(ids(elsewhere.nextQuestions).includes('itpBuyerNetTaxBase'), false, 'no rate is left to decide');
});

test('“I don’t know” keeps the benefit unverified, is never zero and is not asked again as new', () => {
  const unsure = plan(who({ ...basics, ...ruralRate, itpFamilyNetTaxBase: null }));
  const rate = benefit(of(unsure, talarn), 'itp_buy');
  assert.deepEqual([rate.eligibilityStatus, rate.counted], ['needs_verification', false]);
  assert.match(rate.explanation, /combined net tax bases/);
  assert.equal(of(unsure, talarn).withPlaceBenefits?.months, 22);
  assert.equal('itpFamilyNetTaxBaseEur' in (unsure.person.household ?? {}), false);
  assert.equal(unsure.person.answers?.itpFamilyNetTaxBase?.status, 'said_unknown');
  // It is still listed, last, so the person sees what it holds back and where to find it.
  const last = unsure.nextQuestions?.at(-1);
  assert.deepEqual([last?.id, last?.state, last?.effect.months], ['itpFamilyNetTaxBase', 'said_unknown', 6]);
  assert.match(last?.help ?? '', /box 0435/);
  assert.equal(
    unsure.knownFacts?.some(fact => fact.id === 'itpFamilyNetTaxBase'),
    false,
  );
  // A tax base of zero is a different statement: the person said zero, and the rate is counted.
  const zero = plan(who({ ...basics, ...ruralRate, itpFamilyNetTaxBase: 0 }));
  assert.equal(benefit(of(zero, talarn), 'itp_buy').counted, true);
  // For one child: the schooling answer is unknown for that child only.
  const child = plan(who({ ...basics, ...ruralRate, childrenItpSchooling: [null] }));
  assert.equal(benefit(of(child, talarn), 'itp_buy').eligibilityStatus, 'needs_verification');
  assert.equal(asked(child, 'childrenItpSchooling')?.state, 'said_unknown');
  assert.deepEqual(answersToInput({ ...ruralRate, childrenItpSchooling: [null] }, asOf).eligibility.children, [
    { birthDate: '2019-04-02', meetsItpSchooling: null },
  ]);
});

test('with every question answered nothing more is asked, and each fact decides what it says it decides', () => {
  const full = plan(who(everything));
  assert.deepEqual(ids(full.nextQuestions), [], 'nothing more can change the plan');
  assert.equal(full.knownFacts?.length, questions.length - 1, 'everything but the budget, which the size replaced');

  // Screened on the plan date: with the cash already there, the purchase day is today.
  const rich = (answers: Answers) => who({ ...answers, purchaseSavings: 100_000_000 });
  const covered = [
    'itp_buy',
    'itp_young_buyer',
    'itp_large_family',
    'itp_single_parent',
    'itp_disability',
    'irpf_move',
  ];
  const status = (answers: Answers) => {
    const item = of(plan(rich(answers), [place(talarn)]), talarn);
    return Object.fromEntries(covered.map(id => [id, benefit(item, id).eligibilityStatus]));
  };
  assert.deepEqual(status(everything), Object.fromEntries(covered.map(id => [id, 'eligible'])));
  // A condition one of two facts can meet (age or a qualifying child), and a fact that only sets the amount.
  const notAlone: Partial<Record<QuestionId, string[]>> = {
    birthDate: ['irpf_move'],
    children: ['irpf_move'],
    childrenIrpfSchooling: ['irpf_move'],
    singleParent: ['irpf_move'],
  };
  for (const question of questions.filter(item => item.path.startsWith('eligibility.'))) {
    const without = status({ ...everything, [question.id]: undefined });
    for (const id of covered) {
      const decides = (question.decides as string[]).includes(id);
      if (notAlone[question.id]?.includes(id)) assert(decides, `${question.id} is read by ${id}`);
      else
        assert.equal(
          without[id] !== 'eligible',
          decides,
          `${question.id} ${decides ? 'decides' : 'does not decide'} ${id}`,
        );
    }
  }
});

// ------------------------------------------------------- stored answers

const record = (id: string, source: AppInput['source'], observedAt: string, confirmed: boolean, data: object) =>
  inputSchema.parse({ id, source, observedAt, confirmed, synthetic: false, data });
const stored = (...inputs: AppInput[]) =>
  buildPerson({ userId: 'u-1', synthetic: false, context: { resolved: resolveInputs(inputs) } });

test('a stored date of birth replaces a stored age, and an old age or tax figure is flagged with its date', () => {
  const figures = {
    finance: { monthlyIncomeCents: 320_000, monthlyExpensesCents: 230_000, currentSavingsCents: 1_000_000 },
  };
  const person = stored(
    record('a', 'interview', '2025-03-10T09:00:00Z', true, {
      ...figures,
      housing: { homeSizeM2: 90, depositRate: 0.25 },
      eligibility: { age: 33, itpBuyerNetTaxBaseEur: 21_000, children: [{ birthYear: 2012 }] },
    }),
  );
  assert.deepEqual([person.household?.age, person.born], [33, { children: [{ birthYear: 2012 }] }]);
  assert.equal(person.home.depositRate, 0.25);
  assert.deepEqual(person.answers?.birthDate, {
    source: 'interview',
    observedAt: '2025-03-10T09:00:00Z',
    confirmed: true,
    status: 'known',
  });
  const old = plan(person);
  const fact = (result: PlanResult, id: string) => result.knownFacts?.find(item => item.id === id);
  assert.match(fact(old, 'birthDate')?.stale ?? '', /Given as an age on 2025-03-10.*date of birth instead/);
  assert.match(fact(old, 'itpBuyerNetTaxBase')?.stale ?? '', /Given on 2025-03-10, in an earlier year.*tax return/);
  assert.equal(fact(old, 'children')?.value, 'born in 2012, aged 14');
  assert.equal(fact(old, 'children')?.stale, null, 'an age worked out from a birth year is recomputed for every plan');
  assert.equal(fact(old, 'depositRate')?.value, '25%');
  assert.equal(asked(old, 'depositRate'), undefined);
  assert.match(
    of(old, talarn).assumptions.at(-1) ?? '',
    /date of birth: Age 33, as stated \(the interview, given 2025-03-10, confirmed; possibly out of date\)/,
  );

  // The date of birth, once confirmed, is what the plan uses: 35 on the plan date, whatever age was stored.
  const dated = stored(
    record('a', 'interview', '2025-03-10T09:00:00Z', true, { ...figures, eligibility: { age: 33 } }),
    record('b', 'manual', '2026-11-20T09:00:00Z', true, { eligibility: { birthDate: '1991-06-01' } }),
  );
  assert.deepEqual([dated.household, dated.born], [undefined, { self: '1991-06-01' }]);
  const fresh = plan(dated);
  assert.equal(fresh.person.household?.age, 35);
  assert.deepEqual(
    [fact(fresh, 'birthDate')?.value, fact(fresh, 'birthDate')?.stale],
    ['Born 1991-06-01: 35 on 2026-11-22', null],
  );
  // A date of birth nobody confirmed is not used, and the plan says it is waiting for confirmation.
  const guessed = stored(
    record('g', 'interview', '2026-11-20T09:00:00Z', false, {
      ...figures,
      housing: { homeSizeM2: 90 },
      eligibility: { birthDate: '1991-06-01', largeFamily: true },
    }),
  );
  assert.deepEqual([guessed.born, guessed.household], [undefined, undefined]);
  assert.deepEqual(
    [guessed.answers?.birthDate?.status, guessed.answers?.largeFamily?.status],
    ['unconfirmed', 'unconfirmed'],
  );
  assert.equal(asked(plan(guessed), 'birthDate')?.state, 'unconfirmed');
});

test('a confirmed answer that contradicts another is a conflict the person settles, never the newest taken', () => {
  const base = record('a', 'interview', '2026-11-01T09:00:00Z', true, {
    finance: { monthlyIncomeCents: 320_000, monthlyExpensesCents: 230_000, currentSavingsCents: 1_000_000 },
    housing: { homeSizeM2: 90 },
    eligibility: {
      primaryResidence: true,
      children: [{ birthDate: '2019-04-02', meetsItpSchooling: true }],
      itpTransaction: true,
      satisfiesItpOccupancyRules: true,
      itpFamilyNetTaxBaseEur: 28_000,
    },
  });
  const agreed = plan(stored(base));
  assert.equal(benefit(of(agreed, talarn), 'itp_buy').counted, true);
  assert.deepEqual(agreed.conflicts, []);

  // Later, typed into the workspace: a different figure. Newer, and still not silently preferred.
  const other = record('b', 'manual', '2026-11-20T09:00:00Z', true, {
    eligibility: { itpFamilyNetTaxBaseEur: 41_000 },
  });
  const person = stored(base, other);
  assert.equal(person.answers?.itpFamilyNetTaxBase?.status, 'conflict');
  assert.equal('itpFamilyNetTaxBaseEur' in (person.household ?? {}), false);
  const torn = plan(person);
  assert.deepEqual(torn.conflicts, [
    {
      id: 'itpFamilyNetTaxBase',
      inputPath: 'eligibility.itpFamilyNetTaxBaseEur',
      label: 'Your family’s tax bases',
      question: questionById('itpFamilyNetTaxBase').question,
      candidates: [
        { value: 28_000, text: '€28,000', source: 'interview', observedAt: '2026-11-01T09:00:00Z', confirmed: true },
        { value: 41_000, text: '€41,000', source: 'manual', observedAt: '2026-11-20T09:00:00Z', confirmed: true },
      ],
    },
  ]);
  const rate = benefit(of(torn, talarn), 'itp_buy');
  assert.deepEqual([rate.eligibilityStatus, rate.counted], ['needs_verification', false]);
  assert.equal(asked(torn, 'itpFamilyNetTaxBase')?.state, 'conflict');
  assert.equal(
    torn.knownFacts?.some(fact => fact.id === 'itpFamilyNetTaxBase'),
    false,
  );
  // The pick is written under each source that disagreed, and then the plan uses it.
  assert.deepEqual(conflictSources(torn.conflicts?.[0] ?? { candidates: [] }), ['interview', 'manual']);
  const settled = stored(
    base,
    other,
    ...conflictSources(torn.conflicts?.[0] ?? { candidates: [] }).map(source =>
      record(`pick-${source}`, source, '2026-11-22T09:00:00Z', true, {
        eligibility: { itpFamilyNetTaxBaseEur: 28_000 },
      }),
    ),
  );
  const after = plan(settled);
  assert.deepEqual([after.conflicts, benefit(of(after, talarn), 'itp_buy').counted], [[], true]);
  assert.deepEqual(conflictSources({ candidates: [{ source: 'bank' }, { source: 'listing' }] as never }), ['manual']);
});

// ------------------------------------------------- the journey over MCP

/** The answers the scripted person gives, whatever order the plan asks them in. */
function script(today: string): Record<string, AnswerValue | null> {
  const yearsAgo = (years: number) => `${Number(today.slice(0, 4)) - years}-01-15`;
  return {
    monthlyIncome: 320_000,
    monthlyExpenses: 230_000,
    purchaseSavings: 1_000_000,
    homeBudget: null, // "I don't know": the plan then prices a home of a given size
    floorArea: 90,
    primaryResidence: true,
    birthDate: yearsAgo(45),
    children: [{ birthDate: yearsAgo(7) }],
    itpTransaction: true,
    itpOccupancy: true,
    childrenItpSchooling: [true],
    itpFamilyNetTaxBase: 28_000,
    largeFamily: false,
    singleParent: false,
    disability65: false,
    firstRuralMove: true,
    childrenIrpfSchooling: [null],
    filing: 'individual',
    irpfNetTaxBase: null,
    depositRate: 0.2,
    emergencyReserve: 0,
  };
}

test('journey: a signed-in person starts with nothing, is asked in order, and each saved answer moves the plan', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin, db } = server;
  const browser = new Browser(origin);
  await browser.signUp('ada@example.com');
  const cookie = { Cookie: `rc_session=${browser.cookies.get('rc_session')}`, Origin: origin };
  const records = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM input_records')?.n ?? 0;
  const mine = async () => {
    const answer = await mcp(origin, 'plan_home_savings', { me: true, municipalityCodes: [talarn, balaguer] }, cookie);
    assert.equal(answer.result?.isError, undefined, JSON.stringify(answer.result?.content));
    return { result: planResult.parse(answer.result?.structuredContent), text: answer.result?.content?.[0].text ?? '' };
  };

  // Nothing is stored: the plan has no timeline and says what to ask, one question at a time.
  const first = await mine();
  assert.equal(records(), 0);
  assert.deepEqual(ids(first.result.nextQuestions).slice(0, 3), [
    'monthlyIncome',
    'monthlyExpenses',
    'purchaseSavings',
  ]);
  assert(first.result.plans.every(item => item.status === 'insufficient_data'));
  assert.match(first.text, /Ask next, one question at a time: “How much money comes into your household/);
  const answers = script(first.result.asOf);

  const order: string[] = [];
  const seen: Record<string, { status: string; counted: boolean; months: number | null | undefined }> = {};
  let current = first.result;
  for (let turn = 0; turn < 40; turn++) {
    const next = (current.nextQuestions ?? []).find(question => question.state !== 'said_unknown');
    if (!next) break;
    assert(next.id in answers, `the script has no answer for ${next.id}`);
    const value = answers[next.id];
    assert.equal(validateAnswer(next.id as QuestionId, value, { today: current.asOf, childCount: 1 }), null, next.id);
    // Saved the way every surface saves: the shared record for that answer, confirmed by the person.
    const data = answerToInput(next.id as QuestionId, value, { person: current.person, day: current.asOf });
    const saved = await mcp(origin, 'save_my_inputs', { data, confirmed: true, source: 'interview' }, cookie);
    assert.equal(saved.result?.structuredContent?.saved, true, next.id);
    order.push(next.id);
    current = (await mine()).result;
    const rural = of(current, talarn);
    seen[next.id] = {
      status: benefit(rural, 'itp_buy').eligibilityStatus,
      counted: benefit(rural, 'itp_buy').counted,
      months: rural.withPlaceBenefits?.months,
    };
    assert.equal(records(), order.length, 'one dated record per answer');
  }

  // The figures first, then the facts of the largest measure, then the rest.
  assert.deepEqual(order.slice(0, 5), [
    'monthlyIncome',
    'monthlyExpenses',
    'purchaseSavings',
    'homeBudget',
    'floorArea',
  ]);
  const ruralFacts = [
    'primaryResidence',
    'children',
    'itpTransaction',
    'itpOccupancy',
    'childrenItpSchooling',
    'itpFamilyNetTaxBase',
  ];
  assert.deepEqual([...order.slice(5, 11)].sort(), [...ruralFacts].sort());
  for (const id of ['irpfIndividualNetTaxBase', 'ownsHomeInSpain', 'incomeWithinFiveIprem'])
    assert(!order.includes(id), `${id} could not change this plan and was never asked`);
  // The first timeline appears with the floor area; the rural rate is unverified until its last fact is in.
  const withoutRate = seen.floorArea.months;
  assert(typeof withoutRate === 'number' && withoutRate > 0);
  const lastRuralFact = order[10];
  for (const id of order.slice(4, 10))
    assert.deepEqual(seen[id], { status: 'needs_verification', counted: false, months: withoutRate }, id);
  assert.deepEqual([seen[lastRuralFact].status, seen[lastRuralFact].counted], ['eligible', true]);
  const withRate = seen[lastRuralFact].months;
  assert(typeof withRate === 'number' && withRate < withoutRate, `${withRate} months is shorter than ${withoutRate}`);

  // The end state: counted or ruled out with the reason, sourced facts, nothing left to ask as new.
  const rural = of(current, talarn);
  assert.match(benefit(rural, 'itp_buy').explanation, /Counted: lowers the upfront cash needed by €/);
  assert.equal(rural.monthsSavedByPlace, withoutRate - withRate);
  const young = benefit(rural, 'itp_young_buyer');
  assert.deepEqual([young.eligibilityStatus, young.amountCents], ['ineligible', null]);
  assert.match(young.explanation, /criteria not met: The buyer is 35 or younger/);
  for (const id of ['itp_large_family', 'itp_single_parent', 'itp_disability'])
    assert.equal(benefit(rural, id).eligibilityStatus, 'ineligible', id);
  assert(!order.includes('itpBuyerNetTaxBase'), 'a buyer of 45 is never asked for the young buyer’s tax base');
  assert.deepEqual(
    (current.nextQuestions ?? []).map(question => question.state),
    (current.nextQuestions ?? []).map(() => 'said_unknown'),
  );
  assert.equal(current.person.household?.age, 45 - (current.asOf.slice(5) < '01-15' ? 1 : 0));
  const birth = current.knownFacts?.find(fact => fact.id === 'birthDate');
  assert.deepEqual([birth?.source, birth?.confirmed, birth?.usedByPlan, birth?.stale], ['interview', true, true, null]);
  assert.match(
    rural.assumptions.at(-1) ?? '',
    /Facts about you this plan relied on: main home: Yes \(the interview, given \d{4}-\d\d-\d\d, confirmed\)/,
  );
  // “I don't know” was stored as an explicit null, and the person is not labelled synthetic.
  const rows = db.all<{ data: string; confirmed: number; synthetic: number }>(
    'SELECT data, confirmed, synthetic FROM input_records ORDER BY rowid',
  );
  assert(rows.every(row => row.confirmed === 1 && row.synthetic === 0));
  assert(rows.some(row => row.data === '{"housing":{"budgetCents":null}}'));
  assert(rows.some(row => row.data === '{"eligibility":{"irpfNetTaxBaseEur":null}}'));

  // A different answer from another source is a conflict: shown, not taken.
  const contradiction = { eligibility: { itpFamilyNetTaxBaseEur: 52_000 } };
  await mcp(origin, 'save_my_inputs', { data: contradiction, confirmed: true, source: 'manual' }, cookie);
  const torn = await mine();
  assert.match(
    torn.text,
    /1 answer\(s\) disagree \(Your family’s tax bases\): show the candidates and let the person pick/,
  );
  assert.deepEqual(
    torn.result.conflicts?.[0].candidates.map(candidate => [candidate.text, candidate.source]),
    [
      ['€28,000', 'interview'],
      ['€52,000', 'manual'],
    ],
  );
  const held = of(torn.result, talarn);
  assert.deepEqual(
    [benefit(held, 'itp_buy').eligibilityStatus, benefit(held, 'itp_buy').counted, held.withPlaceBenefits?.months],
    ['needs_verification', false, withoutRate],
  );
  // The person picks through the workspace's own client, which writes the pick under both sources.
  const page = createToolClient(
    httpCallTool(`${origin}/mcp`, (input, init) =>
      fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...cookie } }),
    ),
  );
  const conflict = torn.result.conflicts?.[0];
  assert(conflict);
  for (const source of conflictSources(conflict))
    await page.saveInputs({ eligibility: { itpFamilyNetTaxBaseEur: conflict.candidates[0].value } }, true, source);
  const settled = await page.plan({
    subject: { kind: 'me' },
    municipalityCodes: [talarn, balaguer],
    assumptions: { includeProposedHabits: false, includeUnverifiedBenefits: false },
  });
  assert.deepEqual(settled.conflicts, []);
  assert.equal(of(settled, talarn).withPlaceBenefits?.months, withRate);
  assert.deepEqual(planChanges(torn.result, settled)[0], {
    place: 'Talarn',
    lines: [
      'Counted now: Reduced ITP on a rural primary-home purchase (TMR / TEA).',
      planChanges(torn.result, settled)[0].lines[1],
    ],
  });
  assert.match(planChanges(torn.result, settled)[0].lines[1], /^The wait is now .*; it was /);
});

test('journey: the same answers given anonymously plan the same and store nothing', async t => {
  const server = await startApp();
  t.after(() => server.close());
  const { origin, db } = server;
  const records = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM input_records')?.n ?? 0;
  const before = records();
  const inline = async (person: Person) => {
    const answer = await mcp(origin, 'plan_home_savings', { person, municipalityCodes: [talarn, balaguer] });
    assert.equal(answer.status, 200);
    return { result: planResult.parse(answer.result?.structuredContent), text: answer.result?.content?.[0].text ?? '' };
  };
  // Saving needs a signed-in person: the tool answers with the sign-in challenge, never by storing.
  const refused = await mcp(origin, 'save_my_inputs', {
    data: { eligibility: { birthDate: '1990-01-01' } },
    confirmed: true,
  });
  assert.equal(refused.status, 401);

  let person = blankPerson();
  let current = (await inline(person)).result;
  const answers = script(current.asOf);
  const order: string[] = [];
  for (let turn = 0; turn < 40; turn++) {
    const next = (current.nextQuestions ?? []).find(question => question.state !== 'said_unknown');
    if (!next) break;
    // The answer goes into the inline person, exactly as the workspace's what-if does it.
    person = applyAnswer(person, next.id as QuestionId, answers[next.id], { day: current.asOf });
    order.push(next.id);
    current = (await inline(person)).result;
  }
  assert.equal(records(), before, 'nothing was stored');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')?.n, 0);
  assert.deepEqual(order.slice(0, 5), [
    'monthlyIncome',
    'monthlyExpenses',
    'purchaseSavings',
    'homeBudget',
    'floorArea',
  ]);
  const rural = of(current, talarn);
  assert.deepEqual(
    [benefit(rural, 'itp_buy').eligibilityStatus, benefit(rural, 'itp_buy').counted],
    ['eligible', true],
  );
  assert(typeof rural.monthsSavedByPlace === 'number' && rural.monthsSavedByPlace > 0);
  assert.equal(benefit(rural, 'itp_young_buyer').eligibilityStatus, 'ineligible');
  assert(current.knownFacts?.every(fact => fact.source === 'what_if' && fact.confirmed === null));
  assert.match(rural.assumptions.at(-1) ?? '', /this estimate only, not saved/);
  // A person stated with plain facts by a chat model, without the helper, works the same way.
  const spoken = await inline({
    ...blankPerson(),
    finances: {
      ...blankPerson().finances,
      monthlyIncomeCents: 320_000,
      monthlyExpensesCents: 230_000,
      currentSavingsCents: 1_000_000,
    },
    home: { floorAreaM2: 90, budgetCents: null, depositRate: 0.2 },
    household: {
      age: 30,
      primaryResidence: true,
      itpTransaction: true,
      satisfiesItpOccupancyRules: true,
      itpBuyerNetTaxBaseEur: 24_000,
    },
  });
  assert.equal(of(spoken.result, balaguer).transferTax?.baselinePolicyId, 'itp_young_buyer');
  assert.equal(asked(spoken.result, 'birthDate'), undefined);
  assert.equal(records(), before);
});

test('get_next_questions returns the same list without the timelines, for an inline person or the caller', async () => {
  const server = new McpServer({ name: 'questions-test', version: '1' });
  registerPlannerTools(server, { snapshot, policies, today: () => asOf }).registerNextQuestions();
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    const tool = tools.find(item => item.name === 'get_next_questions');
    assert(tool?.annotations?.readOnlyHint);
    assert(!('userId' in (tool.inputSchema.properties ?? {})));
    // The guidance that leads the model is on both tools: one question at a time, save only what was confirmed.
    for (const name of ['get_next_questions', 'plan_home_savings']) {
      const description = tools.find(item => item.name === name)?.description ?? '';
      assert.match(description, /Ask ONE question at a time/);
      assert.match(description, /only after the person confirms it call save_my_inputs with confirmed:true/);
      assert.match(description, /never turn “I don’t know” into zero or no/);
      assert.match(description, /Not signed in: nothing is stored/);
    }
    const person = who(basics);
    const response = await client.callTool({
      name: 'get_next_questions',
      arguments: { person, municipalityCodes: [talarn, balaguer] },
    });
    const result = nextQuestionsResult.parse(response.structuredContent);
    assert.deepEqual(result.nextQuestions, plan(person).nextQuestions);
    assert.deepEqual([result.stored, result.asOf, result.conflicts], [false, asOf, []]);
    assert.equal('plans' in (response.structuredContent as object), false);
    assert.match(
      (response.content as { text: string }[])[0].text,
      /^Ask next, one question at a time: “Will the home you buy be the one you live in/,
    );
    // Without accounts there is no "me": the tool says so instead of guessing a person.
    const mine = await client.callTool({
      name: 'get_next_questions',
      arguments: { me: true, municipalityCodes: [talarn] },
    });
    assert.equal(mine.isError, true);
    const done = await client.callTool({
      name: 'get_next_questions',
      arguments: { person: who(everything), municipalityCodes: [talarn] },
    });
    assert.match((done.content as { text: string }[])[0].text, /^No further question would change this plan\./);
    // No place and nobody: the questions about the person, in order, and a place still to choose.
    const start = await client.callTool({ name: 'get_next_questions', arguments: {} });
    const opening = nextQuestionsResult.parse(start.structuredContent);
    assert.deepEqual(ids(opening.nextQuestions), [
      'monthlyIncome',
      'monthlyExpenses',
      'purchaseSavings',
      'homeBudget',
      'floorArea',
      'depositRate',
      'emergencyReserve',
    ]);
    assert.deepEqual([opening.municipalityCodes, opening.stored], [[], false]);
    assert.equal(opening.placeQuestion?.suggestTool, 'recommend_towns');
    assert.match(
      (start.content as { text: string }[])[0].text,
      /^No place is chosen yet\. Ask next, one question at a time: “How much money/,
    );
    // The same list as the plan without a place, and the same as the planner gives for no places.
    assert.deepEqual(opening.nextQuestions, planForPlaces({}, [], policies, undefined, asOf).nextQuestions);
    // With the figures known the place comes next, and a partial person is enough to say so.
    const figures = {
      finances: { monthlyIncomeCents: 320_000, monthlyExpensesCents: 230_000, currentSavingsCents: 1_000_000 },
      home: { budgetCents: 12_000_000 },
    };
    const placeNext = await client.callTool({ name: 'get_next_questions', arguments: { person: figures } });
    assert.match(
      (placeNext.content as { text: string }[])[0].text,
      /^No place is chosen yet\. Ask next: ask where in Catalonia/,
    );
    const partial = nextQuestionsResult.parse(placeNext.structuredContent);
    assert(partial.nextQuestions.every(question => question.effect.kind !== 'required'));
    assert(partial.knownFacts.some(fact => fact.id === 'homeBudget'));
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
