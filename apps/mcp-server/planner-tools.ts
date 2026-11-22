import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { stateSchema } from '../../packages/contracts/habits.ts';
import { inputSchema } from '../../packages/contracts/inputs.ts';
import type { Policy, Snapshot } from '../../packages/contracts/places.ts';
import { municipalityCode } from '../../packages/contracts/places.ts';
import type { Person } from '../../packages/contracts/planner.ts';
import { person, place, planInput, planResult } from '../../packages/contracts/planner.ts';
import { bankSummaryInput, buildPerson } from '../../packages/model/person.ts';
import { buildPlace } from '../../packages/model/place.ts';
import { normalizedName } from '../../packages/places/geography.ts';
import { planForPlaces } from '../../packages/planner/plan.ts';
import type { Caller, PersonReader } from './identity.ts';
import { anonymous, ownPerson, security } from './identity.ts';

export type PlannerToolOptions = {
  snapshot: Snapshot;
  policies: Policy[];
  /** Clock for date-dependent rules; tests pin it. */
  today: () => string;
  /** Who is calling. Without it only inline persons can be planned. */
  caller?: Caller;
};

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };
/** Complete calendar months of bank movements averaged into a typical month. */
const bankMonths = 3;
const contextResult = z.object({
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

/**
 * What is fictional and what is not, in one sentence for the model to repeat. The person and the
 * bank movements behind their figures are labelled separately: a real person can be connected to a
 * fictional bank, and then the profile is real and the movements are synthetic.
 */
export function provenanceNote(who: Person): string {
  const bank = who.finances.bankSynthetic;
  if (who.synthetic)
    return bank === false
      ? 'This is a fictional persona (synthetic: true), but the bank figures include real bank data.'
      : 'This is a fictional persona: every figure is synthetic demo data.';
  if (bank === true)
    return 'The profile is the person’s own (synthetic: false). The monthly figures observed in the bank come from a fictional bank feed (bankSynthetic: true), not from a real bank.';
  return bank === false
    ? 'The profile is the person’s own and the bank figures come from real bank data (synthetic: false).'
    : 'The profile is the person’s own (synthetic: false).';
}

/** A message that is safe to show: never an upstream body or a URL. */
class PersonUnavailable extends Error {}

/**
 * The person, place and plan tools. A stored person is reached only through the caller: `me` for
 * the signed-in person, or a read-only demo persona. No tool here accepts a user id.
 */
export function registerPlannerTools(server: McpServer, options: PlannerToolOptions) {
  const { snapshot, policies, today } = options;
  const caller = options.caller ?? anonymous;
  const demoIds = caller.demo?.ids ?? [];
  /** Only the configured demo personas can be named; any other id fails validation before a handler runs. */
  const demoId = z.enum((demoIds.length ? demoIds : ['none']) as [string, ...string[]]);

  /**
   * Assemble a person from a handle that is already bound to one id. The context is required; bank
   * movements and habits are optional evidence, and each one that could not be read is reported
   * instead of being silently dropped.
   */
  async function loadPerson(reader: PersonReader): Promise<{ person: Person; notes: string[] }> {
    const raw = await reader.context().catch(() => {
      throw new PersonUnavailable('The stored profile is unavailable right now.');
    });
    if (!raw) throw new PersonUnavailable('No stored person was found.');
    const context = contextResult.parse(raw);
    const notes: string[] = [];
    const period = completeMonths(today(), bankMonths);
    const bankSummary = await reader
      .bankSummary(period)
      .then(value => bankSummaryInput.parse(value))
      .catch(() => {
        notes.push('Bank movements could not be read; only declared figures were used.');
        return null;
      });
    const habitState = await reader
      .habits()
      .then(value => stateSchema.parse(value))
      .catch(() => {
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
        userId: reader.userId,
        // Fictional for a demo persona, real for a person who belongs to an account: stated by the handle.
        synthetic: reader.synthetic,
        context,
        bankSummary: bankSummary ?? undefined,
        habitState: habitState ?? undefined,
        currentMunicipalityCode: current?.code ?? null,
      }),
      notes,
    };
  }

  /** The read-only handle of a demo persona; a tool error when the demo is off or the id is not allowed. */
  function demoPerson(id: string) {
    const reader = caller.demo?.open(id);
    if (!reader) throw new PersonUnavailable('That demo persona is not available on this server.');
    return reader;
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

  const planToolInput = z
    .object({
      /** A person sent inline, for a what-if or an anonymous estimate. */
      person: person.optional(),
      /** Plan for the signed-in person. There is no user id argument: the server knows who is calling. */
      me: z.literal(true).optional(),
      demoId: demoId.optional().describe('A fictional demo persona, read-only'),
      municipalityCodes: planInput.shape.municipalityCodes,
      assumptions: planInput.shape.assumptions,
    })
    .strict();

  server.registerTool(
    'plan_home_savings',
    {
      title: 'Estimate months of saving to buy in each place',
      description:
        'For one person and up to eight municipalities, compute the upfront cash to buy (deposit, transfer tax, purchase fees) and the months of saving needed: with current savings, with the person’s habits, and with the benefits each place offers. Pass exactly one of: me:true for the signed-in person (needs sign-in), an inline person, or demoId for a fictional demo persona. There is no user id argument. Benefits are counted only when eligibility is confirmed unless includeUnverifiedBenefits is set; closed calls are never counted. habits says for each habit whether it was counted and why: say so instead of assuming an active habit was counted. A benefit with a null amountCents and an ineligible status brings the person nothing; nominalAmountCents is only what it is worth to someone who qualifies. person.synthetic and person.finances.bankSynthetic say separately whether the person and the bank movements are fictional: repeat them as given. This is arithmetic on supplied figures: it is not mortgage approval and no aid is guaranteed. Present assumptions, dataMissing and limitations with the result.',
      inputSchema: planToolInput,
      outputSchema: planResult,
      annotations: readOnly,
      _meta: security('either'),
    },
    input =>
      guarded(async () => {
        const chosen = [input.person, input.me, input.demoId].filter(value => value !== undefined);
        if (chosen.length !== 1) return failure('Provide exactly one of me:true, person or demoId.');
        let loaded: { person: Person; notes: string[] };
        if (input.person) loaded = { person: input.person, notes: [] };
        else if (input.me) {
          const own = ownPerson(caller, 'person:read');
          if ('error' in own) return own.error;
          loaded = await loadPerson(own.me);
        } else loaded = await loadPerson(demoPerson(input.demoId as string));
        const places = [...new Set(input.municipalityCodes)].map(code => buildPlace(snapshot, code));
        const plan = planForPlaces(loaded.person, places, policies, input.assumptions, today());
        const finite = plan.plans.filter(item => item.withPlaceBenefits?.months != null);
        const best = finite[0];
        const summary = best
          ? `Shortest estimate: ${best.withPlaceBenefits?.months} months of saving for ${best.place.name}. An arithmetic estimate, not mortgage approval or guaranteed aid.`
          : 'No finite savings timeline could be estimated; see status and dataMissing for each place.';
        const withheld = (plan.habits ?? []).filter(
          effect => effect.reason === 'inside_bank_figures' || effect.reason === 'start_unknown',
        ).length;
        const habitNote = withheld
          ? ` ${withheld} active habit(s) are shown but not counted; habits says why for each.`
          : '';
        return result(`${summary}${habitNote} ${provenanceNote(plan.person)}`, {
          ...plan,
          limitations: [...plan.limitations, ...loaded.notes],
        });
      }),
  );

  server.registerTool(
    'get_person',
    {
      title: 'Read my person: finances, home needs and habits',
      description:
        'Assemble the signed-in person from their saved inputs, recent bank cash flow and habit goals. Takes no arguments: it always reads the caller’s own person and needs sign-in. Unknown facts are null, not zero. finances.basis says whether figures were declared or observed in bank movements; finances.bankSynthetic says whether those movements come from a fictional bank feed, which is separate from the person being real (synthetic: false). Savings for the purchase are only what the person declared: a bank balance is never used for them.',
      inputSchema: z.object({}).strict(),
      outputSchema: person,
      annotations: readOnly,
      _meta: security('personal'),
    },
    () =>
      guarded(async () => {
        const own = ownPerson(caller, 'person:read');
        if ('error' in own) return own.error;
        const loaded = await loadPerson(own.me);
        return result(
          ['Your person, assembled from your saved inputs.', provenanceNote(loaded.person), ...loaded.notes].join(' '),
          loaded.person,
        );
      }),
  );

  server.registerTool(
    'get_my_inputs',
    {
      title: 'Read what I have saved',
      description:
        'Return the signed-in person’s saved input records and the resolved context built from them (which value wins per field, its source, and unresolved conflicts). Each record carries synthetic: false for what the person stated, true only for a record derived from a fictional source. bankSnapshot, when present, is an account balance kept as its own unconfirmed fact: it is not savings for the purchase. Takes no arguments and needs sign-in.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        inputCount: z.number().int().nonnegative(),
        inputs: z.array(z.record(z.string(), z.unknown())),
        resolved: z.record(z.string(), z.unknown()),
        recommendation: z.record(z.string(), z.unknown()).nullable(),
        warnings: z.array(z.string()),
        bankSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
      annotations: readOnly,
      _meta: security('personal'),
    },
    () =>
      guarded(async () => {
        const own = ownPerson(caller, 'person:read');
        if ('error' in own) return own.error;
        const context = await own.me.context();
        if (!context) throw new PersonUnavailable('No stored person was found.');
        const stored = z.object({ inputs: z.array(z.record(z.string(), z.unknown())) }).parse(await own.me.inputs());
        return result(`${stored.inputs.length} saved input records.`, {
          inputCount: stored.inputs.length,
          // Each record carries its own flag: false for what the person stated, true for a fabricated source.
          inputs: stored.inputs,
          resolved: (context.resolved ?? {}) as Record<string, unknown>,
          recommendation: (context.recommendation ?? null) as Record<string, unknown> | null,
          warnings: Array.isArray(context.warnings) ? (context.warnings as string[]) : [],
          bankSnapshot: (context.bankSnapshot ?? null) as Record<string, unknown> | null,
        });
      }),
  );

  server.registerTool(
    'save_my_inputs',
    {
      title: 'Save details to my profile',
      description:
        'Save facts the signed-in person stated about their household, housing needs, schools, transport, finances (integer cents) or eligibility. Needs sign-in with write permission; it always writes to the caller’s own person. Set confirmed:true only when the person explicitly confirmed the values; otherwise false. Each call adds one dated record; earlier records are kept, and conflicts are reported by get_my_inputs.',
      inputSchema: z
        .object({
          data: inputSchema.shape.data,
          confirmed: z.boolean(),
          source: z.enum(['interview', 'manual']).default('interview'),
        })
        .strict(),
      outputSchema: z.object({ saved: z.boolean(), inputId: z.string(), inputCount: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: security('personal', ['person:write']),
    },
    input =>
      guarded(async () => {
        const own = ownPerson(caller, 'person:write');
        if ('error' in own) return own.error;
        const inputId = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        await own.me.saveInputs([
          {
            id: inputId,
            source: input.source,
            observedAt: new Date().toISOString(),
            confirmed: input.confirmed,
            // What a signed-in person states about themselves is real; the handle knows which it is.
            synthetic: own.me.synthetic,
            data: input.data,
          },
        ]);
        const stored = z.object({ inputs: z.array(z.unknown()) }).parse(await own.me.inputs());
        return result('Saved to your profile.', { saved: true, inputId, inputCount: stored.inputs.length });
      }),
  );

  if (demoIds.length)
    server.registerTool(
      'get_demo_person',
      {
        title: 'Read a fictional demo persona',
        description:
          'Read one of the fictional demo personas (synthetic: true): invented household, finances and habits used to show the product. Read-only; it can never address a real person.',
        inputSchema: z.object({ demoId }).strict(),
        outputSchema: person,
        annotations: readOnly,
        _meta: security('public'),
      },
      ({ demoId: id }) =>
        guarded(async () => {
          const loaded = await loadPerson(demoPerson(id));
          return result([provenanceNote(loaded.person), ...loaded.notes].join(' '), loaded.person);
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
