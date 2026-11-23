import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { loadBankRegistry } from '../../packages/banks/registry.ts';
import { createVault, parseDataKey } from '../../packages/banks/vault.ts';
import {
  accessConfig,
  clientAddressConfig,
  clientAddressProblem,
  dataEncryptionKey,
  defaultPorts,
  demoBankConfig,
  demoBankEnabled,
  demoBankMountPath,
  envInteger,
  envList,
  envPort,
  envString,
  envText,
  openaiModels,
  publicOriginConfig,
  rateLimitConfig,
  storageConfig,
} from '../../packages/config/env.ts';
import { product } from '../../packages/config/product.ts';
import { open, readMeta, writeMeta } from '../../packages/db/database.ts';
import { importLegacyJson } from '../../packages/db/legacy.ts';
import { seedDemoStories } from '../../packages/profiles/demo-stories.ts';
import { seedRuntime } from '../../packages/profiles/store.ts';
import { createLiveData } from '../../packages/sources/live.ts';
import { connectDemoBank } from '../demo-bank/connect.ts';
import { startDemoBankFromEnv } from '../demo-bank/server.ts';
import { createInterviewerHandler, interviewerEnv } from '../interviewer/server.ts';
import { createApp } from './app.ts';

/**
 * The one ReloCat server. Everything is served from a single origin:
 *
 *   /mcp            MCP endpoint for ChatGPT and other agents (OAuth for personal tools)
 *   /signup /login /account /oauth/*   accounts, consent and the OAuth endpoints
 *   /preview        journey board         /connect   homepage and agent setup
 *   /workspace      the React workspace   /interview/  voice and guided interview
 *   /api/...        profiles, inputs, bank ledger, bank events and habits (admin token or own credential)
 *   /banc-demo/...  the consent page of Banc Demo, the fictional bank, while it runs (DEMO_BANK)
 *   /health         readiness
 *
 * Runtime state (accounts, profiles, inputs, ledgers, bank connections, habits, board runs) lives in
 * one SQLite database, `DATABASE_FILE`. This process opens it once and hands it to `createApp`
 * (`app.ts`), which holds the routing and the identity rule.
 *
 * Locally that origin is http://127.0.0.1:8787; in production it is https://www.relo.cat.
 */

// An empty variable (`HOST=`) is the same as an unset one, so it can never bind every interface by accident.
const host = envText('HOST', '127.0.0.1');
const port = envPort('PORT', defaultPorts.app);
const publicOrigin = publicOriginConfig();
const access = accessConfig();
// The admin token never leaves the server; a random one per start is enough when none is configured.
const token = envString('PROFILE_API_TOKEN') ?? randomUUID();
const apiPrefix = '/api';

// A public deployment that cannot tell its visitors apart does not start: see `clientAddressProblem`.
const addressProblem = clientAddressProblem();
if (addressProblem) {
  console.error(`The server did not start.\n${addressProblem}`);
  process.exit(1);
}
const clientAddress = clientAddressConfig();
const clientAddressMode =
  clientAddress.kind === 'x-forwarded-for'
    ? `X-Forwarded-For, ${clientAddress.trustedHops} trusted prox${clientAddress.trustedHops === 1 ? 'y' : 'ies'}`
    : clientAddress.kind === 'header'
      ? `the ${clientAddress.name} header`
      : clientAddress.kind === 'none'
        ? 'the connecting address (none): all visitors behind one proxy are counted as one'
        : 'auto: the connecting address, or X-Forwarded-For from a proxy on this machine';

const storage = storageConfig();
const db = open(storage.databaseFile);

// Banc Demo: a fictional bank that pushes signed webhooks to /api. Its keyed API (pull, webhook
// registry, simulation) listens on a loopback port of its own; the one page a person opens, the
// consent page, is mounted on this origin under /banc-demo so it is reachable wherever ReloCat is.
// On by default outside production; DEMO_BANK=off returns to the in-process synthetic feed. In
// production it is off unless DEMO_BANK=on says so: a public demo that shows the live fictional bank.
const demoBankOn = demoBankEnabled();
/** The ReloCat user Banc Demo feeds (the default of `connectDemoBank`). */
const demoBankUser = 'user-001';
if (demoBankOn) {
  // The bank registry reads these when the API handler is created, so they are set first.
  process.env.BANK_DEMO_BANK_BASE_URL ||= `http://127.0.0.1:${demoBankConfig().port}`;
  process.env.BANK_DEMO_BANK_API_KEY ||= randomUUID();
  // The bank keeps its webhook subscription across restarts (its snapshot), so the secret it signs
  // with must survive a restart too: a generated one is kept in the database and reused.
  const storedSecret = readMeta(db, 'demo-bank.webhook-secret');
  process.env.BANK_DEMO_BANK_WEBHOOK_SECRET ||= storedSecret ?? randomUUID();
  if (process.env.BANK_DEMO_BANK_WEBHOOK_SECRET !== storedSecret)
    writeMeta(db, 'demo-bank.webhook-secret', process.env.BANK_DEMO_BANK_WEBHOOK_SECRET);
  process.env.DEMO_BANK_SNAPSHOT_FILE ||= 'data/cache/demo-bank.json';
  // The person consents on this origin, and the bank sends them back to it: localhost always, and
  // the public origin and extra hosts this server answers to. Nowhere else.
  process.env.BANK_DEMO_BANK_PUBLIC_PATH ||= demoBankMountPath;
  process.env.DEMO_BANK_RETURN_ORIGINS ||= [
    ...(publicOrigin ? [publicOrigin] : []),
    ...access.allowedHosts.flatMap(name => [`https://${name}`, `http://${name}`]),
  ].join(',');
}
let demoBank: Awaited<ReturnType<typeof startDemoBankFromEnv>> | undefined;

