# Bank ledger API

This is the complementary finance backend for Relocat. It uses the existing server, token and user IDs. Start it using the [profile API instructions](README.md). All endpoints below require `Authorization: Bearer <PROFILE_API_TOKEN>` and JSON bodies use `Content-Type: application/json`.

Only explicitly synthetic EUR records are supported. There is no connection to a bank, payment execution, credit scoring or mortgage approval. The API calculates results and offers review suggestions; it never cancels subscriptions or moves money.

## Routes

Prefix every route with `/users/:id/bank`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/accounts?asOf=2026-10-31` | List accounts and balances from opening balance plus booked movements through the given date. Defaults to today's UTC date. |
| POST | `/accounts` | Create a synthetic account. |
| PUT | `/accounts/:accountId` | Replace account metadata and opening balance; IDs must match. |
| GET | `/transactions?from=2026-08-01&to=2026-10-31&accountId=demo-current&limit=100&offset=0` | List movements, optionally filtered by dates/account; sorted by date then ID. |
| POST | `/transactions` | Import `{ "transactions": [...] }`; identical IDs/data are idempotent, conflicting ID reuse returns 409. |
| PUT | `/transactions/:transactionId` | Replace one complete movement to correct its amount, date, category or pending/booked status. |
| DELETE | `/transactions/:transactionId` | Delete a synthetic movement. |
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
$base = 'http://127.0.0.1:3001/users/user-001/bank'
Invoke-RestMethod "$base/demo" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
Invoke-RestMethod "$base/accounts?asOf=2026-10-31" -Headers $headers
Invoke-RestMethod "$base/summary?from=2026-08-01&to=2026-10-31" -Headers $headers
$scenario = @{ targetCashCents = 6000000; currentSavingsCents = 1800000; extraMonthlySavingsCents = 15000; emergencyReserveCents = 300000 } | ConvertTo-Json
Invoke-RestMethod "$base/simulate?from=2026-08-01&to=2026-10-31" -Method Post -Headers $headers -ContentType 'application/json' -Body $scenario
```

The supplied profiles have a 21 November 2026 snapshot, so demo seeding produces August–October 2026 movements. These repeat the profile's monthly totals for demonstration and are not reconstructed real history. Opening balances are back-calculated so the end-of-demo balance equals the supplied snapshot balance; that alignment is a fixture assumption, not an assertion about the actual snapshot date. The seed response includes its period.

## Background runtime and events

`GET /users/:id/bank/events?after=0&limit=50` returns durable `bank.updated` events, `nextCursor`, `latestRevision`, `hasMore` and `requiresRefresh`. Save the cursor between polls. Every actual ledger mutation advances the revision; identical import retries do not. The last 500 events are retained. When a cursor is too old or ahead of the current ledger, refresh accounts/summary and resume with the server cursor. Events contain counts and timestamps, not transaction descriptions.

`GET /users/:id/bank/runtime` reads worker status. `POST` to that path with `{ "enabled": true, "intervalMs": 5000 }` starts a simulated background feed (1000–60000 ms). `{ "enabled": false }` stops it and waits for its active tick. `POST /users/:id/bank/runtime/tick` with `{}` performs one explicit tick without enabling a timer. An empty ledger is seeded from the profile first. The feed appends clearly synthetic grocery purchases with retry-stable IDs, not realistic population spending or bank-synced data. It pauses on errors and exposes a sanitized failure status. At most 20 feeds can run in one API process.

Set `DEMO_BANK_USERS=user-001` and optional `DEMO_BANK_INTERVAL_MS=5000` when starting the profile service to opt in at startup. `npm run dev:stack` uses `user-001` by default; an empty `DEMO_BANK_USERS` disables that default. Runtime enablement is process-local; durable ledger rows/cursors survive restarts. Restart with the startup list to resume timers.

The existing MCP server can register read-only `get_bank_updates`, `get_bank_runtime` and `get_bank_summary` when both `BANK_API_URL` and `BANK_API_TOKEN` are configured. The integrated plugin uses its server-side `PROFILE_API_URL`/`PROFILE_API_TOKEN` instead. Tokens never enter widget/tool payloads. These are polling tools, not push subscriptions; background mutations do not automatically trigger ChatGPT messages.

## Persistence and limitations

Ledger reads/writes are separate from the existing `bank-account.json` snapshot. Updating one does not synchronize the other, and neither refreshes committed JSON/CSV exports. The API derives balances from the ledger, not stale profile totals. Runtime records remain git-ignored.

Ledger changes are atomic file replacements and serialized per user within one API process. Run a single process per data directory; multiple processes need database transactions/locking. Concurrent full replacements of the same transaction use last-write-wins. There is no cross-file transaction, audit history or production per-user authorization. All clients with the shared demo token can access all demo users. Real financial data requires a different production storage/authentication design and separately consented open banking.
