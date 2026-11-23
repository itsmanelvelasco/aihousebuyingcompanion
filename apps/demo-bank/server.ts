import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { z } from 'zod';
import { demoBankConfig } from '../../packages/config/env.ts';
import {
  ApiError,
  pageHeaders,
  pathParts,
  readForm,
  readJson,
  redirect,
  requireBearer,
  sendJson,
} from '../../packages/http/server.ts';
import { requestLocale } from '../../packages/i18n/server.ts';
import type { DemoBankCoreOptions } from './bank.ts';
import { createDemoBankCore } from './bank.ts';
import { createConsentDesk } from './consent.ts';

/**
 * Banc Demo, a fictional neobank with a business-style API. It runs as its own process on its own
 * port and knows nothing about ReloCat: ReloCat reaches it over HTTP through the one provider file
 * `packages/banks/providers/demo-bank.ts`, exactly as it would reach a real bank.
 *
 *   Pull   GET /customers, /customers/:id/accounts, /customers/:id/transactions[/:transactionId]
 *   Push   POST|GET /webhooks, DELETE /webhooks/:id, PUT /webhooks/:id/secret, GET /webhooks/deliveries
 *   Consent  POST /consents, POST /consents/token   (API key)
 *            GET|POST /consent/:id                  (the customer's browser; see consent.ts)
 *   Demo   GET /simulate/status, POST /simulate/step, /simulate/transaction,
 *          /simulate/transactions/:id/state            (admin key)
 *
 * It is a demo: a single process with a rolling window of transactions in memory (and an optional
 * JSON snapshot), no database and no real money. Every response carries `X-Demo-Bank: fictional` and every resource
 * `synthetic: true`. See README.md in this folder.
 */

export type DemoBankOptions = DemoBankCoreOptions & {
  /** Bearer key of the pull and webhook routes. */
  apiKey: string;
  /** Bearer key of the `/simulate` routes. Defaults to `apiKey`. */
  adminKey?: string;
  /** Days an approved consent lasts. Default 90. */
  consentDays?: number;
};

const listQuery = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/, 'Use YYYY-MM-DD or a UTC timestamp with milliseconds')
      .optional(),
    cursor: z.string().min(1).max(400).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    account_id: z.string().min(1).max(64).optional(),
  })
  .strict();
