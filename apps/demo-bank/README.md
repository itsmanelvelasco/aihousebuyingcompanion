# Banc Demo: a fictional bank service

Banc Demo (`demo-bank`) is a stand-in for the business API of a modern bank. It runs as its own process on its own port and knows nothing about ReloCat. ReloCat talks to it over HTTP through one provider file, [`packages/banks/providers/demo-bank.ts`](../../packages/banks/providers/demo-bank.ts), exactly as it would talk to a real bank: it **pulls** accounts and transactions with a bearer key, and the bank **pushes** signed webhook events when something changes.

It exists so that webhooks, signatures, cursors, retries and state changes run against a real peer instead of an in-process fake.

**It is a demo.** Every customer, account and transaction is fabricated: every resource carries `"synthetic": true` and every response the header `X-Demo-Bank: fictional`. It is one process with its state in memory (a rolling window of the newest transactions), no database, no real money and no relation to any real bank. Do not put real data in it.

## Which fictional bank is this

Three fictional banks exist in this repository. None is real, all are labelled, and they are not interchangeable:

| Which | Where | What it is | Used by | Label a person sees |
| --- | --- | --- | --- | --- |
| **Banc Demo** | `apps/demo-bank`, provider `demo-bank` | A fictional bank service: pull API, signed webhooks, a consent page. The live bank. | The default feed of `user-001` while `DEMO_BANK` is on; any signed-in person who connects it on `/account`. | "Banc Demo (fictional bank)"; records `synthetic: true` |
| **In-process synthetic feed** | `apps/profile-api/runtime.ts`, provider `synthetic` | A timer inside the server that appends fabricated movements to a ledger. No HTTP, no webhook, no consent. | Only the users named in `DEMO_BANK_USERS`, or `user-001` when `DEMO_BANK=off` outside production. | fictional bank / synthetic; records `synthetic: true` |
| **Static sample statement** | `data/demo-bank.csv` | A fixed CSV of fabricated movements. It never changes and reaches no ledger. | The `/interview` page, the `sample_cash_flow` tool and `packages/finance/scenario.ts`: a worked example for somebody with no bank data. | fictional sample; results `synthetic: true` |

Never feed one ledger from two of them: the histories would be summed. The server leaves a user Banc Demo feeds out of the in-process feed, also when `DEMO_BANK_USERS` lists them.

## Run it

**With ReloCat, nothing to do.** Outside production (`NODE_ENV` other than `production`) `npm run dev` and `npm start` start the bank inside the server process: its keyed API on port 3003 of this machine, and its consent page on ReloCat's own origin under `/banc-demo` (see [One origin](#one-origin)). They invent its API key and signing secret for that run when they are not configured, register ReloCat's webhook, link `user-001` to `cust-001` and pull the history. The bank's state is kept in `data/cache/demo-bank.json`. When the server restarts with a new signing secret, the webhook already stored in that file is given the new secret, so deliveries keep being accepted. `DEMO_BANK=off` switches all of this off.

**As its own process**, the way a real bank would be, set `DEMO_BANK=off` and:

```powershell
# .env (any long random strings for the two secrets)
BANK_DEMO_BANK_BASE_URL=http://127.0.0.1:3003
BANK_DEMO_BANK_API_KEY=<random>
BANK_DEMO_BANK_WEBHOOK_SECRET=<random>
PROFILE_API_TOKEN=<random>

npm run start:demo-bank      # terminal 1: the bank, http://127.0.0.1:3003
npm run dev                  # terminal 2: ReloCat, http://127.0.0.1:8787
npm run demo-bank:connect    # once: register the webhook, link user-001 to cust-001, first pull
```

`demo-bank:connect` is idempotent and accepts `-- --user user-002 --customer cust-002`. It registers `http://127.0.0.1:8787/api/webhooks/bank/demo-bank` at the bank, creates the user's `demo-bank` connection in ReloCat and pulls the history. From then on each simulated movement arrives by webhook. If the webhook already exists but signs with a secret other than `BANK_DEMO_BANK_WEBHOOK_SECRET` (ReloCat was restarted with a new one), the command sets the current secret on it instead of leaving every delivery to be rejected with 401.

