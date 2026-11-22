# Synthetic bank and runtime events area

**Owner:** bank/finance backend team. **Purpose:** produce and manage fictional movements, expose freshness/events and calculate explainable financial summaries.

## Entry points

- `apps/profile-api/bank.ts`: accounts, ledger persistence and movement CRUD/import.
- `packages/finance/cashflow.ts`: deterministic cash flow, recurring candidates and savings scenarios.
- `apps/profile-api/runtime.ts`: simulated movement producer, timers and stop/status handling.
- `apps/profile-api/server.ts`: authenticated bank routes and runtime wiring.
- `apps/mcp-server/bank-tools.ts`: HTTP-backed read-only MCP access.
- [BANK_API.md](../../apps/profile-api/BANK_API.md): account/movement formats and scenario examples.

## Data flow and boundaries

Runtime data belongs in a user's `bank-ledger.json`, separate from the original bank snapshot. Integer EUR cents are authoritative. Booked movements affect balances; income/spending summaries exclude pending movements and transfers between owned accounts. Recurring charges are candidates to confirm, not automatic subscription cancellations.

The background synthetic producer runs inside the profile API. Ledger changes carry durable revisions and a retained event log. Event consumers must retain their cursor and request a full refresh when `requiresRefresh` reports a retention/reset gap; the ledger retains the latest 500 events. MCP readers poll through `get_bank_updates`, `get_bank_runtime` and `get_bank_summary`; they do not open a real bank connection, execute payments or send proactive ChatGPT messages.

| Route below `/users/:id/bank` | Purpose |
| --- | --- |
| `GET /events?after=0&limit=50` | Read persisted revision events and the next cursor. |
| `GET /runtime` | Read enabled state, interval, ticks and latest error. |
| `POST /runtime` with `{ "enabled": true, "intervalMs": 5000 }` | Start/stop the user's simulated feed; interval range is 1000–60000 ms. |
| `POST /runtime/tick` with `{}` | Produce one simulated tick without requiring an enabled timer. |

Keep one API process as the runtime-directory writer. The producer shares that process's ledger serialization; MCP reads through HTTP rather than writing files independently. Timer enablement is process-local; ledger movements and event revisions persist. Feed enablement is explicit through the route or startup configuration, and timers stop when the server closes.

## Run, verify and hand off

Start the profile API with `PROFILE_API_TOKEN` and `npm run start:api`. Set `DEMO_BANK_USERS=user-001` (comma-separated IDs for several users) to opt into startup feeds; `DEMO_BANK_INTERVAL_MS` defaults to 5000. The combined `npm run dev` launcher defaults its demo feed to `user-001`. Follow [BANK_API.md](../../apps/profile-api/BANK_API.md) for detailed semantics. Run `npm run typecheck` and `npm test`; cover import idempotency, concurrent writes, event cursors, restart persistence, shutdown and background errors.

Give the board freshness, aggregate figures and event revision rather than credentials/raw transactions. Missing months produce unknown estimates. Financial scenarios are user-reviewed assumptions, not credit scores, mortgage approval or guaranteed affordability.
