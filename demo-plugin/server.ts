import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { getView, openDemo, openSchema, updateDemo, updateSchema } from './demo.ts';

const widgetUri = 'ui://arrela/journey-v2.html';
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;

function withBoardLink(view: ReturnType<typeof getView>) {
  return { ...view, boardUrl: publicOrigin ? `${publicOrigin}/preview?run=${view.runId}` : null };
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
  const server = new McpServer({ name: 'arrela-demo', version: '0.1.0' }, {
    instructions: 'Arrela uses fictional Catalan housing snapshots. Open the requested persona with open_demo. ' +
      'If the user gives a board code, use pairCode to join that board. Reuse its runId for all writes and persona switches. ' +
      'For Laia, group missing home details or finances into a natural prompt. Extract all answers from each spoken or typed reply ' +
      'and save them in one update_demo answer_batch call. Ask only for details still missing; do not make the user repeat answers. ' +
      'The board updates when the tool saves the turn. Offer boardUrl as a clickable link if the voice host does not show the widget. ' +
      'Only claim the widget is visible if you have confirmed it. For Núria, ask before opening the inbox or switching route. ' +
      'Import the sample bank or replay a payment only on request. Jordi starts debt-free; celebrate immediately. ' +
      'Always separate the upfront milestone from the finish: owning the home outright, with no mortgage or other demo debt. ' +
      'The timeline assumes 20 years of mortgage repayment after purchase readiness. Never claim demo rules, offers or payments are real.',
  });

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
    description: 'Change a fictional demo run by runId. Use answer_batch with answers containing all provided fields (town, bedrooms, ' +
      'household, employment, income, spending, savings). Accept them in any order and ask only for missing fields. ' +
      'Other actions: sample_bank on request, switch_persona with persona, join_quest, read_inbox after yes, choose_shortcut with opportunity ID, ' +
      'keep_route, replay_payment to queue Jordi’s last installment, final_payment to finish the replay, restart_persona, restart_all. ' +
      'Returns the updated live board state and the next missing group.',
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
      // Read-only access to a fictional run. The UUID is needed even with the widget origin allowed.
      res.setHeader('Access-Control-Allow-Origin', '*');
      const run = openSchema.shape.runId.safeParse(url.searchParams.get('run'));
      if (!run.success || !run.data) {
        send(res, 400, 'A valid run ID is required.');
        return;
      }
      try {
        send(res, 200, JSON.stringify(withBoardLink(getView(run.data))), 'application/json; charset=utf-8');
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
  console.log('Arrela preview: http://localhost:%d/preview', boundPort);
  console.log('MCP endpoint:   http://localhost:%d/mcp', boundPort);
});
