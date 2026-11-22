import { readFileSync } from 'node:fs';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { widgetUri } from '../../packages/config/product.ts';
import { safeId } from '../../packages/contracts/ids.ts';
import { municipalityCode } from '../../packages/contracts/places.ts';

/** MCP App resource of the React workspace, `ui://relocat/workspace-v1.html`. */
export const workspaceUri = widgetUri('workspace-v1.html');

export const workspaceInput = z
  .object({
    userId: safeId.optional().describe('Stored person to plan for, for example user-001'),
    municipalityCodes: z.array(municipalityCode).max(8).optional().describe('Places to compare, at most eight'),
  })
  .strict();

/** What the widget receives. `apps/web/launch.ts` parses the same shape in the browser. */
export const workspaceResult = z.object({
  userId: safeId.nullable(),
  municipalityCodes: z.array(municipalityCode).max(8),
});
export type WorkspaceResult = z.infer<typeof workspaceResult>;

const web = (file: string) => new URL(`../web/${file}`, import.meta.url);

/**
 * The workspace page with its React bundle and stylesheet inlined, or `undefined` when
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
  return readFileSync(web('workspace.html'), 'utf8')
    .replace('/* STYLES */', () => styles.replace(/<\/style/gi, '<\\/style'))
    .replace('<!-- WIDGET -->', () => `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
}

/**
 * Registers the workspace widget and `show_workspace`, the tool that opens it. The tool only hands
 * over who is planning and where; the widget reads `plan_home_savings`, the bank tools and
 * `list_catalonia_municipalities` itself, so rendering and data stay separate.
 */
export function registerWorkspace(server: McpServer, page: string) {
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
        'Open the ReloCat workspace: the person who is planning with their finances and habits, the places compared by how long until the upfront cash is ready (baseline, with habits, with each place’s benefits), and the synthetic live bank feed. Pass the stored userId and up to eight municipality codes; resolve names with list_catalonia_municipalities first. This tool only opens the view. The widget loads figures through plan_home_savings and the bank tools; call those directly when the numbers are needed in chat.',
      inputSchema: workspaceInput,
      outputSchema: workspaceResult,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: workspaceUri, visibility: ['model'] } },
    },
    ({ userId, municipalityCodes }) => {
      const structuredContent: WorkspaceResult = {
        userId: userId ?? null,
        municipalityCodes: [...new Set(municipalityCodes ?? [])],
      };
      const places = structuredContent.municipalityCodes.length;
      return {
        content: [
          {
            type: 'text',
            text: `Opened the ReloCat workspace${userId ? ` for ${userId}` : ' without a person selected'}${
              places ? `, comparing ${places} ${places === 1 ? 'place' : 'places'}` : ', with no places yet'
            }. The view loads its own figures; it has not returned any to this chat.`,
          },
        ],
        structuredContent,
      };
    },
  );
}
