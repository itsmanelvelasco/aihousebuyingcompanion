import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { z } from 'zod';
import { safeId } from '../../packages/contracts/ids.ts';
import { analyzeTransactions, periodSchema, scenarioSchema, simulateSavings } from '../../packages/finance/cashflow.ts';
import { ApiError, pathParts, readJson, sendJson as reply, requireBearer } from '../../packages/http/server.ts';
import type { Section } from '../../packages/profiles/store.ts';
import { createStore, profileSchema, sections } from '../../packages/profiles/store.ts';
import { accountBalances, createBankStore, dateSchema } from './bank.ts';
import { createInputStore } from './inputs.ts';
import { createBankRuntime } from './runtime.ts';

const body = (req: Parameters<typeof readJson>[0]) => readJson(req, 262_144, 'Body exceeds 256 KiB');

/** The profile, inputs and bank routes as a request handler, so one server can mount them under a prefix. */
export function createProfileApiHandler(root: string, token: string) {
  if (!token) throw new Error('PROFILE_API_TOKEN is required');
  const store = createStore(root);
  const bank = createBankStore(root);
  const inputs = createInputStore(root);
  const runtime = createBankRuntime(bank);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      requireBearer(req, token);
      const parts = pathParts(req);
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      if (parts[0] !== 'users' || parts.length > 5) throw new ApiError(404, 'Route not found');
      if (parts.length === 1) {
        if (req.method === 'GET') return reply(res, 200, { users: await store.list() });
        if (req.method === 'POST') {
          const data = profileSchema.parse(await body(req));
          const id = safeId.parse(data.details.id);
          return reply(res, 201, await store.create(id, data));
        }
      } else {
        const id = safeId.parse(parts[1]);
        if (parts[2] === 'context' && parts.length === 3) {
          if (req.method !== 'GET') throw new ApiError(405, 'Method not allowed');
          return reply(res, 200, await inputs.context(id));
        }
        if (parts[2] === 'inputs') {
          if (parts.length === 3 && req.method === 'GET') return reply(res, 200, await inputs.read(id));
          if (parts.length === 3 && req.method === 'POST')
            return reply(res, 200, await inputs.add(id, await body(req)));
          if (parts.length === 4) {
            const inputId = safeId.parse(parts[3]);
            if (req.method === 'PUT') return reply(res, 200, await inputs.replace(id, inputId, await body(req)));
            if (req.method === 'DELETE') return reply(res, 200, await inputs.delete(id, inputId));
          }
          throw new ApiError(405, 'Method not allowed');
        }
        if (parts[2] === 'bank') {
          const route = parts[3];
          const itemId = parts[4] === undefined ? undefined : safeId.parse(parts[4]);
          if (route === 'events' && parts.length === 4 && req.method === 'GET') {
            const after = z.coerce
              .number()
              .int()
              .nonnegative()
              .safe()
              .parse(query.get('after') ?? 0);
            const limit = z.coerce
              .number()
              .int()
              .min(1)
              .max(100)
              .parse(query.get('limit') ?? 50);
            return reply(res, 200, await bank.events(id, after, limit));
          }
          if (route === 'runtime') {
            if (parts.length === 4 && req.method === 'GET') return reply(res, 200, await runtime.status(id));
            if (parts.length === 4 && req.method === 'POST')
              return reply(res, 200, await runtime.configure(id, await body(req)));
            if (parts.length === 5 && itemId === 'tick' && req.method === 'POST') {
              z.object({})
                .strict()
                .parse(await body(req));
              return reply(res, 200, await runtime.tick(id));
            }
          }
          if (route === 'demo' && parts.length === 4 && req.method === 'POST') {
            z.object({})
              .strict()
              .parse(await body(req));
            const outcome = await bank.seedDemo(id);
            return reply(res, 201, { ...outcome.result, updatedAt: outcome.ledger.updatedAt, synthetic: true });
          }
          if (route === 'accounts') {
            if (parts.length === 4 && req.method === 'GET') {
              const ledger = await bank.read(id);
              const asOf = dateSchema.parse(query.get('asOf') ?? new Date().toISOString().slice(0, 10));
              return reply(res, 200, {
                synthetic: true,
                updatedAt: ledger.updatedAt || null,
                accounts: accountBalances(ledger, asOf),
              });
            }
            if (parts.length === 4 && req.method === 'POST')
              return reply(res, 201, (await bank.createAccount(id, await body(req))).result);
            if (parts.length === 5 && req.method === 'PUT')
              return reply(res, 200, (await bank.updateAccount(id, itemId!, await body(req))).result);
          } else if (route === 'transactions') {
            if (parts.length === 4 && req.method === 'POST')
              return reply(res, 200, (await bank.importTransactions(id, await body(req))).result);
            if (parts.length === 5 && req.method === 'PUT')
              return reply(res, 200, (await bank.updateTransaction(id, itemId!, await body(req))).result);
            if (parts.length === 5 && req.method === 'DELETE')
              return reply(res, 200, (await bank.deleteTransaction(id, itemId!)).result);
            if (parts.length === 4 && req.method === 'GET') {
              const ledger = await bank.read(id);
              const from = query.has('from') ? dateSchema.parse(query.get('from')) : undefined;
              const to = query.has('to') ? dateSchema.parse(query.get('to')) : undefined;
              if (from && to && from > to) throw new ApiError(400, 'from must not follow to');
              const accountId = query.has('accountId') ? safeId.parse(query.get('accountId')) : undefined;
              if (accountId && !ledger.accounts.some(account => account.id === accountId))
                throw new ApiError(404, 'Account not found');
              const limit = z.coerce
                .number()
                .int()
                .min(1)
                .max(500)
                .parse(query.get('limit') ?? 100);
              const offset = z.coerce
                .number()
                .int()
                .min(0)
                .max(10000)
                .parse(query.get('offset') ?? 0);
              const transactions = ledger.transactions
                .filter(
                  tx =>
                    (!from || tx.date >= from) && (!to || tx.date <= to) && (!accountId || tx.accountId === accountId),
                )
                .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
              return reply(res, 200, {
                synthetic: true,
                updatedAt: ledger.updatedAt || null,
                total: transactions.length,
                offset,
                limit,
                transactions: transactions.slice(offset, offset + limit),
              });
            }
          } else if ((route === 'summary' && req.method === 'GET') || (route === 'simulate' && req.method === 'POST')) {
            if (parts.length !== 4) throw new ApiError(404, 'Route not found');
            const { from, to } = periodSchema.parse({ from: query.get('from'), to: query.get('to') });
            const ledger = await bank.read(id);
            const summary = analyzeTransactions(ledger.transactions, from, to);
            const result =
              route === 'simulate' ? simulateSavings(summary, scenarioSchema.parse(await body(req))) : summary;
            return reply(res, 200, { ...result, ledgerUpdatedAt: ledger.updatedAt || null });
          }
          if (!['accounts', 'transactions', 'summary', 'simulate', 'demo', 'runtime', 'events'].includes(route ?? ''))
            throw new ApiError(404, 'Bank route not found');
          throw new ApiError(405, 'Method not allowed');
        }
        if (parts.length > 3) throw new ApiError(404, 'Route not found');
        if (parts.length === 2 && req.method === 'GET') {
          const values = await Promise.all(sections.map(async s => [s, await store.read(id, s)]));
          return reply(res, 200, Object.fromEntries(values));
        }
        if (parts.length === 3) {
          if (!sections.includes(parts[2] as Section)) throw new ApiError(404, 'Section not found');
          const section = parts[2] as Section;
          if (req.method === 'GET') return reply(res, 200, await store.read(id, section));
          if (req.method === 'PUT') return reply(res, 200, await store.write(id, section, await body(req)));
        }
      }
      throw new ApiError(405, 'Method not allowed');
    } catch (error) {
      if (error instanceof ApiError) return reply(res, error.status, { error: error.message });
      if (error instanceof z.ZodError) return reply(res, 400, { error: 'Invalid request data', issues: error.issues });
      reply(res, 500, { error: 'Profile storage failure' });
    }
  };
  return { handle, bankRuntime: runtime, bank };
}

/** The same API as a standalone HTTP server; used by tests and tools that want an isolated instance. */
export function createProfileApi(root: string, token: string) {
  const api = createProfileApiHandler(root, token);
  const server = createServer(api.handle);
  server.on('close', () => {
    void api.bankRuntime.close();
  });
  return Object.assign(server, { bankRuntime: api.bankRuntime });
}
