import { z } from 'zod';
import type { Person } from '../../packages/contracts/planner.ts';

/**
 * What `show_workspace` hands the widget: whose plan to show and which places to compare.
 * The server keeps an identical schema in `apps/mcp-server/workspace.ts`; `tests/workspace.test.ts`
 * and `tests/widget-contract.test.ts` check that the tool's real output parses here.
 *
 * There is no user id. `subject` is `me` (the signed-in person: the server knows who that is),
 * `demo` (a fictional persona named by `demoId`, read-only) or `none` (nobody: what-if planning only).
 */
export const workspaceLaunch = z.object({
  subject: z.enum(['me', 'demo', 'none']),
  demoId: z.string().nullable(),
  signedIn: z.boolean(),
  demoIds: z.array(z.string()),
  municipalityCodes: z.array(z.string().regex(/^\d{6}$/)).max(8),
});
export type WorkspaceLaunch = z.infer<typeof workspaceLaunch>;

export const emptyLaunch: WorkspaceLaunch = {
  subject: 'none',
  demoId: null,
  signedIn: false,
  demoIds: [],
  municipalityCodes: [],
};

/** A launch that cannot be read opens the workspace empty instead of failing. */
export function parseLaunch(value: unknown): WorkspaceLaunch {
  const parsed = workspaceLaunch.safeParse(value);
  return parsed.success ? parsed.data : emptyLaunch;
}

/**
 * Whose figures the workspace is showing. `inline` is a what-if person typed into the page: it is
 * sent with each plan request and stored nowhere.
 */
export type Subject =
  | { kind: 'me' }
  | { kind: 'demo'; demoId: string }
  | { kind: 'inline'; person: Person }
  | { kind: 'none' };

export function subjectOf(launch: WorkspaceLaunch): Subject {
  if (launch.subject === 'demo' && launch.demoId) return { kind: 'demo', demoId: launch.demoId };
  return launch.subject === 'me' ? { kind: 'me' } : { kind: 'none' };
}

/** A stable key for effects: changes exactly when the subject does. */
export function subjectKey(subject: Subject) {
  if (subject.kind === 'demo') return `demo:${subject.demoId}`;
  return subject.kind === 'inline' ? `inline:${JSON.stringify(subject.person)}` : subject.kind;
}

/**
 * What the standalone page asks `show_workspace` for: `?demo=user-001&towns=250404,251207`.
 * Without `demo` the server answers with the signed-in person, or with nobody.
 */
export function launchRequestFromQuery(search: string) {
  const query = new URLSearchParams(search);
  const towns = (query.get('towns') ?? '')
    .split(',')
    .map(code => code.trim())
    .filter(code => /^\d{6}$/.test(code));
  const demoId = query.get('demo');
  return {
    ...(demoId && /^[a-z0-9][a-z0-9-]{0,63}$/.test(demoId) ? { demoId } : {}),
    municipalityCodes: [...new Set(towns)].slice(0, 8),
  };
}
