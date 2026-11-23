import type { z } from 'zod';
import type {
  Metric,
  Municipality,
  Policy,
  ProfileRecommendationInput,
  profileRecommendationResult,
  RecommendationInput,
  recommendationResult,
  SchoolJourney,
  Snapshot,
} from '../contracts/places.ts';
import { recommendationInput, schoolStage } from '../contracts/places.ts';
import { defaultLocale, type Locale } from '../i18n/locales.ts';
import { type Translate, translator } from '../i18n/messages.ts';
import { bestCommute, railwayCoverage, schoolJourneys, timeSeconds } from './access.ts';
import { getTown, missingMetrics, snapshotInfo } from './data.ts';
import { evaluateIncentives } from './eligibility.ts';
import { nextSchoolDay, normalizedName } from './geography.ts';

import { recommendMessages } from './messages.ts';
import { getRelocationResearch } from './relocation.ts';
import { type Wording, wording } from './wording.ts';

type Result = z.infer<typeof recommendationResult>;
/** Excluded municipalities whose reasons a result spells out by default; the rest are only counted. */
export const excludedListed = 20;
type ProfileResult = z.infer<typeof profileRecommendationResult>;
type Weight = keyof NonNullable<RecommendationInput['weights']>;
type Say = Translate<keyof (typeof recommendMessages)['en']>;

function estimateHousing(snapshot: Snapshot, town: Municipality, housing: NonNullable<RecommendationInput['housing']>) {
  const metrics = snapshot.townMetrics[town.code];
  if (housing.tenure === 'rent') {
    const metric = metrics.find(metric => metric.kind === 'rent_eur_per_month');
    return metric && { amountEur: metric.value, metric };
  }
  const municipal = metrics.find(metric => metric.kind === 'resale_eur_per_m2');
  const comarca = snapshot.comarcaMetrics[town.comarca]?.find(metric => metric.kind === 'resale_eur_per_m2');
  const metric = municipal ?? (housing.allowComarcaEstimate ? comarca : undefined);
  return metric && { amountEur: Math.round(metric.value * housing.homeSizeM2!), metric };
}

function isFullyRural(town: Municipality, asOf: string) {
  return (
    (town.rural.category === 'rural' || town.rural.category === 'special_attention') &&
    town.rural.effectiveFrom !== null &&
    town.rural.effectiveFrom <= asOf
  );
}

function reasonsForSchool(journeys: SchoolJourney[], t: Say, write: Wording) {
  const options = new Set(
    journeys.map(journey =>
      journey.mode === 'estimated_walk'
        ? t('schoolEstimatedWalks')
        : journey.mode === 'scheduled_rail_with_estimated_walk'
          ? t('schoolRailAndWalks')
          : t('schoolNearbyListed'),
    ),
  );
  return t('schoolCovered', { options: write.list([...options], ' and ') });
}

function assessProfile(
  profile: ProfileRecommendationInput['profile'],
  stages: RecommendationInput['schoolStages'],
  towns: Result['towns'],
  t: Say,
): ProfileResult['profileAssessment'] {
  const applied: string[] = [];
  const followUps: string[] = [];
  const verificationNeeded: string[] = [];
  if (stages?.length) applied.push(t('appliedStages'));
  if (profile.hasChildren && stages === undefined) {
    applied.push(t('appliedStageRange'));
    followUps.push(t('askStages'));
  }
  if (profile.workMode === 'hybrid' || profile.workMode === 'on_site') {
    verificationNeeded.push(t('verifyWorkTravel'));
  }
  if (profile.preferredSetting === 'rural') applied.push(t('appliedRural'));
  if (profile.preferredSetting === 'larger_town') applied.push(t('appliedLargerTown'));
  if (profile.hasDog) verificationNeeded.push(t('verifyDog'));
  if (profile.workMode === 'remote' || profile.workMode === 'hybrid') {
    verificationNeeded.push(t('verifyBroadband'));
  }
  const status = !towns.length ? 'no_matches' : towns.some(town => town.score !== null) ? 'ranked' : 'exploratory';
  if (status === 'exploratory') followUps.push(t('askSetting'));
  return { status, applied, followUps, verificationNeeded };
}

/**
 * Screen and rank the pilot towns. `locale` chooses the language of the reasons, compromises,
 * limitations and of the measures listed for each town; scores, codes and figures do not change.
 */
