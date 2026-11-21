import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { applyTheme } from '../../packages/ui/theme.ts';

export function workspaceConnection() {
  const baseUrl = process.env.PROFILE_API_URL ?? process.env.BANK_API_URL;
  const token = process.env.PROFILE_API_TOKEN ?? process.env.BANK_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : undefined;
}

export function loadWorkspacePage() {
  try {
    const template = readFileSync(new URL('./workspace.html', import.meta.url), 'utf8');
    const bundle = readFileSync(new URL('./dist/workspace.js', import.meta.url), 'utf8');
    return applyTheme(template).replace('<!-- WORKSPACE_WIDGET -->', () =>
      `<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function handleWorkspacePage(req: IncomingMessage, res: ServerResponse, page: string | undefined) {
  if (!['/workspace', '/workspace/'].includes(req.url?.split('?')[0] ?? '')) return false;
  const host = req.headers.host ?? '';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  if (!local || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    res.writeHead(403).end('Local workspace only.'); return true;
  }
  if (req.method !== 'GET') { res.writeHead(405).end(); return true; }
  res.writeHead(page ? 200 : 503, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  }).end(page ?? 'Build the React workspace with npm run build:mcp-ui.');
  return true;
}
