import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const directory = new URL('../../apps/mcp-server/', import.meta.url);
const illustrations = {
  village: 'town-explorer.jpg',
  welcome: 'connect-welcome.jpg',
  guide: 'connect-guide.jpg',
} as const;

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
const page = Object.entries(illustrations)
  .reduce(
    (html, [key, file]) => {
      return html.replace(`{{${key}}}`, imageUrl(file, 'jpeg'));
    },
    readFileSync(new URL('connect.html', directory), 'utf8'),
  )
  .replace('{{agent-icons}}', JSON.stringify(agentIcons));

export function handleConnectPage(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url?.split('?')[0] !== '/connect' || req.method !== 'GET') return false;
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
