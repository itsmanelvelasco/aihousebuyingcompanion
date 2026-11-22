import { z } from 'zod';
import { safeId } from './ids.ts';
import { household, isoDate, municipalityCode, policyId, rural, serviceKind } from './places.ts';

/**
 * ReloCat's two core entities and the plan that joins them.
 *
 * A **person** is a household with finances and habits. A **place** is a municipality node with
 * indicators and benefits. A **plan** answers one question: how long until this person has the
 * upfront cash to buy in this place, and how much sooner because of what the place offers.
 *
 * Money is integer EUR cents throughout. Unknown facts are `null`, never zero.
 */
const cents = z.number().int().safe();
const positiveCents = cents.nonnegative();
const sourced = z.object({ observedAt: z.string().min(1), sourceUrl: z.url() });

// ---------------------------------------------------------------- person

export const habitCategory = z.enum([
  'housing',
  'food',
  'transport',
  'utilities',
  'subscriptions',
  'healthcare',
  'education',
  'debt',
  'other',
]);

/** A habit is something the person does repeatedly that changes how much they save each month. */
export const habit = z
  .object({
    id: safeId,
    title: z.string().trim().min(1).max(80),
    category: habitCategory,
    /** The person's own estimate of the monthly effect. Null means no saving is assumed. */
    monthlySavingCents: positiveCents.nullable(),
    status: z.enum(['proposed', 'active', 'paused']),
    /** Share of planned check-ins completed, 0–1, when check-ins exist. */
    adherence: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const person = z
  .object({
    id: safeId,
    displayName: z.string().trim().min(1).max(80).optional(),
    synthetic: z.boolean(),
    /** Facts used to screen incentives. Missing facts keep eligibility at needs_verification. */
    household: household.optional(),
    householdSize: z.number().int().min(1).max(30).nullable(),
    currentMunicipalityCode: municipalityCode.nullable(),
    finances: z
      .object({
        monthlyIncomeCents: positiveCents.nullable(),
        monthlyExpensesCents: positiveCents.nullable(),
        currentSavingsCents: positiveCents.nullable(),
        /** Cash the person keeps aside and does not spend on the purchase. */
        emergencyReserveCents: positiveCents,
        /** Where the figures came from: declared in the interview or observed in bank movements. */
        basis: z.enum(['declared', 'bank_observed', 'mixed', 'unknown']),
        asOf: isoDate.nullable(),
      })
      .strict(),
    home: z
      .object({
        floorAreaM2: z.number().positive().max(2000).nullable(),
        /** Explicit purchase budget. When null the plan prices the home from the place's EUR/m². */
        budgetCents: positiveCents.nullable(),
        /** Share of the price paid upfront as a deposit. */
        depositRate: z.number().min(0).max(1).default(0.2),
      })
      .strict(),
    habits: z.array(habit).max(20),
  })
  .strict();
export type Person = z.infer<typeof person>;
export type Habit = z.infer<typeof habit>;

// ----------------------------------------------------------------- place

/** A number about a place with its own source, date and geography. */
export const indicator = sourced.extend({
  value: z.number(),
  unit: z.string().min(1),
  geography: z.enum(['municipality', 'comarca']),
});

/** Something a place offers that changes the cost or the timeline of buying there. */
export const placeBenefit = z
  .object({
    policyId,
    title: z.string(),
    /** How the benefit acts on the plan. */
    kind: z.enum(['upfront_cost_reduction', 'one_off_cash', 'annual_cash', 'unquantified']),
    /** Screened amount for this person and place. Null when it cannot be computed from known facts. */
    amountCents: positiveCents.nullable(),
    eligibilityStatus: z.enum(['eligible', 'ineligible', 'needs_verification']),
    callStatus: z.enum(['open', 'closed', 'upcoming', 'unknown']),
    /** True only when the amount was counted in the plan. Unverified benefits are shown, not counted. */
    counted: z.boolean(),
    /**
     * `place`: something this place offers. `anywhere`: a measure that applies in every municipality
     * of Catalonia; it can lower the person's baseline and is never counted as a saving of the place.
     * Absent in results produced before this field existed, where every benefit is of the place.
     */
    scope: z.enum(['place', 'anywhere']).optional(),
    sourceUrl: z.url(),
    explanation: z.string(),
  })
  .strict();

export const place = z
  .object({
    municipalityCode,
    name: z.string(),
    comarca: z.string(),
    rural,
    centre: z.object({ latitude: z.number(), longitude: z.number() }),
    indicators: z
      .object({
        population: indicator.nullable(),
        densityPerKm2: indicator.nullable(),
        /** Residents with foreign nationality as a share of all residents, 0–100. */
        foreignPopulationPercent: indicator.nullable(),
        resaleEurPerM2: indicator.nullable(),
        rentEurPerMonth: indicator.nullable(),
      })
      .strict(),
    /** Counts of services in the municipality; a missing kind is unknown, not zero. */
    services: z.array(sourced.extend({ kind: serviceKind, count: z.number().int().nonnegative() })),
    dataMissing: z.array(z.string()),
  })
  .strict();
export type Place = z.infer<typeof place>;
export type PlaceBenefit = z.infer<typeof placeBenefit>;

// ------------------------------------------------------------------ plan

export const planAssumptions = z
  .object({
    /** Notary, registry and similar purchase costs as a share of the price. */
    purchaseFeesRate: z.number().min(0).max(0.2).default(0.02),
    /** Count benefits whose eligibility still needs verification. Off by default. */
    includeUnverifiedBenefits: z.boolean().default(false),
    /** Count the monthly saving of habits that are only proposed. Off by default. */
    includeProposedHabits: z.boolean().default(false),
    asOf: isoDate.optional(),
  })
  .strict();

const timeline = z.object({
  upfrontCashCents: positiveCents,
  monthlySavingsCents: cents,
  /** Null when savings are zero, negative or unknown: there is no finite timeline. */
  months: z.number().int().nonnegative().nullable(),
});

export const placePlan = z
  .object({
    place,
    status: z.enum(['estimated', 'target_reached', 'no_positive_savings', 'insufficient_data']),
    purchasePriceCents: positiveCents.nullable(),
    priceBasis: z.enum(['budget', 'municipal_eur_per_m2', 'comarca_eur_per_m2', 'unknown']),
    /**
     * The transfer tax behind the baseline. `standardCents` is the general tax on the price;
     * `baselineCents` is what the person pays anywhere in Catalonia: the general tax, or the lower
     * rate of `baselinePolicyId` when every condition of that Catalonia-wide policy is verified.
     * `couldBeLower`: such a rate exists but is unverified, so the baseline may overstate the tax.
     * Null when the price or the general rate is unknown.
     */
    transferTax: z
      .object({
        standardCents: positiveCents,
        baselineCents: positiveCents,
        baselinePolicyId: policyId.nullable(),
        couldBeLower: z.boolean(),
      })
      .strict()
      .nullable()
      .optional(),
    /** The transfer tax the person would pay anywhere in Catalonia, no place benefits, no habits. */
    baseline: timeline.nullable(),
    /** The person's active habits, still without place benefits. */
    withHabits: timeline.nullable(),
    /** Habits plus the counted benefits of this place. */
    withPlaceBenefits: timeline.nullable(),
    /** baseline.months − withPlaceBenefits.months, when both are finite. */
    monthsSaved: z.number().int().nullable(),
    monthsSavedByHabits: z.number().int().nullable(),
    monthsSavedByPlace: z.number().int().nullable(),
    benefits: z.array(placeBenefit),
    assumptions: z.array(z.string()),
    dataMissing: z.array(z.string()),
  })
  .strict();
export type PlacePlan = z.infer<typeof placePlan>;

export const planInput = z
  .object({
    /** A stored person. Either this or `person` is required. */
    userId: safeId.optional(),
    person: person.optional(),
    /** Places to compare, at most eight. */
    municipalityCodes: z.array(municipalityCode).min(1).max(8),
    assumptions: planAssumptions.optional(),
  })
  .strict();

export const planResult = z
  .object({
    person,
    asOf: isoDate,
    /** Sorted by the shortest finite timeline with place benefits; places without one come last. */
    plans: z.array(placePlan),
    limitations: z.array(z.string()),
  })
  .strict();
export type PlanResult = z.infer<typeof planResult>;
