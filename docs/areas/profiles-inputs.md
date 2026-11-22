# Profiles and multi-source inputs area

**Owner:** profile/fake-user team and integration owner. **Purpose:** keep synthetic household records and canonical input provenance durable across app requests.

## Entry points

- `apps/profile-api/server.ts`: authenticated profile, input, context and bank routes.
- `packages/profiles/store.ts`: profile section storage.
- `apps/profile-api/inputs.ts`: source-event storage, normalization and context assembly.
- `packages/contracts/inputs.ts`: schemas, resolution and municipality input adapter.
- `data/users/`: 500 committed synthetic profile fixtures; `scripts/generate-users.ts` regenerates them.

## Inputs and outputs

Each user has `details.json`, `preferences.json` and `bank-account.json`. Runtime copies live under ignored `data/runtime-users/`; writes do not modify committed fixtures or aggregate exports. Source records live in `app-inputs.json` and produce a context containing normalized fields, provenance, conflicts and a prepared recommendation request.

Use `POST /users/:id/inputs` for partial records and `GET /users/:id/context` for a combined view. The exact conflict/recency rules and route examples are in [INPUTS.md](../../apps/profile-api/INPUTS.md). Snapshots are not live ledger summaries. Invalid/unknown facts must remain visible rather than becoming zero or confirmed eligibility.

## Run and verify

Set `PROFILE_API_TOKEN`, then run `npm run start:api` on port 3001. `PROFILE_DATA_DIR` changes the runtime directory. `npm run typecheck` and `npm test` cover storage, input merging, authorization and fixture consistency.

## Handoff

Give the interviewer/frontend stable user IDs and context readiness; give municipality matching only the validated recommendation payload. Keep unsupported hard requirements in a separate pending-check list. Do not rewrite another team's fixtures or reset runtime data to make a demo pass. Production per-user authorization and real financial storage are not implemented by this shared-token demo.
