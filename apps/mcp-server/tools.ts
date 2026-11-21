import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  businessResult, incentivesInput, incentivesResult, intent, municipalityCode, municipalityListInput,
  municipalityListResult, profileInput, profileResult, recommendationInput, recommendationResult,
  schoolQuery, schoolResult, transportQuery, transportResult,
} from "../../packages/contracts/places.ts";
import type { IncentivesInput, Policy, Snapshot } from "../../packages/contracts/places.ts";
import { getNearbySchools, getTransportOptions } from "../../packages/places/access.ts";
import { getTown, missingMetrics, snapshotInfo } from "../../packages/places/data.ts";
import { evaluateIncentives } from "../../packages/places/eligibility.ts";
import { madridDate, nextSchoolDay, normalizedName } from "../../packages/places/geography.ts";
import { recommendTowns } from "../../packages/places/recommend.ts";

import { getRelocationResearch } from "../../packages/places/relocation.ts";

const lleidaCode = "251207";
const placeCoverage = "Selected Catalan municipalities, including the FGC Lleida–La Pobla corridor and Lleida as a transport destination.";
const fiscalLimitations = [
  "Eligibility is a screening result based on declared facts and the official rules verified in the snapshot.",
  "For tax measures, the measure’s effective dates apply. Call status is unknown because tax claims do not have a grant application window.",
];
const businessKinds = new Set(["registered_unemployment", "resident_social_security_affiliates", "retail_establishments", "retail_per_1000"]);
const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent };
}

