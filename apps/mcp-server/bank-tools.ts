import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { safeId } from '../../packages/contracts/ids.ts';
import { periodSchema } from '../../packages/finance/cashflow.ts';
import type { Caller, PersonReader } from './identity.ts';
import { ownPerson, security } from './identity.ts';

const count = z.number().int().safe().nonnegative();
const cents = z.number().int().safe();
const timestamp = z.string().nullable();
const output = z.object({}).catchall(z.json());
/**
 * The provenance sentence of a result. The records are labelled by the result's own `synthetic`
 * flag and the person by the handle that read them, and the two are never merged: a real person
 * connected to a fictional bank has a real profile and synthetic movements, and is told exactly that.
 */
export function provenance(data: Record<string, unknown>, person: Pick<PersonReader, 'synthetic'>) {
  if (data.synthetic !== true) return 'The underlying bank records include real bank data (synthetic: false).';
  return person.synthetic
    ? 'Fictional demo persona: all underlying records are synthetic demo data.'
    : 'These bank records come from a fictional bank feed (synthetic: true), not from a real bank. The profile they are attached to is the person’s own and is not fictional.';
}
/**
 * The same for the status of the demo feed, whose `synthetic: true` describes the feed alone: it
 * says nothing about the person or about any other record in their ledger.
 */
function feedProvenance(data: Record<string, unknown>, person: Pick<PersonReader, 'synthetic'>) {
  if (person.synthetic) return 'Fictional demo persona: the feed and everything it adds are synthetic demo data.';
  return data.enabled === true || (typeof data.tickCount === 'number' && data.tickCount > 0)
    ? 'This feed fabricates movements (synthetic: true describes the feed only). The profile is the person’s own, and get_bank_summary says whether the ledger also holds real bank data.'
    : 'The demo feed is off and has added nothing. Its synthetic: true describes the feed only, not the person, whose profile is their own.';
}
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

/**
 * Bank tools. The three personal tools read the signed-in person's own ledger and take no user id;
 * the three demo tools read a fictional persona from the allowlist and exist only when the public
 * demo is on. Every result is an aggregate: no tool returns movements.
 */
