import type { Place, PlacePlan, PlanResult } from '../../../packages/contracts/planner.ts';

/**
 * A hand-written `PlanResult` that matches `packages/contracts/planner.ts`. It exists for tests and
 * for the `?fixture=1` preview only: the figures are illustrative, not planner output, and the
 * workspace never shows it unless fixture mode was asked for.
 */
const idescat = (code: string) => `https://www.idescat.cat/emex/?id=${code}`;
const prices = 'https://habitatge.gencat.cat/ca/dades/estadistiques_publicacions/indicadors_estadistiques/';
const taxRules = 'https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/';
const deductions = 'https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/';
const grant = 'https://tramits.gencat.cat/ca/tramits/tramits-temes/Rehabilitacio_entorn_rural';
const services = 'https://analisi.transparenciacatalunya.cat/d/8gmd-gz7i';

type Geography = 'municipality' | 'comarca';
const figure = (value: number, unit: string, sourceUrl: string, geography: Geography = 'municipality') => ({
  value,
  unit,
  geography,
  observedAt: '2025',
  sourceUrl,
});
const service = (kind: Place['services'][number]['kind'], count: number, observedAt = '2026-10-01') => ({
  kind,
  count,
  observedAt,
  sourceUrl: services,
});

const ager: PlacePlan = {
  place: {
    municipalityCode: '250024',
    name: 'Àger',
    comarca: 'Noguera',
    rural: 'rural',
    centre: { latitude: 42.0003, longitude: 0.7636 },
    indicators: {
      population: figure(612, 'residents', idescat('250024')),
      densityPerKm2: figure(3.8, 'residents/km²', idescat('250024')),
      foreignPopulationPercent: figure(9.6, '%', idescat('250024')),
      resaleEurPerM2: figure(1050, 'EUR/m²', prices, 'comarca'),
      rentEurPerMonth: null,
    },
    services: [
      service('primary_care', 1),
      service('pharmacy', 1),
      service('school', 1, '2026-09-15'),
      service('rail_station', 1, '2026-06-30'),
    ],
    dataMissing: ['No municipal rent average is published for Àger.'],
  },
  status: 'estimated',
  purchasePriceCents: 9_450_000,
  priceBasis: 'comarca_eur_per_m2',
  baseline: { upfrontCashCents: 3_024_000, monthlySavingsCents: 75_000, months: 24 },
  withHabits: { upfrontCashCents: 3_024_000, monthlySavingsCents: 90_500, months: 20 },
  withPlaceBenefits: { upfrontCashCents: 2_551_500, monthlySavingsCents: 90_500, months: 15 },
  monthsSaved: 9,
  monthsSavedByHabits: 4,
  monthsSavedByPlace: 5,
  benefits: [
    {
      policyId: 'itp_buy',
      title: 'Reduced ITP on a rural primary-home purchase',
      kind: 'upfront_cost_reduction',
      amountCents: 472_500,
      eligibilityStatus: 'eligible',
      callStatus: 'unknown',
      counted: true,
      sourceUrl: taxRules,
      explanation:
        'Àger is listed as rural, so the transfer tax falls from 10% to 5% of the price on the supplied facts.',
    },
    {
      policyId: 'irpf_buy',
      title: 'Catalan IRPF deduction for buying a rural primary home',
      kind: 'annual_cash',
      amountCents: 120_000,
      eligibilityStatus: 'needs_verification',
      callStatus: 'unknown',
      counted: false,
      sourceUrl: deductions,
      explanation: 'Depends on taxable income and on the home becoming the habitual residence; neither is confirmed.',
    },
    {
      policyId: 'renovation_grant_2026',
      title: '2026 rural and mountain housing rehabilitation grant',
      kind: 'one_off_cash',
      amountCents: null,
      eligibilityStatus: 'needs_verification',
      callStatus: 'closed',
      counted: false,
      sourceUrl: grant,
      explanation: 'The 2026 call is closed and the amount depends on the works budget, which is not known.',
    },
    {
      policyId: 'irpf_move',
      title: 'Catalan IRPF deduction for moving to a rural municipality',
      kind: 'one_off_cash',
      amountCents: null,
      eligibilityStatus: 'ineligible',
      callStatus: 'unknown',
      counted: false,
      sourceUrl: deductions,
      explanation: 'The move does not meet the work-related conditions stated in the rule.',
    },
  ],
  assumptions: [
    'Home of 90 m² priced at the Noguera comarca average because Àger has no municipal figure.',
    'Deposit of 20% and purchase fees of 2% of the price.',
    'The €6,000 emergency reserve is not spent on the purchase.',
  ],
  dataMissing: ['Municipal resale price per m² for Àger.'],
};

