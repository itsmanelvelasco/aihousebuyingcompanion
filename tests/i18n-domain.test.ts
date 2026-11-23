import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, languageGuidance } from '../apps/mcp-server/tools.ts';
import { incentivesResult, profileResult, recommendationResult } from '../packages/contracts/places.ts';
import type { Person } from '../packages/contracts/planner.ts';
import { place as placeSchema, planResult } from '../packages/contracts/planner.ts';
import { type Locale, locales } from '../packages/i18n/locales.ts';
import { buildPlace } from '../packages/model/place.ts';
import {
  blankPerson,
  describeAnswer,
  questionById,
  questionIds,
  questions,
  questionsIn,
  validateAnswer,
} from '../packages/model/questions.ts';
import { loadData } from '../packages/places/data.ts';
import { evaluateIncentives } from '../packages/places/eligibility.ts';
import { localizePolicy, policyText } from '../packages/places/policy-text.ts';
import { recommendTowns } from '../packages/places/recommend.ts';
import { missingFacts } from '../packages/planner/next-questions.ts';
import { planForPlaces, planLimitations, planLimitationsIn } from '../packages/planner/plan.ts';

const { snapshot, policies } = loadData();
const asOf = '2026-11-23';
const talarn = '252154';
const termens = '252206';
const balaguer = '250404';
const codes = [balaguer, talarn, termens];

/** A person with a habit, a date of birth and several facts still unknown, so every kind of sentence appears. */
const person: Person = {
  id: 'i18n',
  displayName: 'Test person',
  synthetic: true,
  householdSize: 3,
  currentMunicipalityCode: balaguer,
  finances: {
    monthlyIncomeCents: 320_000,
    monthlyExpensesCents: 240_033,
    currentSavingsCents: 1_500_000,
    emergencyReserveCents: 300_000,
    basis: 'bank_observed',
    expensesBasis: 'bank_observed',
    asOf: '2026-10-31',
  },
  home: { floorAreaM2: 90, budgetCents: null, depositRate: 0.2 },
  habits: [
    {
      id: 'cook',
      title: 'Cook at home',
      category: 'food',
      status: 'active',
      monthlySavingCents: 12_050,
      adherence: 0.8,
      startedOn: '2026-11-05',
    },
  ],
  born: { self: '1992-03-01', children: [{ birthDate: '2015-05-05' }] },
  household: { primaryResidence: true, itpTransaction: true },
};

/** Keys whose values are sentences for a person. Everything else must not depend on the language. */
const prose = new Set([
  'assumptions',
  'dataMissing',
  'limitations',
  'explanation',
  'title',
  'label',
  'question',
  'why',
  'help',
  'sensitivity',
  'text',
  'value',
  'stale',
  'alsoNeeds',
  'benefit',
  'notes',
  'reason',
  'missingCriteria',
  'unmetCriteria',
  'nextStep',
  'matchReasons',
  'tradeoffs',
  'reasons',
  'applied',
  'followUps',
  'verificationNeeded',
]);

/** The same value with every sentence replaced by a mark: what is left is numbers, codes, ids and structure. */
function skeleton(value: unknown, key = ''): unknown {
  if (prose.has(key))
    return Array.isArray(value) ? `<${value.length} sentences>` : value === null ? null : '<sentence>';
  if (Array.isArray(value)) return value.map(item => skeleton(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, skeleton(item, name)]));
  return value;
}

/** Every sentence of a value, in order. */
function sentences(value: unknown, key = '', found: string[] = []): string[] {
  if (typeof value === 'string') {
    if (prose.has(key)) found.push(value);
  } else if (Array.isArray(value)) for (const item of value) sentences(item, key, found);
  else if (value && typeof value === 'object')
    for (const [name, item] of Object.entries(value)) sentences(item, prose.has(key) ? key : name, found);
  return found;
}

const planIn = (locale?: Locale) =>
  planForPlaces(
    person,
    codes.map(code => buildPlace(snapshot, code, locale)),
    policies,
    undefined,
    asOf,
    locale,
  );

