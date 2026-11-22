import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { safeId } from '../../packages/contracts/ids.ts';
import { periodSchema } from '../../packages/finance/cashflow.ts';
import { ApiError } from '../../packages/http/server.ts';
import type { Caller, OwnBank, PersonReader, PersonScope } from './identity.ts';
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
 * Bank tools. The personal tools act on the signed-in person's own bank data and take no user id;
 * the three demo tools read a fictional persona from the allowlist and exist only when the public
 * demo is on. Every result is an aggregate or a state: no tool returns movements. A person reads
 * their movements on their account page, or through `/api` with their own credential.
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

  registerOwnBankTools(server, caller);

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

/** Largest statement a tool accepts, in characters; the store checks the size in bytes again. */
const maxStatementCharacters = 262_144;

/**
 * The person's own bank data: connect and disconnect a bank, sync, and import a statement. Each
 * tool acts on the caller alone (there is no user id to pass) and needs sign-in; the ones that
 * change something need the `bank:manage` scope.
 *
 * The rule for what comes back: **no tool returns a movement.** Results are states (a connection,
 * a consent, an import) and aggregates (balances, counts, totals per category). Individual
 * movements are for the person's own account page and for `/api` with the person's own credential.
 */
function registerOwnBankTools(server: McpServer, caller: Caller) {
  const noMovements =
    ' Returns states and totals only: individual movements are never returned by a tool; the person reads them on their ReloCat account page.';
  const own = ' Acts on the signed-in person’s own data; takes no user id.';
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const change = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const remove = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

  /**
   * Run one action for the caller's own person. A refusal the stores word for people (`ApiError`)
   * is passed on as the tool error; anything else is one plain "unavailable".
   */
  async function act(
    scope: PersonScope,
    summary: (data: Record<string, unknown>) => string,
    action: (bank: OwnBank) => Promise<unknown>,
  ): Promise<CallToolResult> {
    const person = ownPerson(caller, scope);
    if ('error' in person) return person.error;
    const failed = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
    if (!person.me.bank) return failed('Bank connections are not available on this server.');
    try {
      const data = output.parse(await action(person.me.bank)) as Record<string, unknown>;
      return { content: [{ type: 'text', text: summary(data) }], structuredContent: data };
    } catch (error) {
      if (error instanceof ApiError) return failed(error.message);
      if (error instanceof z.ZodError) return failed('That input is not valid.');
      return failed('Bank data is unavailable right now.');
    }
  }
  const size = (data: Record<string, unknown>, field: string) =>
    Array.isArray(data[field]) ? (data[field] as unknown[]).length : 0;

  server.registerTool(
    'list_connectable_banks',
    {
      title: 'List banks I can connect',
      description:
        'List the banks the signed-in person can connect to ReloCat. Each entry says whether its records are synthetic (a fictional demo bank or feed: fabricated data) or real, and how it is connected: consent_at_bank means the person must approve access on the bank’s own page; direct means there is nothing to approve. Only configured banks are listed.' +
        own,
      inputSchema: z.object({}).strict(),
      outputSchema: output,
      annotations: read,
      _meta: security('personal'),
    },
    () =>
      act(
        'person:read',
        data => `${size(data, 'banks')} bank(s) can be connected.`,
        async bank => ({ banks: await bank.connectable() }),
      ),
  );
  server.registerTool(
    'list_my_bank_connections',
    {
      title: 'List my bank connections',
      description:
        'List the signed-in person’s bank connections with their state: the bank, whether its records are synthetic, lastSyncAt, lastError (a short reason when the last sync failed), whether the bank notifies ReloCat (webhooks) or is polled, and the consent (granted, expired or not_required, with consentExpiresAt). An expired consent stops syncing until the person connects that bank again. pendingConsents are authorisations the person started at a bank and has not finished.' +
        noMovements +
        own,
      inputSchema: z.object({}).strict(),
      outputSchema: output,
      annotations: read,
      _meta: security('personal'),
    },
    () =>
      act(
        'person:read',
        data => `${size(data, 'connections')} bank connection(s).`,
        bank => bank.connections(),
      ),
  );
  server.registerTool(
    'get_my_bank_accounts',
    {
      title: 'Read my bank accounts',
      description:
        'List the signed-in person’s bank accounts with today’s booked balance. The synthetic flag says whether every record is fabricated demo data. The account "manual-import" holds statements the person imported: its balance is only the net of those movements, not a bank balance. A balance is not savings available for a purchase: it also holds rent, bills and reserves.' +
        noMovements +
        own,
      inputSchema: z.object({}).strict(),
      outputSchema: output,
      annotations: read,
      _meta: security('personal'),
    },
    () =>
      act(
        'person:read',
        data => `${size(data, 'accounts')} bank account(s).`,
        bank => bank.accounts(),
      ),
  );
  server.registerTool(
    'connect_my_bank',
    {
      title: 'Connect my bank',
      description:
        'Connect one of the banks from list_connectable_banks for the signed-in person. For a bank marked consent_at_bank this does NOT connect anything: it answers status consent_required with continueUrl, the person’s ReloCat account page, where they press Connect, approve on the bank’s own page and come back; give the person that link and say so. For a bank marked direct (a synthetic demo feed) the connection is made at once. The bank reference is never an input: it comes from the bank’s consent, so nobody can attach somebody else’s bank.' +
        own,
      inputSchema: z.object({ providerId: safeId.describe('The id of a bank from list_connectable_banks') }).strict(),
      outputSchema: output,
      annotations: change,
      _meta: security('personal', ['bank:manage']),
    },
    ({ providerId }) =>
      act(
        'bank:manage',
        data =>
          data.status === 'consent_required'
            ? `Nothing is connected yet. ${String(data.message ?? '')} ${String(data.continueUrl ?? '')}`.trim()
            : 'The bank is connected.',
        bank => bank.connect(providerId),
      ),
  );
  server.registerTool(
    'disconnect_my_bank',
    {
      title: 'Disconnect my bank',
      description:
        'Remove one of the signed-in person’s bank connections (an id from list_my_bank_connections). The stored bank credential is deleted and syncing stops. Movements already imported stay in the ledger. Ask the person before calling this.' +
        own,
      inputSchema: z.object({ connectionId: safeId }).strict(),
      outputSchema: output,
      annotations: remove,
      _meta: security('personal', ['bank:manage']),
    },
    ({ connectionId }) =>
      act(
        'bank:manage',
        () => 'The bank connection was removed.',
        bank => bank.disconnect(connectionId),
      ),
  );
  server.registerTool(
    'sync_my_bank',
    {
      title: 'Fetch my new bank movements',
      description:
        'Pull new movements now for the signed-in person’s bank connections, or for one of them. Each result says how many movements were inserted, updated or removed, or why the sync failed (for example an expired consent).' +
        noMovements +
        own,
      inputSchema: z.object({ connectionId: safeId.optional() }).strict(),
      outputSchema: output,
      annotations: change,
      _meta: security('personal', ['bank:manage']),
    },
    ({ connectionId }) =>
      act(
        'bank:manage',
        data => `${size(data, 'results')} connection(s) synced.`,
        bank => bank.sync(connectionId),
      ),
  );
  server.registerTool(
    'preview_statement_import',
    {
      title: 'Preview a bank statement',
      description:
        'Step 1 of importing a bank statement (CSV with date, description and amount columns; dates YYYY-MM-DD; amounts signed, money out negative). This reads and summarises the statement and writes NOTHING to the ledger: it returns the period covered, the number of rows, how many are already in the ledger, totals in and out, rows per category and a previewHash. Show the person that summary and ask whether to import it. When monthlyFigures is false the statement is too short for any monthly figure: do not quote one, and say what averagingNote says. The data is the person’s own and is stored as real (synthetic: false).' +
        noMovements +
        own,
      inputSchema: z
        .object({ csv: z.string().min(1).max(maxStatementCharacters).describe('The statement text') })
        .strict(),
      outputSchema: output,
      annotations: { ...change, openWorldHint: false },
      _meta: security('personal', ['bank:manage']),
    },
    ({ csv }) =>
      act(
        'bank:manage',
        data =>
          `Nothing was imported yet. The statement has ${String(data.rowCount)} row(s) from ${String(data.coveredFrom)} to ${String(data.coveredTo)}, ${String(data.newRows)} of them new. Show the person this summary; import it with confirm_statement_import only after they agree.`,
        bank => bank.previewStatement(csv),
      ),
  );
  server.registerTool(
    'confirm_statement_import',
    {
      title: 'Import the previewed statement',
      description:
        'Step 2: write the statement that preview_statement_import summarised into the signed-in person’s ledger, in the account "manual-import". It takes only the previewHash of that preview, so exactly the statement that was summarised is written; without a preview from the last 15 minutes it writes nothing. Call it only after the person has seen the summary and agreed. Importing the same statement again is harmless: rows already in the ledger are counted as duplicates.' +
        noMovements +
        own,
      inputSchema: z.object({ previewHash: z.string().min(1).max(100) }).strict(),
      outputSchema: output,
      annotations: { ...change, openWorldHint: false },
      _meta: security('personal', ['bank:manage']),
    },
    ({ previewHash }) =>
      act(
        'bank:manage',
        data =>
          `Imported ${String(data.inserted)} new movement(s); ${String(data.duplicates)} were already in the ledger.`,
        bank => bank.confirmStatement(previewHash),
      ),
  );
  server.registerTool(
    'list_my_statement_imports',
    {
      title: 'List statements I imported',
      description:
        'List the bank statements the signed-in person imported: an id, when, the period covered and the number of rows.' +
        noMovements +
        own,
      inputSchema: z.object({}).strict(),
      outputSchema: output,
      annotations: read,
      _meta: security('personal'),
    },
    () =>
      act(
        'person:read',
        data => `${size(data, 'imports')} imported statement(s).`,
        async bank => ({ imports: await bank.statementImports() }),
      ),
  );
  server.registerTool(
    'delete_statement_import',
    {
      title: 'Delete an imported statement',
      description:
        'Delete one imported statement (an id from list_my_statement_imports) together with the movements only it brought; a movement that another imported statement also contains stays. Ask the person before calling this.' +
        own,
      inputSchema: z.object({ importId: safeId }).strict(),
      outputSchema: output,
      annotations: remove,
      _meta: security('personal', ['bank:manage']),
    },
    ({ importId }) =>
      act(
        'bank:manage',
        data => `The statement was deleted with ${String(data.removedMovements)} movement(s).`,
        bank => bank.deleteStatementImport(importId),
      ),
  );
}
