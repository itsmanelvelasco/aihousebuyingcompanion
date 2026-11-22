# Banc Demo: a fictional bank service

Banc Demo (`demo-bank`) is a stand-in for the business API of a modern bank. It runs as its own process on its own port and knows nothing about ReloCat. ReloCat talks to it over HTTP through one provider file, [`packages/banks/providers/demo-bank.ts`](../../packages/banks/providers/demo-bank.ts), exactly as it would talk to a real bank: it **pulls** accounts and transactions with a bearer key, and the bank **pushes** signed webhook events when something changes.

It exists so that webhooks, signatures, cursors, retries and state changes run against a real peer instead of an in-process fake.

**It is a demo.** Every customer, account and transaction is fabricated: every resource carries `"synthetic": true` and every response the header `X-Demo-Bank: fictional`. It is one process with its state in memory, no database, no real money and no relation to any real bank. Do not put real data in it.

## Run it

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

`demo-bank:connect` is idempotent and accepts `-- --user user-002 --customer cust-002`. It registers `http://127.0.0.1:8787/api/webhooks/bank/demo-bank` at the bank, creates the user's `demo-bank` connection in ReloCat and pulls the history. From then on each simulated movement arrives by webhook.

Set `DEMO_BANK_USERS=` (empty) when you link `user-001`, otherwise the older in-process synthetic feed keeps adding its own fictional movements to the same ledger and the two histories are summed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEMO_BANK_PORT` | `3003` | Port of the bank. |
| `DEMO_BANK_API_KEY` | value of `BANK_DEMO_BANK_API_KEY` | Bearer key of the pull and webhook routes. Required. |
| `DEMO_BANK_ADMIN_KEY` | the API key | Bearer key of the `/simulate` routes. |
| `DEMO_BANK_WEBHOOK_SECRET` | value of `BANK_DEMO_BANK_WEBHOOK_SECRET` | Signing secret given to every webhook subscription. Unset: a random secret per subscription. |
| `DEMO_BANK_INTERVAL_MS` | `5000` | Pause between simulated movements (100 ms to 1 hour). |
| `DEMO_BANK_SEED` | `banc-demo` | Same seed, start date and customer count give the same history. |
| `DEMO_BANK_START_DATE` | first day of the month three months ago | First simulated day, `YYYY-MM-DD`. |
| `DEMO_BANK_CUSTOMERS` | `4` | Customers `cust-001` ... |
| `DEMO_BANK_SNAPSHOT_FILE` | none | JSON file that keeps the state across restarts. |
| `DEMO_BANK_ALLOW_REMOTE_WEBHOOKS` | off | Allow webhook URLs that are not on this machine. |

The fallbacks to `BANK_DEMO_BANK_*` let one `.env` configure both ends. A real bank issues the signing secret when the webhook is registered; fixing it in the environment is a demo convenience so ReloCat can be started before the webhook exists.

## The simulation

Each customer has a current account and a savings account in EUR and lives a scripted month:

- salary on a fixed day (24th to 27th, by customer) and a transfer to the savings account the day after;
- rent on the 1st, a transport pass on the 2nd, electricity, water and internet on the 4th, 9th and 14th, three subscriptions on the 6th, 17th and 21st;
- groceries on Mondays, Thursdays and Saturdays, and a transport ticket on about one day in four;
- about one day in six a card payment that stays `pending` and settles a simulated day later (nine in ten complete, one is reverted), and now and then a payment the bank declines.

The plan is a pure function of the seed, the customer and the calendar day ([`simulation.ts`](simulation.ts)). The bank walks it one movement per tick. **The calendar is simulated**: at start the bank silently replays the plan from the start date up to the present, so there is history to pull; after that every tick jumps to the next planned movement, so a month goes by in a few minutes and transaction dates run ahead of the wall clock. Event timestamps, signatures and retry delays use the real clock.

The simulation pauses at 5000 transactions (`paused_reason` in `/simulate/status`); restart without a snapshot to begin again.

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

- **Amounts** are signed decimal strings with a currency: negative is money out. `balance` is the opening balance plus completed transactions.
- **States**: `pending` → `completed` | `declined` | `reverted`. A transaction can also be born `completed` or `declined`. Only `completed` moves money.
- **Types**: `card_payment`, `direct_debit`, `transfer`, `salary`. **Merchant categories**: `salary`, `rent`, `utilities`, `groceries`, `restaurants`, `transport`, `subscriptions`, `health`, `education`, `shopping`, `loan`, `transfer`, `other`.
- **Own-account transfers** are two transactions, one per account, with opposite amounts, the same `transfer_id` and `counterparty.own_account: true`.
- **Pagination and ordering**: the list is in *change order*, oldest change first; a transaction that changes state moves to the end. The answer is `{ transactions, next_cursor, has_more, synthetic }`. Pass `next_cursor` back as `cursor` to read on; store the last one and the next read returns only what was created or changed since. `limit` is 1 to 200 (default 100). `from` (`YYYY-MM-DD` or a UTC timestamp with milliseconds) keeps transactions created at or after it. A cursor issued before the bank lost its state is refused with `410`: start again without a cursor.

## Push: webhooks

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/webhooks` | Body `{ "url": "http://127.0.0.1:8787/api/webhooks/bank/demo-bank", "events"?: [...] }`. Returns 201 with the subscription, `signing_secret` (shown only here) and `signature_tolerance_seconds`. At most 10; loopback URLs only unless remote ones are allowed. |
| GET | `/webhooks` | Subscriptions, without secrets. |
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
| GET | `/simulate/status` | Simulation time, counters, delivery totals, `paused_reason`. |

## State and limits

State lives in memory. With `DEMO_BANK_SNAPSHOT_FILE` the bank writes its whole state (transactions, webhooks with their secrets, pending deliveries, simulation position) to that file shortly after every change, through a temporary file and a rename, and restores it at start; the file is refused if it was made with another seed, start date or customer count. Without it a restart begins a new life: the history is regenerated from the seed with the same IDs, webhooks must be registered again and old cursors are refused.

Run one process per snapshot file. There is no rate limiting, no per-customer authorization (one key reads every customer) and no consent flow: those belong to a real bank, not to this stand-in.

## Code

- [`simulation.ts`](simulation.ts): the deterministic plan of a customer's day.
- [`bank.ts`](bank.ts): state, the simulation loop, events, deliveries with retries, the snapshot.
- [`server.ts`](server.ts): `createDemoBank(options)` (request handler and lifecycle, with injectable `clock`, `seed` and `fetch`), `startDemoBank`, and the standalone entry point.
- [`connect.ts`](connect.ts): `connectDemoBank`, the HTTP wiring behind `npm run demo-bank:connect`.
- [`tests/demo-bank.test.ts`](../../tests/demo-bank.test.ts): both services in one process with stepped clocks.
