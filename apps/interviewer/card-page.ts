import { readFileSync } from 'node:fs';
import { escapeHtml } from '../../packages/http/server.ts';
import { stepImageIds } from '../../packages/ui/images.manifest.ts';
import { inlineUi } from '../../packages/ui/inline.ts';

/**
 * The interview card as one self-contained document for a chat host: `card.html` with the shared
 * theme, the checkpoint illustrations and its bundle (`card.ts`) inlined, and the absolute address
 * of ReloCat's voice route written on `<html>`, because the card runs on the host's own origin.
 * Server side only; the MCP server receives the finished page from the composition root.
 */

/** The card for a ReloCat server at `origin`, or `undefined` when `npm run build` has not produced its bundle. */
export function loadInterviewCard({ origin }: { origin: string }) {
  let bundle: string;
  try {
    bundle = readFileSync(new URL('./dist/card.js', import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const endpoint = `${new URL(origin).origin}/interview/voice`;
  return inlineUi(readFileSync(new URL('./card.html', import.meta.url), 'utf8'), { art: [...stepImageIds] })
    .replace('<html ', () => `<html data-voice-endpoint="${escapeHtml(endpoint)}" `)
    .replace('<!-- WIDGET -->', () => `<script>${bundle.replace(/<\/script/gi, '</script')}</script>`);
}

export type InterviewCard = {
  page: string;
  /** The origin the card calls for voice; the host must let the card connect to it. */
  origin: string;
};

/**
 * The card, when voice can really answer a card embedded in a chat: an OpenAI key, public voice
 * switched on, a public origin the card can reach, and at least one embedding origin allowed
 * (`INTERVIEWER_EMBED_ORIGINS`). Otherwise `undefined`, and the MCP server shows its simple card,
 * whose button continues the interview in the chat.
 */
export function embeddedInterviewCard(options: {
  publicOrigin: string | null;
  apiKey?: string;
  publicAi?: boolean;
  embedOrigins?: readonly string[];
}): InterviewCard | undefined {
  const { publicOrigin } = options;
  if (!publicOrigin || !options.apiKey || !options.publicAi || !options.embedOrigins?.length) return undefined;
  const origin = new URL(publicOrigin).origin;
  const page = loadInterviewCard({ origin });
  return page ? { page, origin } : undefined;
}
