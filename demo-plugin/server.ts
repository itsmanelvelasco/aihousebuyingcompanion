import { handleConnectPage } from '../apps/mcp-server/connect-page.ts';
import { handleTestUi } from '../apps/mcp-server/test-ui.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { getView, openDemo, openSchema, updateDemo, updateSchema } from './demo.ts';
import { profileConnection, ProfileBridge, connectedAnswers } from './profiles.ts';
import { createMcpServer as createPlacesMcpServer } from '../apps/mcp-server/tools.ts';
import { loadData } from '../packages/places/data.ts';
import { registerBankTools } from '../apps/mcp-server/bank-tools.ts';

const connection = profileConnection();
const bridge = connection ? new ProfileBridge(connection) : null;
const connectedUpdateSchema = updateSchema.extend({ answers: connectedAnswers.optional() });

const widgetUri = 'ui://arrela/journey-v3.html';
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;

function withBoardLink(view: ReturnType<typeof getView>) {
  return { ...view, boardUrl: publicOrigin ? `${publicOrigin}/preview?run=${view.runId}` : null };
}
const template = readFileSync(new URL('./widget.html', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('./dist/widget.js', import.meta.url), 'utf8');
const page = template.replace('<!-- WIDGET -->', () =>
  '<script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>');

async function reply(name: string, input: unknown) {
  try {
    let view: ReturnType<typeof getView> | null = null;
    if (name === 'open_demo') view = openDemo(openSchema.parse(input));
    else if (name === 'update_demo') {
      if (!bridge) view = updateDemo(updateSchema.parse(input));
      else {
        const parsed = connectedUpdateSchema.parse(input);
        const before = getView(parsed.runId);
        if (parsed.action === 'sample_bank') {
          await bridge.connectBank(before);
          view = updateDemo({ runId: parsed.runId, action: 'refresh_data' });
        } else if (parsed.action === 'start_bank_runtime' || parsed.action === 'stop_bank_runtime') {
          await bridge.runtime(before, parsed.action === 'start_bank_runtime');
          view = updateDemo({ runId: parsed.runId, action: 'refresh_data' });
        } else if (parsed.action === 'answer_batch') {
          if (!parsed.answers || !Object.keys(parsed.answers).length) throw new Error('Supply interview answers.');
          // Persist before changing the visible board. Backend errors never fall back to scripted state.
          await bridge.save({ ...before, revision: before.revision + 1 }, parsed.answers);
          const legacy = Object.fromEntries(Object.entries(parsed.answers).filter(([key]) => ['town', 'bedrooms', 'household', 'employment', 'income', 'spending', 'savings'].includes(key)));
          view = Object.keys(legacy).length ? updateDemo(updateSchema.parse({ ...parsed, answers: legacy })) : updateDemo({ runId: parsed.runId, action: 'refresh_data' });
        } else if (parsed.action === 'answer') {
          if (!parsed.question || parsed.answer === undefined) throw new Error('Supply a question and answer.');
          const answers = connectedAnswers.parse({ [parsed.question]: parsed.answer });
          await bridge.save({ ...before, revision: before.revision + 1 }, answers);
          view = updateDemo(updateSchema.parse(parsed));
        } else view = updateDemo(updateSchema.parse({ ...parsed, answers: undefined }));
      }
    }
    if (!view) throw new Error('Unknown demo tool.');
    const decorated = bridge ? await bridge.decorate(view) : { ...view, connection: { mode: 'scripted_demo' } };
    const snapshot = { ...decorated, boardUrl: publicOrigin ? `${publicOrigin}/preview?run=${view.runId}` : null };
    const text = name === 'open_demo' && snapshot.boardUrl
      ? `${decorated.message} Live board for this same run: ${snapshot.boardUrl}`
      : decorated.message;
    return { content: [{ type: 'text' as const, text }], structuredContent: snapshot };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const,
      text: error instanceof Error ? error.message : 'Could not update this demo.' }] };
  }
}

