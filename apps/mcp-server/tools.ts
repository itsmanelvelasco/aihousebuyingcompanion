import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { listingSearchConfig } from '../../packages/config/env.ts';
import { product } from '../../packages/config/product.ts';
import { homeSearchInput, homeSearchResult } from '../../packages/contracts/listings.ts';
import type { IncentivesInput, Policy, Snapshot, TravelEstimateData } from '../../packages/contracts/places.ts';
import {
  businessResult,
  incentivesInput,
  incentivesResult,
  intent,
  municipalityCode,
  municipalityListInput,
  municipalityListResult,
  profileInput,
  profileRecommendationInput,
  profileRecommendationResult,
  profileResult,
  recommendationInput,
  recommendationResult,
  schoolQuery,
  schoolResult,
  transportQuery,
  transportResult,
} from '../../packages/contracts/places.ts';
import type { ListingSearchConfig } from '../../packages/listings/search.ts';
import { searchHomes } from '../../packages/listings/search.ts';
import { getNearbySchools, getTransportOptions } from '../../packages/places/access.ts';
import { derivedServices, getTown, missingMetrics, snapshotInfo } from '../../packages/places/data.ts';
import { evaluateIncentives } from '../../packages/places/eligibility.ts';
import { madridDate, nextSchoolDay, normalizedName } from '../../packages/places/geography.ts';
import { recommendTowns, recommendTownsForProfile } from '../../packages/places/recommend.ts';
import { getRelocationResearch } from '../../packages/places/relocation.ts';
import type { BankToolConfig } from './bank-tools.ts';
import { registerBankTools } from './bank-tools.ts';
import { interviewerRouting, registerInterviewerTools } from './interview-tools.ts';
import { registerPlannerTools } from './planner-tools.ts';
import { registerTownExplorer } from './town-explorer.ts';
import { registerWorkspace } from './workspace.ts';

const lleidaCode = '251207';
const placeCoverage =
  'Selected Catalan municipalities, including the FGC Lleida–La Pobla corridor and Lleida as a transport destination.';
const fiscalLimitations = [
  'Eligibility is a screening result based on declared facts and the official rules verified in the snapshot.',
  'For tax measures, the measure’s effective dates apply. Call status is unknown because tax claims do not have a grant application window.',
];
const businessKinds = new Set([
  'registered_unemployment',
  'resident_social_security_affiliates',
  'retail_establishments',
  'retail_per_1000',
]);
const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent };
}

export type McpServerOptions = {
  snapshot: Snapshot;
  policies: Policy[];
  /** Clock for date-dependent rules; tests pin it. */
  today?: () => string;
  travelEstimates?: TravelEstimateData;
  /** Optional live listing provider; defaults to the server environment. */
  listings?: ListingSearchConfig;
  /** Built Town Explorer page. When present, the map widget and its tool are registered. */
  townExplorerPage?: string;
  /** Read-only bridge to the profile API's synthetic bank. */
  bankApi?: BankToolConfig;
  /** Built React workspace page. When present, the workspace widget and its tool are registered. */
  workspacePage?: string;
  /** Freshness of the live data sources, for the `get_data_sources` tool. */
  dataStatus?: () => unknown[];
  /** Guidance appended to the server instructions by a host such as the journey board. */
  extraInstructions?: string;
};

/**
 * The single place where ReloCat's MCP server is assembled. The public server and the journey
 * board both call this, so every deployment exposes the same tools for the same options.
 */
