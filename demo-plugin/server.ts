import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { openDemo, openSchema, updateDemo, updateSchema } from './demo.ts';

const widgetUri = 'ui://arrela/journey.html';
const template = readFileSync(new URL('./widget.html', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('./dist/widget.js', import.meta.url), 'utf8');
const page = template.replace('<!-- WIDGET -->', () =>
  '<script>' + bundle.replace(/<\/script/gi, '<\\/script') + '</script>');

function reply(name: string, input: unknown) {
  try {
    const view = name === 'open_demo' ? openDemo(openSchema.parse(input))
      : name === 'update_demo' ? updateDemo(updateSchema.parse(input)) : null;
    if (!view) throw new Error('Unknown demo tool.');
    return { content: [{ type: 'text' as const, text: view.message }], structuredContent: view };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const,
      text: error instanceof Error ? error.message : 'Could not update this demo.' }] };
  }
}

function createMcpServer() {
  const server = new McpServer({ name: 'arrela-demo', version: '0.1.0' }, {
    instructions: 'Arrela uses fictional Catalan housing snapshots. Use open_demo to show the appropriate persona based on the user request. ' +
      'Keep the runId from the last result when switching personas. For Laia, ask only the next returned question, wait for the user, ' +
      'then call update_demo with action answer, that question ID and the spoken or typed answer. ' +
      'For Núria, mention the unread count and ask before opening the inbox. Only call choose_shortcut, sample_bank or final_payment ' +
      'after the user chooses that demo action. Call open_demo with the same runId if the user wants to see the updated board. ' +
      'Use only fictional details and never claim that demo rules, offers, balances or payments are real.',
  });

  registerAppResource(server, 'Arrela journey board', widgetUri, {}, async () => ({
    contents: [{ uri: widgetUri, mimeType: RESOURCE_MIME_TYPE, text: page }],
  }));

  registerAppTool(server, 'open_demo', {
    title: 'Show Arrela demo',
    description: 'Open a fictional persona and board. Choose onboarding (Laia), progress (Marc), shortcuts (Núria), or payoff (Jordi). ' +
      'Use progress when asked “how am I doing so far?” Include the current runId to preserve progress. Omit runId for a fresh demo run.',
    inputSchema: openSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: widgetUri } },
  }, input => reply('open_demo', input));

  server.registerTool('update_demo', {
    title: 'Update Arrela demo',
    description: 'Change only a fictional demo run. Use its runId. Actions: answer with returned question ID and one answer; ' +
      'sample_bank on explicit request; switch_persona with persona; join_quest; read_inbox after user says yes; choose_shortcut with opportunity ID; ' +
      'keep_route; final_payment when explicitly requested; restart_persona; restart_all. Returns updated demo state and any next question.',
    inputSchema: updateSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
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
