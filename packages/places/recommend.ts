import type { z } from "zod";
import type { Metric, Municipality, Policy, RecommendationInput, SchoolJourney, Snapshot } from "../contracts/places.ts";
import type { recommendationResult } from "../contracts/places.ts";
import { bestCommute, railwayCoverage, schoolJourneys, timeSeconds } from "./access.ts";
import { getTown, missingMetrics, snapshotInfo } from "./data.ts";
import { evaluateIncentives } from "./eligibility.ts";
import { nextSchoolDay, normalizedName } from "./geography.ts";

type Result = z.infer<typeof recommendationResult>;
type Weight = keyof NonNullable<RecommendationInput["weights"]>;

function estimateHousing(snapshot: Snapshot, town: Municipality, housing: NonNullable<RecommendationInput["housing"]>) {
  const metrics = snapshot.townMetrics[town.code];
  if (housing.tenure === "rent") {
    const metric = metrics.find(metric => metric.kind === "rent_eur_per_month");
    return metric && { amountEur: metric.value, metric };
  }
  const municipal = metrics.find(metric => metric.kind === "resale_eur_per_m2");
  const comarca = snapshot.comarcaMetrics[town.comarca]?.find(metric => metric.kind === "resale_eur_per_m2");
  const metric = municipal ?? (housing.allowComarcaEstimate ? comarca : undefined);
  return metric && { amountEur: Math.round(metric.value * housing.homeSizeM2!), metric };
}

function isFullyRural(town: Municipality, asOf: string) {
  return (town.rural.category === "rural" || town.rural.category === "special_attention")
    && town.rural.effectiveFrom !== null && town.rural.effectiveFrom <= asOf;
}

function reasonsForSchool(journeys: SchoolJourney[]) {
  const options = new Set(journeys.map(journey => journey.mode === "estimated_walk" ? "estimated walks"
    : journey.mode === "scheduled_rail_with_estimated_walk" ? "scheduled rail with estimated walks" : "nearby listed schools"));
  return `Requested school stages are covered by ${[...options].join(" and ")}.`;
}

