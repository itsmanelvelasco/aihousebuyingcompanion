import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberate demo coverage quotas, NOT estimated population frequencies.
const householdQuotas = [
  ['single', 150],
  ['couple', 100],
  ['couple_with_children', 140],
  ['single_parent', 70],
  ['multigenerational', 40],
] as const;
const towns = [
  ['Barcelona', 'Barcelona'],
  ["L'Hospitalet de Llobregat", 'Barcelona'],
  ['Badalona', 'Barcelona'],
  ['Sabadell', 'Barcelona'],
  ['Terrassa', 'Barcelona'],
  ['Mataró', 'Barcelona'],
  ['Manresa', 'Barcelona'],
  ['Vic', 'Barcelona'],
  ['Girona', 'Girona'],
  ['Figueres', 'Girona'],
  ['Olot', 'Girona'],
  ['Tarragona', 'Tarragona'],
  ['Reus', 'Tarragona'],
  ['Tortosa', 'Tarragona'],
  ['Lleida', 'Lleida'],
  ['Balaguer', 'Lleida'],
  ['La Seu d’Urgell', 'Lleida'],
] as const;
const employment = [
  'permanent_employee',
  'temporary_employee',
  'self_employed',
  'part_time_employee',
  'unemployed',
  'seasonal_worker',
  'retired',
] as const;
const creditCases = [
  'limited_history',
  'past_missed_payments',
  'high_existing_debt',
  'irregular_income_documentation',
  'no_reported_credit_issue',
] as const;

