import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

const maximumBytes = 65536;
const input = z.object({ sdp: z.string().min(1).max(maximumBytes) }).strict();
const unavailable = 'Voice could not connect. Use the guided interview or ChatGPT voice instead.';
const failure = (message = unavailable): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

async function voiceSession(value: unknown, target = process.env.INTERVIEWER_BASE_URL ?? 'http://127.0.0.1:3003'): Promise<CallToolResult> {
  const parsed = input.safeParse(value);
  if (!parsed.success || Buffer.byteLength(parsed.data.sdp, 'utf8') > maximumBytes) return failure('Send a WebRTC offer no larger than 64 KiB.');
  try {
    const base = new URL(target);
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return failure();
    const response = await fetch(new URL('/voice', base), {
      method: 'POST', headers: { Origin: base.origin, 'Content-Type': 'application/sdp' },
      body: parsed.data.sdp, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return failure();
    if (!response.headers.get('content-type')?.startsWith('application/sdp')) return failure();
    const answer = await response.text();
    if (!answer || Buffer.byteLength(answer, 'utf8') > maximumBytes) return failure();
    return { content: [{ type: 'text', text: 'Voice connection prepared for the workspace.' }], _meta: { voiceSdp: answer } };
  } catch { return failure(); }
}

/** SDP only: the local interviewer owns the API key and upstream Realtime call. */
export function registerWorkspaceVoiceTool(server: McpServer, target?: string) {
  registerAppTool(server, 'workspace_voice_session', {
    title: 'Connect workspace voice interview',
    description: 'Start a paid voice session only after the person presses Start voice in the workspace and grants microphone access.',
    inputSchema: input.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
  }, value => voiceSession(value, target));
}

export async function handleWorkspaceVoiceHttp(req: IncomingMessage, res: ServerResponse, target?: string) {
  if (req.url?.split('?')[0] !== '/workspace/voice') return false;
  const reply = (status: number, data: CallToolResult) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
  };
  const host = req.headers.host ?? '';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  if (!local || (req.headers.origin && req.headers.origin !== `http://${host}`)) { reply(403, failure('Voice is available only from its local workspace origin.')); return true; }
  if (req.method !== 'POST') { reply(405, failure('Use POST for a voice offer.')); return true; }
  if (!req.headers['content-type']?.startsWith('application/sdp')) { reply(415, failure('Send a WebRTC offer as application/sdp.')); return true; }
  try {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > maximumBytes) { reply(413, failure('Voice offer exceeds 64 KiB.')); return true; }
      chunks.push(chunk);
    }
    const result = await voiceSession({ sdp: Buffer.concat(chunks).toString('utf8') }, target);
    reply(result.isError ? 502 : 200, result);
  } catch { if (!res.headersSent) reply(400, failure('The voice offer could not be read.')); }
  return true;
}