export function registerBankTools(server: McpServer, caller: Caller) {
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const unavailable: CallToolResult = {
    isError: true,
    content: [{ type: 'text', text: 'Bank data is unavailable or invalid right now.' }],
  };

  /** Read one aggregate through a person handle and check its shape; any failure is one plain tool error. */
  async function answer<T extends z.ZodType>(
    read: () => Promise<unknown>,
    schema: T,
    message: string,
    label: (data: Record<string, unknown>) => string,
  ) {
    try {
      const data = schema.parse(await read()) as Record<string, unknown>;
      // The feed's last error may quote a provider; the model only needs to know it needs attention.
      if ('lastError' in data && data.lastError) data.lastError = 'Background bank feed needs attention.';
      return {
        content: [{ type: 'text' as const, text: `${message} ${label(data)}` }],
        structuredContent: data,
      } satisfies CallToolResult;
    } catch {
      return unavailable;
    }
  }

  /** Run `read` for the caller's own person, or return the sign-in challenge. */
  function mine(read: (me: PersonReader) => Promise<CallToolResult>) {
    const own = ownPerson(caller, 'person:read');
    return 'error' in own ? own.error : read(own.me);
  }

  /** Run `read` for a demo persona, or fail when the id is not an allowed demo id. */
  function demo(id: string, read: (persona: PersonReader) => Promise<CallToolResult>) {
    const persona = caller.demo?.open(id);
    return persona ? read(persona) : unavailable;
  }

  const updatesInput = { after: count.default(0), limit: z.number().int().min(1).max(100).default(50) };
  const updates = (person: PersonReader, after: number, limit: number) =>
    answer(
      () => person.bankUpdates(after, limit),
      eventsResult,
      'Bank changes since the supplied cursor.',
      data => provenance(data, person),
    );
  const runtime = (person: PersonReader) =>
    answer(
      () => person.bankRuntime(),
      runtimeResult,
      'Bank demo feed status.',
      data => feedProvenance(data, person),
    );
  const summary = (person: PersonReader, period: { from: string; to: string }) =>
    answer(
      () => person.bankSummary(period),
      summaryResult,
      'Historical bank cash-flow aggregates; review data status and assumptions.',
      data => provenance(data, person),
    );
  const descriptions = {
    updates:
      'Poll persisted bank change events after a cursor; save nextCursor for the next call. The synthetic flag in the result says whether every underlying bank record is fabricated demo data (true) or real bank data is included (false); it describes the records, not the person, whose profile can be real with a fictional bank attached. Events carry counts and timestamps only, never movements; transactionCount is the size of the ledger after the change, not the number added. requiresRefresh means earlier events expired or the cursor reset: refresh the bank summary. This read-only tool does not start a feed, subscribe to notifications, wake ChatGPT or send proactive messages.',
    runtime:
      'Read the status of the background demo feed. This feed only ever produces synthetic movements; it is not a real bank connection, and its synthetic flag describes the feed alone, never the person or their other records. Polling this tool cannot wake ChatGPT or deliver proactive messages.',
    summary:
      'Read aggregate bank cash flow for 1–24 complete calendar months. The synthetic flag in the result is true only when every movement in the ledger is fabricated demo data, and false when real bank data is included; report it as labelled, and do not extend it to the person: a real person connected to a fictional bank has a real profile and synthetic movements. Pending movements and owned-account transfers are excluded; empty months may mean missing data. This does not assess creditworthiness or mortgage approval. Raw movements and recurring merchant/account identifiers are not returned.',
  };
  const own = ' Reads the signed-in person’s own ledger; takes no user id and needs sign-in.';

  server.registerTool(
    'get_bank_updates',
    {
      title: 'Read my bank changes',
      description: descriptions.updates + own,
      inputSchema: z.object(updatesInput).strict(),
      outputSchema: output,
      annotations,
      _meta: security('personal'),
    },
    ({ after, limit }) => mine(me => updates(me, after, limit)),
  );
  server.registerTool(
    'get_bank_runtime',
    {
      title: 'Read my bank demo feed status',
      description: descriptions.runtime + own,
      inputSchema: z.object({}).strict(),
      outputSchema: output,
      annotations,
      _meta: security('personal'),
    },
    () => mine(me => runtime(me)),
  );
  server.registerTool(
    'get_bank_summary',
    {
      title: 'Read my monthly bank cash flow',
      description: descriptions.summary + own,
      inputSchema: periodSchema,
      outputSchema: output,
      annotations,
      _meta: security('personal'),
    },
    ({ from, to }) => mine(me => summary(me, { from, to })),
  );

  if (!caller.demo?.ids.length) return;
  const demoId = z.enum(caller.demo.ids as [string, ...string[]]).describe('A fictional demo persona');
  const fictional = ' Reads a fictional demo persona only; it can never address a real person.';
  server.registerTool(
    'get_demo_bank_updates',
    {
      title: 'Read a demo persona’s bank changes',
      description: descriptions.updates + fictional,
      inputSchema: z.object({ demoId, ...updatesInput }).strict(),
      outputSchema: output,
      annotations,
      _meta: security('public'),
    },
    ({ demoId: id, after, limit }) => demo(id, persona => updates(persona, after, limit)),
  );
  server.registerTool(
    'get_demo_bank_runtime',
    {
      title: 'Read a demo persona’s bank feed status',
      description: descriptions.runtime + fictional,
      inputSchema: z.object({ demoId }).strict(),
      outputSchema: output,
      annotations,
      _meta: security('public'),
    },
    ({ demoId: id }) => demo(id, persona => runtime(persona)),
  );
  server.registerTool(
    'get_demo_bank_summary',
    {
      title: 'Read a demo persona’s monthly bank cash flow',
      description: descriptions.summary + fictional,
      inputSchema: periodSchema.safeExtend({ demoId }),
      outputSchema: output,
      annotations,
      _meta: security('public'),
    },
    ({ demoId: id, from, to }) => demo(id, persona => summary(persona, { from, to })),
  );
}