export function createMcpServer(options: McpServerOptions) {
  const { snapshot, policies, today = madridDate, travelEstimates = {}, listings = listingSearchConfig() } = options;
  const metadata = snapshotInfo(snapshot);
  const server = new McpServer(
    { name: product.id, version: product.version },
    {
      instructions:
        interviewerRouting +
        ' Use ReloCat to compare selected Catalan municipalities from a dated official-data snapshot. Cite evidence URLs. Explain geographic proxies and use the actual school and service dates. Describe sample travel times as approximate, with the transport mode and sample date. Distinguish policy eligibility from application status. Do not infer user finances, schooling, residence or tax facts.' +
        (options.extraInstructions ? ` ${options.extraInstructions}` : ''),
    },
  );

  server.registerTool(
    'list_catalonia_municipalities',
    {
      title: 'Find municipalities in the pilot',
      description:
        'Resolve a municipality name or comarca to six-digit Idescat codes and see the places covered by the pilot.',
      inputSchema: municipalityListInput,
      outputSchema: municipalityListResult,
      annotations: readOnly,
    },
    input => {
      const query = normalizedName(input.query ?? '');
      const asOf = today();
      const municipalities = snapshot.municipalities.filter(
        town =>
          [town.name, town.code, town.comarca].some(value => normalizedName(value).includes(query)) &&
          (!input.ruralOnly ||
            ((town.rural.category === 'rural' || town.rural.category === 'special_attention') &&
              town.rural.effectiveFrom !== null &&
              town.rural.effectiveFrom <= asOf)),
      );
      return result(`${municipalities.length} municipalities found in the pilot snapshot.`, {
        snapshot: metadata,
        municipalities,
        coverage: placeCoverage,
      });
    },
  );

  server.registerTool(
    'recommend_towns',
    {
      title: 'Recommend Catalan towns',
      description:
        'Return relocation research alongside towns screened against housing, school, rural status and commute requirements before ranking. Ask for floor area with a purchase budget and obtain explicit consent before setting allowComarcaEstimate. Rail results use the cached dated FGC schedule; school and commute walking legs are estimates from town centres.',
      inputSchema: recommendationInput,
      outputSchema: recommendationResult,
      annotations: readOnly,
    },
    input => {
      const recommendation = recommendTowns(snapshot, policies, input, today());
      const names = recommendation.towns.map(town => town.municipality.name);
      const summary = names.length
        ? `${names.join(', ')} meet the requested pilot screening criteria.`
        : 'No towns met all requested screening criteria with the available data.';
      return result(summary, recommendation);
    },
  );

  server.registerTool(
    'recommend_towns_for_profile',
    {
      title: 'Recommend Catalan towns from a lifestyle profile',
      description:
        'Shortlist pilot municipalities from a profile with household type, children, school stages, dog, work mode and town preference. Pass confirmed profile facts and optionally a result limit. Use recommend_towns for budget and detailed journey filters.',
      inputSchema: profileRecommendationInput,
      outputSchema: profileRecommendationResult,
      annotations: readOnly,
    },
    input => {
      const recommendation = recommendTownsForProfile(snapshot, policies, input, today());
      const { status, followUps, verificationNeeded, ignoredCriteria } = recommendation.profileAssessment;
      const names = recommendation.towns.map(town => town.municipality.name).join(', ');
      const summary =
        status === 'ranked'
          ? `Top pilot matches for the supplied preferences: ${names}.`
          : status === 'exploratory'
            ? `Pilot towns to explore: ${names}.`
            : 'No towns met all requested screening criteria with the available data.';
      const messages = [summary, ...followUps, ...verificationNeeded];
      if (ignoredCriteria?.length) {
        messages.push(
          'This profile shortlist skipped extra criteria. Use recommend_towns for budget and detailed journey filters.',
        );
      }
      return result(messages.join(' '), recommendation);
    },
  );

  server.registerTool(
    'get_town_profile',
    {
      title: 'Read a municipality profile',
      description:
        'Retrieve relocation opportunities and research coverage alongside sourced housing and economic indicators, schools, FGC stations, dated sample travel estimates to city stations and airports where covered, and relevant housing measures.',
      inputSchema: profileInput,
      outputSchema: profileResult,
      annotations: readOnly,
    },
    input => {
      const town = getTown(snapshot, input.municipalityCode);
      const asOf = today();
      const travelDate = input.travelDate ?? nextSchoolDay(asOf);
      const stops = snapshot.rail.stops.filter(stop => stop.municipalityCode === town.code);
      const sampleConnectionToLleida =
        stops.length && town.code !== lleidaCode
          ? getTransportOptions(snapshot, {
              municipalityCode: town.code,
              destinationCode: lleidaCode,
              travelDate,
              limit: 3,
            })
          : null;
      return result(`${town.name}, ${town.comarca} · municipal profile from the ${metadata.generatedOn} snapshot.`, {
        snapshot: metadata,
        municipality: town,
        relocation: getRelocationResearch(snapshot, town.code, asOf),
        metrics: snapshot.townMetrics[town.code],
        comarcaMetrics: snapshot.comarcaMetrics[town.comarca] ?? [],
        nearbySchools: getNearbySchools(snapshot, { municipalityCode: town.code, limit: 6 }, travelDate),
        travelEstimates: travelEstimates[town.code] ?? [],
        railway: {
          stops,
          validThrough: snapshot.rail.validThrough,
          sampleConnectionToLleida,
          observedAt: snapshot.rail.observedAt,
          sourceUrl: snapshot.rail.sourceUrl,
        },
        services: [...(snapshot.services?.[town.code] ?? []), ...(derivedServices(snapshot)[town.code] ?? [])],
        incentives: evaluateIncentives(policies, town, input, asOf).filter(
          incentive => incentive.geographicStatus !== 'does_not_apply',
        ),
        dataMissing: [...missingMetrics(snapshot, town.code), ...(!stops.length ? ['local_fgc_rail_stop'] : [])],
      });
    },
  );

  server.registerTool(
    'get_nearby_schools',
    {
      title: 'Find nearby schools by stage',
      description:
        'Search the official directory in the municipality and nearby towns. Optionally filter by stage, estimated car-free journey, dated rail, or maximum time. School admissions and catchments need separate confirmation.',
      inputSchema: schoolQuery,
      outputSchema: schoolResult,
      annotations: readOnly,
    },
    input => {
      const response = getNearbySchools(snapshot, input, input.travelDate ?? nextSchoolDay(today()));
      return result(`${response.schools.length} listed schools match the query.`, response);
    },
  );

  server.registerTool(
    'get_transport_options',
    {
      title: 'Compare scheduled rail departures',
      description:
        'Return direct FGC RL1/RL2 station-to-station journeys between two pilot municipalities on an exact local service date, with optional departure bounds and total departures in the requested window.',
      inputSchema: transportQuery,
      outputSchema: transportResult,
      annotations: readOnly,
    },
    input => {
      const response = getTransportOptions(snapshot, input);
      return result(
        response.scheduleCoverage === 'covered'
          ? `${response.totalDepartures} scheduled direct rail departures match the search.`
          : 'The requested travel date is outside the cached FGC timetable.',
        response,
      );
    },
  );

  function policyResponse(input: IncentivesInput, includeExcluded: boolean) {
    const town = getTown(snapshot, input.municipalityCode);
    const asOf = today();
    const incentives = evaluateIncentives(policies, town, input, asOf).filter(
      incentive => includeExcluded || incentive.geographicStatus !== 'does_not_apply',
    );
    return result(`${incentives.length} housing measures for ${town.name} in the pilot catalogue.`, {
      snapshot: metadata,
      municipality: town,
      evaluatedOn: input.eventDate ?? asOf,
      asOf,
      incentives,
      limitations: fiscalLimitations,
    });
  }

  server.registerTool(
    'get_applicable_incentives',
    {
      title: 'Find housing measures by municipality',
      description:
        'Find sourced measures potentially available to private households for moving, buying, renting or renovating. Optionally screen confirmed household facts. Includes programme dates and separately identifies closed grant calls.',
      inputSchema: incentivesInput,
      outputSchema: incentivesResult,
      annotations: readOnly,
    },
    input => policyResponse(input, false),
  );

  server.registerTool(
    'check_housing_incentives',
    {
      title: 'Screen household housing incentives',
      description:
        'Apply deterministic rules to one housing intent and confirmed household facts. Missing or uncertain criteria return needs_verification. Provide the correct tax-base figures only when the user has confirmed them.',
      inputSchema: incentivesInput.extend({ intent }),
      outputSchema: incentivesResult,
      annotations: readOnly,
    },
    input => policyResponse(input, true),
  );

  server.registerTool(
    'get_business_activity',
    {
      title: 'Read municipal employment and retail indicators',
      description:
        'Return dated Idescat employment and unemployment signals and official retail census counts or density. These describe local activity and do not measure business financial health.',
      inputSchema: z.object({ municipalityCode }).strict(),
      outputSchema: businessResult,
      annotations: readOnly,
    },
    ({ municipalityCode: code }) => {
      const town = getTown(snapshot, code);
      const metrics = snapshot.townMetrics[code].filter(metric => businessKinds.has(metric.kind));
      return result(`${metrics.length} published economic indicators for ${town.name}.`, {
        snapshot: metadata,
        municipality: town,
        metrics,
        dataMissing: missingMetrics(snapshot, code).filter(kind => businessKinds.has(kind)),
        limitations: [
          'Resident affiliates measure employment among residents. The historical retail census describes establishments at the observation date.',
        ],
      });
    },
  );

  registerInterviewerTools(server);
  server.registerTool(
    'search_homes',
    {
      title: 'Find Idealista property examples',
      description:
        'Search the web live through treg for Idealista listing examples in up to three pilot towns. Budget and bedrooms are search hints, not verified filters. Returns original links and search timestamps; availability and exact location remain unverified. Costs up to USD 0.01 per town. Requires server-side TREG_TOKEN; otherwise returns provider_unavailable and search links.',
      inputSchema: homeSearchInput,
      outputSchema: homeSearchResult,
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: false },
    },
    async input => {
      const response = await searchHomes(snapshot, input, listings);
      const count = response.searches.reduce((sum, search) => sum + search.examples.length, 0);
      return result(
        `${count} indexed property examples returned; inspect per-town search status and verify listing details.`,
        response,
      );
    },
  );

  if (options.townExplorerPage) registerTownExplorer(server, snapshot, options.townExplorerPage);
  if (options.workspacePage) registerWorkspace(server, options.workspacePage);
  if (options.bankApi) registerBankTools(server, options.bankApi);
  // Person and place entities and the savings plan; the profile API supplies stored people.
  if (options.dataStatus) {
    const dataStatus = options.dataStatus;
    server.registerTool(
      'get_data_sources',
      {
        title: 'Check data freshness',
        description:
          'List every official data source ReloCat reads, when it was last fetched and whether the cached copy is fresh, stale or failing. Use it to answer how current a figure is.',
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({
          snapshot: z.object({ version: z.string(), generatedOn: z.string() }),
          sources: z.array(z.record(z.string(), z.unknown())),
        }),
        annotations: readOnly,
      },
      () => {
        const sources = dataStatus() as Record<string, unknown>[];
        return result(`${sources.length} live data sources; the committed snapshot is the baseline.`, {
          snapshot: metadata,
          sources,
        });
      },
    );
  }
  registerPlannerTools(server, { snapshot, policies, today, profileApi: options.bankApi });
  return server;
}
