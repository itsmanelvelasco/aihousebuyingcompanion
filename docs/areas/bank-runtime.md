# Synthetic bank and runtime events area

**Owner:** bank/finance backend team. **Purpose:** produce and manage fictional movements, expose freshness/events and calculate explainable financial summaries.

## Entry points

- `apps/profile-api/bank.ts`: accounts, ledger persistence and movement CRUD/import.
- `packages/finance/cashflow.ts`: deterministic cash flow, recurring candidates and savings scenarios.
- `packages/banks/provider.ts`: the `BankProvider` contract a bank implements, plus helpers for IDs, cents and signatures.
- `packages/banks/providers/`: one file per bank, discovered by `packages/banks/registry.ts`. `synthetic.ts` is the demo feed; `_template.ts` is the skeleton to copy.
- `packages/banks/sync.ts`: connections per user, pull-and-import, polling, webhook-triggered syncs and the in-process event emitter.
- `apps/profile-api/runtime.ts`: the `/runtime` routes, expressed as a synthetic-provider connection polled by the sync engine.
- `apps/profile-api/server.ts`: authenticated bank routes, the bank webhook route, the event stream and runtime wiring.
- `apps/mcp-server/bank-tools.ts`: HTTP-backed read-only MCP access.
- [BANK_API.md](../../apps/profile-api/BANK_API.md): account/movement formats and scenario examples.

## Data flow and boundaries

Runtime data belongs in a user's `bank-ledger.json`, separate from the original bank snapshot. Integer EUR cents are authoritative. Booked movements affect balances; income/spending summaries exclude pending movements and transfers between owned accounts. Recurring charges are candidates to confirm, not automatic subscription cancellations.

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

Two routes sit outside the user prefix: `GET /bank/providers` lists providers as `configured` or `unconfigured` (bearer token), and `POST /webhooks/bank/:providerId` is called by a bank, carries no bearer token and is accepted only when the provider's `verifyWebhook` passes. A webhook only schedules a sync; its body is never stored.

## Add a bank

Copy `packages/banks/providers/_template.ts` to a new file in the same folder; no registration is needed. Implement `listAccounts` and `fetchTransactions` (and `verifyWebhook` plus `parseWebhook` when the bank can call us, otherwise set `pollIntervalMs`). Declare variables as `BANK_<PROVIDER_ID>_<NAME>` in the provider's `env` list and in `.env.example`; a provider with a missing required variable is listed as `unconfigured`. Return integer EUR cents, ledger categories and stable IDs. Details and response shapes are in [BANK_API.md](../../apps/profile-api/BANK_API.md#add-a-bank).

Every account and movement carries the `synthetic` flag of its provider. Ledgers, events, summaries and API responses report `synthetic: true` only when every record behind them is synthetic, and a record without the flag is rejected, never assumed. A provider declared `synthetic: false` can connect and sync, but a production bank still needs a consent/OAuth flow, per-user token storage and per-user authorization (see [BANK_API.md](../../apps/profile-api/BANK_API.md#what-a-production-bank-still-needs)). Do not ship a provider for a real bank from guessed API shapes.

Keep one API process as the runtime-directory writer. The producer shares that process's ledger serialization; MCP reads through HTTP rather than writing files independently. Timer enablement is process-local; ledger movements and event revisions persist. Feed enablement is explicit through the route or startup configuration, and timers stop when the server closes.

## Run, verify and hand off

Start the profile API with `PROFILE_API_TOKEN` and `npm start`. Set `DEMO_BANK_USERS=user-001` (comma-separated IDs for several users) to opt into startup feeds; `DEMO_BANK_INTERVAL_MS` defaults to 5000. The combined `npm run dev` launcher defaults its demo feed to `user-001`. Follow [BANK_API.md](../../apps/profile-api/BANK_API.md) for detailed semantics. Run `npm run typecheck` and `npm test`; cover import idempotency, concurrent writes, event cursors, restart persistence, shutdown and background errors. `tests/banks.test.ts` covers the registry, a fake provider end to end, webhook verification and the event stream.

Give the board freshness, aggregate figures and event revision rather than credentials/raw transactions. Missing months produce unknown estimates. Financial scenarios are user-reviewed assumptions, not credit scores, mortgage approval or guaranteed affordability.
