import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureNoSavings, fixturePlan } from '../apps/web/fixtures/plan.ts';
import { journey, journeyStepIds } from '../apps/web/journey.ts';
import type { NextQuestion, PlanResult } from '../packages/contracts/planner.ts';
import { fallbackArt } from '../packages/ui/art.ts';
import { images, stepImageIds } from '../packages/ui/images.manifest.ts';

const stateOf = (result: ReturnType<typeof journey>, id: (typeof journeyStepIds)[number]) =>
  result.steps.find(step => step.id === id)?.state;

const question = (kind: NextQuestion['effect']['kind'], label: string, state: NextQuestion['state'] = 'missing') =>
  ({ label, state, effect: { kind } }) as unknown as NextQuestion;

test('every journey step has an illustration slot and a fallback, in the same order', () => {
  assert.deepEqual([...stepImageIds], [...journeyStepIds]);
  for (const id of journeyStepIds) {
    assert.ok(
      images.some(image => image.id === id),
      `${id} is in the manifest`,
    );
    assert.match(fallbackArt[id](), /^<svg/);
  }
});

test('with no plan nothing counts as reached and nothing personal counts as missed', () => {
  const trail = journey({ result: null, placeCount: 0, bankMovements: null, bankSynthetic: null });
  assert.equal(trail.reached, 0);
  assert.equal(trail.total, 7);
  for (const id of ['step-profile', 'step-money', 'step-bank', 'step-aid', 'step-habits', 'step-ready'] as const)
    assert.equal(stateOf(trail, id), 'unknown', id);
  // Places are counted on screen, so that checkpoint can be judged: it is the one to work on.
  assert.equal(trail.current?.id, 'step-places');
});

test('checkpoints are reached only by data that exists', () => {
  const result: PlanResult = {
    ...fixturePlan,
    knownFacts: fixturePlan.knownFacts?.length ? fixturePlan.knownFacts : ([{}] as PlanResult['knownFacts']),
    nextQuestions: [question('benefit', 'Date of birth'), question('assumption', 'Deposit share')],
  };
  const trail = journey({ result, placeCount: 2, bankMovements: 0, bankSynthetic: null });
  assert.equal(stateOf(trail, 'step-profile'), 'done');
  assert.equal(stateOf(trail, 'step-money'), 'done', 'no required figure is missing');
  assert.equal(stateOf(trail, 'step-bank'), 'current', 'a summary with no movements is the first gap');
  assert.equal(stateOf(trail, 'step-places'), 'done');
  assert.equal(stateOf(trail, 'step-aid'), 'ahead', 'a fact that decides a measure is still open');
  assert.match(trail.steps[4].detail, /1 answer could still change .* date of birth/);
  assert.equal(trail.current?.id, 'step-bank');

  const withBank = journey({ result, placeCount: 2, bankMovements: 41, bankSynthetic: true });
  assert.equal(stateOf(withBank, 'step-bank'), 'done');
  assert.match(withBank.steps[2].detail, /41 booked movements .* fictional bank feed/);
  assert.equal(withBank.current?.id, 'step-aid');
});

test('an unknown bank feed is not a missed checkpoint, and "I don\'t know" does not block one', () => {
  const result: PlanResult = {
    ...fixturePlan,
    nextQuestions: [question('required', 'Monthly income'), question('benefit', 'Tax base', 'said_unknown')],
  };
  const trail = journey({ result, placeCount: 1, bankMovements: null, bankSynthetic: null });
  assert.equal(stateOf(trail, 'step-bank'), 'unknown');
  assert.equal(stateOf(trail, 'step-money'), 'current');
  assert.match(trail.steps[1].detail, /monthly income/);
  assert.equal(stateOf(trail, 'step-places'), 'ahead');
  assert.match(trail.steps[3].detail, /Add another/);
  assert.equal(stateOf(trail, 'step-aid'), 'done', 'the only deciding fact was answered "I don\'t know"');
});

test('ready to buy is reached only when the planner says the upfront cash is covered', () => {
  const none = journey({ result: fixtureNoSavings, placeCount: 2, bankMovements: 3, bankSynthetic: false });
  assert.notEqual(stateOf(none, 'step-ready'), 'done');
  const plans = fixturePlan.plans.map((plan, index) =>
    index === 0 ? { ...plan, status: 'target_reached' as const } : plan,
  );
  const reached = journey({ result: { ...fixturePlan, plans }, placeCount: 2, bankMovements: 3, bankSynthetic: false });
  assert.equal(stateOf(reached, 'step-ready'), 'done');
  assert.match(reached.steps[6].detail, new RegExp(plans[0].place.name));
});

