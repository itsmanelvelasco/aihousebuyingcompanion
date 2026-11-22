# Synthetic bank and runtime events area

**Owner:** bank/finance backend team. **Purpose:** produce and manage fictional movements, expose freshness/events and calculate explainable financial summaries.

## Entry points

- `apps/profile-api/bank.ts`: accounts, ledger persistence and movement CRUD/import.
- `packages/finance/cashflow.ts`: deterministic cash flow, recurring candidates and savings scenarios.
- `packages/banks/provider.ts`: the `BankProvider` contract a bank implements, plus helpers for IDs, cents and signatures.
- `packages/banks/providers/`: one file per bank, discovered by `packages/banks/registry.ts`. `synthetic.ts` is the in-process demo feed, `demo-bank.ts` connects to the Banc Demo service and is the worked example, `_template.ts` is the skeleton to copy.
- `apps/demo-bank/`: Banc Demo, a fictional bank that runs as its own process (pull API, signed webhooks with retries, a scripted simulation). See its [README](../../apps/demo-bank/README.md).
- `packages/banks/sync.ts`: connections per user, pull-and-import, polling, the persistent webhook queue, retries with backoff, the fallback pull and the in-process event emitter. Also the person's own path: consents at the bank (single-use state bound to the person and their browser session), sealed credentials, expiry and renewal.
- `packages/banks/vault.ts`: AES-256-GCM sealing of what a consent returns, the keyed fingerprint that stands in for a bank reference, and the development key.
- `apps/profile-api/statements.ts`: a person's statement import, as preview then confirm.
- `packages/db/bank-person.ts` and `packages/db/person-data.ts`: queries for credentials, consents and imports, and the one list of person-owned tables that export and deletion share.
- `apps/profile-api/runtime.ts`: the `/runtime` routes, expressed as a synthetic-provider connection polled by the sync engine.
- `apps/profile-api/server.ts`: authenticated bank routes, the bank webhook route, the event stream and runtime wiring.
- `apps/mcp-server/bank-tools.ts`: the MCP tools: read-only aggregates, and the signed-in person's own bank actions (connect, sync, import a statement). No tool returns a movement.
- `apps/server/account-routes.ts` and `apps/server/pages.ts`: the bank section of `/account` and the consent callback `/bank/consent/callback`.
- [BANK_API.md](../../apps/profile-api/BANK_API.md): account/movement formats and scenario examples.

## Data flow and boundaries

Runtime data belongs in the ledger tables of the runtime database (`bank_accounts`, `bank_transactions`, `bank_events`; schema in `packages/db/schema.ts`), separate from the original bank snapshot. A change, its revision and its event are one transaction. Integer EUR cents are authoritative. Booked movements affect balances; income/spending summaries exclude pending movements and transfers between owned accounts. Recurring charges are candidates to confirm, not automatic subscription cancellations.

The background synthetic producer is the `synthetic` provider, polled by the sync engine inside the profile API. Providers never write: the engine imports their rows through the ledger store. Ledger changes carry durable revisions and a retained event log. Event consumers must retain their cursor and request a full refresh when `requiresRefresh` reports a retention/reset gap; the ledger retains the latest 500 events. MCP readers poll through `get_bank_updates`, `get_bank_runtime` and `get_bank_summary`; they do not open a real bank connection, execute payments or send proactive ChatGPT messages.

| Route below `/users/:id/bank` | Purpose |
| --- | --- |
| `GET /events?after=0&limit=50` | Read persisted revision events and the next cursor. |
| `GET /runtime` | Read enabled state, interval, ticks and latest error. |
| `POST /runtime` with `{ "enabled": true, "intervalMs": 5000 }` | Start/stop the user's simulated feed; interval range is 1000–60000 ms. |
| `POST /runtime/tick` with `{}` | Produce one simulated tick without requiring an enabled timer. |
| `GET /connections`, `POST /connections`, `DELETE /connections/:connectionId` | List, create and remove the user's provider connections. |
| `POST /sync` with `{}` or `{ "connectionId": "..." }` | Pull from the user's providers now. |
| `GET /events/stream?after=0` | Server-Sent Events: each new revision event, with heartbeats. |