Leave `DEMO_BANK_USERS` unset or empty for a user you link here. It starts the older in-process synthetic feed for the users it lists; a user fed by both gets two fictional histories summed in one ledger.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEMO_BANK_PORT` | `3003` | Port of the bank. |
| `DEMO_BANK_API_KEY` | value of `BANK_DEMO_BANK_API_KEY` | Bearer key of the pull and webhook routes. Required. |
| `DEMO_BANK_ADMIN_KEY` | the API key | Bearer key of the `/simulate` routes. |
| `DEMO_BANK_WEBHOOK_SECRET` | value of `BANK_DEMO_BANK_WEBHOOK_SECRET` | Signing secret given to every webhook subscription. Unset: a random secret per subscription. |
| `DEMO_BANK_TICK_MS` | `5000` | Pause between simulated movements (100 ms to 1 hour). When unset, `DEMO_BANK_INTERVAL_MS` is read instead: that older name also paces ReloCat's in-process synthetic feed, which is why the bank has its own. |
| `DEMO_BANK_SEED` | `banc-demo` | Same seed, start date and customer count give the same history. |
| `DEMO_BANK_START_DATE` | first day of the month three months ago | First simulated day, `YYYY-MM-DD`. The default is decided when the bank first starts and then kept in the snapshot. |
| `DEMO_BANK_CUSTOMERS` | `4` | Customers `cust-001` ... |
| `DEMO_BANK_SNAPSHOT_FILE` | none (`data/cache/demo-bank.json` when started by the ReloCat server) | JSON file that keeps the state across restarts. |
| `DEMO_BANK_ALLOW_REMOTE_WEBHOOKS` | off | Allow webhook URLs that are not on this machine. |

The fallbacks to `BANK_DEMO_BANK_*` let one `.env` configure both ends. A real bank issues the signing secret when the webhook is registered; fixing it in the environment is a demo convenience so ReloCat can be started before the webhook exists.

## One origin

A person's browser often cannot reach port 3003: ReloCat is behind a tunnel, or deployed. So the server that starts the bank also serves the one page a person opens, on its own origin:

| Who calls | Address | Notes |
| --- | --- | --- |
| The person's browser | `<origin>/banc-demo/consent/<id>` (GET and POST) | `<origin>` is wherever they reached ReloCat: `PUBLIC_ORIGIN`, a host in `ALLOWED_HOSTS`, or localhost. The bank sends them back to `<origin>/bank/consent/callback`. |
| Anyone | `<origin>/banc-demo/health` | `{ "status": "ok", "service": "demo-bank", "synthetic": true }` |
| ReloCat, server to server | `http://127.0.0.1:3003/...` | Pull API, `/consents`, webhook registry, `/simulate`. Bearer keys. Not served under `/banc-demo`: with or without a key those paths answer 404 there. |
| The bank, server to server | `http://127.0.0.1:<PORT>/api/webhooks/bank/demo-bank` | Signed webhooks, on loopback. |

What makes it safe is unchanged: the consent id is 128 random bits and expires in ten minutes; the bank only redirects to the return address ReloCat registered with its API key, and only accepts return addresses on this machine or on the origins in `DEMO_BANK_RETURN_ORIGINS` (the server fills in its `PUBLIC_ORIGIN` and `ALLOWED_HOSTS`); ReloCat accepts the callback once, from the browser session that started it; the page has no script and a `default-src 'none'` policy, and says "Fictional bank" in every language.

The provider builds the person's address from `BANK_DEMO_BANK_PUBLIC_PATH` (the server sets `/banc-demo`) and the origin of the callback address, so it follows the origin the person is actually on. Without that variable (a bank you run as its own process) the person is sent to `BANK_DEMO_BANK_BASE_URL`.

**Production.** With `NODE_ENV=production` the bank does not start. `DEMO_BANK=on` starts it there too, for a public demo that shows the live bank. The trade-off: the site then offers a bank that is entirely fictional. It is labelled everywhere and touches no real account, but visitors can link its invented customers to their accounts and `user-001`'s public demo ledger keeps growing; leave it off on a site that connects real banks. `DATA_ENCRYPTION_KEY` is required, as for any bank with a consent.

## The simulation

Each customer has a current account and a savings account in EUR and lives a scripted month:

