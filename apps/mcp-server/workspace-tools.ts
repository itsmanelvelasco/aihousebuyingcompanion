import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { dateSchema } from '../profile-api/finance.ts';

export type WorkspaceConfig = { baseUrl: string; token: string };
const widgetUri = 'ui://relocat/input-workspace-v1.html';
const safeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const maxBytes = 262144;
const requestSchema = z.object({
  path: z.string().min(1).max(1024),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
  body: z.json().optional(),
}).strict();
type WorkspaceRequest = z.infer<typeof requestSchema>;
type Route = { pattern: RegExp; methods: string[]; queries?: Record<string, z.ZodType> };
const id = '[a-z0-9][a-z0-9-]{0,63}';
const integer = (maximum: number) => z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().safe().min(0).max(maximum));
const routes: Route[] = [
  { pattern: /^\/users$/, methods: ['GET', 'POST'] },
  { pattern: new RegExp(`^/users/${id}$`), methods: ['GET'] },
  { pattern: new RegExp(`^/users/${id}/(?:details|preferences|bank-account)$`), methods: ['GET', 'PUT'] },
  { pattern: new RegExp(`^/users/${id}/context$`), methods: ['GET'] },
  { pattern: new RegExp(`^/users/${id}/inputs$`), methods: ['GET', 'POST'] },
  { pattern: new RegExp(`^/users/${id}/inputs/${id}$`), methods: ['PUT', 'DELETE'] },
  { pattern: new RegExp(`^/users/${id}/bank/accounts$`), methods: ['GET', 'POST'], queries: { asOf: dateSchema } },
  { pattern: new RegExp(`^/users/${id}/bank/accounts/${id}$`), methods: ['PUT'] },
  { pattern: new RegExp(`^/users/${id}/bank/transactions$`), methods: ['GET', 'POST'], queries: { from: dateSchema, to: dateSchema, accountId: safeId, limit: integer(500).refine(n => n > 0), offset: integer(10000) } },
  { pattern: new RegExp(`^/users/${id}/bank/transactions/${id}$`), methods: ['PUT', 'DELETE'] },
  { pattern: new RegExp(`^/users/${id}/bank/events$`), methods: ['GET'], queries: { after: integer(Number.MAX_SAFE_INTEGER), limit: integer(100).refine(n => n > 0) } },
  { pattern: new RegExp(`^/users/${id}/bank/runtime$`), methods: ['GET', 'POST'] },
  { pattern: new RegExp(`^/users/${id}/bank/(?:runtime/tick|demo)$`), methods: ['POST'] },
  { pattern: new RegExp(`^/users/${id}/bank/summary$`), methods: ['GET'], queries: { from: dateSchema, to: dateSchema } },
  { pattern: new RegExp(`^/users/${id}/bank/simulate$`), methods: ['POST'], queries: { from: dateSchema, to: dateSchema } },
];

function baseUrl(config?: WorkspaceConfig) {
  if (!config?.token.trim()) return undefined;
  try {
    const base = new URL(config.baseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/') return undefined;
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) return undefined;
    return base;
  } catch { return undefined; }
}

function allowedPath(input: WorkspaceRequest) {
  // Reject encoded separators, normalization, credentials and URL-based origin changes.
  if (!input.path.startsWith('/users') || /[%\\#\s]/.test(input.path)) return false;
  const url = new URL(input.path, 'https://workspace.invalid');
  if (url.origin !== 'https://workspace.invalid' || url.pathname.includes('..')) return false;
  const route = routes.find(route => route.pattern.test(url.pathname));
  if (!route || !route.methods.includes(input.method)) return false;
  if (input.path.split('?')[0] !== url.pathname) return false;
  if (input.method !== 'GET' && input.body === undefined && input.method !== 'DELETE') return false;
  if (input.method === 'GET' && input.body !== undefined) return false;
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1 || !route.queries?.[key]?.safeParse(value).success) return false;
  }
  return true;
}