export function createMcpServer(snapshot: Snapshot, policies: Policy[], today = madridDate) {
  const metadata = snapshotInfo(snapshot);
  const server = new McpServer({ name: "relocat", version: "0.1.0" }, {
    instructions: "Use relocat to compare selected Catalan municipalities from a dated official-data snapshot. Cite evidence URLs. Explain geographic proxies, use the actual school and service dates, and distinguish policy eligibility from application status. Do not infer user finances, schooling, residence or tax facts.",
  });

  server.registerTool("list_catalonia_municipalities", {
    title: "Find municipalities in the pilot",
    description: "Resolve a municipality name or comarca to six-digit Idescat codes and see the places covered by the pilot.",
    inputSchema: municipalityListInput, outputSchema: municipalityListResult, annotations: readOnly,
  }, (input) => {
    const query = normalizedName(input.query ?? "");
    const asOf = today();
    const municipalities = snapshot.municipalities.filter(town =>
      [town.name, town.code, town.comarca].some(value => normalizedName(value).includes(query))
      && (!input.ruralOnly || ((town.rural.category === "rural" || town.rural.category === "special_attention")
        && town.rural.effectiveFrom !== null && town.rural.effectiveFrom <= asOf)));
    return result(`${municipalities.length} municipalities found in the pilot snapshot.`, { snapshot: metadata, municipalities, coverage: placeCoverage });
  });

  server.registerTool("recommend_towns", {
    title: "Recommend Catalan towns",
    description: "Return relocation research alongside towns screened against housing, school, rural status and commute requirements before ranking. Ask for floor area with a purchase budget and obtain explicit consent before setting allowComarcaEstimate. Rail results use the cached dated FGC schedule; school and commute walking legs are estimates from town centres.",
    inputSchema: recommendationInput, outputSchema: recommendationResult, annotations: readOnly,
  }, (input) => {
    const recommendation = recommendTowns(snapshot, policies, input, today());
    const names = recommendation.towns.map(town => town.municipality.name);
    const summary = names.length ? names.join(", ") + " meet the requested pilot screening criteria."
      : "No towns met all requested screening criteria with the available data.";
    return result(summary, recommendation);
  });

  server.registerTool("get_town_profile", {
    title: "Read a municipality profile",
    description: "Retrieve relocation opportunities and research coverage alongside sourced housing, population and economic indicators, map coordinates, nearby schools, FGC stations, a sample connection to Lleida and geographically relevant housing measures.",
    inputSchema: profileInput, outputSchema: profileResult, annotations: readOnly,
  }, (input) => {
    const town = getTown(snapshot, input.municipalityCode);
    const asOf = today();
    const travelDate = input.travelDate ?? nextSchoolDay(asOf);
    const stops = snapshot.rail.stops.filter(stop => stop.municipalityCode === town.code);
    const sampleConnectionToLleida = stops.length && town.code !== lleidaCode
      ? getTransportOptions(snapshot, { municipalityCode: town.code, destinationCode: lleidaCode, travelDate, limit: 3 }) : null;
    return result(`${town.name}, ${town.comarca} · municipal profile from the ${metadata.generatedOn} snapshot.`, {
      snapshot: metadata,
      municipality: town,
      relocation: getRelocationResearch(snapshot, town.code, asOf),
      metrics: snapshot.townMetrics[town.code],
      comarcaMetrics: snapshot.comarcaMetrics[town.comarca] ?? [],
      nearbySchools: getNearbySchools(snapshot, { municipalityCode: town.code, limit: 6 }, travelDate),
      railway: { stops, validThrough: snapshot.rail.validThrough, sampleConnectionToLleida, observedAt: snapshot.rail.observedAt, sourceUrl: snapshot.rail.sourceUrl },
      incentives: evaluateIncentives(policies, town, input, asOf).filter(incentive => incentive.geographicStatus !== "does_not_apply"),
      dataMissing: [...missingMetrics(snapshot, town.code), ...(!stops.length ? ["local_fgc_rail_stop"] : [])],
    });
  });

  server.registerTool("get_nearby_schools", {
    title: "Find nearby schools by stage",
    description: "Search the official directory in the municipality and nearby towns. Optionally filter by stage, estimated car-free journey, dated rail, or maximum time. School admissions and catchments need separate confirmation.",
    inputSchema: schoolQuery, outputSchema: schoolResult, annotations: readOnly,
  }, (input) => {
    const response = getNearbySchools(snapshot, input, input.travelDate ?? nextSchoolDay(today()));
    return result(`${response.schools.length} listed schools match the query.`, response);
  });

  server.registerTool("get_transport_options", {
    title: "Compare scheduled rail departures",
    description: "Return direct FGC RL1/RL2 station-to-station journeys between two pilot municipalities on an exact local service date, with optional departure bounds and total departures in the requested window.",
    inputSchema: transportQuery, outputSchema: transportResult, annotations: readOnly,
  }, (input) => {
    const response = getTransportOptions(snapshot, input);
    return result(response.scheduleCoverage === "covered"
      ? `${response.totalDepartures} scheduled direct rail departures match the search.`
      : "The requested travel date is outside the cached FGC timetable.", response);
  });

  function policyResponse(input: IncentivesInput, includeExcluded: boolean) {
    const town = getTown(snapshot, input.municipalityCode);
    const asOf = today();
    const incentives = evaluateIncentives(policies, town, input, asOf)
      .filter(incentive => includeExcluded || incentive.geographicStatus !== "does_not_apply");
    return result(`${incentives.length} housing measures for ${town.name} in the pilot catalogue.`, {
      snapshot: metadata, municipality: town, evaluatedOn: input.eventDate ?? asOf, asOf, incentives, limitations: fiscalLimitations,
    });
  }

  server.registerTool("get_applicable_incentives", {
    title: "Find housing measures by municipality",
    description: "Find sourced measures potentially available to private households for moving, buying, renting or renovating. Optionally screen confirmed household facts. Includes programme dates and separately identifies closed grant calls.",
    inputSchema: incentivesInput, outputSchema: incentivesResult, annotations: readOnly,
  }, input => policyResponse(input, false));

  server.registerTool("check_housing_incentives", {
    title: "Screen household housing incentives",
    description: "Apply deterministic rules to one housing intent and confirmed household facts. Missing or uncertain criteria return needs_verification. Provide the correct tax-base figures only when the user has confirmed them.",
    inputSchema: incentivesInput.extend({ intent }), outputSchema: incentivesResult, annotations: readOnly,
  }, input => policyResponse(input, true));

  server.registerTool("get_business_activity", {
    title: "Read municipal employment and retail indicators",
    description: "Return dated Idescat employment and unemployment signals and official retail census counts or density. These describe local activity and do not measure business financial health.",
    inputSchema: z.object({ municipalityCode }).strict(), outputSchema: businessResult, annotations: readOnly,
  }, ({ municipalityCode: code }) => {
    const town = getTown(snapshot, code);
    const metrics = snapshot.townMetrics[code].filter(metric => businessKinds.has(metric.kind));
    return result(`${metrics.length} published economic indicators for ${town.name}.`, {
      snapshot: metadata, municipality: town, metrics,
      dataMissing: missingMetrics(snapshot, code).filter(kind => businessKinds.has(kind)),
      limitations: ["Resident affiliates measure employment among residents. The historical retail census describes establishments at the observation date."],
    });
  });

  return server;
}