- salary on a fixed day (24th to 27th, by customer) and a transfer to the savings account the day after;
- rent on the 1st, a transport pass on the 2nd, electricity, water and internet on the 4th, 9th and 14th, three subscriptions on the 6th, 17th and 21st;
- groceries on Mondays, Thursdays and Saturdays, and a transport ticket on about one day in four;
- about one day in six a card payment that stays `pending` and settles a simulated day later (nine in ten complete, one is reverted), and now and then a payment the bank declines.

The plan is a pure function of the seed, the customer and the calendar day ([`simulation.ts`](simulation.ts)). The bank walks it one movement per tick. **The calendar is simulated**: at start the bank silently replays the plan from the start date up to the present, so there is history to pull; after that every tick jumps to the next planned movement, so a month goes by in a few minutes and transaction dates run ahead of the wall clock. Event timestamps, signatures and retry delays use the real clock.

The bank never stops producing movements. It keeps a **rolling window** of the 5000 transactions that changed most recently (about seven hours of history at the default pace). When a new one arrives the oldest leaves: its amount, if it completed, stays in the account's balance, and the account's `opening_balance` and `opened_on` move forward to the start of the window, so opening balance plus the listed completed transactions always equals `balance`. A reader whose cursor is older than the window gets `410` and starts again without a cursor, receiving the window; what it had already imported stays in its own ledger. `/simulate/status` reports `transactions`, `max_transactions` and `dropped_transactions`; `paused_reason` is kept for older readers and is always `null`.

## Pull API

`Authorization: Bearer <API key>` on every route except `/health`. Errors are `{ "error": "..." }`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, no key. |
| GET | `/customers` | The fictional customers. |
| GET | `/customers/:customerId/accounts` | The customer's accounts. |
| GET | `/customers/:customerId/transactions?from=&cursor=&limit=&account_id=` | One page of transactions. |
| GET | `/customers/:customerId/transactions/:transactionId` | One transaction. |

```json
{
  "id": "acc-001-main", "customer_id": "cust-001", "name": "Compte corrent fictici", "type": "current",
  "currency": "EUR", "balance": "2796.33", "opening_balance": "2919.00", "opened_on": "2026-08-01",
  "synthetic": true
}
```

```json
{
  "id": "tx-000592", "customer_id": "cust-001", "account_id": "acc-001-main",
  "type": "card_payment", "state": "completed", "amount": "-42.10", "currency": "EUR",
  "description": "Sopar de prova",
  "counterparty": { "name": "Sopar de prova", "own_account": false, "account_id": null },
  "merchant_category": "restaurants", "transfer_id": null,
  "created_at": "2026-11-23T18:03:53.000Z", "updated_at": "2026-11-23T18:03:53.000Z",
  "completed_at": "2026-11-23T18:03:53.000Z", "synthetic": true
}
```

- **Amounts** are signed decimal strings with a currency: negative is money out. `balance` is the opening balance plus completed transactions. `opening_balance` is the balance just before the oldest transaction the bank still lists and `opened_on` the day of that transaction; both start at the first simulated day and move forward with the rolling window.
- **States**: `pending` → `completed` | `declined` | `reverted`. A transaction can also be born `completed` or `declined`. Only `completed` moves money.
- **Types**: `card_payment`, `direct_debit`, `transfer`, `salary`. **Merchant categories**: `salary`, `rent`, `utilities`, `groceries`, `restaurants`, `transport`, `subscriptions`, `health`, `education`, `shopping`, `loan`, `transfer`, `other`.
- **Own-account transfers** are two transactions, one per account, with opposite amounts, the same `transfer_id` and `counterparty.own_account: true`.
- **Pagination and ordering**: the list is in *change order*, oldest change first; a transaction that changes state moves to the end. The answer is `{ transactions, next_cursor, has_more, synthetic }`. Pass `next_cursor` back as `cursor` to read on; store the last one and the next read returns only what was created or changed since. `limit` is 1 to 200 (default 100). `from` (`YYYY-MM-DD` or a UTC timestamp with milliseconds) keeps transactions created at or after it. A cursor issued before the bank lost its state, or one so old that changes after it have left the rolling window, is refused with `410`: start again without a cursor.

