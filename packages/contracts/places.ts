import { z } from 'zod';

export const isoDate = z.iso.date();
export const clockTime = z.iso.time({ precision: -1 });
export const municipalityCode = z
  .string()
  .regex(/^\d{6}$/)
  .describe('Official six-digit Idescat municipal code');
export const source = z.object({ observedAt: z.string().min(1), sourceUrl: z.url() });
export const point = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
export const rural = z.enum(['rural', 'special_attention', 'partial', 'not_listed']);
export const schoolStage = z.enum(['nursery', 'infantil', 'primary', 'eso', 'batxillerat', 'fp']);

export const municipality = z.object({
  code: municipalityCode,
  name: z.string().min(1),
  comarca: z.string().min(1),
  recommendable: z.boolean(),
  identity: source,
  centre: point.extend(source.shape).extend({ name: z.string() }),
  rural: source.extend({ category: rural, effectiveFrom: isoDate.nullable(), legalUrl: z.url().optional() }),
});

export const metricKind = z.enum([
  'population',
  'resale_eur_per_m2',
  'resale_transactions',
  'rent_eur_per_month',
  'rent_contracts',
  'registered_unemployment',
  'resident_social_security_affiliates',
  'retail_establishments',
  'retail_per_1000',
]);
export const metric = source.extend({
  kind: metricKind,
  value: z.number().nonnegative(),
  unit: z.string().min(1),
  geography: z.enum(['municipality', 'comarca']),
  geographyName: z.string().min(1),
});
export const school = source.extend({
  id: z.string(),
  name: z.string(),
  municipalityCode,
  locality: z.union([z.string().min(1), z.null()]),
  public: z.boolean(),
  coordinates: point.nullable(),
  stages: z.array(schoolStage).nonempty(),
});

export const railStop = point.extend({ id: z.string(), name: z.string(), municipalityCode });
export const railRoute = source.extend({
  line: z.string(),
  from: railStop,
  to: railStop,
  departure: z.string(),
  arrival: z.string(),
  durationMinutes: z.number().int().nonnegative(),
});
export const railFeed = source.extend({
  validFrom: isoDate,
  validThrough: isoDate,
  stops: z.array(railStop).nonempty(),
  dates: z.record(isoDate, z.array(z.string())),
  trips: z
    .array(
      z.object({
        service: z.string(),
        line: z.enum(['RL1', 'RL2']),
        calls: z.array(z.tuple([z.string(), z.number().int().nonnegative(), z.number().int().nonnegative()])).min(2),
      }),
    )
    .nonempty(),
});

// Research evidence remains separate from official metrics and policy eligibility.
const researchLink = z.object({ label: z.string().min(1), url: z.url() });
export const relocationOpportunity = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.enum(['closed', 'filled', 'unverified', 'open_in_sources_checked', 'proposed']),
    checkedOn: isoDate,
    housingRentEurPerMonth: z
      .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
      .refine(value => value.min <= value.max, 'Invalid rent range')
      .nullable(),
    applicationDeadline: isoDate.nullable(),
    reportedDeadlineDates: z.array(isoDate),
    businessConcessionRequired: z.boolean(),
    baseBusinessFeeEurPerMonth: z.number().nonnegative().nullable(),
    response: z
      .object({
        metric: z.string(),
        approximateCount: z.number().nonnegative().optional(),
        greaterThan: z.number().nonnegative().optional(),
        reportedOn: isoDate.optional(),
      })
      .nullable(),
    notes: z.string(),
    sources: z.array(researchLink).nonempty(),
    visualReferences: z.array(researchLink.extend({ reuseRights: z.literal('unverified') })),
  })
  .refine(
    value => new Set(value.reportedDeadlineDates).size <= 1 || value.applicationDeadline === null,
    'Conflicting deadlines must remain unresolved',
  );
