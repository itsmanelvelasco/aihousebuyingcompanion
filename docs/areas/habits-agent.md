# Habits area

Branch: `feat/habits-agent`. Owner: habits development; coordinate shared contracts with integration. This is a separate feature from the bank worker and does not modify bank data.

- Entry point: `apps/habits-agent/server.ts`, started by `npm run start:habits` on port 3002.
- Contracts: `apps/habits-agent/contracts.ts`; strict aggregate summaries, user-reviewed habit goals and explicit check-ins.
- Rules/AI: `apps/habits-agent/agent.ts`; rules by default, optional `gpt-6.2-sol` Responses requests only on explicit demand.
- Persistence: `apps/habits-agent/store.ts`; separate ignored runtime files, no changes to committed profile fixtures.
- Verification: `tests/habits.test.ts`; mock API tests make no paid calls.
- Setup, routes and cost limits: [service README](../../apps/habits-agent/README.md).

Handoff: bank analysis supplies category totals and recurring-category counts with source period and completeness. Never forward raw movements, descriptions, bank IDs, check-in notes or identity. The app shows suggestions for review, then explicitly creates goals/check-ins via this API. Monetary targets are user assumptions. There are no automatic financial actions, reminders, credit decisions or guaranteed savings. Production auth and frontend/MCP integration are later work.

The [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) remains authoritative for scope; current hackathon priority is the municipality/incentive journey. Habits are complementary and must not block it.