## Push: webhooks

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/webhooks` | Body `{ "url": "http://127.0.0.1:8787/api/webhooks/bank/demo-bank", "events"?: [...] }`. Returns 201 with the subscription, `signing_secret` (shown only here) and `signature_tolerance_seconds`. At most 10; loopback URLs only unless remote ones are allowed. |
| GET | `/webhooks` | Subscriptions, without secrets. Each has a `secret_fingerprint`, a short hash that changes when the secret changes, so the owner can tell whether the bank still signs with the secret the receiver verifies with. |
| PUT | `/webhooks/:id/secret` | Rotate the signing secret. Body `{ "signing_secret"?: "…" }` (16 to 200 characters); without it the bank invents one. Returns the subscription with the new `signing_secret`. Deliveries still waiting are signed with the new secret on their next attempt. |
| DELETE | `/webhooks/:id` | Remove one. |
| GET | `/webhooks/deliveries?state=&limit=` | The delivery log, newest first (the last 500). |

Two events exist, `TransactionCreated` and `TransactionStateChanged`. The bank POSTs:

```http
POST /api/webhooks/bank/demo-bank
Content-Type: application/json
X-Demo-Bank: fictional
X-Demo-Bank-Event-Id: evt-000006
X-Demo-Bank-Timestamp: 1795363033000
X-Demo-Bank-Signature: 5f0c...e1 (64 hex characters)
X-Demo-Bank-Delivery-Attempt: 1

{"id":"evt-000006","type":"TransactionStateChanged","created_at":"2026-11-22T15:57:13.000Z","synthetic":true,
 "data":{"customer_id":"cust-001","account_id":"acc-001-main","transaction_id":"tx-000587",
         "state":"completed","previous_state":"pending"}}
```

An event is a notification, not the record: read the transaction through the pull API.

**Signature.** `X-Demo-Bank-Signature` is the lowercase hex HMAC-SHA256, keyed with the subscription's signing secret, of the string `<X-Demo-Bank-Timestamp>.<raw request body>`. The timestamp is milliseconds since the Unix epoch.

```ts
const expected = createHmac('sha256', signingSecret).update(`${timestamp}.${rawBody}`).digest('hex');
```

A receiver must compare in constant time over the raw bytes and **reject a timestamp more than 300 seconds from its own clock**: that window is the replay protection, and because the timestamp is signed an old call cannot be re-stamped.

**Idempotency.** `id` (also in `X-Demo-Bank-Event-Id`) is unique per event and stays the same on every retry. A receiver must ignore an ID it has already accepted.

**Retries.** Any answer that is not 2xx, a timeout (5 s) or a refused connection is a failure. Attempts follow after 1 s, 2 s, 4 s, 8 s and 16 s; every attempt is signed with a fresh timestamp. After the sixth failure the delivery is `dead` and is never sent again: the receiver catches up by pulling. Deliveries are sent in the background and never hold the simulation back. A delivery in the log is `{ id, event_id, event_type, webhook_id, url, state: "pending" | "delivered" | "dead", attempts, next_attempt_at, last_status, last_error, created_at, updated_at }`.

## Consent

How a customer allows an application to read their accounts. It has the shape of a real bank's redirect flow and none of its substance: there are no logins, so the page lets the visitor say which fictional customer they are. A real bank would make them sign in and pass strong customer authentication at that point.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/consents` | API key. Body `{ "redirect_uri": "http://127.0.0.1:8787/bank/consent/callback", "state": "…" }` (`state` 16 to 200 characters). Returns 201 `{ consent_id, consent_path, expires_at }`. The return address must be on this machine unless `DEMO_BANK_ALLOW_REMOTE_WEBHOOKS` is on. |
| GET | `/consent/:id` | No key: the page the customer opens. It names the host that asks, says that the bank and everything on it are fictional, and offers Allow and Deny. No script; its form may post only to the bank and be redirected to the return address. |
| POST | `/consent/:id` | The form: `decision=approve&customer_id=cust-002`, or `decision=deny`. Answers 303 to the return address with the unchanged `state` and a one-time `code`, or with `error=access_denied`. A request is decided once. |
| POST | `/consents/token` | API key. Body `{ "code": "…" }`. Returns `{ customer_id, expires_at }`: the customer reference and the day the consent ends (90 days). A code works once and for two minutes. |

A request nobody decides lapses after ten minutes. Requests and codes live in memory only and are not in the snapshot. The unguessable `consent_id` is what admits the browser to the page; there is nothing else to protect, since no login exists.