export const relocationTown = z.object({
  municipalityCode,
  name: z.string().min(1),
  opportunities: z.array(relocationOpportunity),
  connections: z.object({ summary: z.string(), sources: z.array(researchLink) }),
  rentalSearch: z.object({ status: z.literal('incomplete'), verifiedWholeHomeCount: z.null(), notes: z.string() }),
  socialObservations: z.object({
    paidAds: z.object({
      sourceUrl: z.url(),
      country: z.string(),
      resultsReviewed: z.number().int().nonnegative(),
      verifiedOfferAds: z.number().int().nonnegative(),
      coverage: z.literal('first_page_only'),
    }),
    publicPosts: z.array(researchLink),
  }),
  contacts: z.array(z.object({ organisation: z.string(), email: z.email().optional(), sourceUrl: z.url() })),
});
export const relocationDataset = z.object({
  schemaVersion: z.literal(1),
  checkedOn: isoDate,
  sourcePage: z.url(),
  municipalities: z.array(relocationTown),
  scopeNotes: z.array(z.string()),
});
export const relocationResult = z.object({
  coverage: z.enum(['researched', 'not_researched']),
  checkedOn: isoDate.nullable(),
  sourcePage: z.url().nullable(),
  asOf: isoDate,
  research: relocationTown.nullable(),
  opportunityChecks: z.array(
    z.object({
      id: z.string(),
      availability: z.enum(['closed', 'filled', 'proposed', 'needs_verification']),
      eligibilityStatus: z.literal('needs_verification'),
      checkedBeforeAsOf: z.boolean(),
      deadlinePassed: z.boolean(),
      conflictingDeadlines: z.boolean(),
    }),
  ),
  limitations: z.array(z.string()),
});

export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().min(1),
  generatedOn: isoDate,
  municipalities: z.array(municipality).nonempty(),
  townMetrics: z.record(municipalityCode, z.array(metric)),
  comarcaMetrics: z.record(z.string(), z.array(metric)),
  schools: z.array(school),
  schoolDirectory: source,
  rail: railFeed,
  relocation: relocationDataset.optional(),
});

export const intent = z.enum(['move', 'buy', 'rent', 'renovate']);
export const policyId = z.enum([
  'irpf_move',
  'irpf_buy',
  'irpf_rent',
  'irpf_renovate',
  'itp_buy',
  'renovation_grant_2026',
]);
/** An amount or rate that depends on the municipality's rural category. */
export const byRuralCategory = z
  .object({
    rural: z.number().nonnegative(),
    special_attention: z.number().nonnegative(),
    /** Municipalities that are neither; zero when the measure does not reach them. */
    other: z.number().nonnegative().default(0),
  })
  .strict();
/**
 * The machine-readable part of a policy: how it changes what a household pays or receives.
 * The planner turns this into fewer months of saving. `benefit` stays as the human summary.
 */
export const policyEffect = z.discriminatedUnion('kind', [
  /** A lower transfer-tax rate on the purchase, replacing `standardRate`. Rates are 0–1. */
  z
    .object({
      kind: z.literal('transfer_tax_rate'),
      standardRate: z.number().min(0).max(1),
      reducedRate: byRuralCategory,
    })
    .strict(),
  /** A single payment or deduction in euros. */
  z.object({ kind: z.literal('one_off_eur'), amount: byRuralCategory }).strict(),
  /** A fixed amount in euros every year, for at most `maxYears` (null: while conditions hold). */
  z
    .object({
      kind: z.literal('annual_eur'),
      amount: byRuralCategory,
      maxYears: z.number().int().positive().nullable(),
    })
    .strict(),
  /** A yearly percentage of a qualifying cost, on a capped base. Rates are 0–1. */
  z
    .object({
      kind: z.literal('annual_rate_of_cost'),
      cost: z.enum(['purchase_payments', 'rent', 'renovation']),
      rate: byRuralCategory,
      maxBaseEur: z.number().positive(),
    })
    .strict(),
  /** A real measure whose amount depends on facts ReloCat does not model. */
  z.object({ kind: z.literal('unquantified'), reason: z.string().min(1) }).strict(),
]);
export type PolicyEffect = z.infer<typeof policyEffect>;
export const policy = z.object({
  id: policyId,
  version: z.string(),
  title: z.string(),
  authority: z.string(),
  beneficiary: z.literal('household'),
  intent,
  mechanism: z.enum(['tax_deduction', 'reduced_tax_rate', 'grant']),
  effectiveFrom: isoDate,
  effectiveThrough: isoDate,
  sourceUrl: z.url(),
  legalUrl: z.url(),
  lastVerified: isoDate,
  benefit: z.string(),
  effect: policyEffect.optional(),
  notes: z.array(z.string()),
  municipalityCodes: z.array(municipalityCode).optional(),
});
export const eligibility = policy.extend({
  geographicStatus: z.enum(['applies', 'does_not_apply', 'needs_verification']),
  measureStatus: z.enum(['active', 'ended', 'upcoming', 'needs_verification']),
  callStatus: z.enum(['open', 'closed', 'upcoming', 'unknown']),
  eligibilityStatus: z.enum(['eligible', 'ineligible', 'needs_verification']),
  screenedAmountEur: z.number().positive().optional(),
  missingCriteria: z.array(z.string()),
  unmetCriteria: z.array(z.string()),
  nextStep: z.string(),
});

