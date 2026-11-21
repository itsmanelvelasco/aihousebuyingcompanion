import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { getView, openDemo, openSchema, updateDemo, updateSchema } from './demo.ts';

const widgetUri = 'ui://arrela/journey-v5.html';
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;

function withBoardLink(view: ReturnType<typeof getView>) {
  const path = view.sharedBoard ? '/preview' : `/preview?run=${view.runId}`;
  return { ...view, boardUrl: publicOrigin ? publicOrigin + path : null };
}
const template = readFileSync(new URL('./widget.html', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('./dist/widget.js', import.meta.url), 'utf8');
const page = template.replace('<!-- WIDGET -->', () =>
  '<script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>');

function reply(name: string, input: unknown) {
  try {
    const view = name === 'open_demo' ? openDemo(openSchema.parse(input))
      : name === 'update_demo' ? updateDemo(updateSchema.parse(input)) : null;
    if (!view) throw new Error('Unknown demo tool.');
    const snapshot = withBoardLink(view);
    const text = name === 'open_demo' && snapshot.boardUrl
      ? `${view.message} Live board for this same run: ${snapshot.boardUrl}`
      : view.message;
    return { content: [{ type: 'text' as const, text }], structuredContent: snapshot };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const,
      text: error instanceof Error ? error.message : 'Could not update this demo.' }] };
  }
}

function createMcpServer() {
  const server = new McpServer({ name: 'relo.cat', version: '0.1.0' }, {
    instructions: 'When the user says “relo.cat, start” (or the old “Arrela, start”), call open_demo with no arguments immediately. The browser and chat share one live board. ' +
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
      'Always separate the upfront milestone from owning outright; the comparison assumes 20 years of repayments after purchase readiness.',
  });

  registerAppResource(server, 'relo.cat journey board', widgetUri, {}, async () => ({
    contents: [{
      uri: widgetUri, mimeType: RESOURCE_MIME_TYPE, text: page,
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: publicOrigin ? [publicOrigin] : [] } },
        'openai/widgetCSP': { connect_domains: publicOrigin ? [publicOrigin] : [], resource_domains: [] },
      },
    }],
  }));

  registerAppTool(server, 'open_demo', {
    title: 'Show relo.cat demo',
    description: 'Call with no arguments when the user says “relo.cat, start” or “start relo.cat”. Opens the shared live board without a code. ' +
      'Pass persona only when asked to show Laia (onboarding), Marc (progress), Núria (shortcuts), or Jordi (payoff). ' +
      'Return the board link in chat if the host does not display the widget. Use newRun only for an explicitly separate rehearsal.',
    inputSchema: openSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: widgetUri }, 'openai/outputTemplate': widgetUri },
  }, input => reply('open_demo', input));

  server.registerTool('update_demo', {
    title: 'Update relo.cat demo',
    description: 'Update relo.cat by runId. Use answer_batch with answers containing all provided fields (town, bedrooms, ' +
      'household, employment, income, spending, savings, currentTown, budget, homeSize, dependants, rural, commuteTo, commuteTime, transport, schoolStages, debtPayments, reserve, cashTarget). ' +
      'Use adopt_habit or complete_habit with habit ID coffee, takeout, or picnic; adoption comes before check-in. ' +
      'Use preview_shortcut to highlight A (rule), B (listing), C (job), D (rural), or E (friends) via opportunity ID without changing the active route. ' +
      'After confirmation use choose_shortcut, or keep_route to dismiss the preview. Use show_credits on yes to Jordi’s credits and hide_credits to close. ' +
      'Also supports sample_bank, switch_persona, join_quest, read_inbox, replay_payment, final_payment, restart_persona and restart_all.',
    inputSchema: updateSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
  }, input => reply('update_demo', input));
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
      // No run parameter means the shared demo board; separate rehearsals use their UUID.
      res.setHeader('Access-Control-Allow-Origin', '*');
      const run = openSchema.shape.runId.safeParse(url.searchParams.get('run') ?? undefined);
      if (!run.success) {
        send(res, 400, 'A valid run ID is required.');
        return;
      }
      try {
        const view = run.data ? getView(run.data) : openDemo({});
        send(res, 200, JSON.stringify(withBoardLink(view)), 'application/json; charset=utf-8');
      } catch {
        send(res, 404, 'This rehearsal expired. Open the shared live board.');
      }
      return;
    }
    if (req.method === 'GET' && path === '/health') {
      send(res, 200, 'relo.cat demo is ready');
      return;
    }
    if (req.method === 'POST' && path === '/preview/action') {
      if (!req.headers['content-type']?.startsWith('application/json')) {
        send(res, 415, 'Expected JSON');
        return;
      }
      const { name, args } = await readJson(req);
      send(res, 200, JSON.stringify(reply(name, args)), 'application/json; charset=utf-8');
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
  console.log('relo.cat preview: http://localhost:%d/preview', boundPort);
  console.log('MCP endpoint:   http://localhost:%d/mcp', boundPort);
});