function createMcpServer() {
  const legacyServer = () => new McpServer({ name: 'arrela-demo', version: '0.1.0' }, {
    instructions: 'Open the requested Arrela persona with open_demo. Speak as a warm, concise game guide. The board already labels the rehearsal data, ' +
      'so do not repeat that label in spoken turns. If asked about real-world applicability, explain what needs verification. ' +
      'If the user gives a board code, use pairCode to join that board. Reuse its runId for all writes and persona switches. ' +
      'For Laia, group missing home details or finances into a natural prompt. Extract all answers from each spoken or typed reply ' +
      'and save them in one update_demo answer_batch call. Ask only for details still missing; do not make the user repeat answers. ' +
      'The board updates when the tool saves the turn. Offer boardUrl as a clickable link if the voice host does not show the widget. ' +
      'Only claim the widget is visible if you have confirmed it. For Marc, lead with the win and the next quest from progress.coach; ' +
      'offer financial details if asked. For Núria, ask before opening the inbox. Then pitch routes A/B/C briefly and ask which to preview. ' +
      'Use preview_shortcut to highlight a route on the map without switching. Route A = rule, B = listing, C = job, D = rural, E = friends. ' +
      'Only call choose_shortcut after explicit confirmation. Import the sample bank or replay a payment only on request. ' +
      'Jordi starts debt-free. Celebrate and ask whether to roll the credits; on yes, call update_demo with action show_credits and briefly recap. ' +
      'Always separate the upfront milestone from owning outright; the comparison assumes 20 years of repayments after purchase readiness.',
  });
  const server = bridge ? (() => { const { snapshot, policies } = loadData(); return createPlacesMcpServer(snapshot, policies); })() : legacyServer();
  if (connection) registerBankTools(server, { baseUrl: connection.baseUrl, token: connection.token });

  registerAppResource(server, 'Arrela journey board', widgetUri, {}, async () => ({
    contents: [{
      uri: widgetUri, mimeType: RESOURCE_MIME_TYPE, text: page,
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: publicOrigin ? [publicOrigin] : [] } },
        'openai/widgetCSP': { connect_domains: publicOrigin ? [publicOrigin] : [], resource_domains: [] },
      },
    }],
  }));

  registerAppTool(server, 'open_demo', {
    title: 'Show Arrela demo',
    description: 'Open a fictional persona and live board. Choose onboarding (Laia), progress (Marc), shortcuts (Núria), or payoff (Jordi, already debt-free). ' +
      'Use pairCode when given a board code. Otherwise keep the current runId when switching personas. ' +
      'With neither, start a new run. If the widget is not visible, share the returned boardUrl to follow the same run in a browser.',
    inputSchema: openSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: widgetUri }, 'openai/outputTemplate': widgetUri },
  }, input => reply('open_demo', input));

  server.registerTool('update_demo', {
    title: 'Update Arrela demo',
    description: 'Change a fictional demo run by runId. Use answer_batch with all provided fields (town, bedrooms, household, employment, income, spending, savings; in connected mode also budget, floorArea, destinationCode, maxCommuteMinutes, schoolStages, schoolMode, allowComarcaEstimate, upfrontTarget and emergencyReserve in EUR). Spending includes debt. Ask only for missing fields. ' +
      'Use preview_shortcut to highlight A (rule), B (listing), C (job), D (rural), or E (friends) via opportunity ID without changing the active route. ' +
      'After confirmation use choose_shortcut, or keep_route to dismiss the preview. Use show_credits on yes to Jordi’s credits and hide_credits to close. ' +
      'Also supports sample_bank, switch_persona, join_quest, read_inbox, replay_payment, final_payment, restart_persona and restart_all. ' +
      'Connected-only actions start_bank_runtime/stop_bank_runtime explicitly control the simulated background feed; refresh_data reads the latest ledger. Returns the updated board, profile context and provisional sourced town screen.',
    inputSchema: (bridge ? connectedUpdateSchema : updateSchema).shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
  }, (input: unknown) => reply('update_demo', input));
  return server;
}

async function readJson(req: IncomingMessage) {
  const body: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16_384) throw new Error('Demo input is too long.');
    body.push(chunk);
  }
  return JSON.parse(Buffer.concat(body).toString('utf8'));
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(body);
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  try {
    if (handleConnectPage(req, res)) return;
    if (path === '/test' || path.startsWith('/test/')) {
      const { snapshot, policies } = loadData();
      if (await handleTestUi(req, res, snapshot, policies)) return;
    }
    if (path === '/mcp') {
      const mcp = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    if (req.method === 'GET' && (path === '/' || path === '/preview')) {
      send(res, 200, page, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && path === '/preview/state') {
      // Read-only access to a fictional run. The UUID is needed even with the widget origin allowed.
      res.setHeader('Access-Control-Allow-Origin', '*');
      const run = openSchema.shape.runId.safeParse(url.searchParams.get('run'));
      if (!run.success || !run.data) {
        send(res, 400, 'A valid run ID is required.');
        return;
      }
      try {
        const view = getView(run.data);
        const decorated = bridge ? await bridge.decorate(view) : withBoardLink(view);
        send(res, 200, JSON.stringify({ ...decorated, boardUrl: publicOrigin ? `${publicOrigin}/preview?run=${view.runId}` : null }), 'application/json; charset=utf-8');
      } catch {
        send(res, 404, 'This demo run expired. Start a fresh board.');
      }
      return;
    }
    if (req.method === 'GET' && path === '/health') {
      send(res, 200, 'Arrela demo is ready');
      return;
    }
    if (req.method === 'POST' && path === '/preview/action') {
      if (!req.headers['content-type']?.startsWith('application/json')) {
        send(res, 415, 'Expected JSON');
        return;
      }
      const { name, args } = await readJson(req);
      send(res, 200, JSON.stringify(await reply(name, args)), 'application/json; charset=utf-8');
      return;
    }
    send(res, 404, 'Not found');
  } catch (error) {
    if (!res.headersSent) send(res, 400, error instanceof Error ? error.message : 'Request failed.');
    else res.end();
  }
});
server.listen(port, host, () => {
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  console.log('Arrela preview: http://localhost:%d/preview', boundPort);
  console.log('MCP endpoint:   http://localhost:%d/mcp', boundPort);
});
