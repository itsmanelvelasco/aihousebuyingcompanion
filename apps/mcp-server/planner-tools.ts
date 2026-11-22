import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { stateSchema } from '../../packages/contracts/habits.ts';
import { safeId } from '../../packages/contracts/ids.ts';
import type { Policy, Snapshot } from '../../packages/contracts/places.ts';
import { municipalityCode } from '../../packages/contracts/places.ts';
import type { Person } from '../../packages/contracts/planner.ts';
import { person, place, planInput, planResult } from '../../packages/contracts/planner.ts';
import { bankSummaryInput, buildPerson } from '../../packages/model/person.ts';
import { buildPlace } from '../../packages/model/place.ts';
import { normalizedName } from '../../packages/places/geography.ts';
import { planForPlaces } from '../../packages/planner/plan.ts';

export type PlannerToolOptions = {
  snapshot: Snapshot;
  policies: Policy[];
  /** Clock for date-dependent rules; tests pin it. */
  today: () => string;
  /** Read-only bridge to the profile API. Without it only inline persons can be planned. */
  profileApi?: { baseUrl: string; token: string };
};

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };
/** Complete calendar months of bank movements averaged into a typical month. */
const bankMonths = 3;
const contextResult = z.object({
  synthetic: z.boolean().optional(),
  resolved: z.object({
    data: z.record(z.string(), z.record(z.string(), z.unknown())),
    provenance: z.record(z.string(), z.array(z.object({ confirmed: z.boolean(), observedAt: z.string() }))).optional(),
  }),
});

function result(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent };
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** The last `count` complete calendar months before `today`, as first and last day. */
function completeMonths(today: string, count: number) {
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const day = (date: Date) => date.toISOString().slice(0, 10);
  return { from: day(new Date(Date.UTC(year, month - 1 - count, 1))), to: day(new Date(Date.UTC(year, month - 1, 0))) };
}

/** A message that is safe to show: never an upstream body, a URL or the token. */
class PersonUnavailable extends Error {}

function profileReader(config: NonNullable<PlannerToolOptions['profileApi']>) {
  const base = new URL(config.baseUrl);
  if (base.username || base.password || base.search || base.hash || !config.token.trim())
    throw new Error('Invalid profile API configuration');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
    throw new Error('Profile API requires HTTPS or loopback HTTP');
  /** Parsed JSON, `null` for 404, or a thrown error for anything else. */
  return async function read<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T> | null> {
    const response = await fetch(base.href.replace(/\/$/, '') + path, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Unavailable');
    return schema.parse(await response.json());
  };
}

export function registerPlannerTools(server: McpServer, options: PlannerToolOptions) {
  const { snapshot, policies, today } = options;
  const read = options.profileApi ? profileReader(options.profileApi) : null;

  /**
   * Load a stored person. The context is required; bank movements and habits are optional
   * evidence, and each one that could not be read is reported instead of being silently dropped.
   */
  async function loadPerson(userId: string): Promise<{ person: Person; notes: string[] }> {
    if (!read)
      throw new PersonUnavailable(
        'Stored persons are not available on this server. Pass the person inline instead of a userId.',
      );
    const context = await read(`/users/${userId}/context`, contextResult).catch(() => {
      throw new PersonUnavailable('The profile API is unavailable or returned an invalid context.');
    });
    if (!context) throw new PersonUnavailable('No stored person has that userId.');
    const notes: string[] = [];
    const { from, to } = completeMonths(today(), bankMonths);
    const bankSummary = await read(`/users/${userId}/bank/summary?from=${from}&to=${to}`, bankSummaryInput).catch(
      () => {
        notes.push('Bank movements could not be read; only declared figures were used.');
        return null;
      },
    );
    const habitState = await read(`/users/${userId}/habits`, stateSchema).catch(() => {
      notes.push('Habits could not be read; none were counted.');
      return null;
    });
    const name = context.resolved.data.location?.currentMunicipality;
    const current =
      typeof name === 'string'
        ? snapshot.municipalities.find(town => normalizedName(town.name) === normalizedName(name))
        : undefined;
    return {
      person: buildPerson({
        userId,
        context,
        bankSummary: bankSummary ?? undefined,
        habitState: habitState ?? undefined,
        currentMunicipalityCode: current?.code ?? null,
      }),
      notes,
    };
  }

  /** Run a tool body and turn every failure into a tool error that carries no upstream detail. */
  async function guarded(run: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PersonUnavailable) return failure(error.message);
      if (error instanceof z.ZodError) return failure('The request or the stored data did not match the contract.');
      const outside = error instanceof Error && error.message.startsWith('Municipality ');
      return failure(outside ? (error as Error).message : 'The plan could not be computed.');
    }
  }

  server.registerTool(
    'plan_home_savings',
    {
      title: 'Estimate months of saving to buy in each place',
      description:
        'For one person and up to eight municipalities, compute the upfront cash to buy (deposit, transfer tax, purchase fees) and the months of saving needed: with current savings, with the person’s habits, and with the benefits each place offers. Pass userId for a stored person or an inline person. Benefits are counted only when eligibility is confirmed unless includeUnverifiedBenefits is set; closed calls are never counted. This is arithmetic on supplied figures: it is not mortgage approval and no aid is guaranteed. Present assumptions, dataMissing and limitations with the result.',
      inputSchema: planInput,
      outputSchema: planResult,
      annotations: readOnly,
    },
    input =>
      guarded(async () => {
        if (!input.person && !input.userId) return failure('Provide either userId or person.');
        const loaded = input.person
          ? { person: input.person, notes: [] as string[] }
          : await loadPerson(input.userId as string);
        const places = [...new Set(input.municipalityCodes)].map(code => buildPlace(snapshot, code));
        const plan = planForPlaces(loaded.person, places, policies, input.assumptions, today());
        const finite = plan.plans.filter(item => item.withPlaceBenefits?.months != null);
        const best = finite[0];
        const summary = best
          ? `Shortest estimate: ${best.withPlaceBenefits?.months} months of saving for ${best.place.name}. An arithmetic estimate, not mortgage approval or guaranteed aid.`
          : 'No finite savings timeline could be estimated; see status and dataMissing for each place.';
        return result(summary, { ...plan, limitations: [...plan.limitations, ...loaded.notes] });
      }),
  );

  server.registerTool(
    'get_person',
    {
      title: 'Read a person: finances, home needs and habits',
      description:
        'Assemble the stored person entity from the resolved inputs, recent synthetic bank cash flow and habit goals. Unknown facts are null, not zero. finances.basis says whether figures were declared or observed in bank movements.',
      inputSchema: z.object({ userId: safeId }).strict(),
      outputSchema: person,
      annotations: readOnly,
    },
    ({ userId }) =>
      guarded(async () => {
        const loaded = await loadPerson(userId);
        const text = ['Person assembled from stored inputs.', ...loaded.notes].join(' ');
        return result(text, loaded.person);
      }),
  );

  server.registerTool(
    'get_place',
    {
      title: 'Read a place: indicators and services',
      description:
        'Return one municipality as a place node: rural category, centre, sourced population, density, foreign-population share, resale price and rent, and service counts. Missing figures are null and named in dataMissing; a comarca figure used as a proxy is marked geography: comarca.',
      inputSchema: z.object({ municipalityCode }).strict(),
      outputSchema: place,
      annotations: readOnly,
    },
    ({ municipalityCode: code }) =>
      guarded(() => {
        const node = buildPlace(snapshot, code);
        return result(`${node.name}, ${node.comarca} · place node from the ${snapshot.generatedOn} snapshot.`, node);
      }),
  );
}