test('the same plan in three languages has the same numbers, codes and ids, and different sentences', () => {
  const [en, ca, es] = [planIn('en'), planIn('ca'), planIn('es')];
  // No language stated is English.
  assert.deepEqual(planIn(), en);
  assert.deepEqual(skeleton(ca), skeleton(en));
  assert.deepEqual(skeleton(es), skeleton(en));
  // The plans come in the same order with the same timelines.
  for (const plan of [ca, es]) {
    assert.deepEqual(
      plan.plans.map(item => [item.place.municipalityCode, item.status, item.withPlaceBenefits?.months]),
      en.plans.map(item => [item.place.municipalityCode, item.status, item.withPlaceBenefits?.months]),
    );
    assert.deepEqual(
      plan.plans.flatMap(item =>
        item.benefits.map(benefit => [benefit.policyId, benefit.counted, benefit.amountCents]),
      ),
      en.plans.flatMap(item => item.benefits.map(benefit => [benefit.policyId, benefit.counted, benefit.amountCents])),
    );
  }

  const [english, catalan, spanish] = [sentences(en), sentences(ca), sentences(es)];
  assert.equal(catalan.length, english.length);
  assert.equal(spanish.length, english.length);
  assert(english.length > 100);
  // A sentence is never left in English, and Catalan is never Spanish. The few texts that are the
  // same in two languages are names of fields, one-word answers, amounts and the person's own habit title.
  const same = (a: string[], b: string[]) => a.filter((text, index) => text === b[index]);
  for (const kept of [...same(english, catalan), ...same(english, spanish), ...same(catalan, spanish)])
    assert.match(kept, /^(person\.[\w.]+|\p{L}+|Cook at home|[\d\s.,]+(m²|€))$/u, `left untranslated: ${kept}`);

  // No placeholder is left unfilled in any language.
  for (const text of [...english, ...catalan, ...spanish]) assert.doesNotMatch(text, /\{\w+[,}]/, text);
  assert.deepEqual(en.limitations, planLimitations);
  assert.deepEqual(ca.limitations, planLimitationsIn('ca'));
  assert.match(ca.limitations[1], /^Cap ajut, subvenció o benefici fiscal està garantit\./);
  assert.match(es.limitations[1], /^Ninguna ayuda, subvención o beneficio fiscal está garantizado\./);
});

test('amounts, shares and dates in a sentence are written as each language writes them', () => {
  const [en, ca, es] = [planIn('en'), planIn('ca'), planIn('es')];
  const monthly = (plan: typeof en) =>
    plan.plans[0].assumptions.find(text => text.includes('799,67') || text.includes('799.67'));
  // English: two decimals when there are cents, none otherwise, and ISO dates as before.
  assert.equal(
    monthly(en),
    'Monthly savings are income less expenses (€799.67), from bank-observed figures as of 2026-10-31.',
  );
  assert.equal(
    monthly(ca),
    'L’estalvi mensual són els ingressos menys les despeses (799,67 €), a partir de xifres observades al banc a data 31 d’oct. 2026.',
  );
  assert.equal(
    monthly(es),
    'El ahorro mensual son los ingresos menos los gastos (799,67 €), a partir de cifras observadas en el banco a fecha 31 oct 2026.',
  );
  // Whole euros never carry a stray decimal, in any language.
  for (const plan of [en, ca, es])
    for (const text of sentences(plan)) {
      assert.doesNotMatch(text, /€\d[\d,]*\.\d(?!\d)/, text);
      assert.doesNotMatch(text, /\d,\d\s€/, text);
    }
  assert(en.plans[0].assumptions.some(text => /Available savings are €12,000: /.test(text)));
  assert(ca.plans[0].assumptions.some(text => /Els estalvis disponibles són 12\.000\s€: /.test(text)));

  const habit = (plan: typeof en) => plan.habits?.[0].explanation;
  assert.equal(
    habit(en),
    'Counted: €96.40 a month. It started on 2026-11-05, after the bank movements your spending comes from (up to 2026-10-31). Scaled by the 80% of check-ins kept.',
  );
  assert.match(habit(ca) ?? '', /^Es compta: 96,40\s€ al mes\. Va començar el 5 de nov\. 2026, /);
  assert.match(habit(es) ?? '', /^Se cuenta: 96,40\s€ al mes\. Empezó el 5 nov 2026, .* 80\s% de registros/);
});

