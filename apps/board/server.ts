import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { defaultPorts, envPort, envText, publicOriginConfig } from '../../packages/config/env.ts';
import { product, widgetUri as productWidgetUri } from '../../packages/config/product.ts';
import type { Database } from '../../packages/db/database.ts';
import { ApiError, readJson, sendText as send, sendJson } from '../../packages/http/server.ts';
import { toolLocale } from '../../packages/i18n/server.ts';
import type { ListingSearchConfig } from '../../packages/listings/search.ts';
import { loadData } from '../../packages/places/data.ts';
import { inlineUi } from '../../packages/ui/inline.ts';
import { handleConnectPage } from '../mcp-server/connect-page.ts';
import type { Caller } from '../mcp-server/identity.ts';
import { anonymous, authRequired, requiredScopes } from '../mcp-server/identity.ts';
import { handleTestUi } from '../mcp-server/test-ui.ts';
import { createMcpServer as createRelocatMcpServer } from '../mcp-server/tools.ts';
import { loadTownExplorerPage } from '../mcp-server/town-explorer.ts';
import { loadWorkspacePage } from '../mcp-server/workspace.ts';
import { getView, hasSharedBoard, openDemo, openSchema, persistDemoRuns, updateDemo, updateSchema } from './demo.ts';
import { decorateDemo, demoPersonaIds } from './profiles.ts';

const widgetUri = productWidgetUri('journey-board-v1.html');
const baseline = loadData();
const townExplorerPage = loadTownExplorerPage();
const workspacePage = loadWorkspacePage();

/** Who a `/mcp` request is for, or the challenge to answer with when its credential is not valid. */
export type CallerResolution = { caller: Caller } | { unauthorized: string };

export type BoardOptions = {
  /** Public HTTPS origin used to build shareable board links. */
  publicOrigin: string | null;
  /** Extra browser origins allowed to call /mcp. Same-origin pages and non-browser agents always may. */
  allowedOrigins?: Set<string>;
  /** Current place data. Defaults to the committed snapshot; the server passes the live overlay. */
  data?: () => ReturnType<typeof loadData>;
  /** Freshness of the live sources, exposed as a tool when present. */
  dataStatus?: () => unknown[];
  /** Runtime database for board runs, so a restart keeps them. Omitted: runs stay in memory. */
  db?: Database;
  /**
   * Resolves the caller of each `/mcp` request: an OAuth access token or a same-origin session.
   * Omitted: every caller is anonymous and there is no demo, so the board is purely scripted.
   */
  resolveCaller?: (request: IncomingMessage) => CallerResolution;
  /** The read-only public demo behind the board's bank panel. Null or omitted: scripted scenes only. */
  demo?: Caller['demo'];
  /**
   * One board that every visitor without a run id joins and may restart. A convenience for a local
   * demo; on a public origin leave it off, so each visitor gets a private run nobody else can address.
   */
  sharedBoard?: boolean;
  /** Paid listing search configuration, including its spending budget. Defaults to the environment. */
  listings?: ListingSearchConfig;
  /** The interview card with voice inside it, handed to the MCP server as it is. Omitted: the simple card. */
  interviewCard?: { page: string; origin: string };
  /** Counts new runs per client so one visitor cannot fill the store and push other runs out. */
  newRuns?: { check(request: IncomingMessage): { allowed: boolean } };
};

/** Board actions that would change stored data. The board never does: it only reads the public demo. */
const storedDataActions = new Set(['start_bank_runtime', 'stop_bank_runtime']);