const optionalFact = (description: string) => z.boolean().describe(description).optional();
const taxBase = (description: string) => z.number().describe(description).optional();
export const household = z
  .object({
    primaryResidence: optionalFact("The property is or will be the taxpayer's habitual residence"),
    age: z.number().int().min(0).max(125).optional(),
    children: z
      .array(
        z.object({
          age: z.number().int().min(0).max(125),
          inDesignatedSchool: optionalFact(
            'Child is in the qualifying educational zone or designated affiliated school for IRPF',
          ),
          meetsItpSchooling: optionalFact(
            'Child meets the ITP school location, timing and continuing enrollment conditions',
          ),
        }),
      )
      .max(30)
      .optional()
      .describe('Dependent children for the applicable tax rule. An empty array explicitly means none.'),
    firstRuralMove: optionalFact('First move to a rural or special-attention rural municipality'),
    singleParent: optionalFact('Official single-parent family status'),
    filing: z.enum(['individual', 'joint']).optional(),
    irpfNetTaxBaseEur: taxBase(
      'Applicable IRPF return: general plus savings tax bases less personal and family minimums; use the joint amount for joint filing. This is not salary.',
    ),
    irpfIndividualNetTaxBaseEur: taxBase(
      "Claimant's individually computed current-year tax base after personal/family minimums, even with joint filing",
    ),
    itpFamilyNetTaxBaseEur: taxBase(
      'Combined net tax bases of family members on the last applicable IRPF return before the transaction',
    ),
    itpTransaction: optionalFact('Acquisition is subject to ITP/TPO and concerns a qualifying ownership or use right'),
    paysQualifyingRent: optionalFact(
      'Qualifying rent was paid during the tax year and landlord identification is available for the return; do not provide the identifier',
    ),
    satisfiesRentCompatibility: optionalFact(
      "The rural rent deduction is compatible with the claimant's other deductions",
    ),
    satisfiesPurchaseDeductionRules: optionalFact(
      'Confirmed IRPF occupancy, investment and patrimony tests, previous-deduction/reinvestment adjustments and transitional state deduction compatibility',
    ),
    satisfiesItpOccupancyRules: optionalFact(
      'Confirmed the applicable occupancy deadline and three-year habitual-residence requirement or an official exception',
    ),
    pre1970: optionalFact('Home was built before 1 January 1970'),
    satisfiesRehabilitationRules: optionalFact(
      'Confirmed structural-works cost threshold, qualifying expenses, license, occupancy, subsidy adjustments and deduction compatibility',
    ),
    ownerOfVacantHome: optionalFact(
      "Applicant is a private owner and the dwelling meets the call's vacancy requirement",
    ),
  })
  .strict();

export const incentivesInput = z
  .object({
    municipalityCode,
    intent: intent.optional().describe("Supply the user's action, or omit for the catalogue"),
    eventDate: isoDate
      .optional()
      .describe('Actual or planned transaction or qualifying event date in Catalonia; omit if unknown'),
    nucleus: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Official settlement name for partially covered municipalities, e.g. Palau de Noguera'),
    household: household.optional(),
  })
  .strict();

