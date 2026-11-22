import type { CallTool, ToolResult } from '../client.ts';
import { fixtureNoSavings, fixturePlan } from './plan.ts';

/**
 * `CallTool` for `?fixture=1`: answers the same tools with canned data so the page can be inspected
 * without a server. `variant` picks a state to look at: `nosavings` (timelines with no end),
 * `plan-error` and `bank-error` (failed tools), `empty` (no places returned).
 */
export function fixtureCallTool(variant: string, delayMs = 350): CallTool {
  let polls = 0;
  const ok = (structuredContent: unknown): ToolResult => ({ structuredContent });
  const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });
  const startedAt = Date.now();
  const event = (sequence: number, secondsAgo: number, transactionCount: number) => ({
    sequence,
    occurredAt: new Date(startedAt - secondsAgo * 1000).toISOString(),
    type: 'bank.updated',
    accountCount: 1,
    transactionCount,
  });
  return async (name, args) => {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (name === 'plan_home_savings') {
      if (variant === 'plan-error') return fail('MCP error -32602: Tool plan_home_savings not found');
      const base = variant === 'nosavings' ? fixtureNoSavings : fixturePlan;
      const codes = Array.isArray(args.municipalityCodes) ? (args.municipalityCodes as string[]) : [];
      const plans = variant === 'empty' ? [] : base.plans.filter(plan => codes.includes(plan.place.municipalityCode));
      // The fixture does not recalculate: an edited person is echoed back with the same timelines.
      return ok({ ...base, person: args.person ?? base.person, plans });
    }
    if (name.startsWith('get_bank_') && variant === 'bank-error')
      return fail(
        'Synthetic bank data is unavailable or invalid. Check the local profile API and server-side bridge configuration.',
      );
    if (name === 'get_bank_updates') {
      polls += 1;
      const after = Number(args.after ?? 0);
      // Two stored events at first, then one new event on the third poll to exercise the refresh.
      const all = [event(1, 5400, 6), event(2, 900, 3), ...(polls >= 3 ? [event(3, 0, 2)] : [])];
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
    if (name === 'list_catalonia_municipalities') {
      const source = { observedAt: '2026-11-21', sourceUrl: 'https://api.idescat.cat/emex/v1/nodes.json?lang=ca' };
      return ok({
        snapshot: { version: 'fixture', generatedOn: '2026-11-21' },
        coverage: 'Fixture towns.',
        municipalities: fixturePlan.plans.map(({ place }) => ({
          code: place.municipalityCode,
          name: place.name,
          comarca: place.comarca,
          recommendable: true,
          identity: source,
          centre: { ...place.centre, ...source, name: place.name },
          rural: { ...source, category: place.rural, effectiveFrom: null },
        })),
      });
    }
    return fail(`MCP error -32602: Tool ${name} not found`);
  };
}
