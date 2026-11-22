import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { defaultPorts, demoBankConfig, envInteger, envList, envPort, openaiModels } from '../../packages/config/env.ts';
import { product } from '../../packages/config/product.ts';
import { createRateLimiter } from '../../packages/http/rate-limit.ts';
import { sendJson } from '../../packages/http/server.ts';
import { seedRuntime } from '../../packages/profiles/store.ts';
import { createLiveData } from '../../packages/sources/live.ts';
import { createBoardApp } from '../board/server.ts';
import { connectDemoBank } from '../demo-bank/connect.ts';
import { startDemoBankFromEnv } from '../demo-bank/server.ts';
import { createHabitsHandler } from '../habits-agent/server.ts';
import { createInterviewerHandler, interviewerEnv } from '../interviewer/server.ts';
import { createProfileApiHandler } from '../profile-api/server.ts';

/**
 * The one ReloCat server. Everything is served from a single origin:
 *
 *   /mcp            MCP endpoint for ChatGPT and other agents
 *   /preview        journey board         /connect   homepage and agent setup
 *   /interview/     voice and guided interview
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

// Banc Demo: a separate fictional bank on its own port that pushes signed webhooks to /api.
// On by default outside production; DEMO_BANK=off returns to the in-process synthetic feed.
const demoBankOn = process.env.NODE_ENV !== 'production' && process.env.DEMO_BANK !== 'off';
if (demoBankOn) {
  // The bank registry reads these when the API handler is created, so they are set first.
  process.env.BANK_DEMO_BANK_BASE_URL ||= `http://127.0.0.1:${demoBankConfig().port}`;
  process.env.BANK_DEMO_BANK_API_KEY ||= randomUUID();
  process.env.BANK_DEMO_BANK_WEBHOOK_SECRET ||= randomUUID();
  process.env.DEMO_BANK_SNAPSHOT_FILE ||= 'data/cache/demo-bank.json';
}
let demoBank: Awaited<ReturnType<typeof startDemoBankFromEnv>> | undefined;

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

// Official data: the committed snapshot is the baseline; fresher cached values are overlaid on it.
const live = createLiveData({ cacheDir: resolve(process.env.DATA_CACHE_DIR ?? 'data/cache') });
const liveEnabled = process.env.LIVE_DATA !== 'off';

// One client cannot saturate the server. Bank webhooks are exempt: the bank retries on its own schedule.
const limiter = createRateLimiter({
  limit: envInteger('RATE_LIMIT_PER_MINUTE', 300),
  windowMs: 60_000,
  trustProxy: process.env.TRUST_PROXY === 'on',
});

// Voice and guided interview. Its paid OpenAI routes stay local-only unless explicitly enabled.
const interviewer = createInterviewerHandler({ prefix: '/interview', publicOrigin, ...interviewerEnv() });

let board: ReturnType<typeof createBoardApp> | undefined;

async function route(request: IncomingMessage, response: ServerResponse) {
  const path = (request.url ?? '/').split('?')[0];
  if (path === '/health' && request.method === 'GET') {
    return sendJson(response, 200, {
      status: 'ok',
      product: product.name,
      version: product.version,
      snapshot: live.current().snapshot.version,
      liveData: liveEnabled,
      sources: live.status().map(({ id, status, fetchedAt, applied }) => ({ id, status, fetchedAt, applied })),
    });
  }
  if (!path.startsWith(`${apiPrefix}/webhooks/`)) {
    const { allowed, retryAfterSeconds } = limiter.check(request);
    if (!allowed) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
      return sendJson(response, 429, { error: 'Too many requests' });
    }
  }
  if (path === apiPrefix || path.startsWith(`${apiPrefix}/`)) {
    request.url = (request.url ?? '').slice(apiPrefix.length) || '/';
    const parts = request.url.split('?')[0].split('/').filter(Boolean);
    const isHabits = parts[0] === 'limits' || (parts[0] === 'users' && parts[2] === 'habits');
    return isHabits ? habits(request, response) : profiles.handle(request, response);
  }
  if (path === '/interview' || path.startsWith('/interview/')) return interviewer(request, response);
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
  board = createBoardApp({
    connection: { baseUrl: local + apiPrefix, token },
    publicOrigin,
    allowedOrigins: new Set(envList('ALLOWED_ORIGINS')),
    data: () => live.current(),
    dataStatus: () => live.status(),
  });
  if (liveEnabled) {
    // Pre-cache every source once, then keep refreshing in the background. Failures keep the last good copy.
    void live.warm().then(() => live.start());
  }
  // Outside production the demo feed for user-001 runs unless DEMO_BANK_USERS says otherwise.
  // With Banc Demo running, user-001 gets movements from it; the in-process feed would double them.
  const demoUsers =
    process.env.DEMO_BANK_USERS === undefined && process.env.NODE_ENV !== 'production' && !demoBankOn
      ? ['user-001']
      : envList('DEMO_BANK_USERS');
  for (const id of demoUsers) {
    await profiles.bankRuntime.configure(id, { enabled: true, intervalMs: envInteger('DEMO_BANK_INTERVAL_MS', 5000) });
    await profiles.bankRuntime.tick(id);
  }
  if (demoBankOn) {
    try {
      demoBank = await startDemoBankFromEnv();
      await connectDemoBank({
        bankUrl: demoBank.url,
        bankApiKey: process.env.BANK_DEMO_BANK_API_KEY ?? '',
        relocatApiUrl: local + apiPrefix,
        relocatToken: token,
        expectedSecret: process.env.BANK_DEMO_BANK_WEBHOOK_SECRET,
      });
      console.log(
        '  Banc Demo %s (fictional bank, webhooks to %s%s/webhooks/bank/demo-bank)',
        demoBank.url,
        local,
        apiPrefix,
      );
    } catch (error) {
      console.warn('Banc Demo did not start: %s', error instanceof Error ? error.message : 'unknown error');
    }
  }
  console.log('%s server: %s', product.name, publicOrigin ?? local);
  console.log('  board    %s/preview', local);
  console.log('  workspace %s/workspace?user=user-001&towns=250404,252542,251207', local);
  console.log('  interview %s/interview/', local);
  console.log('  connect  %s/connect', local);
  console.log('  MCP      %s/mcp', local);
  console.log('  API      %s%s (bearer token, server-side only)', local, apiPrefix);
});

// A failure in background work (a bank sync, a source refresh) is logged and must not stop the server.
process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason.message : 'unknown error');
});
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error.message);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    live.stop();
    void demoBank?.close();
    void profiles.close().then(() => server.close());
  });
}
