import type { IncomingMessage, ServerResponse } from 'node:http';

const localPeer = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const assets = new Set(['/', '/app.mjs', '/finances.mjs', '/demo.csv']);
const actions = new Set(['/voice', '/classify']);

/** Local same-origin bridge; deliberately not a public API or arbitrary URL proxy. */
export async function handleInterviewerProxy(req: IncomingMessage, res: ServerResponse,
  baseUrl = process.env.INTERVIEWER_BASE_URL ?? 'http://127.0.0.1:3003'): Promise<boolean> {
  const path = req.url?.split('?')[0] ?? '';
  if (path !== '/interviewer' && !path.startsWith('/interviewer/')) return false;
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const host = req.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
    || !localPeer.has(req.socket.remoteAddress ?? '')
    || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    send(403, { error: 'The interviewer bridge is available only from its local origin.' }); return true;
  }
  if (path === '/interviewer' && req.method === 'GET') {
    res.writeHead(302, { Location: '/interviewer/', 'Cache-Control': 'no-store' }).end(); return true;
  }
  const targetPath = path.slice('/interviewer'.length);
  if (!assets.has(targetPath) && !actions.has(targetPath)) {
    send(404, { error: 'Unknown interviewer route.' }); return true;
  }
  if (!(req.method === 'GET' && assets.has(targetPath)) && !(req.method === 'POST' && actions.has(targetPath))) {
    send(405, { error: 'Method not allowed.' }); return true;
  }
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid local backend');
    const headers: Record<string, string> = { Origin: base.origin };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    let body: Buffer | undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) { send(413, { error: 'Interviewer request exceeds 64 KiB.' }); return true; }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const upstream = await fetch(new URL(targetPath, base), {
      method: req.method, headers, body: body ? new Uint8Array(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000)
    });
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    if (!res.headersSent) send(502, { error: 'The local interviewer backend is unavailable. Start it on the configured port.' });
    else res.end();
  }
  return true;
}