test('what an answer could change keeps its force in each language', () => {
  const asked = (locale: Locale) =>
    missingFacts(
      person,
      codes.map(code => buildPlace(snapshot, code)),
      policies,
      asOf,
      undefined,
      locale,
    );
  const [en, ca, es] = [asked('en'), asked('ca'), asked('es')];
  assert.deepEqual(skeleton(ca), skeleton(en));
  assert.deepEqual(skeleton(es), skeleton(en));
  const benefit = en.findIndex(question => question.effect.kind === 'benefit' && (question.effect.months ?? 0) > 0);
  assert(benefit >= 0, 'a question that could shorten the wait');
  const { months, placeName } = en[benefit].effect;
  assert.match(
    en[benefit].effect.text,
    new RegExp(`^Could shorten the wait by up to ${months} months? in ${placeName}`),
  );
  assert.match(
    ca[benefit].effect.text,
    new RegExp(`^Podria escurçar l’espera en fins a ${months} (mes|mesos) a ${placeName}`),
  );
  assert.match(
    es[benefit].effect.text,
    new RegExp(`^Podría acortar la espera en hasta ${months} (mes|meses) en ${placeName}`),
  );
  // The measure is named as each language names it, and the question is the shared one.
  assert.match(ca[benefit].effect.text, /gràcies a «.+»\./);
  assert.equal(ca[benefit].question, questionById(ca[benefit].id as never, 'ca').question);
  assert.equal(ca[benefit].inputPath, en[benefit].inputPath);
});

test('a question reads the same in structure and differently in words', () => {
  assert.equal(questionsIn('en'), questions);
  for (const locale of locales) {
    const list = questionsIn(locale);
    assert.deepEqual(
      list.map(question => question.id),
      [...questionIds],
    );
    for (const [index, question] of list.entries()) {
      const { label, question: asks, why, help, sensitivity, kind, ...rest } = question;
      const english = questions[index];
      // Everything but the words is the English question.
      const {
        label: _l,
        question: _q,
        why: _w,
        help: _h,
        sensitivity: _s,
        kind: englishKind,
        ...englishRest
      } = english;
      assert.deepEqual(rest, englishRest);
      assert.equal(kind.type, englishKind.type);
      assert.equal(help === null, english.help === null);
      assert.equal(sensitivity === null, english.sensitivity === null);
      for (const text of [label, asks, why, help, sensitivity])
        if (text !== null) {
          assert(text.trim().length > 0);
          assert.doesNotMatch(text, /\{\w+\}/, `${locale} ${question.id}`);
        }
      if (locale !== 'en') {
        assert.notEqual(asks, english.question, `${locale} ${question.id} question`);
        assert.notEqual(why, english.why, `${locale} ${question.id} why`);
      }
    }
  }

  const base = (locale: Locale) => questionById('itpFamilyNetTaxBase', locale);
  assert.equal(base('en').label, 'Your family’s tax bases');
  assert.equal(base('ca').label, 'Les bases imposables de la teva família');
  assert.equal(base('es').label, 'Las bases imponibles de tu familia');
  assert.match(base('en').why, /apply only if this total is at most €36,000/);
  assert.match(base('ca').why, /només s’apliquen si aquest total és com a màxim de 36\.000 €/);
  assert.match(base('es').why, /solo se aplican si este total es como máximo de 36\.000 €/);
  // The help says where the figure is on the return, with the box numbers in every language.
  assert.match(base('en').help ?? '', /^Add the figure of each member who files a return\. This is not your salary\./);
  assert.match(base('ca').help ?? '', /^Suma la xifra de cada membre que presenta declaració\. No és el teu sou\./);
  assert.match(base('es').help ?? '', /^Suma la cifra de cada miembro que presenta declaración\. No es tu sueldo\./);
  for (const locale of locales) assert.match(base(locale).help ?? '', /0435.*0460.*0520/);
  assert.match(base('ca').sensitivity ?? '', /^De la teva declaració de la renda\./);
  assert.match(base('es').sensitivity ?? '', /^De tu declaración de la renta\./);
  // Official terms as the administrations write them.
  assert.equal(questionById('largeFamily', 'ca').label, 'Família nombrosa');
  assert.equal(questionById('largeFamily', 'es').label, 'Familia numerosa');
  assert.equal(questionById('primaryResidence', 'ca').label, 'Habitatge habitual');
  assert.equal(questionById('primaryResidence', 'es').label, 'Vivienda habitual');
  assert.deepEqual(
    (['en', 'ca', 'es'] as const).map(locale => {
      const { kind } = questionById('filing', locale);
      return kind.type === 'choice' ? kind.options : [];
    }),
    [
      [
        { value: 'individual', label: 'On my own (individual)' },
        { value: 'joint', label: 'Jointly' },
      ],
      [
        { value: 'individual', label: 'Individualment' },
        { value: 'joint', label: 'Conjuntament' },
      ],
      [
        { value: 'individual', label: 'Individualmente' },
        { value: 'joint', label: 'Conjuntamente' },
      ],
    ],
  );
});