/** The journey board and its MCP endpoint as a request handler. */
export function createBoardApp({
  publicOrigin,
  allowedOrigins,
  data = () => baseline,
  dataStatus,
  db,
  resolveCaller,
  demo = null,
  sharedBoard = true,
  newRuns,
  listings,
  interviewCard,
}: BoardOptions) {
  if (db) persistDemoRuns(db);

  function withBoardLink(view: ReturnType<typeof getView>) {
    const shared = sharedBoard && view.sharedBoard;
    const path = shared ? '/preview' : `/preview?run=${view.runId}`;
    return { ...view, sharedBoard: shared, boardUrl: publicOrigin ? publicOrigin + path : null };
  }
  const template = inlineUi(readFileSync(new URL('./widget.html', import.meta.url), 'utf8'));
  const bundle = readFileSync(new URL('./dist/widget.js', import.meta.url), 'utf8');
  const page = template.replace(
    '<!-- WIDGET -->',
    () => `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`,
  );

  /** A scripted view with its link and, when the public demo is on, the persona's read-only facts. */
  async function present(view: ReturnType<typeof getView>) {
    const linked = withBoardLink(view);
    return {
      ...(await decorateDemo(linked, demo?.open(demoPersonaIds[view.persona]) ?? null)),
      boardUrl: linked.boardUrl,
    };
  }

  /**
   * Run a board tool. Every action changes only the run's own scripted state; answers typed into
   * the board are never written to a stored person.
   */
  async function reply(name: string, input: unknown, request?: IncomingMessage) {
    try {
      let view: ReturnType<typeof getView> | null = null;
      if (name === 'open_demo') {
        const parsed = openSchema.parse(input);
        const joins = parsed.runId || parsed.pairCode || (sharedBoard && !parsed.newRun && hasSharedBoard());
        if (!joins && request && newRuns && !newRuns.check(request).allowed)
          throw new Error('Too many new boards from this address. Reopen the board you already have.');
        view = openDemo(parsed, { shared: sharedBoard });
      } else if (name === 'update_demo') {
        const parsed = updateSchema.parse(input);
        if (storedDataActions.has(parsed.action))
          throw new Error('The demo bank feed is read-only here: it cannot be started or stopped from the board.');
        view = updateDemo(parsed);
      }
      if (!view) throw new Error('Unknown demo tool.');
      const snapshot = await present(view);
      const text =
        name === 'open_demo' && snapshot.boardUrl
          ? `${snapshot.message} Live board for this same run: ${snapshot.boardUrl}`
          : snapshot.message;
      return { content: [{ type: 'text' as const, text }], structuredContent: snapshot };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: error instanceof Error ? error.message : 'Could not update this demo.' },
        ],
      };
    }
  }

  // Board guidance for the model, appended to the shared ReloCat server instructions.
  const boardInstructions = (
    'When the user says “ReloCat, start”, call open_demo with no arguments immediately. The browser and chat share one live board. ' +
    'Do not ask for a code, run ID, or persona to start. Present boardUrl as a clickable link if the widget is hidden; do not read URLs aloud. ' +
    'Use the runId returned by open_demo for subsequent writes. Pass persona to switch when asked. ' +
    'Speak as a warm, concise game guide. The board labels the rehearsal data, so skip repeated spoken labels. ' +
    'If asked about real-world applicability, explain what needs verification. ' +
    'For Laia, group missing home details or finances into a natural prompt. Extract all answers from each spoken or typed reply ' +
    'and save them in one update_demo answer_batch call. Ask only for details still missing. Once the basics are saved, offer the extra profile groups. ' +
    'The board updates when the tool saves the turn. Offer boardUrl as a clickable link if the voice host does not show the widget. ' +
    'Only claim the widget is visible if you have confirmed it. For Marc, lead with the win and the next quest from progress.coach; ' +
    'offer a concrete quest with its spending swap and estimated monthly benefit. Use adopt_habit on acceptance and complete_habit only after a check-in. For Núria, ask before opening the inbox. Then pitch routes A/B/C briefly and ask which to preview. ' +
    'Use preview_shortcut to highlight a route on the map without switching. Route A = rule, B = listing, C = job, D = rural, E = friends. ' +
    'Only call choose_shortcut after explicit confirmation. Import the sample bank or replay a payment only on request. ' +
    'Jordi starts debt-free. Celebrate and ask whether to roll the credits; on yes, call update_demo with action show_credits and briefly recap. ' +
    'Always separate the upfront milestone from owning outright; the comparison assumes 20 years of repayments after purchase readiness.'
  ).trim();

  function createMcpServer(caller: Caller, request: IncomingMessage) {
    // Same tools as the public server, plus the board. The caller decides what the personal tools reach.
    const server = createRelocatMcpServer({
      ...data(),
      dataStatus,
      townExplorerPage,
      workspacePage,
      interviewCard,
      caller,
      listings,
      extraInstructions: boardInstructions,
    });

    registerAppResource(server, 'ReloCat journey board', widgetUri, {}, async () => ({
      contents: [
        {
          uri: widgetUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: page,
          _meta: {
            ui: { prefersBorder: true, csp: { connectDomains: publicOrigin ? [publicOrigin] : [] } },
            'openai/widgetCSP': { connect_domains: publicOrigin ? [publicOrigin] : [], resource_domains: [] },
          },
        },
      ],
    }));

    registerAppTool(
      server,
      'open_demo',
      {
        title: 'Show ReloCat demo',
        description:
          'Call with no arguments when the user says “ReloCat, start” or “start ReloCat”. Opens the shared live board without a code. ' +
          'Pass persona only when asked to show Laia (onboarding), Marc (progress), Núria (shortcuts), or Jordi (payoff). ' +
          'Return the board link in chat if the host does not display the widget. Use newRun only for an explicitly separate rehearsal.',
        inputSchema: openSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        _meta: { ui: { resourceUri: widgetUri }, 'openai/outputTemplate': widgetUri },
      },
      input => reply('open_demo', input, request),
    );

    server.registerTool(
      'update_demo',
      {
        title: 'Update ReloCat demo',
        description:
          'Update by runId. Record all provided fields in answer_batch. Ask only for missing fields. Use adopt_habit/complete_habit for accepted scripted habits. ' +
          'Use preview_shortcut to highlight A (rule), B (listing), C (job), D (rural), or E (friends) via opportunity ID without changing the active route. ' +
          'After confirmation use choose_shortcut, or keep_route to dismiss the preview. Use show_credits on yes to Jordi’s credits and hide_credits to close. ' +
          'Also supports sample_bank, switch_persona, join_quest, read_inbox, replay_payment, final_payment, restart_persona and restart_all. ' +
          'refresh_data re-reads the fictional persona’s read-only bank feed. Everything typed here stays in this rehearsal: nothing is saved to a stored person. Returns the updated board and a provisional sourced town screen.',
        inputSchema: updateSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
      },
      (input: unknown) => reply('update_demo', input, request),
    );
    return server;
  }

  /**
   * A `tools/call` for a personal tool without the authority it needs is answered here, before any
   * tool runs: HTTP 401 (or 403 for a missing scope) with `WWW-Authenticate`, which is what MCP
   * clients act on, and in the body the tool error with `mcp/www_authenticate`, which ChatGPT reads.
   * Returns true when the request was refused.
   */
  function refuseUnauthorized(res: ServerResponse, body: unknown, caller: Caller) {
    if (!caller.challenge) return false;
    for (const message of Array.isArray(body) ? body : [body]) {
      const call = message as {
        id?: unknown;
        method?: unknown;
        params?: { name?: unknown; arguments?: { locale?: unknown }; _meta?: Record<string, unknown> };
      };
      if (!call || typeof call !== 'object' || call.method !== 'tools/call') continue;
      const needed = requiredScopes(call.params?.name, call.params?.arguments);
      if (!needed) continue;
      const missing = caller.me ? needed.find(scope => !caller.scopes.includes(scope)) : undefined;
      if (caller.me && !missing) continue;
      // The sentence the assistant can say aloud comes in the language the call asked for.
      const result = authRequired(caller, missing, toolLocale(call.params?.arguments?.locale, call.params?._meta));
      const challenges = (result._meta?.['mcp/www_authenticate'] ?? []) as string[];
      if (challenges[0]) res.setHeader('WWW-Authenticate', challenges[0]);
      sendJson(res, caller.me ? 403 : 401, { jsonrpc: '2.0', id: call.id ?? null, result });
      return true;
    }
    return false;
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (handleConnectPage(req, res, publicOrigin)) return;
      if (path === '/test' || path.startsWith('/test/')) {
        if (await handleTestUi(req, res, data().snapshot, data().policies, undefined, data().travelEstimates)) return;
      }
      if (path === '/mcp') {
        // Browsers send Origin; agents such as ChatGPT do not. Only this site's own pages may call from a browser.
        const origin = req.headers.origin;
        const sameOrigin = origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
        if (origin !== undefined && !sameOrigin && origin !== publicOrigin && !allowedOrigins?.has(origin)) {
          sendJson(res, 403, { jsonrpc: '2.0', error: { code: -32000, message: 'Origin is not allowed' }, id: null });
          return;
        }
        const resolution = resolveCaller?.(req) ?? { caller: anonymous };
        if ('unauthorized' in resolution) {
          // A credential was presented and is not valid: never fall back to anonymous.
          res.setHeader('WWW-Authenticate', resolution.unauthorized);
          sendJson(res, 401, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Invalid or expired token' },
            id: null,
          });
          return;
        }
        const { caller } = resolution;
        let body: unknown;
        if (req.method === 'POST') {
          try {
            body = await readJson(req, 1_048_576, 'MCP request is too large');
          } catch (error) {
            const status = error instanceof ApiError ? error.status : 400;
            sendJson(res, status, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
            return;
          }
          if (refuseUnauthorized(res, body, caller)) return;
        }
        const mcp = createMcpServer(caller, req);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.once('close', () => {
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === 'GET' && (path === '/' || path === '/preview')) {
        send(res, 200, page, 'text/html');
        return;
      }
      if (req.method === 'GET' && path === '/workspace' && workspacePage) {
        // The React workspace outside a chat host; it calls the tools through POST /mcp on this origin.
        send(res, 200, workspacePage, 'text/html');
        return;
      }
      if (req.method === 'GET' && path === '/preview/state') {
        // Same-origin only: no CORS header. A run is addressed by its unguessable id; without one
        // only the shared board of a local demo answers.
        const run = openSchema.shape.runId.safeParse(url.searchParams.get('run') ?? undefined);
        if (!run.success || (!run.data && !sharedBoard)) {
          send(res, 400, 'A valid run ID is required.');
          return;
        }
        try {
          const view = run.data ? getView(run.data) : openDemo({}, { shared: true });
          send(res, 200, JSON.stringify(await present(view)), 'application/json');
        } catch {
          send(res, 404, 'This rehearsal expired. Open the shared live board.');
        }
        return;
      }
      if (req.method === 'GET' && path === '/health') {
        send(res, 200, `${product.name} demo is ready`);
        return;
      }
      if (req.method === 'POST' && path === '/preview/action') {
        if (!req.headers['content-type']?.startsWith('application/json')) {
          send(res, 415, 'Expected JSON');
          return;
        }
        const { name, args } = (await readJson(req, 16_384, 'Demo input is too long.')) as {
          name: string;
          args: unknown;
        };
        send(res, 200, JSON.stringify(await reply(name, args, req)), 'application/json');
        return;
      }
      send(res, 404, 'Not found');
    } catch (error) {
      if (!res.headersSent) send(res, 400, error instanceof Error ? error.message : 'Request failed.');
      else res.end();
    }
  };
  return { handle };
}

if (import.meta.main) {
  const port = envPort('PORT', defaultPorts.app);
  const host = envText('HOST', '127.0.0.1');
  const publicOrigin = publicOriginConfig();
  // On its own the board is the scripted demo: no accounts, no stored people, runs in memory.
  const server = createServer(createBoardApp({ publicOrigin }).handle);
  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    console.log('%s preview: http://localhost:%d/preview', product.name, boundPort);
    console.log('MCP endpoint:   http://localhost:%d/mcp', boundPort);
  });
}