export function recommendTowns(snapshot: Snapshot, policies: Policy[], input: RecommendationInput, asOf: string): Result {
  if (input.housing?.tenure === "buy" && input.housing.homeSizeM2 === undefined) {
    throw new Error("Provide homeSizeM2 (constructed floor area) with a purchase budget to estimate a resale price.");
  }
  if (!input.schoolStages?.length && (input.schoolMode || input.maxSchoolJourneyMinutes || input.schoolArriveBy)) {
    throw new Error("Provide at least one required school stage for the school journey constraints.");
  }
  if (input.commute?.departFrom && input.commute.departBy
    && timeSeconds(input.commute.departFrom) > timeSeconds(input.commute.departBy)) {
    throw new Error("Commute departFrom must be at or before departBy within the service day.");
  }
  const travelDate = input.travelDate ?? nextSchoolDay(asOf);
  const destination = input.commute ? getTown(snapshot, input.commute.destinationCode) : undefined;
  const stages = [...new Set(input.schoolStages ?? [])];
  const excluded: Result["excluded"] = [];
  const towns: Result["towns"] = [];

  for (const municipality of snapshot.municipalities.filter(town => town.recommendable)) {
    const dataMissing: string[] = missingMetrics(snapshot, municipality.code);
    const reasons: string[] = [];
    const matchReasons: string[] = [];
    const tradeoffs: string[] = [];
    const factors: { value: number; weight: number }[] = [];
    const addFactor = (key: Weight, value: number, defaultWeight = 1) =>
      factors.push({ value, weight: input.weights?.[key] ?? defaultWeight });
    const metrics: Metric[] = [...snapshot.townMetrics[municipality.code]];
    const rural = isFullyRural(municipality, asOf);

    if (input.comarca && normalizedName(input.comarca) !== normalizedName(municipality.comarca)) reasons.push("Outside the requested comarca.");
    if (input.ruralOnly && !rural) reasons.push("The requested municipality-wide rural classification is not evidenced.");
    if (rural) matchReasons.push(`Official rural classification: ${municipality.rural.category === "special_attention" ? "special attention" : "rural"}.`);
    if (municipality.rural.category === "partial") tradeoffs.push("Rural tax benefits depend on the exact attached settlement.");
    addFactor("rural", rural ? 1 : 0, 0);

    const housingEstimate = input.housing ? estimateHousing(snapshot, municipality, input.housing) : undefined;
    if (input.housing && !housingEstimate) reasons.push("Published housing data is insufficient to screen the budget.");
    if (input.housing && housingEstimate) {
      const { amountEur, metric } = housingEstimate;
      const budget = input.housing.maxBudgetEur;
      if (amountEur > budget) reasons.push("The housing estimate exceeds the requested budget.");
      else matchReasons.push(`The ${metric.geography} housing estimate of €${amountEur} is within the stated budget.`);
      addFactor("affordability", 1 - Math.min(1, amountEur / budget));
      if (metric.geography === "comarca") {
        metrics.push(metric);
        tradeoffs.push(`Purchase estimate uses the ${metric.geographyName} comarca average because the municipal resale price is unavailable.`);
      }
      tradeoffs.push("Housing budget is screened using historical averages. Check actual homes and transaction costs.");
    }

    const schoolMatches: SchoolJourney[] = [];
    if (stages.length) {
      const journeys = schoolJourneys(snapshot, municipality, travelDate, input.schoolArriveBy);
      for (const stage of stages) {
        const available = journeys.find(journey => journey.school.stages.includes(stage)
          && (input.schoolMode !== "rail" || journey.rail)
          && (input.schoolMode !== "car_free" || journey.estimatedMinutes !== null)
          && (input.maxSchoolJourneyMinutes === undefined
            || (journey.estimatedMinutes !== null && journey.estimatedMinutes <= input.maxSchoolJourneyMinutes)));
        if (available) schoolMatches.push(available);
        else {
          dataMissing.push(`school_access_${stage}`);
          reasons.push(`No evidenced ${stage} school option meets the requested journey constraints.`);
        }
      }
      if (schoolMatches.length === stages.length) {
        matchReasons.push(reasonsForSchool(schoolMatches));
        const timings = schoolMatches.map(journey => journey.estimatedMinutes);
        if (timings.every(minutes => minutes !== null)) {
          addFactor("schoolAccess", 1 - Math.min(1, Math.max(...timings) / (input.maxSchoolJourneyMinutes ?? 90)));
        }
        tradeoffs.push("Verify school admissions, walkability and the return journey.");
      }
    }

    const commute = input.commute && destination ? bestCommute(snapshot, municipality, destination, travelDate, input.commute) : undefined;
    if (input.commute && (!commute || commute.estimatedMinutes > input.commute.maxMinutes)) {
      if (!commute) dataMissing.push("direct_rail_commute");
      reasons.push("No evidenced direct rail commute meets the stated destination, time limit and departure window.");
    }
    if (input.commute && commute && commute.estimatedMinutes <= input.commute.maxMinutes) {
      addFactor("commute", 1 - commute.estimatedMinutes / input.commute.maxMinutes);
      matchReasons.push(`Direct ${commute.rail.line} connection in approximately ${commute.estimatedMinutes} minutes, including estimated walks from and to the municipal centres.`);
      tradeoffs.push("Rail journey times come from the cached timetable and exclude delays.");
    }
    if ((input.commute || input.schoolMode === "rail") && !railwayCoverage(snapshot, travelDate)) dataMissing.push("rail_timetable_for_requested_date");
    if (reasons.length) {
      excluded.push({ municipalityCode: municipality.code, reasons, dataMissing });
      continue;
    }

    const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
    const score = totalWeight ? Math.round(100 * factors.reduce((sum, factor) => sum + factor.value * factor.weight, 0) / totalWeight) : null;
    if (input.weights?.schoolAccess && schoolMatches.some(journey => journey.estimatedMinutes === null)) dataMissing.push("school_journey_time");
    const incentives = evaluateIncentives(policies, municipality, { municipalityCode: municipality.code, intent: input.housing?.tenure }, asOf)
      .filter(incentive => incentive.geographicStatus !== "does_not_apply");
    towns.push({
      municipality, score, matchReasons, tradeoffs, metrics, housingEstimate: housingEstimate ?? null,
      schools: [...new Map(schoolMatches.map(journey => [journey.school.id, journey])).values()],
      commute: commute ?? null, incentives, dataMissing,
    });
  }

  towns.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.municipality.name.localeCompare(b.municipality.name, "ca"));
  const limitations = [
    "Recommendations cover the selected Catalan municipalities in the pilot. Scheduled rail coverage is limited to the FGC Lleida–La Pobla corridor.",
    "Scores rank only known preference signals. The dated snapshot provides estimates and scheduled access.",
  ];
  if (!railwayCoverage(snapshot, travelDate)) limitations.push("The requested travel date is outside the cached FGC timetable.");
  return { snapshot: snapshotInfo(snapshot), travelDate, towns: towns.slice(0, input.limit ?? 3), excluded, limitations };
}