test('“I don’t know” and unknown data stay unknown in each language', () => {
  // An answer of "I don't know" is a word, never zero.
  assert.equal(describeAnswer('itpBuyerNetTaxBase', null, asOf), 'I don’t know');
  assert.equal(describeAnswer('itpBuyerNetTaxBase', null, asOf, 'ca'), 'No ho sé');
  assert.equal(describeAnswer('itpBuyerNetTaxBase', null, asOf, 'es'), 'No lo sé');
  assert.equal(describeAnswer('childrenItpSchooling', [true, null], asOf, 'ca'), 'sí, no se sap');
  assert.equal(describeAnswer('childrenItpSchooling', [false, null], asOf, 'es'), 'no, no se sabe');
  assert.equal(describeAnswer('children', [{}], asOf, 'ca'), 'edat desconeguda');
  assert.equal(describeAnswer('itpBuyerNetTaxBase', 20_000.5, asOf), '€20,000.5');
  assert.match(describeAnswer('itpBuyerNetTaxBase', 20_000.5, asOf, 'ca'), /^20\.000,50\s€$/);
  assert.equal(describeAnswer('birthDate', '1992-03-01', asOf), 'Born 1992-03-01: 34 on 2026-11-23');
  assert.match(describeAnswer('birthDate', '1992-03-01', asOf, 'es'), /^1 mar 1992: 34 años el 23 nov 2026$/);

  // Where it is not accepted, the refusal is said in the language; whether it is accepted never changes.
  const context = { today: asOf };
  assert.equal(
    validateAnswer('monthlyIncome', null, context),
    'This one needs a value: the plan cannot use “I don’t know” here.',
  );
  assert.equal(
    validateAnswer('monthlyIncome', null, context, 'ca'),
    'Aquí cal un valor: el pla no pot fer servir «No ho sé» en aquest cas.',
  );
  assert.equal(
    validateAnswer('monthlyIncome', null, context, 'es'),
    'Aquí hace falta un valor: el plan no puede usar «No lo sé» en este caso.',
  );
  for (const locale of locales) {
    assert.equal(validateAnswer('itpBuyerNetTaxBase', null, context, locale), null);
    for (const id of questionIds)
      for (const value of [undefined, null, 'x', -5, 1e12, true, [], '2999-01-01'])
        assert.equal(
          validateAnswer(id, value, context, locale) === null,
          validateAnswer(id, value, context) === null,
          `${locale} ${id} ${String(value)}`,
        );
  }
  assert.equal(validateAnswer('homeBudget', 0, context), 'Enter at least €1.');
  assert.match(validateAnswer('homeBudget', 1e12, context, 'ca') ?? '', /^Escriu com a màxim 50\.000\.000\s€\.$/);

  // A person with nothing known: no timeline, no zero, and the reason in the language.
  const unknown = (locale: Locale) =>
    planForPlaces(
      blankPerson('what-if', locale),
      [buildPlace(snapshot, talarn, locale)],
      policies,
      undefined,
      asOf,
      locale,
    );
  const [en, ca, es] = [unknown('en'), unknown('ca'), unknown('es')];
  assert.equal(ca.person.displayName, 'Estimació hipotètica');
  assert.equal(es.person.displayName, 'Estimación hipotética');
  for (const plan of [en, ca, es]) {
    assert.equal(plan.plans[0].status, 'insufficient_data');
    assert.equal(plan.plans[0].withPlaceBenefits, null);
    assert.equal(plan.plans[0].purchasePriceCents, null);
    assert(plan.plans[0].dataMissing.includes('person.finances.currentSavingsCents'));
  }
  assert(en.plans[0].dataMissing.includes('person.home.floorAreaM2 or person.home.budgetCents'));
  assert(ca.plans[0].dataMissing.includes('person.home.floorAreaM2 o person.home.budgetCents'));
  const first = (plan: typeof en) => plan.nextQuestions?.[0];
  assert.equal(first(en)?.effect.text, 'Needed before any timeline can be estimated.');
  assert.equal(first(ca)?.effect.text, 'Cal abans de poder estimar cap termini.');
  assert.equal(first(es)?.effect.text, 'Hace falta antes de poder estimar ningún plazo.');
  assert.equal(first(ca)?.state, 'missing');
  // A benefit whose facts are unknown needs verification in every language, and says so.
  const pending = (plan: typeof en) => plan.plans[0].benefits.find(benefit => benefit.policyId === 'itp_buy');
  for (const plan of [en, ca, es]) assert.equal(pending(plan)?.eligibilityStatus, 'needs_verification');
  assert.match(pending(en)?.explanation ?? '', /Shown but not counted until verified: /);
  assert.match(pending(ca)?.explanation ?? '', /Es mostra, però no es compta fins que es verifiqui: /);
  assert.match(pending(es)?.explanation ?? '', /Se muestra, pero no se cuenta hasta que se verifique: /);
});