export function recommendTowns(
  snapshot: Snapshot,
  policies: Policy[],
  input: RecommendationInput,
  asOf: string,
  profile?: ProfileRecommendationInput['profile'],
  locale: Locale = defaultLocale,
): Result {
  const t = translator(recommendMessages, locale);
  const write = wording(locale);
  if (input.housing?.tenure === 'buy' && input.housing.homeSizeM2 === undefined) {
    throw new Error('Provide homeSizeM2 (constructed floor area) with a purchase budget to estimate a resale price.');
  }
  if (!input.schoolStages?.length && (input.schoolMode || input.maxSchoolJourneyMinutes || input.schoolArriveBy)) {
    throw new Error('Provide at least one required school stage for the school journey constraints.');
  }
  if (
    input.commute?.departFrom &&
    input.commute.departBy &&
    timeSeconds(input.commute.departFrom) > timeSeconds(input.commute.departBy)
  ) {
    throw new Error('Commute departFrom must be at or before departBy within the service day.');
  }
  const travelDate = input.travelDate ?? nextSchoolDay(asOf);
  const destination = input.commute ? getTown(snapshot, input.commute.destinationCode) : undefined;
  const stages = [...new Set(input.schoolStages ?? [])];
  const candidates = snapshot.municipalities.filter(town => town.recommendable);
  const preferLargerTown = profile?.preferredSetting === 'larger_town';
  const maxPopulation = preferLargerTown
    ? Math.max(
        1,
        ...candidates.map(
          town => snapshot.townMetrics[town.code].find(metric => metric.kind === 'population')?.value ?? 0,
        ),
      )
    : 1;
  const excluded: Result['excluded'] = [];
  const towns: Result['towns'] = [];

  for (const municipality of candidates) {
    const dataMissing: string[] = missingMetrics(snapshot, municipality.code);
    const reasons: string[] = [];
    const matchReasons: string[] = [];
    const tradeoffs: string[] = [];
    const factors: { value: number; weight: number }[] = [];
    const addFactor = (key: Weight, value: number, defaultWeight = 1) =>
      factors.push({ value, weight: input.weights?.[key] ?? defaultWeight });
    const metrics: Metric[] = [...snapshot.townMetrics[municipality.code]];
    const rural = isFullyRural(municipality, asOf);

    if (input.comarca && normalizedName(input.comarca) !== normalizedName(municipality.comarca))
      reasons.push(t('outsideComarca'));
    if (input.ruralOnly && !rural) reasons.push(t('ruralNotEvidenced'));
    if (rural)
      matchReasons.push(
        t(municipality.rural.category === 'special_attention' ? 'ruralSpecialAttention' : 'ruralRural'),
      );
    if (municipality.rural.category === 'partial') tradeoffs.push(t('ruralPartial'));
    addFactor('rural', rural ? 1 : 0, profile?.preferredSetting === 'rural' ? 1 : 0);
    if (preferLargerTown) {
      const population = metrics.find(metric => metric.kind === 'population');
      if (population) {
        factors.push({ value: population.value / maxPopulation, weight: 1 });
        matchReasons.push(
          t('population', {
            population: write.number(population.value, population.value.toLocaleString('en')),
            observedAt: population.observedAt,
          }),
        );
      }
    }

    const housingEstimate = input.housing ? estimateHousing(snapshot, municipality, input.housing) : undefined;
    if (input.housing && !housingEstimate) reasons.push(t('housingInsufficient'));
    if (input.housing && housingEstimate) {
      const { amountEur, metric } = housingEstimate;
      const budget = input.housing.maxBudgetEur;
      if (amountEur > budget) reasons.push(t('housingOverBudget'));
      else
        matchReasons.push(
          t(metric.geography === 'comarca' ? 'housingWithinComarca' : 'housingWithinMunicipality', {
            amount: write.euros(Math.round(amountEur * 100), `€${amountEur}`),
          }),
        );
      addFactor('affordability', 1 - Math.min(1, amountEur / budget));
      if (metric.geography === 'comarca') {
        metrics.push(metric);
        tradeoffs.push(t('comarcaAverage', { comarca: metric.geographyName }));
      }
      tradeoffs.push(t('historicalAverages'));
    }

    const schoolMatches: SchoolJourney[] = [];
    if (stages.length) {
      const journeys = schoolJourneys(snapshot, municipality, travelDate, input.schoolArriveBy);
      for (const stage of stages) {
        const available = journeys.find(
          journey =>
            journey.school.stages.includes(stage) &&
            (input.schoolMode !== 'rail' || journey.rail) &&
            (input.schoolMode !== 'car_free' || journey.estimatedMinutes !== null) &&
            (input.maxSchoolJourneyMinutes === undefined ||
              (journey.estimatedMinutes !== null && journey.estimatedMinutes <= input.maxSchoolJourneyMinutes)),
        );
        if (available) schoolMatches.push(available);
        else {
          dataMissing.push(`school_access_${stage}`);
          reasons.push(t('noSchoolOption', { stage: t(`stage.${stage}`) }));
        }
      }
      if (schoolMatches.length === stages.length) {
        matchReasons.push(reasonsForSchool(schoolMatches, t, write));
        const timings = schoolMatches.map(journey => journey.estimatedMinutes);
        if (timings.every(minutes => minutes !== null)) {
          addFactor('schoolAccess', 1 - Math.min(1, Math.max(...timings) / (input.maxSchoolJourneyMinutes ?? 90)));
        }
        tradeoffs.push(t('verifySchools'));
      }
    } else if (profile?.hasChildren && input.schoolStages === undefined) {
      const localStages = new Map<string, SchoolJourney>();
      for (const journey of schoolJourneys(snapshot, municipality, travelDate)) {
        if (journey.school.municipalityCode !== municipality.code) continue;
        for (const stage of journey.school.stages) {
          if (!localStages.has(stage)) localStages.set(stage, journey);
        }
      }
      addFactor('schoolAccess', localStages.size / schoolStage.options.length);
      schoolMatches.push(...localStages.values());
      if (localStages.size) {
        matchReasons.push(t('inTownSchools', { count: localStages.size }));
        tradeoffs.push(t('confirmStages'));
      } else {
        dataMissing.push('local_school_option');
        tradeoffs.push(t('noListedSchool'));
      }
    }

    const commute =
      input.commute && destination
        ? bestCommute(snapshot, municipality, destination, travelDate, input.commute)
        : undefined;
    if (input.commute && (!commute || commute.estimatedMinutes > input.commute.maxMinutes)) {
      if (!commute) dataMissing.push('direct_rail_commute');
      reasons.push(t('noCommute'));
    }
    if (input.commute && commute && commute.estimatedMinutes <= input.commute.maxMinutes) {
      addFactor('commute', 1 - commute.estimatedMinutes / input.commute.maxMinutes);
      matchReasons.push(t('commute', { line: commute.rail.line, minutes: commute.estimatedMinutes }));
      tradeoffs.push(t('railTimes'));
    }
    if ((input.commute || input.schoolMode === 'rail') && !railwayCoverage(snapshot, travelDate))
      dataMissing.push('rail_timetable_for_requested_date');
    if (reasons.length) {
      excluded.push({ municipalityCode: municipality.code, reasons, dataMissing });
      continue;
    }

    const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
    const score = totalWeight
      ? Math.round((100 * factors.reduce((sum, factor) => sum + factor.value * factor.weight, 0)) / totalWeight)
      : null;
    if (input.weights?.schoolAccess && schoolMatches.some(journey => journey.estimatedMinutes === null))
      dataMissing.push('school_journey_time');
    const incentives = evaluateIncentives(
      policies,
      municipality,
      { municipalityCode: municipality.code, intent: input.housing?.tenure },
      asOf,
      locale,
    ).filter(incentive => incentive.geographicStatus !== 'does_not_apply');
    towns.push({
      municipality,
      score,
      matchReasons,
      tradeoffs,
      metrics,
      housingEstimate: housingEstimate ?? null,
      schools: [...new Map(schoolMatches.map(journey => [journey.school.id, journey])).values()],
      commute: commute ?? null,
      incentives,
      dataMissing,
      relocation: getRelocationResearch(snapshot, municipality.code, asOf, locale),
    });
  }

  towns.sort(
    (a, b) => (b.score ?? -1) - (a.score ?? -1) || a.municipality.name.localeCompare(b.municipality.name, 'ca'),
  );
  const limitations = [t('limitCoverage'), t('limitScores')];
  if (!railwayCoverage(snapshot, travelDate)) limitations.push(t('limitTravelDate'));
  return {
    snapshot: snapshotInfo(snapshot),
    travelDate,
    towns: towns.slice(0, input.limit ?? 3),
    // Every town is screened; the reasons are listed for the first ones only, with the full count.
    excluded: excluded.slice(0, input.excludedLimit ?? excludedListed),
    excludedCount: excluded.length,
    limitations,
  };
}

export function recommendTownsForProfile(
  snapshot: Snapshot,
  policies: Policy[],
  input: ProfileRecommendationInput,
  asOf: string,
  locale: Locale = defaultLocale,
): ProfileResult {
  // `locale` is how the result is worded, not a criterion: it is never reported as ignored.
  const { profile, limit, locale: _, ...extra } = input as ProfileRecommendationInput & { locale?: unknown };
  const legacyStages = recommendationInput.shape.schoolStages.safeParse(extra.schoolStages);
  const schoolStages = profile.schoolStages ?? (legacyStages.success ? legacyStages.data : undefined);
  const ignoredCriteria = Object.keys(extra).filter(
    key => key !== 'schoolStages' || !legacyStages.success || profile.schoolStages !== undefined,
  );
  const recommendation = recommendTowns(snapshot, policies, { schoolStages, limit }, asOf, profile, locale);
  const profileAssessment = assessProfile(
    profile,
    schoolStages,
    recommendation.towns,
    translator(recommendMessages, locale),
  );
  if (ignoredCriteria.length) profileAssessment.ignoredCriteria = ignoredCriteria;
  return { ...recommendation, profileAssessment };
}
