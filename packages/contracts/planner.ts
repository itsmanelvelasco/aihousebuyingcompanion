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
    /**
     * The day the person started the habit. When the monthly figures were observed in bank movements,
     * a habit counts on top of them only if it started after the observed period ended; without this
     * date the plan cannot tell whether the saving is already inside the observed figures.
     */
    startedOn: isoDate.optional(),
  })
  .strict();

/**
 * What is known about one question of the shared question set (`packages/model/questions.ts`),
 * keyed by question id in `person.answers`.
 * - `known`: a confirmed answer the plan can use.
 * - `said_unknown`: the person was asked and said they do not know. It is not asked again as new.
 * - `unconfirmed`: a value exists but nobody confirmed it, so the plan does not rely on it.
 * - `conflict`: confirmed answers disagree; `candidates` lists them and the plan uses none.
 */
export const factAnswer = z
  .object({
    status: z.enum(['known', 'said_unknown', 'unconfirmed', 'conflict']),
    /** `what_if`: typed into a page or said in chat for an estimate, stored nowhere. */
    source: z.enum(['profile', 'interview', 'manual', 'bank', 'listing', 'what_if']).optional(),
    /** When the answer was given, as an ISO date or date-time. */
    observedAt: z.string().optional(),
    /** Whether the person confirmed it. A plan figure can be used unconfirmed; a household fact cannot. */
    confirmed: z.boolean().optional(),
    candidates: z
      .array(
        z
          .object({
            value: z.unknown(),
            source: z.string(),
            observedAt: z.string(),
            confirmed: z.boolean(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
export type FactAnswer = z.infer<typeof factAnswer>;

/** Where one monthly figure came from. */
export const figureBasis = z.enum(['declared', 'bank_observed', 'unknown']);

export const person = z
  .object({
    id: safeId,
    displayName: z.string().trim().min(1).max(80).optional(),
    synthetic: z.boolean(),
    /** Facts used to screen incentives. Missing facts keep eligibility at needs_verification. */
    household: household.optional(),
    /**
     * Dates of birth, when known. The plan derives `household.age` and `household.children` from
     * them on its own date, so an age never goes stale; where both are given, these win. A child with
     * only a birth year is taken at the age reached during the plan year, the cautious reading of a
     * rule with an upper age limit. Inline what-if persons can keep stating plain ages in `household`.
     */
    born: z
      .object({
        self: isoDate.optional(),
        children: z
          .array(
            z
              .object({
                birthDate: isoDate.optional(),
                birthYear: z.number().int().min(1900).max(2200).optional(),
                age: z.number().int().min(0).max(125).optional(),
                inDesignatedSchool: z.boolean().optional(),
                meetsItpSchooling: z.boolean().optional(),
              })
              .strict(),
          )
          .max(30)
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * Provenance of the answers behind this person, by question id: where each came from, when it was
     * given, and which questions were answered "I don't know" or are in conflict. Absent on a person
     * that carries no provenance (an inline person, a person built before the field existed).
     */
    answers: z.record(z.string(), factAnswer).optional(),
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
        /**
         * Where each of the two monthly figures came from. `basis` summarises them; these say which
         * one is which, so the plan knows whether spending was observed in bank movements. Absent on
         * persons built before the fields existed.
         */
        incomeBasis: figureBasis.optional(),
        expensesBasis: figureBasis.optional(),
        /**
         * Whether the bank movements behind a bank-observed figure are fabricated: true for a
         * fictional bank feed, false for real bank data, null or absent when no figure came from a bank.
         * It is separate from `synthetic`: a real person can be connected to a fictional bank.
         */
        bankSynthetic: z.boolean().nullable().optional(),
        /**
         * The upfront cash the person said they are aiming for, when they stated one. The plan shows
         * it next to the upfront cash it computes and says how the two relate; the timeline always
         * uses the computed figure, so a stated target never replaces the arithmetic in silence.
         */
        targetCashCents: positiveCents.nullable().optional(),
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

/**
 * A person as a tool accepts it inline: the same entity, with every field optional. `id` defaults
 * to `what-if`, `synthetic` to false, and everything else to unknown or empty, so an assistant can
 * start with `{}` and add each answer as it is given. Unknown stays `null`, never zero. `basis` may
 * be left out: `inlinePerson` (`packages/model/person.ts`) reads figures said in a conversation as
 * declared. The result of parsing is completed by `inlinePerson`, never used as it is.
 */
export const personInput = person
  .extend({
    id: safeId.default('what-if'),
    synthetic: z.boolean().default(false),
    householdSize: person.shape.householdSize.default(null),
    currentMunicipalityCode: person.shape.currentMunicipalityCode.default(null),
    finances: person.shape.finances
      .extend({
        monthlyIncomeCents: positiveCents.nullable().default(null),
        monthlyExpensesCents: positiveCents.nullable().default(null),
        currentSavingsCents: positiveCents.nullable().default(null),
        emergencyReserveCents: positiveCents.default(0),
        basis: person.shape.finances.shape.basis.optional(),
        asOf: isoDate.nullable().default(null),
      })
      .strict()
      .prefault({}),
    home: person.shape.home
      .extend({
        floorAreaM2: person.shape.home.shape.floorAreaM2.default(null),
        budgetCents: positiveCents.nullable().default(null),
      })
      .strict()
      .prefault({}),
    habits: z
      .array(habit.extend({ adherence: habit.shape.adherence.default(null) }).strict())
      .max(20)
      .default([]),
  })
  .strict();
export type PersonInput = z.input<typeof personInput>;

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
    /**
     * What the measure is worth to this person in this place. Null when it cannot be computed from
     * the known facts, and null when the person is screened ineligible: an amount they would not
     * receive is never shown as theirs.
     */
    amountCents: positiveCents.nullable(),
    /**
     * What the measure is worth to someone who qualifies, at this price and in this place, whatever
     * this person's eligibility. For reference next to an ineligible or unverified benefit. Absent
     * in results produced before this field existed.
     */
    nominalAmountCents: positiveCents.nullable().optional(),
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
    /**
     * The day the rural classification took effect. A rural tax measure does not apply to a purchase
     * before it. Null or absent: not stated by the source.
     */
    ruralEffectiveFrom: isoDate.nullable().optional(),
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
  /**
   * Null when there is no finite timeline to show: savings are zero, negative or unknown, or the
   * target lies beyond the planning horizon (`maxPlanningMonths`, 600 months).
   */
  months: z.number().int().nonnegative().nullable(),
});

export const placePlan = z
  .object({
    place,
    /**
     * `beyond_horizon`: the person saves something each month, but the upfront cash is more than
     * 600 months away, so no timeline is given. Results produced before this status existed never carry it.
     */
    status: z.enum(['estimated', 'target_reached', 'no_positive_savings', 'insufficient_data', 'beyond_horizon']),
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
    /**
     * The day the person could buy with the benefits of this place: the plan date plus
     * `withPlaceBenefits.months`. Buy-side benefits are screened on this date, with ages advanced to it.
     * Null when there is no finite timeline. Absent in results produced before this field existed.
     */
    estimatedPurchaseDate: isoDate.nullable().optional(),
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
    /**
     * Present when the person stated an upfront target (`finances.targetCashCents`): the target, the
     * upfront cash this plan computed for the baseline (null when none could be computed), and the
     * target less the computed figure. `usedByTimeline` is always `computed`: every timeline here is
     * measured against the computed upfront cash, and the stated target is shown beside it.
     */
    upfrontTarget: z
      .object({
        statedCents: positiveCents,
        computedCents: positiveCents.nullable(),
        differenceCents: cents.nullable(),
        usedByTimeline: z.literal('computed'),
      })
      .strict()
      .optional(),
    assumptions: z.array(z.string()),
    dataMissing: z.array(z.string()),
  })
  .strict();
export type PlacePlan = z.infer<typeof placePlan>;

/**
 * The plan when no place is chosen yet: what the person would need anywhere in Catalonia, from a
 * stated budget, the general transfer tax (or a Catalonia-wide reduced rate already verified) and
 * their habits. It has no place and counts no benefit of a place.
 */
export const anywherePlan = placePlan.omit({
  place: true,
  withPlaceBenefits: true,
  monthsSaved: true,
  monthsSavedByPlace: true,
  estimatedPurchaseDate: true,
});
export type AnywherePlan = z.infer<typeof anywherePlan>;

/**
 * Said when no place is chosen: the question to ask, why, where the answer is saved and the tool
 * that proposes places. It is not one of `nextQuestions`, because its answer is a municipality, not
 * a fact about the person.
 */
export const placeQuestion = z
  .object({
    inputPath: z.literal('location.selectedMunicipalityCode'),
    label: z.string(),
    question: z.string(),
    why: z.string(),
    /** The tool that proposes places to choose from. */
    suggestTool: z.literal('recommend_towns'),
  })
  .strict();
export type PlaceQuestion = z.infer<typeof placeQuestion>;

export const planInput = z
  .object({
    /** A stored person. Either this or `person` is required. */
    userId: safeId.optional(),
    person: person.optional(),
    /** Places to compare, at most eight. Empty or left out: no place is chosen yet. */
    municipalityCodes: z.array(municipalityCode).max(8).default([]),
    assumptions: planAssumptions.optional(),
  })
  .strict();

/** What the plan did with one habit of the person. */
export const habitEffect = z
  .object({
    habitId: safeId,
    /** True when the habit's monthly saving is inside the with-habits timeline. */
    counted: z.boolean(),
    /** The monthly saving that was counted, after adherence; 0 when not counted. */
    countedMonthlyCents: positiveCents,
    /**
     * - `counted`: an active habit added to the monthly savings.
     * - `counted_as_proposed`: a proposed habit counted because `includeProposedHabits` is set.
     * - `not_adopted`: a proposed habit; counted only with `includeProposedHabits`.
     * - `paused`: switched off by the person.
     * - `no_amount`: the habit has no monthly saving attached.
     * - `inside_bank_figures`: it started before the observed bank period ended, so its effect is
     *   already in the monthly spending.
     * - `start_unknown`: spending was observed in bank movements and the habit has no start date (or
     *   the period has no end date), so the plan cannot tell whether it is already in the spending.
     */
    reason: z.enum([
      'counted',
      'counted_as_proposed',
      'not_adopted',
      'paused',
      'no_amount',
      'inside_bank_figures',
      'start_unknown',
    ]),
    explanation: z.string(),
  })
  .strict();
export type HabitEffect = z.infer<typeof habitEffect>;

/** How a question is answered. Every surface renders and validates from this, never from its own rules. */
export const answerSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('boolean') }).strict(),
  /** A calendar day, `YYYY-MM-DD`. */
  z.object({ type: z.literal('date'), min: isoDate, max: isoDate }).strict(),
  /** An amount in euros as the person says it. `storedAs` is the unit of the saved value. */
  z.object({ type: z.literal('money'), storedAs: z.enum(['cents', 'eur']), min: z.number(), max: z.number() }).strict(),
  z.object({ type: z.literal('number'), unit: z.string(), min: z.number(), max: z.number() }).strict(),
  /** A percentage as the person says it (20), stored as a share (0.2). */
  z.object({ type: z.literal('percent'), min: z.number(), max: z.number() }).strict(),
  z
    .object({
      type: z.literal('choice'),
      options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).min(2),
    })
    .strict(),
  /** The children of the household, each with a date of birth; an empty list means none. */
  z.object({ type: z.literal('children'), max: z.number().int().positive() }).strict(),
  /** One yes, no or "I don't know" per listed child; `index` is the child's position in the household. */
  z
    .object({
      type: z.literal('per_child'),
      children: z.array(z.object({ index: z.number().int().nonnegative(), label: z.string() }).strict()),
    })
    .strict(),
]);
export type AnswerSpec = z.infer<typeof answerSpec>;

/** What answering one question could change in the plan, in the place where it changes the most. */
export const questionEffect = z
  .object({
    /**
     * `required`: without it no timeline can be computed. `benefit`: it decides a measure that would
     * change the upfront cash or the wait. `baseline`: it decides a rate that applies anywhere in
     * Catalonia, which changes what a place is compared with. `assumption`: the plan is using a
     * default in its place.
     */
    kind: z.enum(['required', 'benefit', 'baseline', 'assumption']),
    /** Months the wait could be shorter by; null when no finite timeline exists to compare. */
    months: z.number().int().nonnegative().nullable(),
    /** How much lower the upfront cash could be, in cents; null when it cannot be computed. */
    upfrontCents: positiveCents.nullable(),
    municipalityCode: municipalityCode.nullable(),
    placeName: z.string().nullable(),
    /** The measures this answer helps decide for the places compared. */
    policyIds: z.array(policyId),
    /** Labels of the other unanswered questions of the same measure: the effect needs those answers too. */
    alsoNeeds: z.array(z.string()),
    /** The effect in one sentence, such as "Could shorten the wait by up to 14 months in Talarn." */
    text: z.string(),
  })
  .strict();

/** One question worth asking next, with everything a surface needs to ask it and store the answer. */
export const nextQuestion = z
  .object({
    id: z.string(),
    /** The input field the answer is saved to, such as `eligibility.birthDate`. */
    inputPath: z.string(),
    label: z.string(),
    question: z.string(),
    /** Why it is asked: the measure it decides, in one sentence. */
    why: z.string(),
    /** Where to find the answer, when that is not obvious. */
    help: z.string().nullable(),
    /** Present for a sensitive fact: why it is asked and where it is kept. */
    sensitivity: z.string().nullable(),
    answer: answerSpec,
    /** True when "I don't know" is an accepted answer, stored as an explicit unknown. */
    allowUnknown: z.boolean(),
    /**
     * `missing`: never answered. `unconfirmed`: a value exists that nobody confirmed. `conflict`:
     * confirmed answers disagree and the person has to pick. `said_unknown`: answered "I don't know";
     * listed so the benefit is explained, not asked again as if new.
     */
    state: z.enum(['missing', 'unconfirmed', 'conflict', 'said_unknown']),
    effect: questionEffect,
  })
  .strict();
export type NextQuestion = z.infer<typeof nextQuestion>;

/** One fact the plan knows about the person, with where it came from. */
export const knownFact = z
  .object({
    id: z.string(),
    inputPath: z.string(),
    label: z.string(),
    /** The value in words, as the plan read it ("Born 1994-03-02: 32 on the plan date"). */
    value: z.string(),
    source: factAnswer.shape.source,
    observedAt: z.string().nullable(),
    /** True when the person confirmed it; null when the person carries no provenance for it. */
    confirmed: z.boolean().nullable(),
    /** True when the screening of a measure or the arithmetic of the plan read this fact. */
    usedByPlan: z.boolean(),
    /** Set when the fact may no longer hold: the reason, with the date it was given. */
    stale: z.string().nullable(),
  })
  .strict();
export type KnownFact = z.infer<typeof knownFact>;

/** Confirmed answers that disagree. The plan uses none of them until the person picks one. */
export const factConflict = z
  .object({
    id: z.string(),
    inputPath: z.string(),
    label: z.string(),
    question: z.string(),
    candidates: z.array(
      z
        .object({
          value: z.unknown(),
          /** The value in words. */
          text: z.string(),
          source: z.string(),
          observedAt: z.string(),
          confirmed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type FactConflict = z.infer<typeof factConflict>;

export const planResult = z
  .object({
    person,
    asOf: isoDate,
    /**
     * The questions whose answers could still change this plan, most valuable first: what is missing
     * for a timeline, then the facts that decide a measure, ranked by the months and the upfront cash
     * at stake for the places compared, then the defaults the plan is assuming. Empty when nothing
     * more can change the plan. Absent in results produced before this field existed.
     */
    nextQuestions: z.array(nextQuestion).optional(),
    /** The facts about the person that are known, each with its source and whether the plan relied on it. */
    knownFacts: z.array(knownFact).optional(),
    /** Questions with confirmed answers that disagree. The person picks; nothing is taken silently. */
    conflicts: z.array(factConflict).optional(),
    /**
     * One entry per habit of the person, in the same order: whether the plan counted it and why.
     * Displays read this instead of deriving it from the habit's status. Absent in results produced
     * before this field existed.
     */
    habits: z.array(habitEffect).optional(),
    /** Sorted by the shortest finite timeline with place benefits; places without one come last. Empty when no place is chosen. */
    plans: z.array(placePlan),
    /** Only when no place is chosen: the plan anywhere in Catalonia, without the benefits of a place. */
    withoutPlace: anywherePlan.optional(),
    /** Only when no place is chosen: the question that chooses one, and the tool that proposes places. */
    placeQuestion: placeQuestion.optional(),
    limitations: z.array(z.string()),
    /**
     * Set by the tool that returns the plan: true when it is the plan of the signed-in person's
     * stored answers, false for an inline person or a demo persona. Absent from `planForPlaces`.
     */
    stored: z.boolean().optional(),
    /** For an inline person: the sentence saying the answers live only in this conversation, in the person's language. */
    sayNotStored: z.string().nullable().optional(),
  })
  .strict();
export type PlanResult = z.infer<typeof planResult>;