// Bank providers are discovered once here (after the demo bank's variables are set) so the server
// can check what they need before it serves anything.
const bankRegistry = await loadBankRegistry();
// Bank credentials are sealed at rest with DATA_ENCRYPTION_KEY. A bank that people connect by a
// consent hands back something worth protecting, so in production such a bank does not run without
// a key of the operator's own. Outside production a key kept in the database stands in (app.ts).
let dataKey: Buffer | undefined;
try {
  dataKey = parseDataKey(dataEncryptionKey());
} catch (error) {
  console.error(`The server did not start.\n${error instanceof Error ? error.message : 'Invalid DATA_ENCRYPTION_KEY'}`);
  db.close();
  process.exit(1);
}
const consentBanks = bankRegistry.list().filter(bank => bank.consent && bank.status === 'configured');
if (access.production && !dataKey && consentBanks.length) {
  console.error(
    [
      'The server did not start.',
      `DATA_ENCRYPTION_KEY is not set, and ${consentBanks.map(bank => bank.id).join(', ')} is configured: a bank people connect by`,
      'consenting at the bank returns a credential, which is stored encrypted with that key.',
      'Generate one and keep it with your other secrets (losing it means every person connects their bank again):',
      "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
    ].join('\n'),
  );
  db.close();
  process.exit(1);
}

// First start on a machine that ran the JSON-file version: bring that state in once. The files stay.
const legacy = await importLegacyJson(db, {
  profileDir: resolve(storage.legacyProfileDir),
  habitsDir: resolve(storage.legacyHabitsDir),
});
if (legacy.status === 'imported') {
  const { users, bank_transactions: movements, bank_connections: connections } = legacy.counts;
  console.log(
    'Imported the JSON runtime files into %s: %d users, %d movements, %d bank connections. The files were left in place.',
    storage.databaseFile,
    users,
    movements,
    connections,
  );
  for (const { path, reason } of legacy.skipped) console.warn('  not imported: %s (%s)', path, reason);
}

// Committed fixtures fill in demo personas that do not exist yet; an existing user's edits are never overwritten.
const fixtures = resolve('data/users');
if (existsSync(fixtures)) {
  const { skipped } = await seedRuntime(fixtures, db);
  for (const { id, reason } of skipped) console.warn('Fixture %s was not seeded: %s', id, reason);
  // The demo personas also get their story (confirmed answers and habits); a person with an account is never written.
  const stories = await seedDemoStories(db, { fixtures, ids: access.demoUserIds });
  for (const { id, reason } of stories.skipped) console.warn('Demo story of %s was not seeded: %s', id, reason);
}

// Official data: the committed snapshot is the baseline; fresher cached values are overlaid on it.
const live = createLiveData({ cacheDir: resolve(envText('DATA_CACHE_DIR', 'data/cache')) });
const liveEnabled = process.env.LIVE_DATA !== 'off';

let boundPort = port;
const app = createApp({
  db,
  adminToken: token,
  publicOrigin,
  port: () => boundPort,
  access,
  allowedOrigins: new Set(envList('ALLOWED_ORIGINS')),
  data: () => live.current(),
  dataStatus: () => live.status(),
  // Voice and guided interview. Its paid OpenAI routes stay local-only unless explicitly enabled.
  interviewer: createInterviewerHandler({ prefix: '/interview', publicOrigin, ...interviewerEnv() }),
  // The bank starts after this server listens, so its handler is looked up per request.
  demoBank: demoBankOn
    ? {
        path: demoBankMountPath,
        handle: (request, response, basePath) => {
          if (demoBank) return demoBank.bank.handleCustomer(request, response, basePath);
          response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
          response.end(JSON.stringify({ error: 'Banc Demo (fictional bank) is not running' }));
        },
      }
    : undefined,
  health: () => ({
    product: product.name,
    version: product.version,
    snapshot: live.current().snapshot.version,
    liveData: liveEnabled,
    database: { schemaVersion: db.schemaVersion },
    sources: live.status().map(({ id, status, fetchedAt, applied }) => ({ id, status, fetchedAt, applied })),
  }),
  rateLimit: { ...rateLimitConfig(), trustProxy: process.env.TRUST_PROXY === 'on' },
  profileApi: { bankRegistry },
  vault: dataKey && createVault(dataKey),
  habits: {
    dailyCalls: envInteger('HABITS_DAILY_AI_CALLS', 20),
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: openaiModels().habits,
      maxOutputTokens: envInteger('HABITS_MAX_OUTPUT_TOKENS', 1024),
    },
  },
});
const { profiles } = app;

