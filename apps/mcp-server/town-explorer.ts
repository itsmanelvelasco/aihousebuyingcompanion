import { readFileSync } from 'node:fs';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { widgetUri as productWidgetUri } from '../../packages/config/product.ts';
import type { Snapshot } from '../../packages/contracts/places.ts';
import { escapeHtml } from '../../packages/http/server.ts';
import { locales } from '../../packages/i18n/locales.ts';
import { getTown } from '../../packages/places/data.ts';
import { inlineUi } from '../../packages/ui/inline.ts';
import { explorer } from './town-explorer.messages.ts';
import { explorerInput, explorerResult } from './town-explorer-contract.ts';

const widgetUri = productWidgetUri('town-explorer-v1.html');

export function loadTownExplorerPage() {
  let bundle: string;
  try {
    bundle = readFileSync(new URL('./dist/town-explorer.js', import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  // The theme, the icons and the header illustration are inlined from packages/ui.
  const template = inlineUi(readFileSync(new URL('./town-explorer.html', import.meta.url), 'utf8'), {
    art: ['hero-valley'],
  });
  // The page is one static resource: its script picks the language. Without a script nothing can,
  // so the one sentence that is read then is written in the three languages.
  const noscript = locales.map(locale => `<p lang="${locale}">${escapeHtml(explorer[locale].noscript)}</p>`).join('');
  return template
    .replace('<!-- NOSCRIPT -->', () => noscript)
    .replace('<!-- WIDGET -->', () => `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
}

export function registerTownExplorer(server: McpServer, snapshot: Snapshot, page: string) {
  registerAppResource(server, 'ReloCat Town Explorer', widgetUri, {}, async () => ({
    contents: [
      {
        uri: widgetUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: page,
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
      },
    ],
  }));

  registerAppTool(
    server,
    'show_town_explorer',
    {
      title: 'Show ReloCat Town Explorer',
      description:
        'Open the Catalonia town map and cards. After recommend_towns or recommend_towns_for_profile, call this to visualize the shortlist using the same tool and its exact arguments. Without a recommendation, browse the pilot or open a specific town. Resolve town names with list_catalonia_municipalities first.',
      inputSchema: explorerInput,
      outputSchema: explorerResult,
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: widgetUri, visibility: ['model'] } },
    },
    ({ municipalityCode: code, recommendation }) => {
      const town = code === undefined ? null : getTown(snapshot, code);
      return {
        content: [
          {
            type: 'text',
            text: recommendation
              ? 'Opened the Town Explorer map and cards for the supplied shortlist criteria.'
              : town
                ? `Opened ReloCat Town Explorer for ${town.name}. Use get_town_profile for the sourced profile in chat.`
                : 'Opened ReloCat Town Explorer. Pick any covered town, or use list_catalonia_municipalities for pilot coverage in chat.',
          },
        ],
        structuredContent: { municipalityCode: town?.code ?? null, ...(recommendation ? { recommendation } : {}) },
      };
    },
  );
}
