import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { product } from '../../packages/config/product.ts';
import { markSvg } from '../../packages/ui/icons.ts';
import { images } from '../../packages/ui/images.manifest.ts';
import { imageFile, inlineUi } from '../../packages/ui/inline.ts';

const directory = new URL('../../apps/mcp-server/', import.meta.url);

function imageUrl(file: string, mime: string) {
  const image = readFileSync(new URL(`assets/${file}`, directory), 'base64');
  return `data:image/${mime};base64,${image}`;
}

const agentIcons = {
  chatgpt: imageUrl('agents/chatgpt.png', 'png'),
  claude: imageUrl('agents/claude.svg', 'svg+xml'),
  hermes: imageUrl('agents/hermes.png', 'png'),
  openclaw: imageUrl('agents/openclaw.svg', 'svg+xml'),
  codex: imageUrl('agents/codex.png', 'png'),
  cursor: imageUrl('agents/cursor.svg', 'svg+xml'),
  gemini: imageUrl('agents/gemini.png', 'png'),
  muse: imageUrl('agents/muse.webp', 'webp'),
};

// Illustrations come from the image slots of packages/ui: the generated file when present, the SVG otherwise.
const page = inlineUi(readFileSync(new URL('connect.html', directory), 'utf8'))
  .replace('{{og-image}}', `${product.site}/og.jpg`)
  .replace('{{og-alt}}', images.find(image => image.id === 'og-card')?.alt ?? '')
  .replace('{{agent-icons}}', () => JSON.stringify(agentIcons));

const ogImage = imageFile('og-card');

/** The homepage at /connect, plus the two files a crawler or a browser tab asks for by URL. */
export function handleConnectPage(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = req.url?.split('?')[0];
  if (path === '/og.jpg' || path === '/favicon.svg' || path === '/favicon.ico') {
    const file = path === '/og.jpg' ? ogImage : { type: 'image/svg+xml', bytes: Buffer.from(markSvg, 'utf8') };
    res.writeHead(200, {
      'Content-Type': file.type,
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : file.bytes);
    return true;
  }
  if (path !== '/connect' || req.method !== 'GET') return false;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy':
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(page);
  return true;
}
