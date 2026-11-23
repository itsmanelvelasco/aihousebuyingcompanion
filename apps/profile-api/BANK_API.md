# Bank ledger API

This is the complementary finance backend for ReloCat. It uses the existing server, token and user IDs. Start it using the [profile API instructions](README.md). JSON bodies use `Content-Type: application/json`. Two kinds of caller are accepted:

- **The operator**, with `Authorization: Bearer <PROFILE_API_TOKEN>`: every route below, for every user.
- **A signed-in person**, with their own OAuth access token or browser session, on the one server (`apps/server`): only `/users/<their own id>/…`. They read everything there and may change their own bank data through the routes under [A person's own bank data](#a-persons-own-bank-data). Raw ledger writes (`POST /accounts`, `POST`/`PUT /transactions`), the demo feed (`/runtime`, `/demo`) and the provider registry stay with the operator.

The one exception is the bank webhook route, which a bank calls without any token and which is authenticated by the provider's signature check.

Records are EUR only and every account and movement carries an explicit `synthetic` flag: `true` for fabricated demo data, `false` for real bank data. Movements reach the ledger through pluggable bank providers (see [Bank providers, connections and live events](#bank-providers-connections-and-live-events)). Two providers ship, both fictional: the in-process synthetic demo feed and `demo-bank`, which talks HTTP to the [Banc Demo service](../demo-bank/README.md). A third fictional source, the fixed sample statement `data/demo-bank.csv`, never reaches a ledger; [which is which](../../docs/areas/bank-runtime.md#three-fictional-banks). Out of the box there is no connection to a real bank; the API can store real records once a provider for a real bank is added, but it is not yet a production bank backend (see [What a production bank still needs](#what-a-production-bank-still-needs)). There is no payment execution, credit scoring or mortgage approval. The API calculates results and offers review suggestions; it never cancels subscriptions or moves money.

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
| PATCH | `/transactions/:transactionId` | Body `{ "category": "…" }`: correct the category of one movement. The choice is kept when the bank reports the movement again. |
| DELETE | `/transactions/:transactionId` | Delete a movement. A person may delete only what they imported themselves (403 otherwise); the operator any. |
| GET | `/summary?from=2026-08-01&to=2026-10-31` | Cash flow, category spending, monthly totals and recurring-expense candidates. |
| POST | `/simulate?from=2026-08-01&to=2026-10-31` | Estimate the effect of a user-supplied extra monthly saving and emergency reserve. |
| POST | `/demo` | With body `{}`, create three scripted historical months from this user's bank snapshot. Rejects a nonempty ledger with 409. |

Summary and simulation dates are required and must span 1–24 complete calendar months, including their first and last days. Transaction lists support arbitrary valid date ranges, limits of 1–500 and offsets of 0–10000. Import batches contain 1–500 rows, with at most 100000 stored movements and 20 accounts per user. A batch that would pass the movement cap is refused whole with 400 and `Movement limit reached…`; nothing of it is stored, and it succeeds again once older movements have been deleted. Bodies remain limited to 256 KiB.

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

Everything derived reports `synthetic: true` only when every record it is built from is synthetic, and `false` as soon as one real account or movement is in the ledger: the account and transaction lists, `/events` and each event (labelled as the ledger was at that revision), the stream's `ready` message, `/summary` and `/simulate`. A ledger without any record has nothing to say, so the person decides: `true` for a fixture or demo persona, `false` for a person who belongs to an account, who is never labelled synthetic for having no bank data. The flag describes the bank records, not the person: a real person connected to the fictional bank has a real profile and synthetic movements. `/runtime` always reports `true`: it describes the demo feed alone, which only fabricates. Consumers must show the label they receive; `false` means real financial data and the privacy rules for it apply.

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

This in-process feed is opt-in. `DEMO_BANK_USERS=user-002,user-003` (comma-separated) starts it for those users when the server starts, with `DEMO_BANK_INTERVAL_MS` (default 5000) between movements. By default the server starts no in-process feed: outside production (`NODE_ENV` other than `production`) `npm run dev` and `npm start` start [Banc Demo](../demo-bank/README.md) instead and link `user-001` to its customer `cust-001`, so that user's movements arrive by webhook. Do not list a user in `DEMO_BANK_USERS` who is also linked to Banc Demo: both feeds would write to the same ledger and their histories would be summed. `DEMO_BANK=off` (again outside production) switches Banc Demo off and returns `user-001` to the in-process feed. In production neither starts unless `DEMO_BANK_USERS` names users or `DEMO_BANK=on` asks for Banc Demo explicitly (a public demo of the fictional bank; see the [Banc Demo guide](../demo-bank/README.md#one-origin)). Runtime enablement is process-local; durable ledger rows/cursors survive restarts. Restart with the startup list to resume timers.

The MCP server registers read-only `get_bank_updates`, `get_bank_runtime` and `get_bank_summary` for the signed-in person's own ledger (they take no user id), the tools of [A person's own bank data](#a-persons-own-bank-data), and `get_demo_bank_*` for the fictional personas of the public demo. The tools reach the stores in-process through a handle bound to one person (`apps/server/people.ts`); the admin token is not involved and never enters widget or tool payloads. These are polling tools, not push subscriptions; background mutations do not automatically trigger ChatGPT messages.

**The rule for movements.** No MCP tool returns a movement: tool results are aggregates (totals, balances, counts per category) and states (a connection, a consent, an import). Individual movements, with their descriptions, are for the person themselves: the account page (`/account`) and `/api/users/<own id>/bank/transactions` with the person's own credential. A model acting for a person therefore never needs, and never gets, a movement id, which is why correcting a category or deleting a movement exists on the page and in `/api` only.

## A person's own bank data

A signed-in person connects a bank, imports a statement and corrects their movements themselves. Every route acts on the person the credential belongs to; the id in the path must be theirs (403 otherwise, whether or not the other id exists). Changes need the `bank:manage` scope (a browser session has it, with the `X-CSRF-Token` header and this origin, like every session write); reads need `person:read`.

| Method | Route below `/users/:id` | Purpose |
| --- | --- | --- |
| GET | `/bank/banks` | Banks this person can connect: `id`, `displayName`, `synthetic` (true for a fictional bank or feed), `connect` (`consent_at_bank` or `direct`), `webhooks`. Only configured providers; no variable names. |
| GET | `/bank/connections` | Their connections, each with `displayName`, `synthetic`, `webhooks`, `polling`, `lastSyncAt`, `lastError`, `consent` (`not_required`, `granted` or `expired`) and `consentExpiresAt`. |
| POST | `/bank/connections` | Body `{ "providerId": "…" }` and nothing else: a body with `ref`, `id` or `pollIntervalMs` is 403, because a person who could name a reference could attach somebody else's bank. A `direct` bank answers 201 `{ "status": "connected", connection }`. A `consent_at_bank` bank answers 202 `{ "status": "consent_required", continuePath: "/account", … }`: the consent starts on the account page, see below. |
| DELETE | `/bank/connections/:connectionId` | Disconnect: polling stops and the stored credential is deleted. Imported movements stay. |
| POST | `/bank/sync` | Pull now, as above. |
| GET | `/bank/consents` | Consents they started at a bank and have not finished: `providerId`, `createdAt`, `expiresAt`. Never the state. |
| POST | `/bank/imports/preview` | Body `{ "csv": "…" }`: read and summarise a statement. Writes nothing to the ledger. |
| POST | `/bank/imports` | Body `{ "previewHash": "…" }`: write the statement that preview summarised. |
| GET | `/bank/imports` | Statements they imported. |
| DELETE | `/bank/imports/:importId` | Delete a statement with the movements only it brought. |
| PATCH | `/bank/transactions/:transactionId` | Correct a category; `internal_transfer` marks a transfer between their own accounts. |
| DELETE | `/bank/transactions/:transactionId` | Delete a movement they imported. A movement that came from a bank is refused: the next sync would bring it back, so it is corrected instead. |
| GET | `/export` | Everything stored about them, as one JSON document (also a button on `/account`). |

The MCP tools are the same actions for an assistant: `list_connectable_banks`, `list_my_bank_connections`, `get_my_bank_accounts`, `list_my_statement_imports` (`person:read`) and `connect_my_bank`, `disconnect_my_bank`, `sync_my_bank`, `preview_statement_import`, `confirm_statement_import`, `delete_statement_import` (`bank:manage`). None takes a user id, and none returns a movement.

### Consent at the bank

A real bank is connected by the person authorising access at the bank itself. The provider contract models that as an optional capability, `consent` (`packages/banks/provider.ts`):

- `beginConsent({ returnUrl, state })` asks the bank for the page the person must visit and returns `{ redirectUrl }`.
- `completeConsent(params)` receives the query parameters of the bank's callback and returns `{ ref, expiresAt? }`: the reference of the link, and when the consent ends.

The engine (`packages/banks/sync.ts`) does the rest, the same for every bank:

1. The person presses **Connect** on `/account` (a form with the session's CSRF token). The engine makes a random single-use `state`, stores only its SHA-256 with the person, the provider, a hash of the browser session and an expiry of ten minutes (`bank_consents`), and calls `beginConsent`. The page that follows names the bank and what is asked for, and the way out is a plain link: no form of ReloCat posts to a bank.
2. The person approves or refuses at the bank, which sends the browser to `GET /bank/consent/callback?state=…` with whatever it adds (a one-time `code`, or `error=access_denied`).
3. The callback needs the signed-in session. The state is deleted as soon as it is presented, whoever presents it, so it works once. It must be unexpired and belong to this person **and this browser session**; otherwise the answer is 400 or 403 and nothing is connected. This is what stops somebody from starting a consent and getting another person to approve it with their own bank login: the callback would arrive in the other person's session.
4. Only then is `completeConsent` called. A refusal (`error=…`) connects nothing. On success the engine seals the reference, creates the connection and pulls once.

A consent that the bank says ends (`expiresAt`) is shown as `consentExpiresAt`. When it has passed, the connection is `consent: "expired"`: syncs fail with `The consent at the bank has expired. Connect this bank again to renew it.`, nothing is retried, and a new consent for the same bank login renews the same connection, with its history. A person has at most ten connections and five consents in progress. One bank reference belongs to one person, whether an operator linked it or a consent did.

Assistants cannot run this flow: `connect_my_bank` and `POST /bank/connections` answer `consent_required` with the address of the account page, because the consent must start in, and return to, the person's own signed-in browser. A provider without `consent` is linked by the operator only, except a `synthetic` one, which a person connects directly since there is no bank to ask (its reference is made by the server, never taken from the caller).

`demo-bank` implements the capability against [Banc Demo's consent desk](../demo-bank/README.md#consent): a consent request created with the API key, a page of the bank's own where the (fictional) customer approves (served on ReloCat's origin at `/banc-demo/consent/<id>` when the server runs the bank, so it is reachable through a tunnel or on a deployed site), a one-time code, and its exchange for the customer reference and the day the consent ends.

### Credentials at rest

What `completeConsent` returns as `ref` is treated as a credential, whatever the bank calls it:

- It is stored only encrypted, in `bank_credentials`: AES-256-GCM (`node:crypto`), a random nonce per value, and additional authenticated data that names the person, the connection and the provider, so a ciphertext copied to another row does not decrypt.
- The connection row keeps a keyed fingerprint (`sealed:<HMAC-SHA256>`) in place of the reference. That keeps "one reference, one person" and the lookup of a webhook's reference working without the reference in the database, and nobody without the key can test a guess against the file. The webhook queue stores the same fingerprint.
- The key is `DATA_ENCRYPTION_KEY` (32 random bytes as hex or base64), split with HKDF into independent keys for sealing and for fingerprints. In production the server refuses to start without it while a provider with `consent` is configured. Outside production a key is created on first use and kept in the database's `app_meta`, with one log line saying so: fine for a laptop, no protection against somebody who has the file.
- A wrong key, a missing key or a damaged value fails closed: the provider is not called, and the connection shows `The stored bank credential cannot be read…`. Losing or changing the key means every person connects their bank again; nothing else is lost.
- Disconnecting deletes the credential. Deleting the account deletes credentials, consents in progress and unconfirmed uploads with everything else.

Connections an operator creates with `ref` are stored as before, in clear: that reference "must not be a password or token". Banc Demo's customer id is not a secret either; it goes through the sealed path anyway, so the path is exercised by the demo and by the tests.

### Importing a statement

A person without a connectable bank imports a CSV statement (`date`, `description`, `amount`; dates `YYYY-MM-DD`; amounts signed, money out negative; `,` or `;` as separator), read by the same parser the interview uses (`packages/finance/csv.ts`).

1. **Preview** summarises and writes nothing: rows, how many are new and how many are already in the ledger, the period, totals in and out (transfers between own accounts left out), rows and sum per category, and `previewHash`. The upload is kept for 15 minutes (at most three per person).
2. **Confirm** takes that hash and writes exactly the statement that was summarised. There is no call that takes a statement and writes it in one step, so nothing is written that was not summarised first; the tools tell an assistant to show the summary and wait for the person.

What is written:

- Movements go to the account `manual-import`, `synthetic: false`: a statement is the person's own real data. Its balance is the net of the imported movements, not a bank balance (opening balance 0 on the earliest imported day).
- A movement's ID is derived from its date, amount, description and its position among identical rows, never from the file. Importing the same statement again, or another one that overlaps it, writes each movement once and counts the rest as duplicates; two identical rows in one statement are two movements.
- Categories are guessed from the description (rent, groceries, utilities, transport, subscriptions, health, education, loan; pay is `income`; other money in is `other`), and each can be corrected afterwards.
- **Short statements.** The preview repeats the parser's `averageBasis`. With `period_too_short` (fewer than 28 days) `monthlyFigures` is `false` and `averagingNote` says that no monthly figure can be given. The movements can still be imported: they are real movements, only too few to read a month from.
- Limits: 256 KiB and 2000 rows per statement, 200 imported statements per person, and the ledger's own cap of movements.

Deleting an import removes the movements only it brought; a movement that another imported statement also contains stays. Deleting a single imported movement removes it from its import as well.

## Bank providers, connections and live events

A bank is a provider: one file in `packages/banks/providers/` that implements the contract in `packages/banks/provider.ts`. `packages/banks/registry.ts` loads every `*.ts` in that folder except names starting with `_`. `packages/banks/sync.ts` pulls from providers and imports through the ledger store, which stays the single writer. `synthetic` and `demo-bank` ship; no real bank or aggregator is integrated.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/bank/providers` | Registered providers with `status` (`configured` or `unconfigured`), `webhooks`, `consent` (true when people connect it by authorising at the bank), `synthetic` and their variables as `{ name, description, required, set }`. Values are never returned. `loadErrors` lists provider files that failed to load. |
| GET | `/users/:id/bank/connections` | The user's connections: `id`, `providerId`, `createdAt`, `lastSyncAt`, `lastError`, `lastAttemptAt`, `consecutiveFailures`, `nextRetryAt`, `pollIntervalMs`, `polling`, `syncCount`. |
| POST | `/users/:id/bank/connections` | Link a provider: `{ "providerId": "synthetic", "ref": "demo-link", "id"?: "my-id", "pollIntervalMs"?: 60000 }`. Returns 201. |
| DELETE | `/users/:id/bank/connections/:connectionId` | Remove the link and stop its polling. Imported movements stay. |
| POST | `/users/:id/bank/sync` | Pull now. Body `{}` syncs every connection, `{ "connectionId": "..." }` one. Returns one result per connection. |
| POST | `/webhooks/bank/:providerId` | Called by the bank. No bearer token. |
| GET | `/users/:id/bank/events/stream?after=0` | Server-Sent Events with each new ledger event. |

**Connections.** `ref` is the opaque identifier the bank's consent flow issued for the link (1-200 printable characters). It is stored in the `bank_connections` table of the runtime database, is never returned by the API and must not be a password or token. One reference can be linked once. A user has at most 10 connections. Providers without webhooks are polled, at `pollIntervalMs` when given (1 second to 1 day), else at the provider's own cadence; `"pollIntervalMs": null` means manual syncs only. Polling stops after five consecutive failures and restarts with the process, except for synthetic providers, which never resume on their own. Connecting an unknown provider returns 404 and an unconfigured one 409. A provider declared `synthetic: false` connects and syncs like any other; its accounts and movements are stored with `synthetic: false`.

**Sync.** Each sync creates the provider's accounts that are missing from the ledger, then upserts its movements: new IDs are inserted, changed rows (pending to booked) are updated and identical rows are skipped, so repeating a sync writes no revision and emits no event. Movements a provider reports as declined or reverted (`removedIds`) are deleted if they were imported while pending. A result is `{ "status": "synced", connectionId, providerId, accountsCreated, inserted, updated, duplicates, removed, revision, syncedAt }` or `{ "status": "failed", connectionId, providerId, error }` with a sanitized message. A batch with any invalid row is rejected whole.

**Webhooks.** A webhook is a signal to sync, not data. The route answers 404 when the provider is unknown or has no webhook support, 503 when it is unconfigured, 413 above 64 KiB and 401 when the provider's `verifyWebhook` does not accept the raw body and headers. A verified call returns `202 { "accepted": true }` whether or not the reference is known, and the sync runs in the background through the provider's own API. Nothing from the webhook body is stored. The verifier receives the server's clock, so a provider can reject stale signed timestamps.

**Reliability.** These rules exist because a real bank retries, goes down and sends things twice:

- *Acknowledge fast, process from a queue.* A verified notification is committed to the `bank_webhook_queue` table of the runtime database before the 202 is sent, and the sync starts afterwards. One pending entry is kept per connection (a webhook only says "sync this connection"); it is removed when a sync that started after it arrived succeeds. A notification that arrives during a sync triggers one more sync, and one that was accepted just before a restart is processed when the server starts again. During shutdown the route answers 503 so the bank retries.
- *Duplicates.* When the provider returns the bank's notification ID (`eventId`), the last 2000 accepted IDs are remembered, also across restarts; a repeated ID is acknowledged with the same 202 and starts nothing.
- *Failures.* A sync that fails (bank down, 5xx, timeout, invalid data) never crashes the process. The connection records `lastError` (sanitized), `lastAttemptAt` and `consecutiveFailures`, keeps `lastSyncAt` and its cursor, and, for providers with webhooks and for polled connections, is retried after 2 s, 4 s, 8 s and 16 s (`nextRetryAt`). After five consecutive failures the backoff stops; the fallback pull below, the next webhook or a manual sync tries again. A success resets the counters. Connections that are only synced by hand are not retried.
- *A full ledger.* When an import would pass the movement cap, the batch is refused whole and the connection records `lastError` (`Movement limit reached: … Delete older movements, then sync again.`) with `nextRetryAt: null`. Retrying cannot help, so the engine stops there: no backoff, and timers, webhooks and the fallback pull leave that connection alone (notifications stay in the queue). Delete movements and call `POST /users/:id/bank/sync`: a successful manual sync clears the error and automatic syncs resume. After a restart the engine tries once and stops again if the ledger is still full.
- *Polling fallback.* A connection of a provider with webhooks is pulled anyway when nothing was attempted for five minutes, so a notification the bank gave up on (a dead letter) only delays a movement.

**Live events.** The stream first sends `event: ready` with `{ latestRevision, requiresRefresh, synthetic }`, replays persisted events after the cursor, then pushes every new revision, whatever caused it (sync, runtime feed or a manual import):

```text
id: 7
event: bank.updated
data: {"sequence":7,"occurredAt":"2026-11-21T12:00:05.000Z","type":"bank.updated","accountCount":1,"transactionCount":16,"synthetic":true}
```

`data` has exactly the shape of an item of `GET /events`. A comment line `: heartbeat` is sent every 15 seconds. Reconnect with `?after=<last id>` or the standard `Last-Event-ID` header; when both are sent (a browser's `EventSource` repeats its address and adds the header) the later of the two counts, so nothing is replayed twice; `requiresRefresh: true` means the cursor is older than the retained log or ahead of the ledger, so refresh accounts and summary first. Browsers cannot set the bearer header on `EventSource`: with a token, consume the stream server-side or with `fetch`. A page of ReloCat's own origin uses its session cookie instead, at `GET /api/me/bank/events/stream`: the same stream for the signed-in caller, with no user id in the address (401 without a session or from another origin; there is no other `/api/me/...` route). The standalone `/workspace` page follows it and reads the events by cursor; it falls back to polling when the stream is refused or does not become ready within ten seconds (some proxies buffer event streams), inside a chat host, and for the read-only demo personas, which have no stream. At most 100 streams are open per process, and streams end when the server closes. In-process code can subscribe with `createProfileApiHandler(...).bankEvents.onEvent(listener)`.

## Banc Demo: the worked example

[`packages/banks/providers/demo-bank.ts`](../../packages/banks/providers/demo-bank.ts) is one file that connects ReloCat to [Banc Demo](../demo-bank/README.md), a fictional bank running as a separate process (`npm run start:demo-bank`). It is the reference for everything a real provider has to do:

| Concern | How the file handles it |
| --- | --- |
| Configuration | `BANK_DEMO_BANK_BASE_URL`, `BANK_DEMO_BANK_API_KEY`, `BANK_DEMO_BANK_WEBHOOK_SECRET`; without them the provider is listed as `unconfigured`. |
| Which customer | `connection.ref` is the bank's customer ID (`cust-001`), a non-secret reference. |
| Money | The bank sends decimal strings; `decimalToCents` makes integer cents. |
| States | `pending` stays `pending`, `completed` becomes `booked`, `declined` and `reverted` go to `removedIds`. |
| Idempotency | `stableId('demo-bank', tx.id)`: a pending payment that completes updates its row. |
| Incremental pull | The bank's opaque change cursor is saved as `nextCursor`; a refused cursor (410) restarts from `since`. |
| Own transfers | `counterparty.own_account` maps to `internal_transfer`, which summaries exclude. |
| Webhook security | Hex HMAC-SHA256 over `<timestamp>.<raw body>`, constant-time, five-minute window against replays. |
| Redeliveries | The event ID is returned as `eventId`, so the engine ignores a repeat. |
| Errors | Timeouts (10 s) and HTTP failures become short `ApiError` messages without URLs or keys. |

`npm run dev` starts both ends and connects them (see the [Banc Demo guide](../demo-bank/README.md#run-it)); to run the bank as a separate process use `DEMO_BANK=off`, `npm run start:demo-bank`, `npm run dev` and `npm run demo-bank:connect`. `tests/demo-bank.test.ts` starts both services in one process and covers the webhook path, state changes, own transfers, bad signatures, retries with the receiver down, duplicates, restarts and pull-only convergence.

## Add a bank

1. Copy `packages/banks/providers/_template.ts` to `packages/banks/providers/<your-bank>.ts`. That is the only file; the registry finds it.
2. Set `id`, `displayName`, `synthetic` and the `env` list. Variables are named `BANK_<PROVIDER_ID>_<NAME>` (`my-bank` reads `BANK_MY_BANK_CLIENT_ID`); the provider receives their values in `context.env` and reads no other configuration. Add the names, without values, to `.env.example`.
3. Implement two functions: `listAccounts(connection, context)` and `fetchTransactions(connection, { since, ...context })`. Return ledger-shaped rows: integer EUR cents (`decimalToCents`), a ledger category (`safeCategory`), `booked` or `pending`, and IDs that are the same on every fetch (`stableId`).
4. If the bank can notify us, implement `verifyWebhook(request, context)` and `parseWebhook(rawBody, context)` and register `https://<origin>/api/webhooks/bank/<id>` at the bank. Otherwise set `pollIntervalMs`. Return the bank's notification ID as `eventId` so redeliveries are ignored, and list declined or reverted movements in `removedIds`.
5. If people authorise access at the bank, implement `consent` (`beginConsent` and `completeConsent`) from the bank's documented redirect flow and register `https://<origin>/bank/consent/callback` as the redirect URI. The engine handles state, expiry, the session binding and sealing; the provider only talks to the bank. Without it, only the operator can link the bank.
6. Set the variables (and `DATA_ENCRYPTION_KEY` when the provider has `consent`), restart, and check `GET /bank/providers`, `POST /users/:id/bank/connections` and `POST /users/:id/bank/sync`.

A provider missing a required variable is listed as `unconfigured` and does not stop the server. Test a provider the way `tests/banks.test.ts` does: pass `createBankRegistry([provider], env)` as `bankRegistry` to `createProfileApi`.

## What a production bank still needs

The provider contract, sync engine, truthful labels and events are in place, and a provider with `synthetic: false` can connect and sync. That is not enough to put a real customer's bank data behind this API. Still missing:

- **A real consent flow, verified against a real bank.** The contract, the engine, expiry and renewal exist and run end to end against the fictional Banc Demo. No real bank's redirect, strong customer authentication or consent API has been implemented or tested; each must come from that bank's documentation and sandbox.
- **Token refresh.** A provider gets back, decrypted, the one value `completeConsent` returned. There is no slot for a short-lived access token that is refreshed from a longer-lived one, and no rotation of a stored credential other than consenting again.
- **Key management.** One `DATA_ENCRYPTION_KEY` from the environment seals every credential. There is no key rotation (changing the key makes people connect again), no hardware or managed key store, and the ledger itself is not encrypted: movements, accounts and answers are plain rows of the SQLite file.
- **Audit.** There is no audit trail of who connected, synced, imported or corrected what, and no retention policy beyond the 100000-movement cap per user. Deletion is complete (`/account`) and a person can export everything, but neither leaves a record.
- **A real provider.** None ships; `demo-bank` shows the shape against a fictional bank. Each bank or aggregator must be implemented from its own documentation and verified against its sandbox, including pagination, rate limits and error handling.
- **Webhook hardening.** The route checks the provider's signature, bounds the body, queues durably and ignores repeated event IDs; the timestamp window is the provider's job (see `demo-bank`). The one server limits webhook calls per client address (`WEBHOOK_RATE_LIMIT_PER_MINUTE`); source allow-lists are left to the deployment.

## Persistence and limitations

Ledger reads/writes are separate from the profile's `bank-account` snapshot document. Updating one does not synchronize the other, and neither refreshes committed JSON/CSV exports. The API derives balances from the ledger, not stale profile totals. Runtime records remain git-ignored.

Storage is the SQLite database `DATABASE_FILE`. Every ledger change is one transaction that also bumps the user's revision and appends its event, so a failed or interrupted change leaves the previous ledger, and an import of N movements writes N rows rather than the whole ledger. Summaries, balances and movement pages are computed by the database for the period asked, from its indexes; recurring-expense candidates are looked for in the period and the twelve months before it. Reads never wait for a writer. Writers in other processes exclude each other (`BEGIN IMMEDIATE`), so imports stay idempotent with more than one instance on the same file; a write that finds the database busy for more than 250 ms is answered with 503 and `Retry-After` instead of holding the server, and can simply be sent again. Polling timers and event streams are still per process. Concurrent full replacements of the same transaction use last-write-wins. There is no audit history. The operator's token reads and writes every user; a person's own credential reaches only their own. Real bank data additionally needs what [What a production bank still needs](#what-a-production-bank-still-needs) lists.