function error(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function redact(value: unknown, token: string): unknown {
  if (Array.isArray(value)) return value.map(item => redact(item, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:token|api[_-]?key|authorization|password|cookie|secret|access_token|refresh_token)$/i.test(key) ? '[redacted]' : redact(item, token)]));
  return typeof value === 'string' && value.includes(token) ? value.replaceAll(token, '[redacted]') : value;
}

async function workspaceRequest(value: unknown, config?: WorkspaceConfig): Promise<CallToolResult> {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success || !allowedPath(parsed.data)) return error('Choose a supported workspace route, method and bounded query.');
  const base = baseUrl(config);
  if (!base || !config) return error('The profile workspace is not configured. Set the server-side profile API connection.');
  const body = parsed.data.body === undefined ? undefined : JSON.stringify(parsed.data.body);
  if (body && Buffer.byteLength(body) > maxBytes) return error('Workspace input exceeds 256 KiB.');
  try {
    const response = await fetch(new URL(parsed.data.path, base), {
      method: parsed.data.method,
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const description = response.status === 400 ? 'The workspace rejected the data. Check required fields, IDs, dates, units and synthetic provenance.'
        : response.status === 404 ? 'The requested workspace record was not found.'
        : response.status === 409 ? 'The record conflicts with an existing ID. Refresh and review before saving.'
        : response.status === 413 ? 'Workspace input exceeds 256 KiB.'
        : 'The workspace request could not be completed. Check the profile service and server-side connection.';
      return error(description);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) return error('Workspace response is too large. Use a smaller page.');
    const data: unknown = JSON.parse(text);
    return { content: [{ type: 'text', text: 'The synthetic workspace request completed.' }], _meta: { workspace: redact(data, config.token) } };
  } catch { return error('The workspace service is unavailable or returned an invalid response.'); }
}

export function registerWorkspaceTools(server: McpServer, page: string, config?: WorkspaceConfig) {
  registerAppResource(server, 'ReloCat input workspace', widgetUri, {}, async () => ({
    contents: [{ uri: widgetUri, mimeType: RESOURCE_MIME_TYPE, text: page,
      _meta: { ui: { prefersBorder: true, permissions: { microphone: {} }, csp: { connectDomains: [], resourceDomains: [] } } } }],
  }));
  registerAppTool(server, 'open_input_workspace', {
    title: 'Open ReloCat input workspace',
    description: 'Open the React workspace to review fictional profiles, preferences, interview inputs, provenance, bank movements and simulated feed controls. Opening this view does not change records or spend API credits.',
    inputSchema: z.object({ userId: safeId.optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: widgetUri }, 'openai/outputTemplate': widgetUri },
  }, ({ userId }) => ({
    content: [{ type: 'text', text: 'ReloCat synthetic input workspace opened.' }],
    structuredContent: { ...(userId ? { userId } : {}), configured: Boolean(baseUrl(config)), synthetic: true },
  }));
  server.registerTool('workspace_request', {
    title: 'Use the synthetic workspace',
    description: 'App-only workspace operation. Raw fictional records are returned only to the widget. Writes require an explicit reviewed UI action.',
    inputSchema: requestSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
  }, input => workspaceRequest(input, config));
}

/** Local preview transport; remote widgets must use the host's app-only tool bridge. */
export async function handleWorkspaceHttp(req: IncomingMessage, res: ServerResponse, config?: WorkspaceConfig) {
  if (req.url?.split('?')[0] !== '/workspace/api') return false;
  const reply = (status: number, result: CallToolResult) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(result));
  };
  const host = req.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    reply(403, error('The workspace preview is available only from its local origin.')); return true;
  }
  if (req.method !== 'POST') { reply(405, error('Use POST for workspace operations.')); return true; }
  if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, error('Send workspace operations as JSON.')); return true; }
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) { reply(413, error('Workspace input exceeds 256 KiB.')); return true; }
      chunks.push(chunk);
    }
    const result = await workspaceRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), config);
    reply(200, result);
  } catch { reply(400, error('Invalid workspace JSON.')); }
  return true;
}
