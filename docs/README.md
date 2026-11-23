# Monorepo development map

The [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) owns product decisions. Code and verified checks establish delivered behavior. The core demo is Catalonia town discovery with sourced schools, transport and incentives; financial coaching is complementary.

| Area | Development entry point | Responsibility |
| --- | --- | --- |
| [Interviewer](areas/interviewer.md) | `apps/interviewer/`, `apps/board/intake.ts`, `profiles.ts` | Voice/guided interviews, cash-flow cards and confirmed structured answers. |
| [Frontend/plugin](areas/frontend-plugin.md) | `apps/web/`, `apps/board/server.ts`, `apps/mcp-server/` widgets | The workspace, the widgets, the live board and the ChatGPT plugin. |
| [Profiles/inputs](areas/profiles-inputs.md) | `apps/profile-api/server.ts`, `inputs.ts` | Persistent profiles (fictional personas and account-owned people) and multi-source context. |
| [Bank/runtime](areas/bank-runtime.md) | `apps/profile-api/bank.ts`, `packages/finance/cashflow.ts`, `packages/banks/`, `apps/demo-bank/` | Movements, event consumption and deterministic finance. |
| [Habits agent](areas/habits-agent.md) | `apps/habits-agent/server.ts`, `agent.ts` | User-reviewed goals/check-ins and optional on-demand Sol suggestions. |
| [Municipalities/incentives](areas/municipalities-incentives.md) | `apps/mcp-server/tools.ts`, `packages/places/`, `packages/sources/` | Sourced town matching, live pre-cached official data and policy screening. |
| [Shared contracts](areas/shared-contracts.md) | `packages/contracts/` | Validation, units and cross-area handoffs. |
| [Integration/deployment](areas/integration-deployment.md) | Root `package.json` and service entry points | Run services, test connections and release. |
| [Team plugins/skills](areas/team-plugins-skills.md) | `plugins/relocat-team/`, `scripts/package-team-plugin.ts` | One shared versioned bundle and verified teammate rollout. |

Shared packages with their own guide:

| Package | Guide | Responsibility |
| --- | --- | --- |
| `packages/auth` | [Accounts and OAuth](../packages/auth/README.md) | Accounts, sessions, OAuth 2.1 for MCP clients, throttling. |
| `packages/i18n` | [Languages](../packages/i18n/README.md) | The contract for English, Catalan and Spanish, and the one formatter. |
| `packages/ui` | [Design system](../packages/ui/README.md) | Tokens, components, icons, the embedded typeface and the illustrations. |
| `packages/model`, `packages/planner` | [MCP service guide](../apps/mcp-server/README.md#public-and-personal-tools) | The person and the place, the question set, and the plan that joins them. |

```text
Interview / manual answers / reviewed bank aggregates
    -> versioned shared inputs -> profile API -> resolved context
    -> municipality request -> matching + policy functions
    -> structured results -> ChatGPT tools + live board

Person (inputs, ledger summary, habits) + places (official sources over the snapshot)
    -> planner -> months of saving per place -> plan_home_savings -> chat + workspace

Banc Demo / synthetic bank movements -> runtime ledger/events -> summaries
    -> polling app/MCP readers -> reviewed financial scenarios
```

Each area guide describes its owner, paths, input/output contract, checks and handoff. Owners describe team responsibilities, not assigned people. Coordinate shared-contract changes before parallel implementation and keep file ownership distinct. The API remains the single writer of the runtime database; MCP readers use its authenticated HTTP interface.

Start with [integration/deployment](areas/integration-deployment.md) for `npm run dev`, which starts the one server (API, board, workspace, interview and MCP) with an API token generated for that run and, outside production, the fictional Banc Demo feeding `user-001`. Every stored person belongs to an account and each request is authorized for that person only ([accounts](../packages/auth/README.md)); the bank side is fictional (Banc Demo and the synthetic feed), and no real bank is integrated. Release readiness still requires the combined checks and a rehearsal in the target ChatGPT client.
