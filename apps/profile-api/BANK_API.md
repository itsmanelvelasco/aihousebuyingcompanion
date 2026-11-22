# Bank ledger API

This is the complementary finance backend for ReloCat. It uses the existing server, token and user IDs. Start it using the [profile API instructions](README.md). All endpoints below require `Authorization: Bearer <PROFILE_API_TOKEN>` and JSON bodies use `Content-Type: application/json`. The one exception is the bank webhook route, which a bank calls without the token and which is authenticated by the provider's signature check.

Records are EUR only and every account and movement carries an explicit `synthetic` flag: `true` for fabricated demo data, `false` for real bank data. Movements reach the ledger through pluggable bank providers (see [Bank providers, connections and live events](#bank-providers-connections-and-live-events)). The only provider that ships is the synthetic demo feed, so out of the box there is no connection to a real bank; the API can store real records once a provider for a real bank is added, but it is not yet a production bank backend (see [What a production bank still needs](#what-a-production-bank-still-needs)). There is no payment execution, credit scoring or mortgage approval. The API calculates results and offers review suggestions; it never cancels subscriptions or moves money.

## Routes

Prefix every route with `/users/:id/bank`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/accounts?asOf=2026-10-31` | List accounts and balances from opening balance plus booked movements through the given date. Defaults to today's UTC date. |
| POST | `/accounts` | Create an account by hand. |
| PUT | `/accounts/:accountId` | Replace account metadata and opening balance; IDs must match. |
| GET | `/transactions?from=2026-08-01&to=2026-10-31&accountId=demo-current&limit=100&offset=0` | List movements, optionally filtered by dates/account; sorted by date then ID. |
| POST | `/transactions` | Import `{ "transactions": [...] }`; identical IDs/data are idempotent, conflicting ID reuse returns 409. |
| PUT | `/transactions/:transactionId` | Replace one complete movement to correct its amount, date, category or pending/booked status. |
| DELETE | `/transactions/:transactionId` | Delete a movement. |
| GET | `/summary?from=2026-08-01&to=2026-10-31` | Cash flow, category spending, monthly totals and recurring-expense candidates. |
| POST | `/simulate?from=2026-08-01&to=2026-10-31` | Estimate the effect of a user-supplied extra monthly saving and emergency reserve. |
| POST | `/demo` | With body `{}`, create three scripted historical months from this user's bank snapshot. Rejects a nonempty ledger with 409. |

Summary and simulation dates are required and must span 1–24 complete calendar months, including their first and last days. Transaction lists support arbitrary valid date ranges, limits of 1–500 and offsets of 0–10000. Import batches contain 1–500 rows, with at most 10000 stored movements and 20 accounts per user. Bodies remain limited to 256 KiB.

## Account and movement shapes

Create an account first:

```json
{
  "id": "demo-current",
  "name": "Fictional current account",
  "currency": "EUR",
  "openingBalanceCents": 500000,
  "openingDate": "2026-08-01",
  "synthetic": true
}
```

The opening balance is the balance immediately before that date's movements. Movement dates may not precede it. Account balances include booked transfers because money actually enters/leaves that account; aggregate income and spending exclude own-account transfers. Historical balances before an account's opening date are unknown (`balanceCents: null`). Negative balances represent an overdraft, not available purchase savings.

Import movements:

```json
{
  "transactions": [
    {
      "id": "salary-2026-08",
      "accountId": "demo-current",
      "date": "2026-08-02",
      "description": "Fictional household income",
      "amountCents": 240000,
      "currency": "EUR",
      "category": "income",
      "status": "booked",
      "synthetic": true
    },
    {
      "id": "rent-2026-08",
      "accountId": "demo-current",
      "date": "2026-08-05",
      "description": "Fictional rent",
      "amountCents": -100000,
      "currency": "EUR",
      "category": "housing",
      "status": "booked",
      "synthetic": true
    }
  ]
}
```

Use integer EUR cents: income is positive and expenses are negative. `status` is `booked` (default) or `pending`. Categories are `income`, `housing`, `food`, `transport`, `utilities`, `subscriptions`, `healthcare`, `education`, `debt`, `other` and `internal_transfer`. `other` accepts either sign for adjustments/refunds; positive adjustments count as cash inflow and are not proof of employment income. Zero amounts are rejected. `income` requires positive amounts and named expense categories require negative amounts. Refunds should use `other`.

Transaction IDs are unique within the user. Use the same IDs for retried imports; use PUT for corrections. An invalid account, duplicate conflict or invalid row rejects the whole batch. To represent a transfer between two owned accounts, import both sides and label both `internal_transfer`; classification is explicit, not inferred from descriptions. Missing transfer counterparts are not automatically detected.

## The `synthetic` flag

`synthetic` is a required boolean on every account and movement. Providers stamp it from their own declaration; hand-made imports must state it, and a row without it is rejected with 400 rather than guessed. Ledgers written before the flag became a boolean contain only `true` and keep loading unchanged.

Everything derived reports `synthetic: true` only when every record it is built from is synthetic, and `false` as soon as one real account or movement is in the ledger: the account and transaction lists, `/events` and each event (labelled as the ledger was at that revision), the stream's `ready` message, `/summary` and `/simulate`. An empty ledger reports `true` because it contains no real record. `/runtime` always reports `true`: it describes the demo feed, which only fabricates. Consumers must show the label they receive; `false` means real financial data and the privacy rules for it apply.

## Summaries and decision support

Summaries exclude pending movements and internal transfers, retain debt payments as expenses, and show positive expense totals. Monthly savings are the floor of the historical net cash-flow average across the requested months. If any requested month lacks external booked movements, the savings average is unknown. Even months with movements may be incomplete: imported data is not bank-verified.

Recurring-expense candidates match normalized description, account and category in at least two distinct historical months up to the requested end date. They are review candidates, not confirmed active subscriptions; old/cancelled commitments may still appear. Raw descriptions remain in the summary, so consumers should send only the needed aggregates to model-facing tools.

Simulation body:

```json
{
  "targetCashCents": 6000000,
  "currentSavingsCents": 1800000,
  "extraMonthlySavingsCents": 15000,
  "emergencyReserveCents": 300000
}
```

The caller explicitly confirms savings available and the purchase cash target, including their chosen deposit, fees and taxes. Do not automatically treat all account balances as spendable. The reserve is deducted from available purchase savings. The response compares baseline and scenario monthly savings and months to target, rounding months up. Missing history or nonpositive savings gives a null timeline unless the cash target is already reached. Extra savings are an assumption, not a detected opportunity.

Suggestions flag incomplete history, a cash-flow deficit and subscription spending for user review. The calculation does not estimate a credit score, infer lender eligibility, select investments or guarantee affordability. No interest, inflation or future income changes are modeled. The caller must review the returned assumptions before acting.

## Quick demo in PowerShell

```powershell
$headers = @{ Authorization = "Bearer $env:PROFILE_API_TOKEN" }
$base = 'http://127.0.0.1:8787/api/users/user-001/bank'
Invoke-RestMethod "$base/demo" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
Invoke-RestMethod "$base/accounts?asOf=2026-10-31" -Headers $headers
Invoke-RestMethod "$base/summary?from=2026-08-01&to=2026-10-31" -Headers $headers
$scenario = @{ targetCashCents = 6000000; currentSavingsCents = 1800000; extraMonthlySavingsCents = 15000; emergencyReserveCents = 300000 } | ConvertTo-Json
Invoke-RestMethod "$base/simulate?from=2026-08-01&to=2026-10-31" -Method Post -Headers $headers -ContentType 'application/json' -Body $scenario
```

The supplied profiles have a 21 November 2026 snapshot, so demo seeding produces August–October 2026 movements. These repeat the profile's monthly totals for demonstration and are not reconstructed real history. Opening balances are back-calculated so the end-of-demo balance equals the supplied snapshot balance; that alignment is a fixture assumption, not an assertion about the actual snapshot date. The seed response includes its period.

## Background runtime and events

`GET /users/:id/bank/events?after=0&limit=50` returns durable `bank.updated` events, `nextCursor`, `latestRevision`, `hasMore` and `requiresRefresh`. Save the cursor between polls. Every actual ledger mutation advances the revision; identical import retries do not. The last 500 events are retained. When a cursor is too old or ahead of the current ledger, refresh accounts/summary and resume with the server cursor. Events contain counts and timestamps, not transaction descriptions.

`GET /users/:id/bank/runtime` reads worker status. The feed is the `synthetic` bank provider polled by the sync engine through the user's `synthetic-feed` connection; these routes keep their original shape. `POST` to that path with `{ "enabled": true, "intervalMs": 5000 }` starts a simulated background feed (1000–60000 ms). `{ "enabled": false }` stops it and waits for its active tick. `POST /users/:id/bank/runtime/tick` with `{}` performs one explicit tick without enabling a timer. An empty ledger is seeded from the profile first. The feed appends clearly synthetic grocery purchases with retry-stable IDs, not realistic population spending or bank-synced data. It pauses on errors and exposes a sanitized failure status. At most 20 feeds can run in one API process.

Set `DEMO_BANK_USERS=user-001` and optional `DEMO_BANK_INTERVAL_MS=5000` when starting the profile service to opt in at startup. `npm run dev` uses `user-001` by default; an empty `DEMO_BANK_USERS` disables that default. Runtime enablement is process-local; durable ledger rows/cursors survive restarts. Restart with the startup list to resume timers.

The existing MCP server can register read-only `get_bank_updates`, `get_bank_runtime` and `get_bank_summary` when both `BANK_API_URL` and `BANK_API_TOKEN` are configured. The integrated plugin uses its server-side `PROFILE_API_URL`/`PROFILE_API_TOKEN` instead. Tokens never enter widget/tool payloads. These are polling tools, not push subscriptions; background mutations do not automatically trigger ChatGPT messages.

## Bank providers, connections and live events

A bank is a provider: one file in `packages/banks/providers/` that implements the contract in `packages/banks/provider.ts`. `packages/banks/registry.ts` loads every `*.ts` in that folder except names starting with `_`. `packages/banks/sync.ts` pulls from providers and imports through the ledger store, which stays the single writer. Only `synthetic` ships; no real bank or aggregator is integrated.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/bank/providers` | Registered providers with `status` (`configured` or `unconfigured`), `webhooks`, `synthetic` and their variables as `{ name, description, required, set }`. Values are never returned. `loadErrors` lists provider files that failed to load. |
| GET | `/users/:id/bank/connections` | The user's connections: `id`, `providerId`, `createdAt`, `lastSyncAt`, `lastError`, `pollIntervalMs`, `polling`, `syncCount`. |
| POST | `/users/:id/bank/connections` | Link a provider: `{ "providerId": "synthetic", "ref": "demo-link", "id"?: "my-id", "pollIntervalMs"?: 60000 }`. Returns 201. |
| DELETE | `/users/:id/bank/connections/:connectionId` | Remove the link and stop its polling. Imported movements stay. |
| POST | `/users/:id/bank/sync` | Pull now. Body `{}` syncs every connection, `{ "connectionId": "..." }` one. Returns one result per connection. |
| POST | `/webhooks/bank/:providerId` | Called by the bank. No bearer token. |
| GET | `/users/:id/bank/events/stream?after=0` | Server-Sent Events with each new ledger event. |

**Connections.** `ref` is the opaque identifier the bank's consent flow issued for the link (1-200 printable characters). It is stored in the user's runtime `bank-connections.json`, is never returned by the API and must not be a password or token. One reference can be linked once. A user has at most 10 connections. Providers without webhooks are polled, at `pollIntervalMs` when given (1 second to 1 day), else at the provider's own cadence; `"pollIntervalMs": null` means manual syncs only. Polling stops after five consecutive failures and restarts with the process, except for synthetic providers, which never resume on their own. Connecting an unknown provider returns 404 and an unconfigured one 409. A provider declared `synthetic: false` connects and syncs like any other; its accounts and movements are stored with `synthetic: false`.

**Sync.** Each sync creates the provider's accounts that are missing from the ledger, then upserts its movements: new IDs are inserted, changed rows (pending to booked) are updated and identical rows are skipped, so repeating a sync writes no revision and emits no event. A result is `{ "status": "synced", connectionId, providerId, accountsCreated, inserted, updated, duplicates, revision, syncedAt }` or `{ "status": "failed", connectionId, providerId, error }` with a sanitized message. A batch with any invalid row is rejected whole.

**Webhooks.** A webhook is a signal to sync, not data. The route answers 404 when the provider is unknown or has no webhook support, 503 when it is unconfigured, 413 above 64 KiB and 401 when the provider's `verifyWebhook` does not accept the raw body and headers. A verified call returns `202 { "accepted": true }` whether or not the reference is known, and the sync runs in the background through the provider's own API. Nothing from the webhook body is stored.

**Live events.** The stream first sends `event: ready` with `{ latestRevision, requiresRefresh, synthetic }`, replays persisted events after the cursor, then pushes every new revision, whatever caused it (sync, runtime feed or a manual import):

```text
id: 7
event: bank.updated
data: {"sequence":7,"occurredAt":"2026-11-21T12:00:05.000Z","type":"bank.updated","accountCount":1,"transactionCount":16,"synthetic":true}
```

`data` has exactly the shape of an item of `GET /events`. A comment line `: heartbeat` is sent every 15 seconds. Reconnect with `?after=<last id>` or the standard `Last-Event-ID` header; `requiresRefresh: true` means the cursor is older than the retained log or ahead of the ledger, so refresh accounts and summary first. Browsers cannot set the bearer header on `EventSource`: consume the stream server-side or with `fetch`. At most 100 streams are open per process, and streams end when the server closes. In-process code can subscribe with `createProfileApiHandler(...).bankEvents.onEvent(listener)`.

## Add a bank

1. Copy `packages/banks/providers/_template.ts` to `packages/banks/providers/<your-bank>.ts`. That is the only file; the registry finds it.
2. Set `id`, `displayName`, `synthetic` and the `env` list. Variables are named `BANK_<PROVIDER_ID>_<NAME>` (`my-bank` reads `BANK_MY_BANK_CLIENT_ID`); the provider receives their values in `context.env` and reads no other configuration. Add the names, without values, to `.env.example`.
3. Implement two functions: `listAccounts(connection, context)` and `fetchTransactions(connection, { since, ...context })`. Return ledger-shaped rows: integer EUR cents (`decimalToCents`), a ledger category (`safeCategory`), `booked` or `pending`, and IDs that are the same on every fetch (`stableId`).
4. If the bank can notify us, implement `verifyWebhook(request, context)` and `parseWebhook(rawBody, context)` and register `https://<origin>/api/webhooks/bank/<id>` at the bank. Otherwise set `pollIntervalMs`.
5. Set the variables, restart, and check `GET /bank/providers`, `POST /users/:id/bank/connections` and `POST /users/:id/bank/sync`.

A provider missing a required variable is listed as `unconfigured` and does not stop the server. Test a provider the way `tests/banks.test.ts` does: pass `createBankRegistry([provider], env)` as `bankRegistry` to `createProfileApi`.

## What a production bank still needs

The provider contract, sync engine, truthful labels and events are in place, and a provider with `synthetic: false` can connect and sync. That is not enough to put a real customer's bank data behind this API. Still missing:

- **Consent and bank authorization.** There is no consent screen, OAuth/redirect flow or consent expiry and renewal. `POST /connections` accepts a `ref` that some other system must have obtained with the user's consent.
- **Per-user credential storage.** A provider only receives process-wide environment variables and the non-secret `ref`. There is nowhere to keep a per-user access or refresh token, no encryption at rest and no rotation.
- **Per-user authorization.** One shared bearer token reads and writes every user. A real deployment needs authenticated end users who can reach only their own ledger, connections and event stream.
- **Storage and audit.** Ledgers are plain JSON files written by a single process, with no encryption, audit trail, retention or deletion policy, and a 10000-movement cap per user.
- **A real provider.** None ships. Each bank or aggregator must be implemented from its own documentation and verified against its sandbox, including pagination, rate limits and error handling.
- **Webhook hardening.** The route checks the provider's signature and bounds the body; replay protection, rate limiting and source allow-lists are left to the provider and the deployment.

## Persistence and limitations

Ledger reads/writes are separate from the existing `bank-account.json` snapshot. Updating one does not synchronize the other, and neither refreshes committed JSON/CSV exports. The API derives balances from the ledger, not stale profile totals. Runtime records remain git-ignored.

Ledger changes are atomic file replacements and serialized per user within one API process. Run a single process per data directory; multiple processes need database transactions/locking. Concurrent full replacements of the same transaction use last-write-wins. There is no cross-file transaction, audit history or production per-user authorization. All clients with the shared demo token can access all demo users. Real financial data requires a different production storage/authentication design and separately consented open banking.
