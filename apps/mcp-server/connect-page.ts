import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { savingsCoachDemoMarkup } from '../interviewer/savings-coach.ts';
import { localizeMarkup, siteLanguage } from '../../packages/site/language.ts';
import { catalanAgents, connectCopy } from './connect-copy.ts';

const illustrations = {
  village: 'town-explorer.jpg',
  welcome: 'connect-welcome.jpg',
  guide: 'connect-guide.jpg',
} as const;

function imageUrl(file: string, mime: string) {
  const image = readFileSync(new URL(`../../apps/mcp-server/assets/${file}`, import.meta.url), 'base64');
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
const page = Object.entries(illustrations).reduce((html, [key, file]) => {
  return html.replace(`{{${key}}}`, imageUrl(file, 'jpeg'));
}, readFileSync(new URL('../../apps/mcp-server/connect.html', import.meta.url), 'utf8'))
  .replace('{{agent-icons}}', JSON.stringify(agentIcons));
const pages = {
  ca: localizeMarkup(page, connectCopy, 'ca').replace('{{catalan-agents}}', JSON.stringify(catalanAgents).replace(/</g, '\\u003c')),
  en: localizeMarkup(page, connectCopy, 'en').replace('{{catalan-agents}}', 'null'),
};

export async function handleConnectPage(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.url?.split('?')[0] !== '/connect' || req.method !== 'GET') return false;
  const language = siteLanguage(req.url);
  const coach = await savingsCoachDemoMarkup(language).catch(() => language === 'ca'
    ? '<p id="savings-coach">El simulador d’estalvi no està disponible de moment.</p>'
    : '<p id="savings-coach">The Savings Coach demo is temporarily unavailable.</p>');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Language': language,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(pages[language].replace('<!-- SAVINGS COACH -->', () => coach));
  return true;
}
