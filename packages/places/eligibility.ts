import type { z } from 'zod';
import type { eligibility, IncentivesInput, Municipality, Policy } from '../contracts/places.ts';
import { normalizedName } from './geography.ts';

type Eligibility = z.infer<typeof eligibility>;
type Household = NonNullable<IncentivesInput['household']>;

const trempNuclei = new Set(
  [
    'Aulàs',
    'Casterner de les Olles',
    'Castissent',
    'Claramunt',
    'Claret',
    'El Castellet',
    'Els Masos de Tamúrcia',
    'Eroles',
    'Escarlà',
    'Espills',
    'Espluga Serra',
    'Espluga Freda',
    'Fígols',
    'Gurp',
    'La Torre de Tamúrcia',
    'Llastarri',
    "El Pont d'Orrit",
    'Palau de Noguera',
    'Puigcercós',
    'Puigverd',
  ].map(normalizedName),
);

type Test = boolean | undefined;
type Check = [result: Test, criterion: string];

function oneOf(tests: Test[]): Test {
  if (tests.includes(true)) return true;
  return tests.includes(undefined) ? undefined : false;
}

function schoolChild(children: Household['children'], key: 'inDesignatedSchool' | 'meetsItpSchooling'): Test {
  if (!children) return undefined;
  return oneOf(children.filter(child => child.age <= 16).map(child => (child.age <= 3 ? true : child[key])));
}

function atMost(value: number | undefined, maximum: number): Test {
  return value === undefined ? undefined : value <= maximum;
}