A signed-in person reaches these for their own id with their own credential, plus the routes of [A person's own bank data](../../apps/profile-api/BANK_API.md#a-persons-own-bank-data): `GET /banks`, `GET /consents`, `POST /imports/preview`, `POST`/`GET /imports`, `DELETE /imports/:importId`, `PATCH /transactions/:transactionId` and `GET /users/:id/export`. For a person, `POST /connections` takes `{ "providerId" }` only, and `/runtime`, `/demo`, `POST /accounts` and `POST`/`PUT /transactions` stay with the operator.

Two routes sit outside the user prefix: `GET /bank/providers` lists providers as `configured` or `unconfigured` (bearer token), and `POST /webhooks/bank/:providerId` is called by a bank, carries no bearer token and is accepted only when the provider's `verifyWebhook` passes. A webhook only schedules a sync; its body is never stored.

The engine assumes an unreliable peer. A verified webhook is committed to the `bank_webhook_queue` table before it is acknowledged and processed afterwards, so one that arrives during a sync or just before a restart is not lost; repeated event IDs are ignored. A failed sync records `lastError`, `lastAttemptAt` and `consecutiveFailures` on the connection and is retried with exponential backoff without crashing the process. A provider with webhooks is still pulled after five silent minutes. Details are in [BANK_API.md](../../apps/profile-api/BANK_API.md#bank-providers-connections-and-live-events).

## Add a bank

`packages/banks/providers/demo-bank.ts` is the worked example of "add a bank = one file": it reaches the separate Banc Demo service over HTTP only and shows cursor pagination, decimal amounts, pending-to-completed updates, declined movements, own-account transfers, a signed webhook with a timestamp window and event IDs. `npm run dev` starts and connects it outside production, inventing the three variables `BANK_DEMO_BANK_BASE_URL`, `BANK_DEMO_BANK_API_KEY` and `BANK_DEMO_BANK_WEBHOOK_SECRET` when they are unset. To run the bank as its own process, set them, set `DEMO_BANK=off` and use `npm run start:demo-bank`, `npm run dev` and `npm run demo-bank:connect`.

Copy `packages/banks/providers/_template.ts` to a new file in the same folder; no registration is needed. Implement `listAccounts` and `fetchTransactions` (and `verifyWebhook` plus `parseWebhook` when the bank can call us, otherwise set `pollIntervalMs`; and `consent` when people authorise access at the bank, without which only the operator can link it). Declare variables as `BANK_<PROVIDER_ID>_<NAME>` in the provider's `env` list and in `.env.example`; a provider with a missing required variable is listed as `unconfigured`. Return integer EUR cents, ledger categories and stable IDs. Details and response shapes are in [BANK_API.md](../../apps/profile-api/BANK_API.md#add-a-bank).

Every account and movement carries the `synthetic` flag of its provider. Ledgers, events, summaries and API responses report `synthetic: true` only when every record behind them is synthetic, and a record without the flag is rejected, never assumed. A provider declared `synthetic: false` can connect and sync. The consent flow, credentials sealed at rest (`DATA_ENCRYPTION_KEY`) and per-person authorization exist and are exercised against the fictional Banc Demo; what a real bank still needs is listed in [BANK_API.md](../../apps/profile-api/BANK_API.md#what-a-production-bank-still-needs). Do not ship a provider for a real bank from guessed API shapes.

Keep one API handler as the ledger's writer. Providers, the in-process producer and statement imports go through its ledger store; the MCP tools reach it through handles bound to one person (`apps/server/people.ts`), never by a user id from the model. Timer enablement is process-local; ledger movements and event revisions persist. Feed enablement is explicit through the route or startup configuration, and timers stop when the server closes.

## Run, verify and hand off

Start the server with `npm start` or `npm run dev` (set `PROFILE_API_TOKEN` when an outside client must call `/api`). Outside production it also starts Banc Demo on port 3003, connects it and links `user-001` to `cust-001`; that is the default demo feed. The in-process synthetic feed is opt-in: `DEMO_BANK_USERS` (comma-separated IDs) starts it for those users, paced by `DEMO_BANK_INTERVAL_MS` (default 5000), and with `DEMO_BANK=off` it is the default for `user-001` again. Never feed one user from both. Banc Demo keeps a rolling window of its newest 5000 transactions and paces itself with `DEMO_BANK_TICK_MS`. A ledger holds at most 100000 movements; at the cap a sync fails once with a clear `lastError` and waits for a manual sync instead of retrying. Follow [BANK_API.md](../../apps/profile-api/BANK_API.md) for detailed semantics. Run `npm run typecheck` and `npm test`; cover import idempotency, concurrent writes, event cursors, restart persistence, shutdown and background errors. `tests/banks.test.ts` covers the registry, a fake provider end to end, webhook verification and the event stream. `tests/demo-bank.test.ts` runs Banc Demo and the profile API together with stepped clocks: webhook delivery, state changes, own transfers, rejected signatures, retries and dead letters, duplicates, restarts and pull-only convergence; and a person connecting Banc Demo through its consent page on the whole server. `tests/banks.test.ts` also covers the consent engine (single use, session binding, expiry, denial, renewal) and sealing (not in the file in clear, wrong key fails closed); `tests/bank-api.test.ts` the statement import; `tests/auth.test.ts` who may do what.

Give the board and every model-facing tool freshness, aggregate figures and event revision rather than credentials or raw transactions: movements are shown to their owner only, on `/account` and through `/api` with their own credential. Missing months produce unknown estimates. Financial scenarios are user-reviewed assumptions, not credit scores, mortgage approval or guaranteed affordability.