export async function generateUsers(outputDirectory = resolve('data/users'), overwrite = false) {
  await mkdir(outputDirectory, { recursive: true });
  const existing = (await readdir(outputDirectory)).filter(name => /^user-\d+$/.test(name));
  if (existing.length && !overwrite) {
    throw new Error('Profiles already exist. Use --overwrite only to reset synthetic fixtures.');
  }
  let state = 20261121;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const integer = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T => values[integer(0, values.length - 1)]!;
  const households: string[] = householdQuotas.flatMap(([type, count]) => Array<string>(count).fill(type));
  // biome-ignore lint/suspicious/noExplicitAny: generated fixture sections have evolving, loosely typed fields
  const records: Record<string, any>[] = [];
  for (let i = households.length - 1; i > 0; i--) {
    const j = integer(0, i);
    [households[i], households[j]] = [households[j]!, households[i]!];
  }
  for (let index = 0; index < 500; index++) {
    const id = `user-${String(index + 1).padStart(3, '0')}`;
    const householdType = households[index]!;
    const dependants = ['couple_with_children', 'single_parent', 'multigenerational'].includes(householdType)
      ? integer(1, 3)
      : 0;
    const adults =
      householdType === 'single' || householdType === 'single_parent'
        ? 1
        : householdType === 'multigenerational'
          ? 3
          : 2;
    const householdSize = adults + dependants;
    const age =
      householdType === 'multigenerational' ? integer(40, 72) : index % 20 === 0 ? integer(60, 72) : integer(21, 59);
    const employmentStatus = age >= 67 ? 'retired' : pick(employment.filter(value => value !== 'retired'));
    const [currentMunicipality, province] = pick(towns);
    const creditStatus = creditCases[index % creditCases.length]!;
    const income =
      (employmentStatus === 'unemployed'
        ? integer(650, 1300)
        : employmentStatus === 'retired'
          ? integer(950, 2000)
          : integer(1100, 2700)) *
        100 +
      (adults > 1 ? integer(400, 1500) * 100 : 0);
    const debtPayments = creditStatus === 'high_existing_debt' ? Math.round(income * 0.24) : integer(0, 220) * 100;
    const monthlyExpenses = Math.round(income * (integer(68, 103) / 100));
    const targetPrice = integer(85, 260) * 100000;
    const estimatedUpfrontCash = Math.round(targetPrice * 0.3);
    const balance = Math.round((estimatedUpfrontCash * integer(1, 65)) / 100);
    // What the household says it has set aside for the purchase: a share of the account balance
    // (60 to 90%, the rest stays for rent, bills and a reserve), in whole euros. It is derived from
    // the index, not drawn from the generator, so adding it changed no other field of any fixture.
    const purchaseSavings = Math.floor((balance * (60 + ((index * 7) % 31))) / 10_000) * 100;
    const barriers = ['insufficient_upfront_savings'];
    if (creditStatus !== 'no_reported_credit_issue') barriers.push(creditStatus);
    if (['temporary_employee', 'seasonal_worker', 'self_employed', 'unemployed'].includes(employmentStatus))
      barriers.push('income_instability');
    if (income - monthlyExpenses - debtPayments <= 0) barriers.push('non_positive_monthly_cashflow');
    const childAges = Array.from({ length: dependants }, () => integer(0, Math.min(17, age - 18)));
    const schoolStages = [
      ...new Set(
        childAges.map(value =>
          value < 3
            ? 'nursery'
            : value < 6
              ? 'infantil'
              : value < 12
                ? 'primary'
                : value < 16
                  ? 'ESO'
                  : 'post_compulsory',
        ),
      ),
    ];
    const hasCar = random() < 0.57;
    const remoteDays = ['unemployed', 'retired', 'seasonal_worker'].includes(employmentStatus) ? 0 : integer(0, 5);
    const common = { schemaVersion: 1, synthetic: true, snapshotDate: '2026-11-21' };
    const details = {
      ...common,
      id,
      name: `Fictional household ${String(index + 1).padStart(3, '0')}`,
      age,
      householdType,
      householdSize,
      dependants,
      dependantAges: childAges,
      currentMunicipality,
      province,
      employmentStatus,
      monthlyIncomeCents: income,
      incomeScope: 'whole_household',
      workMunicipality: ['unemployed', 'retired'].includes(employmentStatus) ? null : currentMunicipality,
      remoteWorkDaysPerWeek: remoteDays,
      currentHousing: pick(['private_rental', 'shared_rental', 'living_with_family']),
      purchaseGoal: 'primary_residence',
      creditHistory: {
        status: creditStatus,
        barriers,
        assessmentType: 'fictional_scenario_not_lender_assessment',
        numericScore: null,
      },
      financialBarriers: barriers,
      accessibilityNeeds: index % 13 === 0 ? ['step_free_access'] : [],
      demographicProvenance: 'data/users/README.md',
    };
    const preferences = {
      ...common,
      userId: id,
      goal: 'buy_primary_home',
      region: 'Catalunya',
      targetPurchasePriceCents: targetPrice,
      housingBudgetCents: targetPrice,
      purchaseSavingsCents: purchaseSavings,
      minimumBedrooms: Math.max(1, Math.ceil(householdSize / 2)),
      preferredPropertyType: pick(['flat', 'house', 'either']),
      schoolStages,
      hasCar,
      requiresPublicTransport: !hasCar,
      maxCommuteMinutes: integer(3, 9) * 10,
      workTripsPerWeek: ['unemployed', 'retired'].includes(employmentStatus) ? 0 : 5 - remoteDays,
      ruralPreference: pick(['open_to_rural', 'small_town', 'near_city', 'no_preference']),
      priorities: [
        pick(['lower_housing_cost', 'public_transport', 'healthcare_access', 'local_jobs']),
        dependants ? 'school_access' : pick(['nature_access', 'community', 'shops_and_services']),
      ],
      incentiveEligibility: 'needs_verification',
      relocationWithinMonths: integer(6, 36),
      mortgageApprovalStatus: 'not_assessed',
    };
    const bankAccount = {
      ...common,
      userId: id,
      currency: 'EUR',
      dataSource: 'simulated',
      balanceCents: balance,
      monthlyIncomeCents: income,
      monthlyExpensesCents: monthlyExpenses,
      debtPaymentsCents: debtPayments,
      monthlyNetCashflowCents: income - monthlyExpenses - debtPayments,
      expensesExcludeDebtPayments: true,
      estimatedUpfrontCashCents: estimatedUpfrontCash,
      purchaseCostAssumption: 'Illustrative 30% of target price; not a verified tax or lending rule.',
      accounts: [
        {
          id: `${id}-demo-current`,
          type: 'current',
          balanceCents: balance,
          currency: 'EUR',
          provider: 'fictional-demo-bank',
        },
      ],
      credentialsStored: false,
    };
    const directory = join(outputDirectory, id);
    records.push({ id, details, preferences, bankAccount });
    await mkdir(directory, { recursive: true });
    for (const [file, content] of Object.entries({ details, preferences, 'bank-account': bankAccount })) {
      await writeFile(join(directory, `${file}.json`), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
    }
  }
  const exportDirectory = resolve(outputDirectory, '..');
  await writeFile(
    join(exportDirectory, 'synthetic-users.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        synthetic: true,
        seed: 20261121,
        count: records.length,
        users: records,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const headers = [
    'id',
    'synthetic',
    'age',
    'householdType',
    'householdSize',
    'dependants',
    'currentMunicipality',
    'province',
    'employmentStatus',
    'monthlyIncomeCents',
    'balanceCents',
    'monthlyExpensesCents',
    'debtPaymentsCents',
    'monthlyNetCashflowCents',
    'targetPurchasePriceCents',
    'purchaseSavingsCents',
    'creditHistoryStatus',
    'financialBarriers',
    'schoolStages',
    'requiresPublicTransport',
    'maxCommuteMinutes',
    'ruralPreference',
  ];
  const escapeCsv = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = records.map(({ id, details: d, preferences: p, bankAccount: b }) =>
    [
      id,
      true,
      d.age,
      d.householdType,
      d.householdSize,
      d.dependants,
      d.currentMunicipality,
      d.province,
      d.employmentStatus,
      d.monthlyIncomeCents,
      b.balanceCents,
      b.monthlyExpensesCents,
      b.debtPaymentsCents,
      b.monthlyNetCashflowCents,
      p.targetPurchasePriceCents,
      p.purchaseSavingsCents,
      d.creditHistory.status,
      d.financialBarriers.join(';'),
      p.schoolStages.join(';'),
      p.requiresPublicTransport,
      p.maxCommuteMinutes,
      p.ruralPreference,
    ]
      .map(escapeCsv)
      .join(','),
  );
  await writeFile(
    join(exportDirectory, 'synthetic-users.csv'),
    `${[headers.join(','), ...rows].join('\r\n')}\r\n`,
    'utf8',
  );
  return { count: 500, seed: 20261121, directory: outputDirectory };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await generateUsers(resolve('data/users'), process.argv.includes('--overwrite'))));
}
