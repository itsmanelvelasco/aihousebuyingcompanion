# Local synthetic profile API

Requires Node.js 24+. Run commands from the repository root:

```powershell
npm ci
$env:PROFILE_API_TOKEN = [guid]::NewGuid().ToString('N')
npm start
```

The API is part of the one ReloCat server and listens on `http://127.0.0.1:8787/api`. `PORT` changes the port. `Authorization: Bearer <PROFILE_API_TOKEN>` is the operator's admin token and reaches every route. When the variable is unset the server invents a token for that run and keeps it to itself, so set it, as above, whenever something outside the server must call `/api`; share it only with trusted local clients. A signed-in person's own OAuth token or session reaches only `/users/<their own id>/…` (every read, and writes to `inputs` and `habits`); anything else is `403`. See `packages/auth/README.md`.

Runtime state lives in one SQLite database, `DATABASE_FILE` (default `data/relocat.db`, git-ignored), opened through `packages/db`. On startup the server copies users that are missing from `data/users/` into it; an existing user is never overwritten. Edits affect the database, not the committed fixtures or aggregate exports. `PROFILE_DATA_DIR` and `HABITS_DATA_DIR` are now only legacy import sources: on the first start with an empty database, the JSON files an earlier version wrote there are imported once in a single transaction, and the files are left untouched. `npm run db:backup -- <file>` copies the database while the server runs. Start from the repo root. This is a local, shared-token demo service for synthetic data; production per-user authorization and real bank storage are not implemented. CORS is not enabled; use a same-origin backend/proxy for browser integration.

## Files and routes

A user has three documents, `details`, `preferences` and `bank-account`: three JSON files per fixture directory in `data/users/`, three rows per user in the database. All documents must be JSON objects with `schemaVersion: 1` and `synthetic: true`. Domain fields are extensible while teams agree their final contracts. `details.id` must match the user ID. IDs use lowercase letters, numbers and hyphens, up to 64 characters.

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
