import type { z } from 'zod';
import type { eligibility, IncentivesInput, Municipality, Policy } from '../contracts/places.ts';
import { defaultLocale, type Locale } from '../i18n/locales.ts';
import { type Translate, translator } from '../i18n/messages.ts';
import { eligibilityMessages } from './eligibility.messages.ts';
import { normalizedName } from './geography.ts';
import { localizePolicy } from './policy-text.ts';

type Eligibility = z.infer<typeof eligibility>;
type Household = NonNullable<IncentivesInput['household']>;
type Say = Translate<keyof (typeof eligibilityMessages)['en']>;

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

function householdChecks(id: Policy['id'], facts: Household, t: Say): Check[] {
  const irpfChild = schoolChild(facts.children, 'inDesignatedSchool');
  const residence: Check = [facts.primaryResidence, t('residence')];
  const minAge = id === 'irpf_move' ? 18 : 0;
  const age = facts.age === undefined ? undefined : facts.age >= minAge && facts.age <= 35;
  const filingLimit = facts.filing && atMost(facts.irpfNetTaxBaseEur, facts.filing === 'joint' ? 45_000 : 30_000);
  const individualLimit: Check = [atMost(facts.irpfIndividualNetTaxBaseEur, 36_000), t('irpfIndividualBase')];
  const childCheck: Check = [irpfChild, t('irpfChild')];
  const irpfAgeOrChild: Check = [oneOf([age, irpfChild]), t(minAge === 18 ? 'irpfAgeOrChild18' : 'irpfAgeOrChild35')];
  const filingBase: Check = [filingLimit, t('irpfFilingBase')];
  // Conditions shared by the 5% rates that apply anywhere in Catalonia (Codi tributari, arts. 641-2 to 641-5).
  const generalItpChecks: Check[] = [
    [facts.itpTransaction, t('itpTransaction')],
    [facts.satisfiesItpOccupancyRules, t('itpOccupancyGeneral')],
  ];
  // The €36,000 limit rises by €14,000 per child above the legal minimum, a count this screen does not hold:
  // a family above €36,000 is unknown, never excluded.
  const familyBaseWithIncreases: Check = [
    atMost(facts.itpFamilyNetTaxBaseEur, 36_000) || undefined,
    t('familyBaseWithIncreases'),
  ];
  switch (id) {
    case 'irpf_move':
      return [residence, irpfAgeOrChild, filingBase, [facts.firstRuralMove, t('firstRuralMove')]];
    case 'irpf_buy':
      return [
        residence,
        childCheck,
        individualLimit,
        [facts.satisfiesPurchaseDeductionRules, t('purchaseDeductionRules')],
      ];
    case 'irpf_rent':
      return [
        residence,
        irpfAgeOrChild,
        filingBase,
        [facts.paysQualifyingRent, t('qualifyingRent')],
        [facts.satisfiesRentCompatibility, t('rentCompatibility')],
      ];
    case 'irpf_renovate':
      return [
        residence,
        individualLimit,
        [facts.pre1970, t('pre1970')],
        [facts.satisfiesRehabilitationRules, t('rehabilitationRules')],
      ];
    case 'itp_buy':
      return [
        residence,
        [schoolChild(facts.children, 'meetsItpSchooling'), t('itpSchoolChild')],
        [atMost(facts.itpFamilyNetTaxBaseEur, 36_000), t('itpFamilyBase')],
        [facts.itpTransaction, t('itpTransaction')],
        [facts.satisfiesItpOccupancyRules, t('itpOccupancyRural')],
      ];
    case 'itp_rehab_buy':
      return [
        residence,
        [facts.pre1970, t('pre1970')],
        [atMost(facts.itpBuyerNetTaxBaseEur, 36_000), t('itpBuyerBase')],
        [facts.itpTransaction, t('itpTransaction')],
        [facts.satisfiesItpRehabilitationRules, t('itpRehabilitationRules')],
      ];
    case 'itp_young_buyer':
      return [
        residence,
        [atMost(facts.age, 35), t('buyerAge35')],
        [atMost(facts.itpBuyerNetTaxBaseEur, 36_000), t('itpBuyerBase')],
        ...generalItpChecks,
      ];
    case 'itp_large_family':
      return [residence, [facts.largeFamily, t('largeFamily')], familyBaseWithIncreases, ...generalItpChecks];
    case 'itp_single_parent':
      return [residence, [facts.singleParent, t('singleParent')], familyBaseWithIncreases, ...generalItpChecks];
    case 'itp_disability':
      return [
        residence,
        [facts.disability65, t('disability65')],
        [atMost(facts.itpFamilyNetTaxBaseEur, 36_000), t('familyUnitBase')],
        ...generalItpChecks,
      ];
    case 'renovation_grant_2026':
      return [
        [facts.ownerOfVacantHome, t('vacantHomeOwner')],
        [undefined, t('grantVerify')],
      ];
    case 'youth_purchase_small_town':
      return [
        residence,
        [atMost(facts.age, 35), t('applicantAge35')],
        [atMost(facts.purchasePriceEur, 300_000), t('priceCap')],
        [facts.ownsHomeInSpain === undefined ? undefined : !facts.ownsHomeInSpain, t('noOtherHome')],
        [facts.incomeWithinFiveIprem, t('incomeIprem')],
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

function geographicCheck(policy: Policy, town: Municipality, date: string, nucleus: string | undefined, t: Say): Check {
  if (policy.id === 'youth_purchase_small_town') {
    // The decree's test is resident population, not the Catalan rural classification.
    if (policy.municipalityCodes?.includes(town.code)) {
      return [true, t('geoSmallTown')];
    }
    return nucleus && normalizedName(nucleus) !== normalizedName(town.centre.name)
      ? [undefined, t('geoSmallNucleusConfirm')]
      : [false, t('geoSmallTownRequired')];
  }
  // A measure for the whole of Catalonia does not depend on the municipality or its rural classification.
  if (policy.territory === 'catalonia') return [true, t('geoCatalonia')];
  if (policy.mechanism === 'grant') {
    if (!policy.municipalityCodes?.includes(town.code)) return [false, t('geoGrantList')];
  } else {
    if (date < '2026-02-24') return [undefined, t('geoHistorical')];
    if (town.rural.category === 'not_listed' || (town.rural.effectiveFrom && date < town.rural.effectiveFrom)) {
      return [false, t('geoRuralRequired')];
    }
  }
  if (town.rural.category !== 'partial') return [true, t('geoInScope')];
  if (nucleus && normalizedName(nucleus) === normalizedName(town.centre.name)) {
    return [false, t('geoCapitalOutside')];
  }
  const namedNucleus = nucleus ? normalizedName(nucleus) : '';
  return [town.code === '252347' && trempNuclei.has(namedNucleus) ? true : undefined, t('geoNucleusConfirm')];
}

/**
 * Screen each policy for one municipality and household.
 *
 * `locale` chooses the language of what a person reads: the name and explanation of the measure
 * (`localizePolicy`), the criteria and the next step. Every status, date, amount and id is the
 * same in every language.
 */
export function evaluateIncentives(
  policies: Policy[],
  town: Municipality,
  input: IncentivesInput,
  asOf: string,
  locale: Locale = defaultLocale,
): Eligibility[] {
  const t = translator(eligibilityMessages, locale);
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
      const geography = geographicCheck(policy, town, evaluatedOn, input.nucleus, t);
      const rulesCovered = isGrant || measureStatus === 'active';
      const checks = [geography, ...(rulesCovered ? householdChecks(policy.id, input.household ?? {}, t) : [])];
      if (!isGrant && !eventDate) checks.push([undefined, t('eventDate')]);
      if (policy.id === 'youth_purchase_small_town') {
        checks.push([eventDate === undefined ? undefined : eventDate >= '2026-01-01', t('contractDate')]);
      }
      if (callNotPublished) {
        checks.push([undefined, t('noCall')]);
      }
      if (!rulesCovered) {
        checks.push([undefined, t('confirmMeasure')]);
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
        callStatus === 'closed' || callNotPublished ? t('nextFutureCall') : isGrant ? t('nextGrant') : t('nextTax');
      const singleParent = input.household?.singleParent;
      const screenedAmountEur =
        policy.id === 'irpf_move' && eligibilityStatus === 'eligible' && singleParent !== undefined
          ? (town.rural.category === 'special_attention' ? 1000 : 750) * (singleParent ? 2 : 1)
          : undefined;
      return {
        ...localizePolicy(policy, locale),
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