test('every policy of the data has its name and explanation in Catalan and Spanish', () => {
  for (const policy of policies) {
    for (const locale of ['ca', 'es'] as const) {
      const text = policyText[locale][policy.id];
      assert(text, `${policy.id} has no ${locale} text`);
      assert(text.title.trim() && text.benefit.trim(), `${policy.id} ${locale} title and benefit`);
      assert.notEqual(text.title, policy.title, `${policy.id} ${locale} title is still English`);
      assert.notEqual(text.benefit, policy.benefit, `${policy.id} ${locale} benefit is still English`);
      // One translated note per note of the data: an edited policy cannot keep a stale translation unnoticed.
      assert.equal(text.notes.length, policy.notes.length, `${policy.id} ${locale} notes`);
      assert.equal(Boolean(text.reason), policy.effect?.kind === 'unquantified', `${policy.id} ${locale} reason`);
      // The figures of the rule survive translation: every amount and percentage of the English is there.
      const figures = (value: string) =>
        [...value.matchAll(/\d[\d.,]*\d|\d/g)].map(([number]) => number.replace(/[.,]/g, '')).sort();
      assert.deepEqual(figures(text.benefit), figures(policy.benefit), `${policy.id} ${locale} benefit figures`);

      const shown = localizePolicy(policy, locale);
      assert.equal(shown.title, text.title);
      assert.deepEqual(shown.notes, text.notes);
      // Everything that is not a sentence is the data's.
      const { title: _t, benefit: _b, notes: _n, effect: _e, ...rest } = shown;
      const { title: _t2, benefit: _b2, notes: _n2, effect: _e2, ...original } = policy;
      assert.deepEqual(rest, original);
      assert.equal(shown.authority, policy.authority);
    }
    assert.equal(localizePolicy(policy, 'en'), policy);
    assert.equal(localizePolicy(policy), policy);
  }
  // Official names stay as the administrations write them.
  assert.match(policyText.ca.itp_young_buyer?.title ?? '', /^ITP reduït .*\(TUJ\)$/);
  assert.match(policyText.es.itp_large_family?.title ?? '', /familia numerosa \(TUF\)$/);
  assert.match(policyText.es.irpf_rent?.notes[1] ?? '', /Codi tributari de Catalunya/);
  // A measure without a translation, or with other notes than the data, falls back to English.
  const unknown = { ...policies[0], id: 'not_translated' as never };
  assert.equal(localizePolicy(unknown, 'ca'), unknown);
  const edited = { ...policies[0], notes: ['One new note.'] };
  assert.deepEqual(localizePolicy(edited, 'ca').notes, ['One new note.']);
});

