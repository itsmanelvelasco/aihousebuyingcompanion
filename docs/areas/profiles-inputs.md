# Profiles and multi-source inputs area

**Owner:** profile/fake-user team and integration owner. **Purpose:** keep synthetic household records and canonical input provenance durable across app requests.

## Entry points

- `apps/profile-api/server.ts`: authenticated profile, input, context and bank routes.
- `packages/profiles/store.ts`: profile section storage.
- `apps/profile-api/inputs.ts`: source-event storage, normalization and context assembly.
- `packages/contracts/inputs.ts`: schemas, resolution and municipality input adapter.
- `data/users/`: 500 committed synthetic profile fixtures; `scripts/generate-users.ts` regenerates them.

## Inputs and outputs

Each user has three documents: `details`, `preferences` and `bank-account`. The fixtures are JSON files; runtime copies are rows of the SQLite database `DATABASE_FILE` (default `data/relocat.db`, ignored by Git), one JSON document per section because their fields are intentionally open. Writes do not modify committed fixtures or aggregate exports. Source records are rows of `input_records` (at most 500 per user; beyond that only superseded records are pruned, see the retention rule in INPUTS.md) and produce a context containing normalized fields, provenance, conflicts and a prepared recommendation request.

Use `POST /users/:id/inputs` for partial records and `GET /users/:id/context` for a combined view. The exact conflict/recency rules and route examples are in [INPUTS.md](../../apps/profile-api/INPUTS.md). Snapshots are not live ledger summaries. Invalid/unknown facts must remain visible rather than becoming zero or confirmed eligibility.

## Run and verify

Run `npm start` (served under `/api` on port 8787); set `PROFILE_API_TOKEN` first when a client outside the server must call it, otherwise a token is invented for that run. `DATABASE_FILE` changes where runtime state is stored; `PROFILE_DATA_DIR` is only where JSON files of an earlier version are imported from, once, into an empty database. `npm run typecheck` and `npm test` cover storage, input merging, authorization and fixture consistency.

## Handoff

Give the interviewer/frontend stable user IDs and context readiness; give municipality matching only the validated recommendation payload. Keep unsupported hard requirements in a separate pending-check list. Do not rewrite another team's fixtures or reset runtime data to make a demo pass. Production per-user authorization and real financial storage are not implemented by this shared-token demo.