function householdChecks(id: Policy['id'], facts: Household): Check[] {
  const irpfChild = schoolChild(facts.children, 'inDesignatedSchool');
  const residence: Check = [facts.primaryResidence, 'The property is or will be the habitual residence.'];
  const minAge = id === 'irpf_move' ? 18 : 0;
  const age = facts.age === undefined ? undefined : facts.age >= minAge && facts.age <= 35;
  const filingLimit = facts.filing && atMost(facts.irpfNetTaxBaseEur, facts.filing === 'joint' ? 45_000 : 30_000);
  const individualLimit: Check = [
    atMost(facts.irpfIndividualNetTaxBaseEur, 36_000),
    'The claimant’s individually computed IRPF tax base is at most €36,000.',
  ];
  const childCheck: Check = [
    irpfChild,
    'At least one dependent child is aged up to 16 and meets IRPF schooling rules. Children up to 3 are exempt from schooling.',
  ];
  const irpfAgeOrChild: Check = [
    oneOf([age, irpfChild]),
    `Claimant is ${minAge === 18 ? '18–35' : '35 or younger'}, or the household has a qualifying child under the schooling rule.`,
  ];
  const filingBase: Check = [
    filingLimit,
    'The applicable current-year IRPF tax base is at most €30,000 individually or €45,000 jointly.',
  ];
  // Conditions shared by the 5% rates that apply anywhere in Catalonia (Codi tributari, arts. 641-2 to 641-5).
  const generalItpChecks: Check[] = [
    [facts.itpTransaction, 'A qualifying acquisition right is subject to ITP/TPO.'],
    [
      facts.satisfiesItpOccupancyRules,
      'The home is occupied within twelve months and kept as the habitual residence for three years, or an official exception applies.',
    ],
  ];
  // The €36,000 limit rises by €14,000 per child above the legal minimum, a count this screen does not hold:
  // a family above €36,000 is unknown, never excluded.
  const familyBaseWithIncreases: Check = [
    atMost(facts.itpFamilyNetTaxBaseEur, 36_000) || undefined,
    'The family’s combined net tax bases on the last IRPF return total at most €36,000, plus €14,000 for each child above the legal minimum for the family category.',
  ];
  switch (id) {
    case 'irpf_move':
      return [
        residence,
        irpfAgeOrChild,
        filingBase,
        [facts.firstRuralMove, 'This is the claimant’s first rural relocation.'],
      ];
    case 'irpf_buy':
      return [
        residence,
        childCheck,
        individualLimit,
        [
          facts.satisfiesPurchaseDeductionRules,
          'The occupancy, investment, patrimony and other purchase-deduction rules are satisfied.',
        ],
      ];
    case 'irpf_rent':
      return [
        residence,
        irpfAgeOrChild,
        filingBase,
        [facts.paysQualifyingRent, 'Qualifying rent was paid and the landlord can be identified on the return.'],
        [facts.satisfiesRentCompatibility, 'The claimant meets the deduction compatibility rules.'],
      ];
    case 'irpf_renovate':
      return [
        residence,
        individualLimit,
        [facts.pre1970, 'The home was built before 1 January 1970.'],
        [
          facts.satisfiesRehabilitationRules,
          'The official structural works, occupancy, investment and rehabilitation rules are satisfied.',
        ],
      ];
    case 'itp_buy':
      return [
        residence,
        [
          schoolChild(facts.children, 'meetsItpSchooling'),
          'At least one child up to age 16 meets the ITP schooling rules. Children up to 3 are exempt from schooling.',
        ],
        [
          atMost(facts.itpFamilyNetTaxBaseEur, 36_000),
          'The family’s combined net tax bases on the last applicable IRPF return total at most €36,000.',
        ],
        [facts.itpTransaction, 'A qualifying acquisition right is subject to ITP/TPO.'],
        [
          facts.satisfiesItpOccupancyRules,
          'The reduced rate’s acquisition and habitual-residence deadlines or an official exception are satisfied.',
        ],
      ];
    case 'itp_rehab_buy':
      return [
        residence,
        [facts.pre1970, 'The home was built before 1 January 1970.'],
        [
          atMost(facts.itpBuyerNetTaxBaseEur, 36_000),
          'The buyer’s own net tax base on the last IRPF return before the purchase is at most €36,000.',
        ],
        [facts.itpTransaction, 'A qualifying acquisition right is subject to ITP/TPO.'],
        [
          facts.satisfiesItpRehabilitationRules,
          'The works are structural rehabilitation above 25% of the price or market value, end within two years of the purchase, and the occupancy deadlines are met.',
        ],
      ];
    case 'itp_young_buyer':
      return [
        residence,
        [atMost(facts.age, 35), 'The buyer is 35 or younger on the date the transfer tax accrues.'],
        [
          atMost(facts.itpBuyerNetTaxBaseEur, 36_000),
          'The buyer’s own net tax base on the last IRPF return before the purchase is at most €36,000.',
        ],
        ...generalItpChecks,
      ];
    case 'itp_large_family':
      return [
        residence,
        [facts.largeFamily, 'The buyer is a member of an officially recognised large family.'],
        familyBaseWithIncreases,
        ...generalItpChecks,
      ];
    case 'itp_single_parent':
      return [
        residence,
        [facts.singleParent, 'The buyer is a member of an officially recognised single-parent family.'],
        familyBaseWithIncreases,
        ...generalItpChecks,
      ];
    case 'itp_disability':
      return [
        residence,
        [
          facts.disability65,
          'The buyer or a member of the buyer’s family unit has a recognised disability of 65% or more.',
        ],
        [
          atMost(facts.itpFamilyNetTaxBaseEur, 36_000),
          'The family unit’s combined net tax bases on the last IRPF return before the purchase total at most €36,000.',
        ],
        ...generalItpChecks,
      ];
    case 'renovation_grant_2026':
      return [
        [facts.ownerOfVacantHome, 'The applicant is a private owner of a qualifying vacant dwelling.'],
        [
          undefined,
          'Verify the technical project, residential use commitment, expense conditions and documentation with the housing agency.',
        ],
      ];
    case 'youth_purchase_small_town':
      return [
        residence,
        [
          atMost(facts.age, 35),
          'The applicant is 35 or younger when applying, or when signing a purchase contract that predates the call.',
        ],
        [
          atMost(facts.purchasePriceEur, 300_000),
          'The purchase price, or the self-build cost excluding land, is at most €300,000 in Catalonia.',
        ],
        [
          facts.ownsHomeInSpain === undefined ? undefined : !facts.ownsHomeInSpain,
          'The applicant does not own or hold a usufruct over another home in Spain, unless an official exception applies.',
        ],
        [
          facts.incomeWithinFiveIprem,
          'Annual income is at most 5 times IPREM (5.5 or 6 times with a recognised disability).',
        ],
      ];
  }
}

/**
 * The status of a policy's application call on a date.
 *
 * A call window that is `null` means no call could be verified, which is unknown rather than closed.
 * The date carries no time of day. A call that closes at a stated time before midnight is reported
 * `closed` for the whole of its closing day: saying `open` after the closing time would be wrong, and
 * the morning of that day is the smaller error. A call without a closing time stays open through its
 * last day.
 */
export function callStatusOn(policy: Policy, asOf: string): Eligibility['callStatus'] {
  if (policy.callWindow === null) return 'unknown';
  const window =
    policy.callWindow ??
    (policy.mechanism === 'grant' ? { opensOn: policy.effectiveFrom, closesOn: policy.effectiveThrough } : undefined);
  if (!window) return 'unknown';
  if (asOf < window.opensOn) return 'upcoming';
  const closingTime = 'closesAtLocalTime' in window ? window.closesAtLocalTime : undefined;
  return asOf > window.closesOn || (asOf === window.closesOn && closingTime !== undefined) ? 'closed' : 'open';
}

