import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Who a tool call is for. The identity rule of ReloCat: **a tool never takes a user id from the
 * model.** The HTTP layer resolves the caller (an OAuth access token, or the session cookie of a
 * same-origin page) and hands `createMcpServer` a `Caller`. Tool code can then reach exactly two
 * things: the caller's own person (`me`), and the read-only fictional personas of the public demo
 * (`demo`). There is no handle that addresses an arbitrary person, and no service token in here.
 */

/** Read access to one person. The id is fixed when the handle is made; no method takes another. */
export type PersonReader = {
  readonly userId: string;
  /** True for a fictional demo persona; false for a person who belongs to an account. */
  readonly synthetic: boolean;
  /** The resolved inputs (`GET /users/:id/context`), or null when the person does not exist. */
  context(): Promise<Record<string, unknown> | null>;
  /** The submitted input records, oldest first. */
  inputs(): Promise<unknown>;
  bankSummary(period: { from: string; to: string }): Promise<unknown>;
  bankUpdates(after: number, limit: number): Promise<unknown>;
  bankRuntime(): Promise<unknown>;
  /** Sum of the booked balances today in cents, or null without accounts. */
  bankBalanceCents(): Promise<number | null>;
  habits(): Promise<unknown>;
};

/** The caller's own person: everything a reader has, plus saving inputs. */
export type PersonWriter = PersonReader & {
  saveInputs(inputs: unknown[]): Promise<{ inserted: number; duplicates: number }>;
};

export type PersonScope = 'person:read' | 'person:write';

export type Caller = {
  /** The signed-in person, or null for an anonymous call. */
  me: PersonWriter | null;
  /** What the credential allows for `me`. A browser session has both; an OAuth token what was granted. */
  scopes: PersonScope[];
  /** The public demo, or null when it is off. `open` returns null for any id outside the allowlist. */
  demo: { ids: string[]; open(id: string): PersonReader | null } | null;
  /** `WWW-Authenticate` value that tells a client how to sign in; absent when the server has no accounts. */
  challenge?: (error?: { code: 'invalid_token' | 'insufficient_scope'; description: string }) => string;
};

export const anonymous: Caller = { me: null, scopes: [], demo: null };

/**
 * Tools that only work for a signed-in person, with the scope each needs. `plan_home_savings` and
 * `show_workspace` are public, and personal only when asked for "me" (see `requiredScopes`).
 */
export const personalTools: Record<string, PersonScope[]> = {
  get_person: ['person:read'],
  get_my_inputs: ['person:read'],
  save_my_inputs: ['person:write'],
  get_bank_summary: ['person:read'],
  get_bank_updates: ['person:read'],
  get_bank_runtime: ['person:read'],
};

/** The scopes a `tools/call` needs before it runs, or null when the call is public. */
export function requiredScopes(name: unknown, args: unknown): PersonScope[] | null {
  if (typeof name !== 'string') return null;
  if (name in personalTools) return personalTools[name];
  const me = args && typeof args === 'object' && (args as { me?: unknown }).me === true;
  return name === 'plan_home_savings' && me ? ['person:read'] : null;
}

/**
 * Tool metadata that tells a chat host whether a tool needs sign-in. ChatGPT reads
 * `securitySchemes` per tool; a tool that works both ways lists both.
 */
export function security(kind: 'public' | 'personal' | 'either', scopes: PersonScope[] = ['person:read']) {
  const none = { type: 'noauth' };
  const oauth = { type: 'oauth2', scopes };
  return { securitySchemes: kind === 'public' ? [none] : kind === 'personal' ? [oauth] : [none, oauth] };
}

/** The tool error for a personal tool called without (enough) authority. It carries the sign-in challenge. */
export function authRequired(caller: Caller, missingScope?: PersonScope): CallToolResult {
  const description = missingScope
    ? `This connection may not do that. Reconnect ReloCat and allow "${missingScope}".`
    : 'Sign in to ReloCat to use your own profile.';
  const challenge = caller.challenge?.({
    code: missingScope ? 'insufficient_scope' : 'invalid_token',
    description,
  });
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: caller.challenge
          ? `${description} Tools about places, incentives and the fictional demo personas work without signing in.`
          : 'This server has no accounts, so there is no stored person. Pass the person inline instead.',
      },
    ],
    ...(challenge ? { _meta: { 'mcp/www_authenticate': [challenge] } } : {}),
  };
}

/** The caller's own person when the credential carries `scope`; otherwise the tool error to return. */
export function ownPerson(caller: Caller, scope: PersonScope): { me: PersonWriter } | { error: CallToolResult } {
  if (!caller.me) return { error: authRequired(caller) };
  if (!caller.scopes.includes(scope)) return { error: authRequired(caller, scope) };
  return { me: caller.me };
}
