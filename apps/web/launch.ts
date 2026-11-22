import { z } from 'zod';

/**
 * What `show_workspace` hands the widget: who is planning and which places to compare.
 * The server keeps an identical schema in `apps/mcp-server/workspace.ts`; `tests/workspace.test.ts`
 * checks that the tool's structured output parses here.
 */
export const workspaceLaunch = z.object({
  userId: z.string().nullable(),
  municipalityCodes: z.array(z.string().regex(/^\d{6}$/)).max(8),
});
export type WorkspaceLaunch = z.infer<typeof workspaceLaunch>;

export const emptyLaunch: WorkspaceLaunch = { userId: null, municipalityCodes: [] };

/** A launch that cannot be read opens the workspace empty instead of failing. */
export function parseLaunch(value: unknown): WorkspaceLaunch {
  const parsed = workspaceLaunch.safeParse(value);
  return parsed.success ? parsed.data : emptyLaunch;
}

/** Launch for the standalone page: `?user=user-001&towns=250404,251207`. */
export function launchFromQuery(search: string): WorkspaceLaunch {
  const query = new URLSearchParams(search);
  const towns = (query.get('towns') ?? '')
    .split(',')
    .map(code => code.trim())
    .filter(code => /^\d{6}$/.test(code));
  return parseLaunch({ userId: query.get('user') || null, municipalityCodes: [...new Set(towns)].slice(0, 8) });
}
