import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Static local operator UI; all data routes still require the bearer token.
export async function handleManagementUi(req: IncomingMessage, res: ServerResponse) {
  const path = req.url?.split('?')[0];
  if (!['/', '/manage', '/manage/', '/manage/app.mjs'].includes(path ?? '')) return false;
  const host = req.headers.host ?? '';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  if (!local || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    res.writeHead(403).end('Management is available on localhost only.'); return true;
  }
  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return true; }
  if (path === '/' || path === '/manage') { res.writeHead(302, { Location: '/manage/' }).end(); return true; }
  const script = path === '/manage/app.mjs';
  const content = await readFile(new URL(script ? './admin.mjs' : './admin.html', import.meta.url));
  res.writeHead(200, {
    'Content-Type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  res.end(content);
  return true;
}