test('incentive screening and town recommendations change words only', () => {
  const town = snapshot.municipalities.find(item => item.code === talarn);
  assert(town);
  const input = {
    municipalityCode: talarn,
    eventDate: '2026-12-01',
    household: { age: 30, primaryResidence: true, children: [{ age: 5 }], filing: 'individual' as const },
  };
  const screen = (locale?: Locale) => evaluateIncentives(policies, town, input, asOf, locale);
  const [en, ca, es] = [screen('en'), screen('ca'), screen('es')];
  assert.deepEqual(screen(), en);
  assert.deepEqual(skeleton(ca), skeleton(en));
  assert.deepEqual(skeleton(es), skeleton(en));
  const move = (list: typeof en) => list.find(item => item.id === 'irpf_move');
  assert.equal(move(en)?.title, 'Catalan IRPF deduction for moving to a rural municipality');
  assert.equal(move(ca)?.title, 'Deducció catalana de l’IRPF per trasllat a un municipi rural');
  assert.equal(move(es)?.title, 'Deducción catalana del IRPF por traslado a un municipio rural');
  assert(move(en)?.missingCriteria.includes('This is the claimant’s first rural relocation.'));
  assert(move(ca)?.missingCriteria.includes('És el primer trasllat del sol·licitant a un municipi rural.'));
  assert(move(es)?.missingCriteria.includes('Es el primer traslado del solicitante a un municipio rural.'));
  assert.equal(move(ca)?.eligibilityStatus, 'needs_verification');
  assert.equal(
    move(es)?.nextStep,
    'Confirma los hechos con sus fechas y el procedimiento para aplicarla con la Agència Tributària de Catalunya.',
  );

  const request = {
    housing: { tenure: 'buy' as const, maxBudgetEur: 150_000, homeSizeM2: 90, allowComarcaEstimate: true },
    schoolStages: ['primary' as const],
    limit: 10,
  };
  const recommend = (locale?: Locale) => recommendTowns(snapshot, policies, request, asOf, undefined, locale);
  const [towns, pobles, pueblos] = [recommend('en'), recommend('ca'), recommend('es')];
  assert.deepEqual(recommend(), towns);
  assert.deepEqual(skeleton(pobles), skeleton(towns));
  assert.deepEqual(skeleton(pueblos), skeleton(towns));
  assert(towns.towns.length > 0);
  const reason = (result: typeof towns) => result.towns[0].matchReasons.find(text => /€/.test(text));
  // English keeps the plain amount it has always printed here; the others group the digits.
  assert.match(
    reason(towns) ?? '',
    /^The (municipality|comarca) housing estimate of €\d+ is within the stated budget\.$/,
  );
  assert.match(
    reason(pobles) ?? '',
    /^L’estimació del cost de l’habitatge (al municipi|a la comarca), de \d{2,3}\.\d{3}\s€, és dins del pressupost indicat\.$/,
  );
  assert.match(
    reason(pueblos) ?? '',
    /^La estimación del coste de la vivienda en (el municipio|la comarca), de \d{2,3}\.\d{3}\s€, está dentro del presupuesto indicado\.$/,
  );
  assert.match(pobles.limitations[0], /^Les recomanacions cobreixen els municipis catalans/);
  assert.match(pueblos.limitations[0], /^Las recomendaciones cubren los municipios catalanes/);
});

