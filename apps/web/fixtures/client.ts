import type { CallTool, ToolResult } from '../client.ts';
import { fixtureNoSavings, fixturePlan } from './plan.ts';

/**
 * `CallTool` for `?fixture=1`: answers the same tools with canned data so the page can be inspected
 * without a server. `variant` picks a state to look at: `nosavings` (timelines with no end),
 * `plan-error` and `bank-error` (failed tools), `empty` (no places returned), `suggest-error` and
 * `suggest-none` (the suggestions fail, or nothing passes the filters), `habit-error` (a server
 * that cannot save habits yet).
 */
export function fixtureCallTool(variant: string, delayMs = 350): CallTool {
  let polls = 0;
  // Saving is the signed-in person's: the variant that cannot save a habit is signed in too.
  const signedIn = variant === 'signed-in' || variant === 'habit-error';
  const ok = (structuredContent: unknown): ToolResult => ({ structuredContent });
  const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });
  const startedAt = Date.now();
  // `transactionCount` is the size of the ledger after the change, as the real bank events report it.
  const event = (sequence: number, secondsAgo: number, transactionCount: number) => ({
    sequence,
    occurredAt: new Date(startedAt - secondsAgo * 1000).toISOString(),
    type: 'bank.updated',
    accountCount: 1,
    transactionCount,
  });
  const source = { observedAt: '2026-11-21', sourceUrl: 'https://api.idescat.cat/emex/v1/nodes.json?lang=ca' };
  const towns = fixturePlan.plans.map(({ place }) => ({
    code: place.municipalityCode,
    name: place.name,
    comarca: place.comarca,
    recommendable: true,
    identity: source,
    centre: { ...place.centre, ...source, name: place.name },
    rural: { ...source, category: place.rural, effectiveFrom: null },
  }));
  return async (name, args) => {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (name === 'recommend_towns') {
      if (variant === 'suggest-error')
        return fail('Provide homeSizeM2 (constructed floor area) with a purchase budget to estimate a resale price.');
      // The fixture does not screen: every sample town "fits" except the last, which is left out.
      const fits = variant === 'suggest-none' ? [] : towns.slice(0, -1);
      return ok({
        snapshot: { version: 'fixture', generatedOn: '2026-11-21' },
        travelDate: '2026-11-23',
        towns: fits.map((municipality, index) => ({
          municipality,
          score: index === 0 ? 72 : null,
          matchReasons: ['Sample reason: the official rural classification applies here.'],
          tradeoffs: index === 0 ? ['Sample compromise: check real listings and the purchase costs.'] : [],
          metrics: [],
          housingEstimate: null,
          schools: [],
          commute: null,
          dataMissing: index === 1 ? ['resale_eur_per_m2'] : [],
          incentives: [],
          relocation: {
            coverage: 'not_researched',
            checkedOn: null,
            sourcePage: null,
            asOf: '2026-11-23',
            research: null,
            opportunityChecks: [],
            limitations: [],
          },
        })),
        excluded: towns.slice(fits.length).map(town => ({
          municipalityCode: town.code,
          reasons: ['Sample exclusion: the published housing data are not enough to screen the budget.'],
          dataMissing: ['resale_transactions'],
        })),
        limitations: ['Sample limitation: the suggestions cover the pilot municipalities only.'],
      });
    }
    if (name === 'save_my_habit')
      return variant === 'habit-error'
        ? fail('MCP error -32602: Tool save_my_habit not found')
        : ok({ saved: true, habit: { id: 'fixture-habit', ...args } });
    if (name === 'plan_home_savings') {
      if (variant === 'plan-error') return fail('MCP error -32602: Tool plan_home_savings not found');
      const base = variant === 'nosavings' ? fixtureNoSavings : fixturePlan;
      const codes = Array.isArray(args.municipalityCodes) ? (args.municipalityCodes as string[]) : [];
      const plans = variant === 'empty' ? [] : base.plans.filter(plan => codes.includes(plan.place.municipalityCode));
      // The fixture does not recalculate: an edited person is echoed back with the same timelines.
      return ok({ ...base, person: args.person ?? base.person, plans });
    }
    if (name === 'show_workspace')
      return ok({
        subject: signedIn ? 'me' : args.demoId ? 'demo' : 'none',
        demoId: signedIn ? null : (args.demoId ?? null),
        signedIn,
        demoIds: ['user-001', 'user-002', 'user-003', 'user-004'],
        municipalityCodes: args.municipalityCodes ?? [],
      });
    if (name === 'save_my_inputs') return ok({ saved: true, inputId: 'fixture-input', inputCount: 1 });
    // The demo tools answer like the personal ones; only who they read differs.
    name = name.replace(/^get_demo_bank_/, 'get_bank_');
    if (name.startsWith('get_bank_') && variant === 'bank-error')
      return fail(
        'Synthetic bank data is unavailable or invalid. Check the local profile API and server-side bridge configuration.',
      );
    if (name === 'get_bank_updates') {
      polls += 1;
      const after = Number(args.after ?? 0);
      // Two stored events at first (ledger of 181, then 184 movements), then two more movements
      // arrive after a few polls to exercise the refresh: the strip must say "2 new transactions".
      const all = [event(1, 5400, 181), event(2, 900, 184), ...(polls >= 4 ? [event(3, 0, 186)] : [])];
      const latest = all.at(-1)!.sequence;
      return ok({
        synthetic: true,
        events: all.filter(item => item.sequence > after),
        latestRevision: latest,
        nextCursor: latest,
        requiresRefresh: false,
        hasMore: false,
      });
    }
    if (name === 'get_bank_runtime')
      return ok({
        synthetic: true,
        userId: 'user-001',
        enabled: true,
        intervalMs: 5000,
        lastTickAt: new Date(startedAt).toISOString(),
        lastError: null,
        tickCount: 42,
      });
    if (name === 'get_bank_summary')
      return ok({
        synthetic: true,
        currency: 'EUR',
        from: args.from,
        to: args.to,
        monthCount: 3,
        dataStatus: 'observed',
        transactionCount: 184,
        incomeCents: 960_000,
        expenseCents: 741_300,
        netCashflowCents: 218_700,
        averageMonthlySavingsCents: 72_900,
        excludedPendingCount: 2,
        excludedInternalTransferCount: 5,
        assumptions: ['Pending movements and transfers between own accounts are excluded.'],
        ledgerUpdatedAt: new Date(startedAt - 900_000).toISOString(),
      });
    if (name === 'list_catalonia_municipalities')
      return ok({
        snapshot: { version: 'fixture', generatedOn: '2026-11-21' },
        coverage: 'Fixture towns.',
        municipalities: towns,
      });
    return fail(`MCP error -32602: Tool ${name} not found`);
  };
}
