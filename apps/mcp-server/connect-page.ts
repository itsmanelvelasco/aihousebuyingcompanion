import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const page = readFileSync(new URL('./connect.html', import.meta.url), 'utf8');
export function handleConnectPage(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url?.split('?')[0] !== '/connect' || req.method !== 'GET') return false;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'none'; img-src https://cdn.brandfetch.io https://web-assets.nousresearch.com https://openclaw.ai https://lookaside.fbsbx.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(page);
  return true;
}
