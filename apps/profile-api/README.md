# Local synthetic profile API

Requires Node.js 24+. Run commands from the repository root:

```powershell
npm ci
$env:PROFILE_API_TOKEN = [guid]::NewGuid().ToString('N')
npm start
```

The API is part of the one ReloCat server and listens on `http://127.0.0.1:8787/api`. `PORT` changes the port. `Authorization: Bearer <PROFILE_API_TOKEN>` is the operator's admin token and reaches every route. When the variable is unset the server invents a token for that run and keeps it to itself, so set it, as above, whenever something outside the server must call `/api`; share it only with trusted local clients. A signed-in person's own OAuth token or session reaches only `/users/<their own id>/…` (every read, and writes to `inputs` and `habits`); anything else is `403`. See `packages/auth/README.md`.

Runtime state lives in one SQLite database, `DATABASE_FILE` (default `data/relocat.db`, git-ignored), opened through `packages/db`. On startup the server copies users that are missing from `data/users/` into it; an existing user is never overwritten. Edits affect the database, not the committed fixtures or aggregate exports. `PROFILE_DATA_DIR` and `HABITS_DATA_DIR` are now only legacy import sources: on the first start with an empty database, the JSON files an earlier version wrote there are imported once in a single transaction, and the files are left untouched (see [Legacy JSON files](#legacy-json-files)). `npm run db:backup -- <file>` copies the database while the server runs. Start from the repo root. Real bank storage is not implemented. CORS is not enabled; use a same-origin backend/proxy for browser integration.

## Files and routes

A user has three documents, `details`, `preferences` and `bank-account`: three JSON files per fixture directory in `data/users/`, three rows per user in the database. All documents must be JSON objects with `schemaVersion: 1` and a boolean `synthetic`: `true` for a fixture or demo persona, `false` for a person who belongs to an account. The flag is required, the three documents of a person carry the same one, and replacing a document never changes it (400): real data is not relabelled synthetic, nor the reverse. Domain fields are extensible while teams agree their final contracts. `details.id` must match the user ID. IDs use lowercase letters, numbers and hyphens, up to 64 characters.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/users` | Sorted user IDs in `{ "users": [...] }`. |
| POST | `/users` | Create all three documents; 201 or 409 if the ID exists. |
| GET | `/users/:id` | Full profile with keys `details`, `preferences`, `bank-account`. |
| GET | `/users/:id/:section` | Read one of the three documents. |
| PUT | `/users/:id/:section` | Replace the complete section, not a partial merge. |

`POST /users` accepts this shape (additional fields belong inside each section):

```json
{
  "details": { "schemaVersion": 1, "synthetic": true, "id": "demo-501", "name": "Fictional household 501" },
  "preferences": { "schemaVersion": 1, "synthetic": true, "schoolStages": ["ESO"] },
  "bank-account": { "schemaVersion": 1, "synthetic": true, "currency": "EUR", "balanceCents": 200000 }
}
```

Read and update an existing preference document in PowerShell:

```powershell
$headers = @{ Authorization = "Bearer $env:PROFILE_API_TOKEN" }
$uri = 'http://127.0.0.1:8787/api/users/user-001/preferences'
$preferences = Invoke-RestMethod -Uri $uri -Headers $headers
$preferences | ConvertTo-Json -Depth 20
# Edit properties in $preferences, then save the entire document:
Invoke-RestMethod -Uri $uri -Method Put -Headers $headers -ContentType 'application/json' -Body ($preferences | ConvertTo-Json -Depth 20)
```

Invalid documents/IDs return 400, unauthenticated requests 401, unknown users/sections 404, unsupported methods 405 and bodies over 256 KiB 413. Each write is one database transaction. Concurrent updates to one section use last-write-wins; there is no edit conflict detection. Never place real bank credentials or account records in this demo service.

## Dataset exports and checks

`data/synthetic-users.json` contains all 500 nested profiles. `data/synthetic-users.csv` contains a flattened summary for spreadsheet import. These are fixture snapshots, not live API exports. See [dataset documentation](../../data/users/README.md) for demographic sources and generation assumptions.

```powershell
npm run typecheck
npm test
npm run generate:users
# Intentionally regenerate existing fixtures and both exports:
npm run generate:users -- --overwrite
```

## Bank movements and financial scenarios

The same server now exposes a [bank ledger API](BANK_API.md) for synthetic accounts, transactions, cash-flow summaries and savings scenarios. It stores accounts, movements and ledger events as rows of the same database, separate from the profile documents. It does not automatically modify the profile's `bank-account` snapshot or fixture exports.

## Several input sources

Use [the shared input contract](INPUTS.md) to submit partial interview answers, manual preferences, bank aggregates and property facts. `/users/:id/context` combines them with saved profile data, exposes conflicts and prepares a validated town-tool request when required facts are available.

## Reads, writes and a busy database

Reads and writes take different transactions (`packages/db/database.ts`). A read (`db.read`) is a deferred transaction on the write-ahead log: it sees one consistent snapshot and never waits for a writer, of this process or another. A write (`db.transaction`) takes the write lock at once. Waiting for a lock is synchronous and would stop the whole server, so a write waits at most 250 ms (`busyTimeoutMs`) and then fails with `DatabaseBusyError`. `/api` answers that with **503**, `Retry-After: 1` and `{ "error": "Storage is busy; try again shortly", "retryable": true }`: nothing was written, and the same request can be sent again. Opening and migrating the file still waits up to 5 s, because nothing is being served yet.

Summaries are computed by the database: `GET /users/:id/bank/summary` runs two grouped queries over the date index (the period, and the period plus the twelve months before it for recurring expenses) and loads no movement. On a ledger of 100,000 movements a three-month summary takes about 50 ms and a 24-month one about 150 ms, down from about 380 ms and 415 ms when every movement was loaded; balances take about 10 ms. These calls are still synchronous. `GET /users/:id/bank/transactions` pages through the index, and `createBankStore(...).read()`, which loads a whole ledger (about 300 ms at 100,000 movements), is used by tests only.

## Legacy JSON files

On its first start with an empty database the server imports the JSON files an earlier version wrote under `PROFILE_DATA_DIR` and `HABITS_DATA_DIR`. Each file is validated with the schemas and limits of the running stores (500 input records, 20 accounts, 100,000 movements per user, a revision counter that can still be incremented), so nothing gets in that the stores would refuse. A file that is truncated, invalid or over a limit is skipped as a whole and reported with its reason, and the rest is imported; the files themselves are only read.

Each imported file is recorded by name in the `legacy_import_files` table. To import what the first start skipped, repair the file and run:

```powershell
npm run db:import-legacy -- data/runtime-users data/runtime-habits
```

Without arguments it reads `PROFILE_DATA_DIR` and `HABITS_DATA_DIR`. The command imports only files that are not recorded yet, adds only records whose IDs are not in the database, and overwrites nothing: a ledger that has moved on keeps its movements and gets one new revision for the ones that were missing. It can be run again at any time and while the server runs; a second run imports nothing. It exits with 0 when every file found is in the database and with 2 when some were skipped, listing each with its reason.