test('the trail speaks the language asked for and says the same things in each', () => {
  const input = { result: fixturePlan, placeCount: 3, bankMovements: 184, bankSynthetic: true };
  // English is what it printed before there were other languages.
  assert.deepEqual(journey(input), journey(input, 'en'));
  assert.deepEqual(
    journey(input).steps.map(step => step.title),
    ['About you', 'Your money', 'Your bank', 'Compare places', 'Aid and tax', 'Saving habits', 'Ready to buy'],
  );

  const catalan = journey(input, 'ca');
  assert.deepEqual(
    catalan.steps.map(step => step.title),
    [
      'Sobre tu',
      'Els teus diners',
      'El teu banc',
      'Compara llocs',
      'Ajuts i impostos',
      'Hàbits d’estalvi',
      'A punt per comprar',
    ],
  );
  // The bank data is still called fictional, and the timeline is still a distance, not a promise.
  assert.equal(
    catalan.steps[2].detail,
    '184 moviments comptabilitzats darrere dels últims tres mesos, d’un banc fictici.',
  );
  assert.equal(catalan.steps[6].detail, 'Falten 1 any i 3 mesos amb el termini més curt en pantalla.');

  const spanish = journey(input, 'es');
  assert.equal(spanish.steps[0].title, 'Sobre ti');
  assert.equal(
    spanish.steps[2].detail,
    '184 movimientos contabilizados detrás de los últimos tres meses, de un banco ficticio.',
  );
  assert.equal(spanish.steps[5].detail, '2 hábitos activos.');

  // The language changes the words only: states, counts and the checkpoint to work on are the same.
  for (const translated of [catalan, spanish]) {
    assert.deepEqual(
      translated.steps.map(step => [step.id, step.state]),
      journey(input).steps.map(step => [step.id, step.state]),
    );
    assert.deepEqual(
      [translated.reached, translated.total, translated.current?.id],
      [journey(input).reached, journey(input).total, journey(input).current?.id],
    );
  }
});

test('a checkpoint that cannot be judged is unknown in every language, and a count takes the plural of the language', () => {
  const nothing = { result: null, placeCount: 0, bankMovements: null, bankSynthetic: null };
  for (const locale of ['en', 'ca', 'es'] as const) {
    const trail = journey(nothing, locale);
    assert.equal(stateOf(trail, 'step-bank'), 'unknown');
    assert.equal(stateOf(trail, 'step-ready'), 'unknown');
    assert.equal(trail.reached, 0);
    // Nothing is known, so no detail states a figure.
    for (const step of trail.steps) assert.doesNotMatch(step.detail, /\d/);
  }
  assert.equal(
    journey(nothing, 'ca').steps[2].detail,
    'Opcional: els moviments bancaris substitueixen les xifres declarades per les observades.',
  );
  assert.equal(journey(nothing, 'es').steps[6].detail, 'El último hito: el dinero inicial está cubierto.');

  // No finite timeline: the distance is said to be unknown, not zero.
  const none = { result: fixtureNoSavings, placeCount: 2, bankMovements: 1, bankSynthetic: false };
  assert.match(journey(none, 'ca').steps[6].detail, /desconeguda/);
  assert.match(journey(none, 'es').steps[6].detail, /desconocida/);
  assert.equal(journey(none, 'ca').steps[2].detail, '1 moviment comptabilitzat darrere dels últims tres mesos.');
  assert.equal(journey(none, 'es').steps[2].detail, '1 movimiento contabilizado detrás de los últimos tres meses.');

  // A question's label is the server's text: it is quoted as received, in whatever language it came.
  const result: PlanResult = { ...fixturePlan, nextQuestions: [question('benefit', 'Data de naixement')] };
  assert.equal(
    journey({ result, placeCount: 2, bankMovements: 3, bankSynthetic: false }, 'ca').steps[4].detail,
    '1 resposta encara podria canviar els ajuts o l’impost. La següent: data de naixement.',
  );
});