/** The plan a tool returned, without what the tool adds about where the answers live. */
function toolPlan(value: unknown) {
  const { stored: _stored, sayNotStored: _say, ...plan } = planResult.parse(value);
  return plan;
}

async function connect() {
  const server = createMcpServer({ snapshot, policies, today: () => asOf });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'i18n-domain-tests', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, close: () => Promise.all([client.close(), server.close()]) };
}

test('a tool answers in the language of its locale argument, else of the host, else in English', async () => {
  const { client, close } = await connect();
  try {
    assert.match(client.getInstructions() ?? '', /pass ca, es or en to match the language the person writes in/);
    assert(client.getInstructions()?.includes(languageGuidance));
    const listed = await client.listTools();
    const takesLocale = listed.tools
      .filter(tool => 'locale' in (tool.inputSchema.properties ?? {}))
      .map(tool => tool.name)
      .sort();
    assert.deepEqual(takesLocale, [
      'check_housing_incentives',
      'get_applicable_incentives',
      'get_next_questions',
      'get_place',
      'get_town_profile',
      'list_my_habits',
      'plan_home_savings',
      'recommend_towns',
      'recommend_towns_for_profile',
      'save_my_habit',
      'save_my_inputs',
      'start_homebuying_interview',
    ]);
    for (const tool of listed.tools.filter(item => takesLocale.includes(item.name))) {
      assert.deepEqual((tool.inputSchema.properties as Record<string, { enum?: string[] }>).locale.enum, [
        'en',
        'ca',
        'es',
      ]);
      assert(!(tool.inputSchema.required ?? []).includes('locale'), tool.name);
      // Written for the model: English whatever the language of the result.
      assert.match(tool.description ?? '', /^[A-Z][a-z]+ /);
    }

    const plan = { person, municipalityCodes: codes };
    const call = async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      assert(!response.isError, JSON.stringify(response.content));
      return response;
    };

    // The locale argument.
    const english = toolPlan((await call('plan_home_savings', plan)).structuredContent);
    const catalanCall = await call('plan_home_savings', { ...plan, locale: 'ca' });
    const catalan = toolPlan(catalanCall.structuredContent);
    assert.deepEqual(catalan, planIn('ca'));
    assert.deepEqual(english, planIn('en'));
    assert.deepEqual(skeleton(catalan), skeleton(english));
    assert.match(catalan.limitations[0], /^Això és una estimació aritmètica/);
    // The short summary is for the model and is English from end to end: it quotes the question in
    // its English wording, and the person's wording stays in nextQuestions.
    const summary = (catalanCall.content as { text: string }[])[0].text;
    assert.match(summary, /An arithmetic estimate, not mortgage approval or guaranteed aid\./);
    const [askedEn, askedCa] = [english.nextQuestions?.[0], catalan.nextQuestions?.[0]];
    assert(askedEn && askedCa && askedEn.question !== askedCa.question);
    assert(summary.includes(`Ask next, one question at a time: “${askedEn.question}” Why: ${askedEn.why}`), summary);
    for (const text of [askedCa.question, askedCa.why, askedCa.effect.text])
      assert(!summary.includes(text), `the English summary carries Catalan text: ${text}`);
    const spanishCall = await call('get_next_questions', { ...plan, locale: 'es' });
    const spanishText = (spanishCall.content as { text: string }[])[0].text;
    const askedEs = (spanishCall.structuredContent as { nextQuestions: { question: string; why: string }[] })
      .nextQuestions[0];
    assert(spanishText.includes(`“${askedEn.question}”`) && !spanishText.includes(askedEs.question), spanishText);
    assert.doesNotMatch(spanishText, /¿|Podría|espera|dinero/);
    // What the assistant says about answers that are not saved is in the person's language, apart from the summary.
    assert.match(
      String((catalanCall.structuredContent as { sayNotStored: string }).sayNotStored),
      /^Guardo les teves respostes només en aquesta conversa/,
    );
    assert.equal((catalanCall.structuredContent as { stored: boolean }).stored, false);

    // Only the host's locale, as ChatGPT sends it.
    const spanish = toolPlan((await call('plan_home_savings', plan, { 'openai/locale': 'es-ES' })).structuredContent);
    assert.deepEqual(spanish, planIn('es'));
    assert.match(spanish.limitations[0], /^Esto es una estimación aritmética/);
    // The argument wins over the host, and a language that is not one of the three is English.
    const argumentWins = await call('plan_home_savings', { ...plan, locale: 'ca' }, { 'openai/locale': 'es-ES' });
    assert.deepEqual(toolPlan(argumentWins.structuredContent), catalan);
    const french = await call('plan_home_savings', plan, { 'openai/locale': 'fr-FR' });
    assert.deepEqual(toolPlan(french.structuredContent), english);
    const refused = await client.callTool({ name: 'plan_home_savings', arguments: { ...plan, locale: 'fr' } });
    assert(refused.isError, 'a locale outside the three languages is refused by the schema');

    const questionsEs = (await call('get_next_questions', plan, { 'openai/locale': 'es-ES' })).structuredContent as {
      nextQuestions: { label: string; question: string }[];
    };
    assert.deepEqual(questionsEs.nextQuestions, spanish.nextQuestions);

    const placeCa = placeSchema.parse(
      (await call('get_place', { municipalityCode: talarn, locale: 'ca' })).structuredContent,
    );
    assert.deepEqual(placeCa, buildPlace(snapshot, talarn, 'ca'));

    const measures = async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
      incentivesResult.parse((await call(name, args, meta)).structuredContent);
    const incentivesEn = await measures('get_applicable_incentives', { municipalityCode: talarn });
    const incentivesCa = await measures('get_applicable_incentives', { municipalityCode: talarn, locale: 'ca' });
    const incentivesEs = await measures(
      'check_housing_incentives',
      { municipalityCode: talarn, intent: 'buy' },
      { 'openai/locale': 'es-ES' },
    );
    assert.deepEqual(skeleton(incentivesCa), skeleton(incentivesEn));
    assert.match(incentivesEn.limitations[0], /^Eligibility is a screening result/);
    assert.match(incentivesCa.limitations[0], /^L’elegibilitat és el resultat d’una comprovació/);
    assert.match(incentivesEs.limitations[0], /^La elegibilidad es el resultado de una comprobación/);
    assert(
      incentivesEs.incentives.every(item => item.intent === 'buy' && !/^(Reduced|Catalan|State) /.test(item.title)),
    );

    const profileEs = profileResult.parse(
      (await call('get_town_profile', { municipalityCode: talarn }, { 'openai/locale': 'es-ES' })).structuredContent,
    );
    const profileEn = profileResult.parse(
      (await call('get_town_profile', { municipalityCode: talarn })).structuredContent,
    );
    assert.deepEqual(skeleton(profileEs), skeleton(profileEn));
    assert.match(profileEs.nearbySchools.limitations[0], /^El directorio recoge las etapas autorizadas\./);
    assert.match(profileEn.nearbySchools.limitations[0], /^The directory records authorized stages\./);

    const recommended = recommendationResult.parse(
      (await call('recommend_towns', { ruralOnly: true, locale: 'ca' })).structuredContent,
    );
    assert(
      recommended.towns.every(item => item.matchReasons.some(text => /^Classificació rural oficial: /.test(text))),
    );
    const forProfile = (await call('recommend_towns_for_profile', { profile: { hasDog: true }, locale: 'es' }))
      .structuredContent as { profileAssessment: { verificationNeeded: string[]; ignoredCriteria?: string[] } };
    assert.match(forProfile.profileAssessment.verificationNeeded[0], /^Comprueba si se admiten animales/);
    // The language is not a search criterion that was skipped.
    assert.equal(forProfile.profileAssessment.ignoredCriteria, undefined);
  } finally {
    await close();
  }
});