const balaguer: PlacePlan = {
  place: {
    municipalityCode: '250404',
    name: 'Balaguer',
    comarca: 'Noguera',
    rural: 'not_listed',
    centre: { latitude: 41.7897, longitude: 0.8053 },
    indicators: {
      population: figure(17_597, 'residents', idescat('250404')),
      densityPerKm2: figure(306.6, 'residents/km²', idescat('250404')),
      foreignPopulationPercent: figure(23.4, '%', idescat('250404')),
      resaleEurPerM2: figure(1150, 'EUR/m²', prices),
      rentEurPerMonth: figure(468, 'EUR/month', prices),
    },
    services: [
      service('primary_care', 1),
      service('hospital', 0),
      service('pharmacy', 7),
      service('school', 9, '2026-09-15'),
      service('library', 1, '2026-05-01'),
      service('rail_station', 1, '2026-06-30'),
    ],
    dataMissing: [],
  },
  status: 'estimated',
  purchasePriceCents: 10_350_000,
  priceBasis: 'municipal_eur_per_m2',
  baseline: { upfrontCashCents: 3_312_000, monthlySavingsCents: 75_000, months: 28 },
  withHabits: { upfrontCashCents: 3_312_000, monthlySavingsCents: 90_500, months: 23 },
  withPlaceBenefits: { upfrontCashCents: 3_312_000, monthlySavingsCents: 90_500, months: 23 },
  monthsSaved: 5,
  monthsSavedByHabits: 5,
  monthsSavedByPlace: 0,
  benefits: [
    {
      policyId: 'itp_buy',
      title: 'Reduced ITP on a rural primary-home purchase',
      kind: 'upfront_cost_reduction',
      amountCents: null,
      eligibilityStatus: 'ineligible',
      callStatus: 'unknown',
      counted: false,
      sourceUrl: taxRules,
      explanation: 'Balaguer is not on the list of rural municipalities, so the standard 10% rate applies.',
    },
  ],
  assumptions: [
    'Home of 90 m² priced at the Balaguer municipal average.',
    'Deposit of 20% and purchase fees of 2% of the price.',
    'The €6,000 emergency reserve is not spent on the purchase.',
  ],
  dataMissing: [],
};

const camarasa: PlacePlan = {
  place: {
    municipalityCode: '250621',
    name: 'Camarasa',
    comarca: 'Noguera',
    rural: 'special_attention',
    centre: { latitude: 41.8747, longitude: 0.8786 },
    indicators: {
      population: figure(842, 'residents', idescat('250621')),
      densityPerKm2: figure(2.7, 'residents/km²', idescat('250621')),
      foreignPopulationPercent: null,
      resaleEurPerM2: null,
      rentEurPerMonth: null,
    },
    services: [service('pharmacy', 1)],
    dataMissing: ['Share of foreign residents.', 'Resale price per m², municipal and comarca.'],
  },
  status: 'insufficient_data',
  purchasePriceCents: null,
  priceBasis: 'unknown',
  baseline: null,
  withHabits: null,
  withPlaceBenefits: null,
  monthsSaved: null,
  monthsSavedByHabits: null,
  monthsSavedByPlace: null,
  benefits: [
    {
      policyId: 'itp_buy',
      title: 'Reduced ITP on a rural primary-home purchase',
      kind: 'upfront_cost_reduction',
      amountCents: null,
      eligibilityStatus: 'needs_verification',
      callStatus: 'unknown',
      counted: false,
      sourceUrl: taxRules,
      explanation: 'Camarasa is a special-attention municipality, but no price is available to compute the saving.',
    },
  ],
  assumptions: [],
  dataMissing: ['No price per m² is available, so no purchase price or timeline can be estimated.'],
};

export const fixturePlan: PlanResult = {
  person: {
    id: 'user-001',
    displayName: 'Marta Soler',
    synthetic: true,
    householdSize: 3,
    currentMunicipalityCode: '251207',
    finances: {
      monthlyIncomeCents: 320_000,
      monthlyExpensesCents: 245_000,
      currentSavingsCents: 1_850_000,
      emergencyReserveCents: 600_000,
      basis: 'mixed',
      asOf: '2026-11-01',
    },
    home: { floorAreaM2: 90, budgetCents: null, depositRate: 0.2 },
    habits: [
      {
        id: 'cook-at-home',
        title: 'Cook at home on weekdays',
        category: 'food',
        monthlySavingCents: 12_000,
        status: 'active',
        adherence: 0.82,
      },
      {
        id: 'drop-unused-subscriptions',
        title: 'Drop two unused subscriptions',
        category: 'subscriptions',
        monthlySavingCents: 3_500,
        status: 'active',
        adherence: 1,
      },
      {
        id: 'monthly-rail-pass',
        title: 'Swap the car commute for a rail pass',
        category: 'transport',
        monthlySavingCents: 6_000,
        status: 'proposed',
        adherence: null,
      },
      {
        id: 'review-insurance',
        title: 'Review home and car insurance',
        category: 'other',
        monthlySavingCents: null,
        status: 'paused',
        adherence: 0.4,
      },
    ],
  },
  asOf: '2026-11-22',
  plans: [ager, balaguer, camarasa],
  limitations: [
    'This is an estimate of upfront cash, not a mortgage assessment or an offer of finance.',
    'Benefits are screened on declared facts; confirm eligibility with the administration before relying on them.',
    'Prices are area averages, not listings.',
  ],
};

/** The same result for a person who saves nothing each month: every timeline exists but has no end. */
export const fixtureNoSavings: PlanResult = {
  ...fixturePlan,
  person: {
    ...fixturePlan.person,
    finances: { ...fixturePlan.person.finances, monthlyExpensesCents: 335_000 },
    habits: [],
  },
  plans: fixturePlan.plans.map(plan =>
    plan.baseline && plan.withHabits && plan.withPlaceBenefits
      ? {
          ...plan,
          status: 'no_positive_savings' as const,
          baseline: { ...plan.baseline, monthlySavingsCents: -15_000, months: null },
          withHabits: { ...plan.withHabits, monthlySavingsCents: -15_000, months: null },
          withPlaceBenefits: { ...plan.withPlaceBenefits, monthlySavingsCents: -15_000, months: null },
          monthsSaved: null,
          monthsSavedByHabits: null,
          monthsSavedByPlace: null,
        }
      : plan,
  ),
};
