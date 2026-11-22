# Shared contracts area

**Owner:** cross-team integration owner with each producing/consuming team. **Purpose:** preserve compatible data across interview, storage, finance, MCP and the board.

## Entry points

- `packages/contracts/inputs.ts`: `inputSchema`, `resolveInputs`, `buildRecommendationInput`.
- `packages/contracts/places.ts`: town/policy data and MCP request/result schemas.
- `packages/finance/cashflow.ts`: synthetic movement, period and savings-scenario schemas.
- `packages/finance/savings.ts`: `monthsToTarget`, the one savings-timeline rule every surface uses.
- `packages/contracts/ids.ts`: `safeId` for users, accounts, movements and goals.
- `packages/contracts/habits.ts`: habit summaries, goals and check-ins.
- `apps/profile-api/bank.ts`: synthetic account/ledger schemas.

## Rules

- Validate external inputs at boundaries; reject unknown schema keys where contracts are strict.
- Keep storage money in integer EUR cents. Convert once when calling municipality tools or euro-based UI view models.
- Keep official municipality codes as strings with leading zeroes.
- Preserve `null`, zero, false and empty arrays according to the input contract; missing evidence is unknown.
- Keep `source`, `observedAt`, confirmation and conflicts. A client-reported confirmation is not verified bank identity or legal eligibility.
- Never silently drop hard constraints. The strict context adapter blocks unsupported bedroom filtering. A connected provisional town screen may proceed only with the bedroom requirement explicitly retained as an unverified property-level check; it must not claim full suitability. Incomplete commute/school requirements need follow-up.
- Keep bank event cursors/revisions distinct from persona run IDs and user IDs.

## Verification and handoff

Run root `npm run typecheck` and `npm test`. Relevant tests include inputs, bank API, finance, bank runtime/bridge and municipality MCP tests. The board is part of the root package, so the same commands cover it. End-to-end checks must exercise persisted profiles, configured plugin tools and runtime changes together.

For any contract change, identify producers, consumers, fixture migrations and exact unit changes in the same review. Add boundary tests where behavior changes; do not create parallel, incompatible representations of household needs. The context adapter prepares a request but does not itself call MCP or prove property suitability.