ReloCat's side is the `consent` capability of [`packages/banks/providers/demo-bank.ts`](../../packages/banks/providers/demo-bank.ts): `beginConsent` calls `POST /consents` and sends the person to the page, `completeConsent` exchanges the code. The customer reference that comes back is not a secret, but ReloCat stores it sealed like any credential a real bank would return (see the [bank API guide](../profile-api/BANK_API.md#credentials-at-rest)). A person does all of this from their ReloCat account page: **Connect** next to Banc Demo, approve at the bank, and the movements of the customer they chose start arriving by webhook.

The data routes do not check consents: one API key reads every customer, and `demo-bank:connect` still links `user-001` to `cust-001` without one. A real bank would tie every read to the consent it was granted under.

## Fire a movement on demand

The `/simulate` routes take the admin key.

```powershell
$headers = @{ Authorization = "Bearer $env:BANK_DEMO_BANK_API_KEY" }
$bank = 'http://127.0.0.1:3003'
# A card payment that completes at once
Invoke-RestMethod "$bank/simulate/transaction" -Method Post -Headers $headers -ContentType 'application/json' `
  -Body '{"customer_id":"cust-001","amount":"-42.10","description":"Sopar de prova","category":"restaurants"}'
# One that stays pending, then settles
$tx = (Invoke-RestMethod "$bank/simulate/transaction" -Method Post -Headers $headers -ContentType 'application/json' `
  -Body '{"customer_id":"cust-001","amount":"-80.00","description":"Botiga Demo","state":"pending"}').transactions[0]
Invoke-RestMethod "$bank/simulate/transactions/$($tx.id)/state" -Method Post -Headers $headers `
  -ContentType 'application/json' -Body '{"state":"completed"}'
```

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/simulate/transaction` | `{ customer_id, amount, description, account_id?, category?, type?, state?, to_account_id? }`. `state` is `completed` (default), `pending` or `declined`. `to_account_id` (another account of the customer, negative amount) makes an own-account transfer with two legs. Returns 201 with the created transactions. |
| POST | `/simulate/transactions/:id/state` | `{ "state": "completed" | "declined" | "reverted" }` for a pending transaction; 409 otherwise. |
| POST | `/simulate/step` | `{ "count"?: 1-500 }`: run that many scripted ticks now. |
| GET | `/simulate/status` | Simulation time, counters, the size of the rolling window and how many transactions have left it, delivery totals. |

## State and limits

State lives in memory. With `DEMO_BANK_SNAPSHOT_FILE` the bank writes its whole state (the seed and start date it was made with, the window of transactions and the balances carried from older ones, webhooks with their secrets, pending deliveries, simulation position) to that file shortly after every change, through a temporary file and a rename, and restores it at start. A restored bank keeps the seed and start date of its snapshot when none is configured, so the default start date ("three months ago") does not move when the month changes. The file is refused only if `DEMO_BANK_SEED` or `DEMO_BANK_START_DATE` is set to a value that differs from the snapshot's, or the customer count (`DEMO_BANK_CUSTOMERS`, default 4) differs: delete the file or restore the setting. Without it a restart begins a new life: the history is regenerated from the seed with the same IDs, webhooks must be registered again and old cursors are refused.

Run one process per snapshot file. There is no rate limiting and no per-customer authorization: one key reads every customer, with or without a consent. The [consent desk](#consent) shows the shape of the flow; enforcing it on every read belongs to a real bank, not to this stand-in.

## Code

- [`simulation.ts`](simulation.ts): the deterministic plan of a customer's day.
- [`bank.ts`](bank.ts): state, the simulation loop, the rolling window, events, deliveries with retries, the snapshot.
- [`consent.ts`](consent.ts): the consent desk: requests, the customer's page, one-time codes.
- [`server.ts`](server.ts): `createDemoBank(options)` (request handler and lifecycle, with injectable `clock`, `seed` and `fetch`), `startDemoBank`, and the standalone entry point.
- [`connect.ts`](connect.ts): `connectDemoBank`, the HTTP wiring behind `npm run demo-bank:connect`.
- [`tests/demo-bank.test.ts`](../../tests/demo-bank.test.ts): both services in one process with stepped clocks.
