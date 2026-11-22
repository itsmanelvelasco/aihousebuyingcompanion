import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { defaultPorts, envInteger, envList, envPort, openaiModels } from '../../packages/config/env.ts';
import { product } from '../../packages/config/product.ts';
import { sendJson } from '../../packages/http/server.ts';
import { seedRuntime } from '../../packages/profiles/store.ts';
import { createBoardApp } from '../board/server.ts';
import { createHabitsHandler } from '../habits-agent/server.ts';
import { createProfileApiHandler } from '../profile-api/server.ts';

/**
 * The one ReloCat server. Everything is served from a single origin:
 *
 *   /mcp            MCP endpoint for ChatGPT and other agents
 *   /preview        journey board         /connect   homepage and agent setup
 *   /api/...        profiles, inputs, bank ledger, bank events and habits (bearer token)
 *   /health         readiness
 *
 * Locally that origin is http://127.0.0.1:8787; in production it is https://www.relo.cat.
 */
const host = process.env.HOST ?? '127.0.0.1';
const port = envPort('PORT', defaultPorts.app);
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;
// The API token never leaves the server; a random one per start is enough when none is configured.
const token = process.env.PROFILE_API_TOKEN || randomUUID();
const profileRoot = resolve(process.env.PROFILE_DATA_DIR ?? 'data/runtime-users');
const apiPrefix = '/api';

const fixtures = resolve('data/users');
if (existsSync(fixtures)) await seedRuntime(fixtures, profileRoot);

const profiles = createProfileApiHandler(profileRoot, token);
const habits = createHabitsHandler({
  token,
  dataRoot: resolve(process.env.HABITS_DATA_DIR ?? 'data/runtime-habits'),
  profileRoot,
  dailyCalls: envInteger('HABITS_DAILY_AI_CALLS', 20),
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: openaiModels().habits,
    maxOutputTokens: envInteger('HABITS_MAX_OUTPUT_TOKENS', 1024),
  },
});

let board: ReturnType<typeof createBoardApp> | undefined;

async function route(request: IncomingMessage, response: ServerResponse) {
  const path = (request.url ?? '/').split('?')[0];
  if (path === '/health' && request.method === 'GET') {
    return sendJson(response, 200, { status: 'ok', product: product.name, version: product.version });
  }
  if (path === apiPrefix || path.startsWith(`${apiPrefix}/`)) {
    request.url = (request.url ?? '').slice(apiPrefix.length) || '/';
    const parts = request.url.split('?')[0].split('/').filter(Boolean);
    const isHabits = parts[0] === 'limits' || (parts[0] === 'users' && parts[2] === 'habits');
    return isHabits ? habits(request, response) : profiles.handle(request, response);
  }
  if (!board) return sendJson(response, 503, { error: 'Server is starting' });
  return board.handle(request, response);
}

const server = createServer((request, response) => {
  route(request, response).catch(() => {
    if (!response.headersSent) sendJson(response, 500, { error: 'Internal server error' });
    else response.destroy();
  });
});

server.listen(port, host, async () => {
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  const local = `http://127.0.0.1:${boundPort}`;
  // The board and MCP tools reach the API over loopback, exactly as an external client would.
  board = createBoardApp({ connection: { baseUrl: local + apiPrefix, token }, publicOrigin });
  for (const id of envList('DEMO_BANK_USERS')) {
    await profiles.bankRuntime.configure(id, { enabled: true, intervalMs: envInteger('DEMO_BANK_INTERVAL_MS', 5000) });
    await profiles.bankRuntime.tick(id);
  }
  console.log('%s server: %s', product.name, publicOrigin ?? local);
  console.log('  board    %s/preview', local);
  console.log('  connect  %s/connect', local);
  console.log('  MCP      %s/mcp', local);
  console.log('  API      %s%s (bearer token, server-side only)', local, apiPrefix);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void profiles.bankRuntime.close().then(() => server.close());
  });
}
