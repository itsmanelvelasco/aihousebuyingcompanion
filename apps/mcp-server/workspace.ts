import { readFileSync } from 'node:fs';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { widgetUri } from '../../packages/config/product.ts';
import { municipalityCode } from '../../packages/contracts/places.ts';
import { inlineUi } from '../../packages/ui/inline.ts';
import type { Caller } from './identity.ts';
import { anonymous, security } from './identity.ts';

/** MCP App resource of the React workspace, `ui://relocat/workspace-v1.html`. */
export const workspaceUri = widgetUri('workspace-v1.html');

/**
 * What the widget receives. `apps/web/launch.ts` parses the same shape in the browser.
 * `subject` says whose figures the workspace shows: the signed-in person (`me`), a fictional demo
 * persona (`demo`, read-only) or nobody yet (`none`: inline what-if planning only).
 */
export const workspaceResult = z.object({
  subject: z.enum(['me', 'demo', 'none']),
  demoId: z.string().nullable(),
  /** Whether the caller is signed in, whatever the workspace is showing. */
  signedIn: z.boolean(),
  /** The fictional personas this server offers, empty when the public demo is off. */
  demoIds: z.array(z.string()),
  municipalityCodes: z.array(municipalityCode).max(8),
});
export type WorkspaceResult = z.infer<typeof workspaceResult>;

const web = (file: string) => new URL(`../web/${file}`, import.meta.url);

/**
 * The workspace page with the shared theme, its own stylesheet and its React bundle inlined, or `undefined` when
 * `npm run build` has not produced `apps/web/dist/workspace.js`. The same string is the MCP App
 * resource and the standalone `/workspace` preview.
 */
export function loadWorkspacePage() {
  let bundle: string;
  try {
    bundle = readFileSync(web('dist/workspace.js'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const styles = readFileSync(web('workspace.css'), 'utf8');
  return inlineUi(readFileSync(web('workspace.html'), 'utf8'), { art: ['workspace-empty'] })
    .replace('/* STYLES */', () => styles.replace(/<\/style/gi, '<\\/style'))
    .replace('<!-- WIDGET -->', () => `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
}

/**
 * Registers the workspace widget and `show_workspace`, the tool that opens it. The tool only hands
 * over whose plan to show and where; the widget reads `plan_home_savings`, the bank tools and
 * `list_catalonia_municipalities` itself, so rendering and data stay separate. There is no user id:
 * the widget shows the caller's own person, or a demo persona named from the allowlist.
 */
export function registerWorkspace(server: McpServer, page: string, caller: Caller = anonymous) {
  const demoIds = caller.demo?.ids ?? [];
  const workspaceInput = z
    .object({
      demoId: z
        .enum((demoIds.length ? demoIds : ['none']) as [string, ...string[]])
        .optional()
        .describe('Show a fictional demo persona instead of the signed-in person'),
      municipalityCodes: z.array(municipalityCode).max(8).optional().describe('Places to compare, at most eight'),
    })
    .strict();

  registerAppResource(server, 'ReloCat Workspace', workspaceUri, {}, async () => ({
    contents: [
      {
        uri: workspaceUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: page,
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
      },
    ],
  }));

  registerAppTool(
    server,
    'show_workspace',
    {
      title: 'Show ReloCat workspace',
      description:
        'Open the ReloCat workspace: who is planning with their finances and habits, the places compared by how long until the upfront cash is ready (baseline, with habits, with each place’s benefits), and the bank feed. With no demoId it shows the signed-in person, or an empty what-if workspace when nobody is signed in. Pass demoId to show a fictional demo persona, and up to eight municipality codes; resolve names with list_catalonia_municipalities first. There is no user id argument. This tool only opens the view. The widget loads figures through plan_home_savings and the bank tools; call those directly when the numbers are needed in chat.',
      inputSchema: workspaceInput,
      outputSchema: workspaceResult,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: workspaceUri, visibility: ['model'] }, ...security('either') },
    },
    ({ demoId, municipalityCodes }) => {
      const demo = demoId !== undefined && caller.demo?.open(demoId) ? demoId : null;
      const structuredContent: WorkspaceResult = {
        subject: demo ? 'demo' : caller.me ? 'me' : 'none',
        demoId: demo,
        signedIn: caller.me !== null,
        demoIds,
        municipalityCodes: [...new Set(municipalityCodes ?? [])],
      };
      const places = structuredContent.municipalityCodes.length;
      const who = {
        me: ' for the signed-in person',
        demo: ` for the fictional demo persona ${demo}`,
        none: ' without a person (sign in, or pick a demo persona)',
      }[structuredContent.subject];
      return {
        content: [
          {
            type: 'text',
            text: `Opened the ReloCat workspace${who}${
              places ? `, comparing ${places} ${places === 1 ? 'place' : 'places'}` : ', with no places yet'
            }. The view loads its own figures; it has not returned any to this chat.`,
          },
        ],
        structuredContent,
      };
    },
  );
}
