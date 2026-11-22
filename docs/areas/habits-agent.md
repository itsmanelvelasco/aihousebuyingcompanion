# Habits area

Owner: habits development; coordinate shared contracts with integration. This is a separate feature from the bank worker and does not modify bank data.

- Entry point: `apps/habits-agent/server.ts`, a handler mounted by the one server (`npm start` or `npm run dev`) under `/api` on port 8787, with the same bearer token as the rest of `/api`.
- Contracts: `packages/contracts/habits.ts`; strict aggregate summaries, user-reviewed habit goals and explicit check-ins.
- Rules/AI: `packages/finance/habits.ts` (rules) and `apps/habits-agent/agent.ts` (optional model); rules by default, optional `gpt-6.2-sol` Responses requests only on explicit demand.
- Persistence: `apps/habits-agent/store.ts` over `packages/db/habits.ts`; tables `habit_goals`, `habit_checkins` and the `ai_usage` counter in the runtime database, no changes to committed profile fixtures.
- Verification: `tests/habits.test.ts`; mock API tests make no paid calls.
- Setup, routes and cost limits: [service README](../../apps/habits-agent/README.md).

Handoff: bank analysis supplies category totals and recurring-category counts with source period and completeness. Never forward raw movements, descriptions, bank IDs, check-in notes or identity. The app shows suggestions for review, then explicitly creates goals/check-ins via this API. Monetary targets are user assumptions. There are no automatic financial actions, reminders, credit decisions or guaranteed savings. Production auth and frontend/MCP integration are later work.

The [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) remains authoritative for scope; current hackathon priority is the municipality/incentive journey. Habits are complementary and must not block it.