const deliveriesQuery = z
  .object({
    state: z.enum(['pending', 'delivered', 'dead']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
const stepBody = z.object({ count: z.number().int().min(1).max(500).optional() }).strict();
const stateBody = z.object({ state: z.enum(['completed', 'declined', 'reverted']) }).strict();
const id = z.string().regex(/^[a-z0-9-]{1,64}$/, 'Invalid identifier');

/**
 * The bank as a request handler plus its lifecycle. Pass `clock`, `seed` and `startDate` to make it
 * deterministic, leave `intervalMs` unset to step it by hand with `step()`.
 */
export function createDemoBank(options: DemoBankOptions) {
  if (!options.apiKey) throw new Error('The demo bank needs an API key');
  const adminKey = options.adminKey || options.apiKey;
  const bank = createDemoBankCore(options);
  const consents = createConsentDesk({
    clock: options.clock,
    customers: () => bank.listCustomers(),
    allowRemote: options.allowRemoteWebhooks,
    consentDays: options.consentDays,
  });

  async function route(request: IncomingMessage, response: ServerResponse) {
    const parts = pathParts(request);
    const method = request.method ?? 'GET';
    const query = Object.fromEntries(new URLSearchParams((request.url ?? '').split('?')[1] ?? ''));
    const body = () => readJson(request, 16_384, 'Body exceeds 16 KiB');
    if (parts.length === 1 && parts[0] === 'health' && method === 'GET')
      return sendJson(response, 200, { status: 'ok', service: 'demo-bank', synthetic: true });
    await bank.ready;

    if (parts[0] === 'simulate') {
      requireBearer(request, adminKey);
      if (parts.length === 2 && parts[1] === 'status' && method === 'GET')
        return sendJson(response, 200, bank.status());
      if (parts.length === 2 && parts[1] === 'step' && method === 'POST') {
        const { count } = stepBody.parse(await body());
        const transactions = await bank.step(count ?? 1);
        return sendJson(response, 200, {
          synthetic: true,
          transactions,
          simulation_time: bank.status().simulation_time,
        });
      }
      if (parts.length === 2 && parts[1] === 'transaction' && method === 'POST')
        return sendJson(response, 201, { synthetic: true, transactions: await bank.simulate(await body()) });
      if (parts.length === 4 && parts[1] === 'transactions' && parts[3] === 'state' && method === 'POST') {
        const { state } = stateBody.parse(await body());
        return sendJson(response, 200, await bank.changeState(id.parse(parts[2]), state));
      }
      throw new ApiError(404, 'Route not found');
    }

    // The customer's own browser: no API key. The unguessable consent id is what admits them.
    if (parts[0] === 'consent' && parts.length === 2) {
      const consentId = z
        .string()
        .regex(/^consent-[0-9a-f]{32}$/, 'Invalid identifier')
        .parse(parts[1]);
      if (method === 'GET') {
        // The language of the customer's browser, or the one the page's own links ask for (`?lang=`).
        const { locale } = requestLocale(request);
        const page = consents.page(consentId, locale, true);
        return void response
          .writeHead(200, {
            ...pageHeaders([page.formAction]),
            'Content-Language': locale,
            Vary: 'Accept-Language, Cookie',
          })
          .end(page.html);
      }
      if (method === 'POST') return redirect(response, consents.decide(consentId, await readForm(request)));
      throw new ApiError(405, 'Method not allowed');
    }

    requireBearer(request, options.apiKey);
    if (parts[0] === 'consents') {
      if (method !== 'POST') throw new ApiError(405, 'Method not allowed');
      if (parts.length === 1) return sendJson(response, 201, consents.create(await body()));
      if (parts.length === 2 && parts[1] === 'token') return sendJson(response, 200, consents.exchange(await body()));
      throw new ApiError(404, 'Route not found');
    }
    if (parts[0] === 'customers') {
      if (method !== 'GET') throw new ApiError(405, 'Method not allowed');
      if (parts.length === 1) return sendJson(response, 200, { synthetic: true, customers: bank.listCustomers() });
      const customerId = id.parse(parts[1]);
      if (parts.length === 3 && parts[2] === 'accounts')
        return sendJson(response, 200, { synthetic: true, accounts: bank.listAccounts(customerId) });
      if (parts.length === 3 && parts[2] === 'transactions') {
        const { account_id: accountId, ...rest } = listQuery.parse(query);
        return sendJson(response, 200, bank.listTransactions(customerId, { ...rest, accountId }));
      }
      if (parts.length === 4 && parts[2] === 'transactions')
        return sendJson(response, 200, bank.getTransaction(customerId, id.parse(parts[3])));
      throw new ApiError(404, 'Route not found');
    }
    if (parts[0] === 'webhooks') {
      if (parts.length === 1 && method === 'POST') return sendJson(response, 201, bank.subscribe(await body()));
      if (parts.length === 1 && method === 'GET')
        return sendJson(response, 200, { synthetic: true, webhooks: bank.listSubscriptions() });
      if (parts.length === 2 && parts[1] === 'deliveries' && method === 'GET')
        return sendJson(response, 200, {
          synthetic: true,
          deliveries: bank.listDeliveries(deliveriesQuery.parse(query)),
        });
      if (parts.length === 2 && method === 'DELETE')
        return sendJson(response, 200, bank.unsubscribe(id.parse(parts[1])));
      if (parts.length === 3 && parts[2] === 'secret' && method === 'PUT')
        return sendJson(response, 200, bank.rotateSecret(id.parse(parts[1]), await body()));
      throw new ApiError(parts.length <= 2 ? 405 : 404, parts.length <= 2 ? 'Method not allowed' : 'Route not found');
    }
    throw new ApiError(404, 'Route not found');
  }

  /** Answer one request. Errors become JSON; nothing thrown here can stop the process. */
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('X-Demo-Bank', 'fictional');
    try {
      await route(request, response);
    } catch (error) {
      if (response.headersSent) return void response.destroy();
      if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
      if (error instanceof z.ZodError)
        return sendJson(response, 400, { error: 'Invalid request data', issues: error.issues });
      sendJson(response, 500, { error: 'Demo bank failure' });
    }
  }

  return {
    handle,
    ready: bank.ready,
    start: bank.start,
    close: bank.close,
    step: bank.step,
    simulate: bank.simulate,
    changeState: bank.changeState,
    flushDeliveries: bank.flushDeliveries,
    status: bank.status,
    listDeliveries: bank.listDeliveries,
    consents,
  };
}

export type DemoBank = ReturnType<typeof createDemoBank>;

/**
 * Start the bank on a port of this machine and begin its real-time loop. Resolves when it listens.
 * Used by the standalone entry point below; a launcher can call it to run the bank next to ReloCat.
 */
export async function startDemoBank(options: DemoBankOptions & { port: number; host?: string }) {
  const bank = createDemoBank(options);
  await bank.ready;
  const server = createServer((request, response) => void bank.handle(request, response));
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port, host, done);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : options.port;
  await bank.start();
  return {
    bank,
    server,
    url: `http://${host}:${port}`,
    /** Stop the loop, write the snapshot and close the listener. */
    async close() {
      await bank.close();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
}

/**
 * Start the bank from environment variables (see `demoBankConfig`). Throws when no API key is set,
 * because a bank nobody can authenticate against is useless and a default key would be a secret in
 * the source.
 */
export function startDemoBankFromEnv(env: Record<string, string | undefined> = process.env) {
  const config = demoBankConfig(env);
  if (!config.apiKey) throw new Error('Banc Demo needs an API key: set DEMO_BANK_API_KEY or BANK_DEMO_BANK_API_KEY');
  return startDemoBank({
    apiKey: config.apiKey,
    adminKey: config.adminKey,
    signingSecret: config.webhookSecret,
    port: config.port,
    seed: config.seed,
    startDate: config.startDate,
    customers: config.customers,
    intervalMs: config.intervalMs,
    snapshotFile: config.snapshotFile && resolve(config.snapshotFile),
    allowRemoteWebhooks: config.allowRemoteWebhooks,
  });
}

if (import.meta.main) {
  try {
    const running = await startDemoBankFromEnv();
    const status = running.bank.status();
    console.log('Banc Demo (fictional bank, synthetic data only): %s', running.url);
    console.log('  %d customers, %d transactions since %s', status.customers, status.transactions, status.start_date);
    console.log('  one simulated movement every %d ms; keys are read from the environment', status.interval_ms);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void running.close());
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Banc Demo could not start');
    process.exit(1);
  }
}
