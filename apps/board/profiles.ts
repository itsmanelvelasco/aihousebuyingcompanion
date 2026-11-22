import { buildRecommendationInput, inputSchema, resolveInputs } from '../../packages/contracts/inputs.ts';
import { loadData } from '../../packages/places/data.ts';
import { recommendTowns } from '../../packages/places/recommend.ts';
import type { PersonReader } from '../mcp-server/identity.ts';
import type { DemoView } from './demo.ts';

/**
 * The read-only link between the journey board and the public demo. Each scripted persona maps to
 * one fictional stored person; the board shows that person's bank feed and a town screen next to
 * the scripted scene. Nothing here writes: answers typed into the board stay in the run's own
 * in-memory state and never reach a stored person.
 */
export const demoPersonaIds = {
  onboarding: 'user-001',
  progress: 'user-002',
  shortcuts: 'user-003',
  payoff: 'user-004',
} as const;

type Context = {
  resolved: {
    data: Record<string, Record<string, unknown> | undefined>;
    provenance: Record<string, unknown[]>;
    conflicts: unknown[];
  };
};

/** The last three complete calendar months before today. */
function recentMonths() {
  const now = new Date();
  const day = (date: Date) => date.toISOString().slice(0, 10);
  return {
    from: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1))),
    to: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))),
  };
}

/**
 * A provisional town screen from the demo persona's stored preferences. A town screen cannot verify
 * bedrooms, so that requirement is kept aside for a property check and never treated as met.
 */
function townScreening(context: Context) {
  const relaxed = structuredClone(context.resolved.data) as Record<string, Record<string, unknown> | undefined>;
  const bedrooms = relaxed.housing?.minimumBedrooms;
  const propertyChecks =
    bedrooms == null ? [] : [{ field: 'minimumBedrooms', required: bedrooms, status: 'needs_property_listing' }];
  if (relaxed.housing) relaxed.housing.minimumBedrooms = null;
  const parsed = inputSchema.safeParse({
    id: 'town-screen',
    source: 'manual',
    confirmed: false,
    synthetic: true,
    observedAt: new Date().toISOString(),
    data: relaxed,
  });
  if (!parsed.success) return undefined;
  const resolved = resolveInputs([parsed.data]);
  // Only an explicit confirmation allows comarca estimates; keep that provenance from the stored context.
  const consent = context.resolved.provenance['housing.allowComarcaEstimate'] ?? [];
  resolved.provenance['housing.allowComarcaEstimate'] = consent as (typeof resolved.provenance)[string];
  resolved.conflicts = context.resolved.conflicts as typeof resolved.conflicts;
  const prepared = buildRecommendationInput(resolved);
  let result: unknown = null;
  if (prepared.ready && prepared.input) {
    const { snapshot, policies } = loadData();
    result = recommendTowns(snapshot, policies, { ...prepared.input, limit: 3 }, new Date().toISOString().slice(0, 10));
  }
  return { ...prepared, result, propertyChecks, completeHomeMatch: false };
}

/**
 * Add the demo persona's read-only facts to a scripted view: ledger revision, feed status, a
 * cash-flow summary and the town screen. A persona that cannot be read leaves the scene scripted.
 */
export async function decorateDemo(view: DemoView, persona: PersonReader | null) {
  if (!persona) return { ...view, connection: { mode: 'scripted_demo' as const } };
  try {
    const [context, events, runtime, summary, balance] = await Promise.all([
      persona.context() as Promise<Context | null>,
      persona.bankUpdates(0, 1) as Promise<{ latestRevision: number }>,
      persona.bankRuntime() as Promise<{ enabled: boolean; intervalMs: number; tickCount: number }>,
      persona.bankSummary(recentMonths()) as Promise<Record<string, unknown>>,
      persona.bankBalanceCents(),
    ]);
    if (!context) return { ...view, connection: { mode: 'scripted_demo' as const } };
    return {
      ...view,
      connection: {
        mode: 'public_demo' as const,
        readOnly: true,
        // The mode names the demo wiring; this flag is the truth about the records behind the figures.
        synthetic: summary.synthetic !== false,
        userId: persona.userId,
        ledgerRevision: events.latestRevision,
        liveBankBalanceCents: balance,
        runtime: { enabled: runtime.enabled, intervalMs: runtime.intervalMs, tickCount: runtime.tickCount },
        summary,
        warnings: [
          'Fictional demo persona, read-only. Answers typed into this board stay in this rehearsal and are not saved.',
          'Live account balances are not assumed available for a purchase. No mortgage approval is implied.',
        ],
      },
      townScreening: townScreening(context),
    };
  } catch {
    return { ...view, connection: { mode: 'scripted_demo' as const } };
  }
}