function geographicCheck(policy: Policy, town: Municipality, date: string, nucleus?: string): Check {
  if (policy.id === 'youth_purchase_small_town') {
    // The decree's test is resident population, not the Catalan rural classification.
    if (policy.municipalityCodes?.includes(town.code)) {
      return [true, 'The municipality has 10,000 residents or fewer.'];
    }
    return nucleus && normalizedName(nucleus) !== normalizedName(town.centre.name)
      ? [undefined, 'Confirm that the population nucleus has 10,000 residents or fewer under the call.']
      : [false, 'The municipality or population nucleus must have 10,000 residents or fewer.'];
  }
  // A measure for the whole of Catalonia does not depend on the municipality or its rural classification.
  if (policy.territory === 'catalonia') return [true, 'The measure applies in every municipality of Catalonia.'];
  if (policy.mechanism === 'grant') {
    if (!policy.municipalityCodes?.includes(town.code))
      return [false, 'Municipality must be listed in the specific 2026 grant call.'];
  } else {
    if (date < '2026-02-24')
      return [undefined, 'The historical rural classification for the event date needs official verification.'];
    if (town.rural.category === 'not_listed' || (town.rural.effectiveFrom && date < town.rural.effectiveFrom)) {
      return [false, 'The municipality must be covered by the rural classification on the event date.'];
    }
  }
  if (town.rural.category !== 'partial') return [true, 'Municipality is within the measure’s geographic scope.'];
  if (nucleus && normalizedName(nucleus) === normalizedName(town.centre.name)) {
    return [false, 'The municipal capital is outside this measure’s geographic scope.'];
  }
  const namedNucleus = nucleus ? normalizedName(nucleus) : '';
  return [
    town.code === '252347' && trempNuclei.has(namedNucleus) ? true : undefined,
    'Confirm the dwelling is in a covered attached nucleus using the official municipality list.',
  ];
}

export function evaluateIncentives(
  policies: Policy[],
  town: Municipality,
  input: IncentivesInput,
  asOf: string,
): Eligibility[] {
  const eventDate = input.eventDate;
  const evaluatedOn = eventDate ?? asOf;
  return policies
    .filter(policy => !input.intent || policy.intent === input.intent)
    .map(policy => {
      const isGrant = policy.mechanism === 'grant';
      const measureStatus =
        evaluatedOn < policy.effectiveFrom
          ? 'upcoming'
          : evaluatedOn <= policy.effectiveThrough
            ? 'active'
            : policy.mechanism === 'tax_deduction'
              ? 'needs_verification'
              : 'ended';
      const callStatus = callStatusOn(policy, asOf);
      const callNotPublished = policy.callWindow === null;
      const geography = geographicCheck(policy, town, evaluatedOn, input.nucleus);
      const rulesCovered = isGrant || measureStatus === 'active';
      const checks = [geography, ...(rulesCovered ? householdChecks(policy.id, input.household ?? {}) : [])];
      if (!isGrant && !eventDate) checks.push([undefined, 'Provide the actual or planned qualifying event date.']);
      if (policy.id === 'youth_purchase_small_town') {
        checks.push([
          eventDate === undefined ? undefined : eventDate >= '2026-01-01',
          'The purchase contract is signed on or after 1 January 2026.',
        ]);
      }
      if (callNotPublished) {
        checks.push([
          undefined,
          'No Catalan call for this aid could be verified; its bases will set the final amount and conditions.',
        ]);
      }
      if (!rulesCovered) {
        checks.push([undefined, 'Confirm whether the measure applies for the stated event date.']);
      }
      const missingCriteria = checks.filter(([result]) => result === undefined).map(([, criterion]) => criterion);
      const unmetCriteria = checks.filter(([result]) => result === false).map(([, criterion]) => criterion);
      const eligibilityStatus = !rulesCovered
        ? 'needs_verification'
        : unmetCriteria.length
          ? 'ineligible'
          : missingCriteria.length
            ? 'needs_verification'
            : 'eligible';
      const geographicStatus =
        geography[0] === true ? 'applies' : geography[0] === false ? 'does_not_apply' : 'needs_verification';
      const nextStep =
        callStatus === 'closed' || callNotPublished
          ? 'Check the housing agency’s official page for a future call.'
          : isGrant
            ? 'Review the application and supporting documents on Tràmits Gencat.'
            : 'Confirm the dated facts and claiming procedure with the Catalan Tax Agency.';
      const singleParent = input.household?.singleParent;
      const screenedAmountEur =
        policy.id === 'irpf_move' && eligibilityStatus === 'eligible' && singleParent !== undefined
          ? (town.rural.category === 'special_attention' ? 1000 : 750) * (singleParent ? 2 : 1)
          : undefined;
      return {
        ...policy,
        geographicStatus,
        measureStatus,
        callStatus,
        eligibilityStatus,
        screenedAmountEur,
        missingCriteria,
        unmetCriteria,
        nextStep,
      };
    });
}
