import { z } from 'zod';
import { municipalityListResult } from '../../packages/contracts/places.ts';
import type { Person, PlanResult } from '../../packages/contracts/planner.ts';
import { planResult } from '../../packages/contracts/planner.ts';

/**
 * Typed client for the MCP tools the workspace reads. It takes one `CallTool` function, so the same
 * code runs inside a chat host (`App.callServerTool`), on the standalone page (JSON-RPC to `/mcp`)
 * and against the fixture. A tool that is missing, fails or returns an unexpected shape becomes a
 * `ToolError`; nothing here falls back to sample data.
 */
export type ToolResult = { isError?: boolean; structuredContent?: unknown; content?: unknown };
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export type ToolErrorKind = 'unavailable' | 'failed' | 'invalid';

export class ToolError extends Error {
  readonly tool: string;
  readonly kind: ToolErrorKind;
  constructor(tool: string, kind: ToolErrorKind, message: string) {
    super(message);
    this.name = 'ToolError';
    this.tool = tool;
    this.kind = kind;
  }
}

const count = z.number().int().nonnegative();
const cents = z.number().int();

export const bankEvent = z.object({
  sequence: count,
  occurredAt: z.string(),
  type: z.literal('bank.updated'),
  accountCount: count,
  transactionCount: count,
});
export const bankUpdates = z.object({
  synthetic: z.literal(true),
  events: z.array(bankEvent),
  latestRevision: count,
  nextCursor: count,
  requiresRefresh: z.boolean(),
  hasMore: z.boolean(),
});
export const bankRuntime = z.object({
  synthetic: z.literal(true),
  userId: z.string(),
  enabled: z.boolean(),
  intervalMs: count,
  lastTickAt: z.string().nullable(),
  lastError: z.string().nullable(),
  tickCount: count,
});
export const bankSummary = z.object({
  synthetic: z.literal(true),
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
  excludedPendingCount: count,
  excludedInternalTransferCount: count,
  assumptions: z.array(z.string()),
  ledgerUpdatedAt: z.string().nullable().optional(),
});
export type BankEvent = z.infer<typeof bankEvent>;
export type BankUpdates = z.infer<typeof bankUpdates>;
export type BankRuntime = z.infer<typeof bankRuntime>;
export type BankSummary = z.infer<typeof bankSummary>;
export type Municipality = z.infer<typeof municipalityListResult>['municipalities'][number];

export type PlanAssumptionsInput = { includeProposedHabits: boolean; includeUnverifiedBenefits: boolean };
/** Either a stored person by id, or an edited person sent inline for a what-if. */
export type PlanRequest = { municipalityCodes: string[]; assumptions: PlanAssumptionsInput } & (
  | { userId: string; person?: undefined }
  | { person: Person; userId?: undefined }
);

function firstText(content: unknown) {
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') return block.text;
  }
  return '';
}

const missingTool = /not found|unknown tool|not available|disabled/i;

/** Human-readable reason for a failed call, without leaking protocol noise. */
export function describeFailure(tool: string, detail: string): { kind: ToolErrorKind; message: string } {
  if (missingTool.test(detail) && detail.includes(tool))
    return { kind: 'unavailable', message: `This server does not offer the ${tool} tool yet.` };
  const text = detail.replace(/^MCP error -?\d+:\s*/i, '').trim();
  return { kind: 'failed', message: text ? text.slice(0, 280) : `The ${tool} tool returned an error.` };
}

async function read<T extends z.ZodType>(call: CallTool, tool: string, args: Record<string, unknown>, schema: T) {
  let result: ToolResult;
  try {
    result = await call(tool, args);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const failure = describeFailure(tool, error instanceof Error ? error.message : '');
    throw new ToolError(tool, failure.kind, failure.message);
  }
  if (result.isError) {
    const failure = describeFailure(tool, firstText(result.content));
    throw new ToolError(tool, failure.kind, failure.message);
  }
  const parsed = schema.safeParse(result.structuredContent);
  if (!parsed.success)
    throw new ToolError(tool, 'invalid', `The ${tool} tool answered in a shape this workspace cannot read.`);
  return parsed.data as z.infer<T>;
}

export function createToolClient(call: CallTool) {
  return {
    plan: (request: PlanRequest): Promise<PlanResult> => read(call, 'plan_home_savings', request, planResult),
    bankUpdates: (userId: string, after: number, limit = 50) =>
      read(call, 'get_bank_updates', { userId, after, limit }, bankUpdates),
    bankRuntime: (userId: string) => read(call, 'get_bank_runtime', { userId }, bankRuntime),
    bankSummary: (userId: string, period: { from: string; to: string }) =>
      read(call, 'get_bank_summary', { userId, ...period }, bankSummary),
    municipalities: async () =>
      (await read(call, 'list_catalonia_municipalities', {}, municipalityListResult)).municipalities,
  };
}
export type ToolClient = ReturnType<typeof createToolClient>;

/**
 * `CallTool` for the standalone page: one stateless JSON-RPC `tools/call` per request to the MCP
 * endpoint on the same origin. No session and no SDK client, to keep the bundle small.
 */
export function httpCallTool(endpoint: string, fetcher: typeof fetch = fetch): CallTool {
  let id = 0;
  return async (name, args) => {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new ToolError(name, 'failed', `The MCP endpoint answered with HTTP ${response.status}.`);
    const text = await response.text();
    // The server answers with JSON; an event stream carries the same message on a `data:` line.
    const body = response.headers.get('content-type')?.includes('text/event-stream')
      ? (text
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .at(-1)
          ?.slice(5) ?? '')
      : text;
    let message: { result?: ToolResult; error?: { message?: string } };
    try {
      message = JSON.parse(body);
    } catch {
      throw new ToolError(name, 'invalid', 'The MCP endpoint did not answer with JSON.');
    }
    if (message.error || !message.result) {
      const failure = describeFailure(name, message.error?.message ?? '');
      throw new ToolError(name, failure.kind, failure.message);
    }
    return message.result;
  };
}