const server = createServer(app.handle);

// A port that is taken, or an address that cannot be bound, is a failed start: say so and exit non-zero.
server.once('error', (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${port} on ${host} is already in use. Stop the other process or set PORT.`
      : `The server could not start: ${error.message}`,
  );
  db.close();
  process.exit(1);
});

server.listen(port, host, async () => {
  const address = server.address();
  boundPort = address && typeof address === 'object' ? address.port : port;
  const local = `http://127.0.0.1:${boundPort}`;
  if (liveEnabled) {
    // Pre-cache every source once, then keep refreshing in the background. Failures keep the last good copy.
    void live.warm().then(() => live.start());
  }
  // Outside production the in-process demo feed for user-001 runs unless DEMO_BANK_USERS says otherwise.
  // A user Banc Demo feeds never gets it as well, whether the list is the default or explicit: two
  // fictional banks writing one ledger would double every movement.
  // Unset means the default; set and empty (`DEMO_BANK_USERS=`) means nobody.
  const configured = process.env.DEMO_BANK_USERS;
  const requested = configured === undefined ? (access.production ? [] : [demoBankUser]) : envList('DEMO_BANK_USERS');
  const demoUsers = requested.filter(id => !(demoBankOn && id === demoBankUser));
  if (configured !== undefined && demoUsers.length !== requested.length)
    console.warn('  The in-process feed for %s is off: Banc Demo already feeds that user.', demoBankUser);
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
        userId: demoBankUser,
        // A subscription the bank kept from an earlier start is moved to the secret this start verifies with.
        expectedSecret: process.env.BANK_DEMO_BANK_WEBHOOK_SECRET,
      });
      console.log(
        '  Banc Demo %s (fictional bank, webhooks to %s%s/webhooks/bank/demo-bank)',
        demoBank.url,
        local,
        apiPrefix,
      );
      console.log(
        '  Banc Demo consent page %s%s/consent/<id> (a person never needs port %d)',
        publicOrigin ?? local,
        demoBankMountPath,
        demoBankConfig().port,
      );
      if (access.production)
        console.warn(
          '  DEMO_BANK=on in production: Banc Demo is a FICTIONAL bank with synthetic data only. It feeds %s and anyone ' +
            'signed in can link one of its invented customers; every page and record says it is fictional.',
          demoBankUser,
        );
    } catch (error) {
      console.warn('Banc Demo did not start: %s', error instanceof Error ? error.message : 'unknown error');
    }
  }
  console.log('%s server: %s', product.name, publicOrigin ?? local);
  console.log('  board     %s/preview', local);
  console.log('  workspace %s/workspace', local);
  console.log('  account   %s/signup  %s/login', local, local);
  console.log('  interview %s/interview/', local);
  console.log('  connect   %s/connect', local);
  console.log('  MCP       %s/mcp (OAuth issuer %s)', local, app.origin());
  console.log('  API       %s%s (admin token, or a person’s own credential)', local, apiPrefix);
  console.log(
    '  public demo %s (%s) · shared board %s',
    access.publicDemo ? 'on' : 'off',
    access.demoUserIds.join(', '),
    access.sharedBoard ? 'on' : 'off',
  );
  // What a proxy in front has to match: the origin forms are checked against, and where addresses come from.
  console.log(
    '  origin    %s (forms and OAuth are checked against it; accepted Host: %s)',
    app.origin(),
    [publicOrigin ? new URL(publicOrigin).host : null, `localhost:${boundPort}`, ...access.allowedHosts]
      .filter(Boolean)
      .join(', '),
  );
  console.log('  client address from %s', clientAddressMode);
  console.log(
    '  rate limit %d requests a minute per address · bank credentials sealed with %s',
    rateLimitConfig().perMinute,
    dataKey
      ? 'DATA_ENCRYPTION_KEY'
      : access.production
        ? 'nothing: no bank that needs a consent is configured'
        : 'a development key kept in the database (set DATA_ENCRYPTION_KEY for anything real)',
  );
  if (publicOrigin)
    console.log(
      '  A reverse proxy must pass the original Host header (%s), or every form answers 403.',
      new URL(publicOrigin).host,
    );
  if (access.production && !publicOrigin)
    console.warn('  PUBLIC_ORIGIN is not set: sign-in links and OAuth metadata point at %s.', local);
});

// A failure in background work (a bank sync, a source refresh) is logged and must not stop the server.
process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason.message : 'unknown error');
});
// After an uncaught exception the process is in an unknown state: log it and exit non-zero so a
// supervisor restarts a clean one instead of serving from a broken one.
process.on('uncaughtException', error => {
  console.error('Uncaught exception, exiting:', error.message);
  try {
    db.close();
  } catch {
    // Exiting anyway.
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    live.stop();
    void demoBank?.close();
    // Order matters: the bank engine finishes its writes, the HTTP server stops, then the database closes.
    void app
      .close()
      .catch(() => {})
      .then(() => {
        server.close(() => db.close());
        server.closeIdleConnections();
      });
  });
}
