# Profiles and multi-source inputs area

**Owner:** profile/fake-user team and integration owner. **Purpose:** keep household records and canonical input provenance durable across app requests, for the fictional demo personas and for people who belong to an account, each labelled truthfully.

## Entry points

- `apps/profile-api/server.ts`: authenticated profile, input, context and bank routes.
- `packages/profiles/store.ts`: profile section storage.
- `apps/profile-api/inputs.ts`: source-event storage, normalization and context assembly.
- `packages/contracts/inputs.ts`: schemas, resolution and municipality input adapter.
- `data/users/`: 500 committed synthetic profile fixtures; `scripts/generate-users.ts` regenerates them.

## Inputs and outputs

Each user has three documents: `details`, `preferences` and `bank-account`. The fixtures are JSON files; runtime copies are rows of the SQLite database `DATABASE_FILE` (default `data/relocat.db`, ignored by Git), one JSON document per section because their fields are intentionally open. Writes do not modify committed fixtures or aggregate exports. Source records are rows of `input_records` (at most 500 per user; beyond that only superseded records are pruned, see the retention rule in INPUTS.md) and produce a context containing normalized fields, provenance, conflicts and a prepared recommendation request.

Use `POST /users/:id/inputs` for partial records and `GET /users/:id/context` for a combined view. The exact conflict/recency rules and route examples are in [INPUTS.md](../../apps/profile-api/INPUTS.md). Snapshots are not live ledger summaries. Invalid/unknown facts must remain visible rather than becoming zero or confirmed eligibility.

`synthetic` is a real boolean on every stored record and document: `true` for fixtures and demo personas, `false` for whatever is written by or for a person who belongs to an account, unless its source is itself fabricated (movements of the synthetic and demo-bank providers, and `bank` inputs derived from them). Migration 3 corrected the rows of existing account-owned people, and a database trigger keeps the rule for accounts created later. Aggregates (the input file, the context, the habit state, ledger heads, summaries) say `true` only when every contributing record is fabricated; a real person without records is never `true`. A real person connected to the fictional bank therefore has a real profile and synthetic movements, and each is labelled as what it is.

The balance of the bank snapshot is never proposed as savings for the purchase: the context returns it as `bankSnapshot`, an unconfirmed fact of its own, and `finance.currentSavingsCents` comes only from a declared or confirmed input (or `preferences.purchaseSavingsCents`). See INPUTS.md.

## Run and verify

Run `npm start` (served under `/api` on port 8787); set `PROFILE_API_TOKEN` first when a client outside the server must call it, otherwise a token is invented for that run. `DATABASE_FILE` changes where runtime state is stored; `PROFILE_DATA_DIR` (a leftover, read by the legacy import only) is where JSON files of an earlier version are imported from, once, into an empty database. Files that import skipped (truncated, invalid, over a store limit) are reported with their reason and can be imported after repair with `npm run db:import-legacy -- <profileDir> [habitsDir]`, which never imports a file twice (see the profile API README). Reads use deferred read transactions and never wait for a writer; a write that finds the database busy is answered with a retryable 503. `npm run typecheck` and `npm test` cover storage, input merging, authorization and fixture consistency.

## Handoff

Give the interviewer/frontend stable user IDs and context readiness; give municipality matching only the validated recommendation payload. Keep unsupported hard requirements in a separate pending-check list. Do not rewrite another team's fixtures or reset runtime data to make a demo pass. `/api` checks every `/users/<id>` against the credential: the operator's admin token reaches everything, a person's own session or OAuth token only their own id ([accounts](../../packages/auth/README.md), matrix in `tests/auth.test.ts`). No real bank is integrated, so no production financial records are stored.
