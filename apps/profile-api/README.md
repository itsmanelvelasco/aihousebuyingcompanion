# Local synthetic profile API

Requires Node.js 24+. Run commands from the repository root:

```powershell
npm install
$env:PROFILE_API_TOKEN = [guid]::NewGuid().ToString('N')
npm start
```

The API listens on `http://127.0.0.1:3001`. `PORT` changes the port. All routes require `Authorization: Bearer <PROFILE_API_TOKEN>`. The token is required at startup; keep it in your local environment and share it only with trusted local clients.

On startup the API copies missing users from `data/users/` into git-ignored `data/runtime-users/`. Edits affect runtime copies, not the committed fixtures or aggregate exports. `PROFILE_DATA_DIR` overrides runtime storage. Start from the repo root. This is a local, single-process, shared-token demo service for synthetic data; production per-user authorization and real bank storage are not implemented. CORS is not enabled; use a same-origin backend/proxy for browser integration.

## Files and routes

Each user directory contains `details.json`, `preferences.json` and `bank-account.json`. All documents must be JSON objects with `schemaVersion: 1` and `synthetic: true`. Domain fields are extensible while teams agree their final contracts. `details.id` must match the directory/API ID. IDs use lowercase letters, numbers and hyphens, up to 64 characters.

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
$uri = 'http://127.0.0.1:3001/users/user-001/preferences'
$preferences = Invoke-RestMethod -Uri $uri -Headers $headers
$preferences | ConvertTo-Json -Depth 20
# Edit properties in $preferences, then save the entire document:
Invoke-RestMethod -Uri $uri -Method Put -Headers $headers -ContentType 'application/json' -Body ($preferences | ConvertTo-Json -Depth 20)
```

Invalid documents/IDs return 400, unauthenticated requests 401, unknown users/sections 404, unsupported methods 405 and bodies over 256 KiB 413. Writes replace individual files atomically. Concurrent updates to one section use last-write-wins; there are no cross-section update transactions or edit conflict detection. Never place real bank credentials or account records in this demo service.

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

The same server now exposes a [bank ledger API](BANK_API.md) for synthetic accounts, transactions, cash-flow summaries and savings scenarios. It stores `bank-ledger.json` in each runtime user's folder. It does not automatically modify the original `bank-account.json` snapshot or fixture exports.