export const schoolJourney = z.object({
  school,
  mode: z.enum(['estimated_walk', 'scheduled_rail_with_estimated_walk', 'unknown']),
  straightLineKm: z.number().nonnegative().nullable(),
  estimatedMinutes: z.number().int().nonnegative().nullable(),
  rail: railRoute.optional(),
});
export const schoolQuery = z
  .object({
    municipalityCode,
    stage: schoolStage.optional(),
    travelDate: isoDate.optional(),
    arriveBy: clockTime.optional().describe('Latest estimated arrival at school. Defaults to 09:00 local time.'),
    mode: z
      .enum(['car_free', 'rail'])
      .optional()
      .describe('Car-free includes short estimated walks; rail requires a scheduled FGC service.'),
    maxJourneyMinutes: z.number().int().positive().max(240).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const transportQuery = z
  .object({
    municipalityCode,
    destinationCode: municipalityCode,
    travelDate: isoDate,
    departFrom: clockTime.optional(),
    departBy: clockTime.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const recommendationInput = z
  .object({
    housing: z
      .object({
        tenure: z.enum(['buy', 'rent']),
        maxBudgetEur: z.number().positive().max(50_000_000),
        homeSizeM2: z
          .number()
          .positive()
          .max(2000)
          .optional()
          .describe('Constructed floor area; required for a purchase budget'),
        allowComarcaEstimate: z
          .boolean()
          .optional()
          .describe('Use a clearly labelled comarca resale proxy only if the user accepts it'),
      })
      .strict()
      .optional(),
    schoolStages: z.array(schoolStage).max(6).optional(),
    schoolMode: z.enum(['car_free', 'rail']).optional(),
    maxSchoolJourneyMinutes: z.number().int().min(1).max(240).optional(),
    schoolArriveBy: clockTime.optional(),
    commute: z
      .object({
        destinationCode: municipalityCode,
        maxMinutes: z.number().int().min(1).max(360),
        departFrom: clockTime.optional(),
        departBy: clockTime.optional(),
      })
      .strict()
      .optional(),
    travelDate: isoDate.optional(),
    ruralOnly: z
      .boolean()
      .optional()
      .describe('Require full rural or special-attention status across the municipality'),
    comarca: z.string().trim().min(1).max(100).optional(),
    weights: z
      .object({
        affordability: z.number().min(0).max(10).optional(),
        schoolAccess: z.number().min(0).max(10).optional(),
        commute: z.number().min(0).max(10).optional(),
        rural: z.number().min(0).max(10).optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const relocationProfile = z
  .object({
    householdType: z
      .enum(['single', 'couple', 'family', 'shared'])
      .optional()
      .describe('Living arrangement supplied by the user. Do not infer children or housing needs from it.'),
    hasChildren: z
      .boolean()
      .optional()
      .describe('When true and schoolStages is omitted, prioritize the range of stages listed in town.'),
    schoolStages: recommendationInput.shape.schoolStages.describe('Required education stages, if known.'),
    hasDog: z
      .boolean()
      .optional()
      .describe('When true, flag pet permission and nearby walking areas for verification.'),
    workMode: z
      .enum(['remote', 'hybrid', 'on_site'])
      .optional()
      .describe('Remote and hybrid work prompt an address-level internet check.'),
    preferredSetting: z
      .enum(['rural', 'larger_town'])
      .optional()
      .describe(
        'Explicit preference. Rural uses official municipality-wide status. Larger town uses published population.',
      ),
  })
  .strict();

// Keep accepting old top-level arguments so cached clients still get a profile shortlist.
// Advertise that policy as a boolean for MCP clients that reject an empty subschema.
export const profileRecommendationInput = z
  .looseObject({
    profile: relocationProfile.describe('Confirmed lifestyle facts and optional town preference. Omit unknown facts.'),
    limit: recommendationInput.shape.limit,
  })
  .meta({ additionalProperties: true });

export const snapshotInfo = z.object({ version: z.string(), generatedOn: isoDate });
export const transportResult = z.object({
  snapshot: snapshotInfo,
  municipalityCode,
  destinationCode: municipalityCode,
  travelDate: isoDate,
  scheduleCoverage: z.enum(['covered', 'outside_snapshot']),
  totalDepartures: z.number().int().nonnegative(),
  routes: z.array(railRoute),
  limitations: z.array(z.string()),
});
export const schoolResult = z.object({
  snapshot: snapshotInfo,
  travelDate: isoDate,
  directory: source,
  schools: z.array(schoolJourney),
  limitations: z.array(z.string()),
});
export const recommendationResult = z.object({
  snapshot: snapshotInfo,
  travelDate: isoDate,
  towns: z.array(
    z.object({
      municipality,
      score: z.number().min(0).max(100).nullable(),
      matchReasons: z.array(z.string()),
      tradeoffs: z.array(z.string()),
      metrics: z.array(metric),
      housingEstimate: z.object({ amountEur: z.number(), metric }).nullable(),
      schools: z.array(schoolJourney),
      commute: z.object({ rail: railRoute, estimatedMinutes: z.number().int().nonnegative() }).nullable(),
      dataMissing: z.array(z.string()),
      incentives: z.array(eligibility),
      relocation: relocationResult,
    }),
  ),
  excluded: z.array(z.object({ municipalityCode, reasons: z.array(z.string()), dataMissing: z.array(z.string()) })),
  limitations: z.array(z.string()),
});

export const profileRecommendationResult = recommendationResult.extend({
  profileAssessment: z.object({
    status: z.enum(['ranked', 'exploratory', 'no_matches']),
    applied: z.array(z.string()),
    followUps: z.array(z.string()),
    verificationNeeded: z.array(z.string()),
    ignoredCriteria: z.array(z.string()).optional(),
  }),
});

export const profileInput = z.object({ municipalityCode, travelDate: isoDate.optional() }).strict();
export const destinationTravelEstimate = z.object({
  destinationId: z.enum(['lleida', 'barcelona', 'bcn_t1', 'bcn_t2', 'girona', 'girona_airport']),
  destination: z.string().min(1),
  car: source.extend({
    durationMinutes: z
      .number()
      .int()
      .positive()
      .describe('Approximate driving time from the town centre from a road network model without live traffic'),
  }),
  publicTransport: z
    .object({
      mode: z.enum(['train', 'bus', 'bus_and_train']),
      durationMinutes: z
        .number()
        .int()
        .positive()
        .describe('Approximate duration from sampled published journeys, including transfer waits where applicable'),
      sampleDate: isoDate,
      sampleCount: z.number().int().positive(),
      summary: z.string().min(1),
      sourceUrls: z.array(z.url()).nonempty(),
    })
    .nullable()
    .describe('Null means the demo has no verified public transport sample to this destination'),
});
export const travelEstimateData = z.record(municipalityCode, z.array(destinationTravelEstimate).nonempty());
export type TravelEstimateData = z.infer<typeof travelEstimateData>;

export const profileResult = z.object({
  snapshot: snapshotInfo,
  municipality,
  metrics: z.array(metric),
  comarcaMetrics: z.array(metric),
  nearbySchools: schoolResult,
  travelEstimates: z.array(destinationTravelEstimate).describe('Dated comparison estimates for selected demo towns'),
  relocation: relocationResult,
  railway: source.extend({
    stops: z.array(railStop),
    validThrough: isoDate,
    sampleConnectionToLleida: transportResult.nullable(),
  }),
  incentives: z.array(eligibility),
  dataMissing: z.array(z.string()),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type Municipality = z.infer<typeof municipality>;
export type Metric = z.infer<typeof metric>;
export type School = z.infer<typeof school>;
export type SchoolJourney = z.infer<typeof schoolJourney>;
export type RailRoute = z.infer<typeof railRoute>;
export type Policy = z.infer<typeof policy>;
export type IncentivesInput = z.infer<typeof incentivesInput>;
export type RecommendationInput = z.infer<typeof recommendationInput>;
export type ProfileRecommendationInput = z.infer<typeof profileRecommendationInput>;
export type SchoolQuery = z.infer<typeof schoolQuery>;
export type TransportQuery = z.infer<typeof transportQuery>;

export const municipalityListInput = z
  .object({
    query: z.string().trim().min(1).max(100).optional().describe('Match municipality name, six-digit code, or comarca'),
    ruralOnly: z.boolean().optional(),
  })
  .strict();
export const municipalityListResult = z.object({
  snapshot: snapshotInfo,
  municipalities: z.array(municipality),
  coverage: z.string(),
});

export const incentivesResult = z.object({
  snapshot: snapshotInfo,
  municipality,
  evaluatedOn: isoDate,
  asOf: isoDate,
  incentives: z.array(eligibility),
  limitations: z.array(z.string()),
});

export const businessResult = z.object({
  snapshot: snapshotInfo,
  municipality,
  metrics: z.array(metric),
  dataMissing: z.array(z.string()),
  limitations: z.array(z.string()),
});
