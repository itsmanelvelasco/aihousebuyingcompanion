import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { safeId } from '../../packages/contracts/ids.ts';
import { periodSchema } from '../../packages/finance/cashflow.ts';

export type BankToolConfig = { baseUrl: string; token: string };
const count = z.number().int().safe().nonnegative();
const cents = z.number().int().safe();
const timestamp = z.string().nullable();
const output = z.object({}).catchall(z.json());
/** The provenance label for a result, taken from its own `synthetic` flag rather than assumed. */
const provenance = (data: Record<string, unknown>) =>
  data.synthetic === true
    ? 'All underlying records are synthetic demo data.'
    : 'The underlying records include real bank data (synthetic: false).';
const eventsResult = z.object({
  synthetic: z.boolean(),
  events: z.array(
    z.object({
      sequence: count,
      occurredAt: z.string(),
      type: z.literal('bank.updated'),
      accountCount: count,
      transactionCount: count,
    }),
  ),
  latestRevision: count,
  nextCursor: count,
  requiresRefresh: z.boolean(),
  hasMore: z.boolean(),
});
const runtimeResult = z.object({
  synthetic: z.boolean(),
  userId: safeId,
  enabled: z.boolean(),
  intervalMs: count,
  lastTickAt: timestamp,
  lastError: timestamp,
  tickCount: count,
});
const summaryResult = z.object({
  synthetic: z.boolean(),
  currency: z.literal('EUR'),
  from: z.string(),
  to: z.string(),
  monthCount: count,
  dataStatus: z.enum(['unknown', 'partial', 'observed']),
  transactionCount: count,
  incomeCents: cents,
  expenseCents: cents,
  netCashflowCents: cents,
  averageMonthlySavingsCents: cents.nullable(),
  spendingByCategory: z.record(z.string(), cents),
  monthlyTotals: z.array(
    z.object({
      month: z.string(),
      incomeCents: cents,
      expenseCents: cents,
      netCashflowCents: cents,
      transactionCount: count,
      dataStatus: z.enum(['observed', 'unknown']),
    }),
  ),
  recurringExpenses: z.array(
    z.object({
      category: z.string(),
      observedMonths: z.array(z.string()),
      occurrenceCount: count,
      averagePaymentCents: cents,
      status: z.literal('candidate_needs_confirmation'),
    }),
  ),
  excludedPendingCount: count,
  excludedInternalTransferCount: count,
  assumptions: z.array(z.string()),
  ledgerUpdatedAt: timestamp.optional(),
});

export function registerBankTools(server: McpServer, config: BankToolConfig) {
  const base = new URL(config.baseUrl);
  if (base.username || base.password || base.search || base.hash || !config.token.trim())
    throw new Error('Invalid bank bridge configuration');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
    throw new Error('Bank bridge requires HTTPS or loopback HTTP');
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  async function call<T extends z.ZodType>(path: string, schema: T, message: string): Promise<CallToolResult> {
    try {
      const response = await fetch(base.href.replace(/\/$/, '') + path, {
        headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Unavailable');
      const data = schema.parse(await response.json()) as Record<string, unknown>;
      return { content: [{ type: 'text', text: `${message} ${provenance(data)}` }], structuredContent: data };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Bank data is unavailable or invalid. Check the profile API and server-side bridge configuration.',
          },
        ],
      };
    }
  }
  server.registerTool(
    'get_bank_updates',
    {
      title: 'Read bank changes',
      description:
        'Poll persisted bank change events after a cursor; save nextCursor for the next call. The synthetic flag in the result says whether every underlying record is fabricated demo data (true) or real bank data is included (false). Events carry counts and timestamps only, never movements. requiresRefresh means earlier events expired or the cursor reset: refresh the bank summary. This read-only tool does not start a feed, subscribe to notifications, wake ChatGPT or send proactive messages.',
      inputSchema: z
        .object({ userId: safeId, after: count.default(0), limit: z.number().int().min(1).max(100).default(50) })
        .strict(),
      outputSchema: output,
      annotations,
    },
    ({ userId, after, limit }) =>
      call(
        `/users/${userId}/bank/events?after=${after}&limit=${limit}`,
        eventsResult,
        'Bank changes since the supplied cursor.',
      ),
  );
  server.registerTool(
    'get_bank_runtime',
    {
      title: 'Read bank demo feed status',
      description:
        'Read the status of the background demo feed for one user. This feed only ever produces synthetic movements; it is not a real bank connection. The worker runs in the profile API independently of tool calls; polling this tool cannot wake ChatGPT or deliver proactive messages.',
      inputSchema: z.object({ userId: safeId }).strict(),
      outputSchema: output,
      annotations,
    },
    async ({ userId }) => {
      const result = await call(`/users/${userId}/bank/runtime`, runtimeResult, 'Bank demo feed status.');
      if (result.structuredContent?.lastError)
        result.structuredContent.lastError = 'Background bank feed needs attention.';
      return result;
    },
  );
  server.registerTool(
    'get_bank_summary',
    {
      title: 'Read monthly bank cash flow',
      description:
        'Read aggregate bank cash flow for 1–24 complete calendar months. The synthetic flag in the result is true only when every movement in the ledger is fabricated demo data, and false when real bank data is included; report it as labelled. Pending movements and owned-account transfers are excluded; empty months may mean missing data. This does not assess creditworthiness or mortgage approval. Raw movements and recurring merchant/account identifiers are not returned.',
      inputSchema: periodSchema.safeExtend({ userId: safeId }),
      outputSchema: output,
      annotations,
    },
    ({ userId, from, to }) =>
      call(
        `/users/${userId}/bank/summary?from=${from}&to=${to}`,
        summaryResult,
        'Historical bank cash-flow aggregates; review data status and assumptions.',
      ),
  );
}
