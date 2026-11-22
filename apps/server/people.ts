import { ApiError } from '../../packages/http/server.ts';
import type { Caller, PersonReader, PersonWriter } from '../mcp-server/identity.ts';

/**
 * In-process access to stored people for the MCP tools and the board. It replaces the loopback
 * HTTP calls that carried the service token on behalf of any caller: a handle made here is bound to
 * one user id when it is created, and nothing else can be reached through it.
 */

/** What the stores offer per user id; `createProfileApiHandler(...).people` plus the habit store. */
export type PeopleSource = {
  context(id: string): Promise<Record<string, unknown>>;
  inputs(id: string): Promise<unknown>;
  addInputs(id: string, value: unknown): Promise<{ inserted: number; duplicates: number }>;
  bankSummary(id: string, period: { from: unknown; to: unknown }): Promise<unknown>;
  bankEvents(id: string, after: number, limit: number): Promise<unknown>;
  bankRuntime(id: string): Promise<unknown>;
  bankBalanceCents(id: string): Promise<number | null>;
  habits(id: string): Promise<unknown>;
};

export function createPeople(source: PeopleSource) {
  /** A read-only handle for one person. `synthetic` is true for a demo persona only. */
  function reader(userId: string, synthetic: boolean): PersonReader {
    return {
      userId,
      synthetic,
      async context() {
        try {
          return { ...(await source.context(userId)), synthetic };
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
      inputs: () => source.inputs(userId),
      bankSummary: period => source.bankSummary(userId, period),
      bankUpdates: (after, limit) => source.bankEvents(userId, after, limit),
      bankRuntime: () => source.bankRuntime(userId),
      bankBalanceCents: () => source.bankBalanceCents(userId),
      habits: () => source.habits(userId),
    };
  }

  return {
    /** The signed-in person's own record: read, and save inputs. */
    own(userId: string): PersonWriter {
      return { ...reader(userId, false), saveInputs: inputs => source.addInputs(userId, { inputs }) };
    },
    /**
     * The public demo: read-only handles for the allowlisted fictional personas and nothing else.
     * `open` checks the allowlist itself, so a caller cannot widen it by passing another id.
     */
    demo(ids: string[], ownedByAccount: (userId: string) => boolean): NonNullable<Caller['demo']> {
      const allowed = new Set(ids);
      // A person who belongs to an account is never a demo persona, even if configuration names its id.
      return {
        ids: [...allowed],
        open: id => (allowed.has(id) && !ownedByAccount(id) ? reader(id, true) : null),
      };
    },
  };
}

export type People = ReturnType<typeof createPeople>;
