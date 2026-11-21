# Monorepo development map

The [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) owns product decisions. Code and verified checks establish delivered behavior. The core demo is Catalonia town discovery with sourced schools, transport and incentives; financial coaching is complementary.

| Area | Development entry point | Responsibility |
| --- | --- | --- |
| [Interviewer](areas/interviewer.md) | `apps/interviewer/`, `demo-plugin/intake.ts`, `profiles.ts` | Voice/guided interviews, cash-flow cards and confirmed structured answers. |
| [Frontend/plugin](areas/frontend-plugin.md) | `demo-plugin/server.ts`, `widget.ts` | Conversation tools, live board and integrated MCP experience. |
| [Profiles/inputs](areas/profiles-inputs.md) | `apps/profile-api/server.ts`, `inputs.ts` | Persistent synthetic profiles and multi-source context. |
| [Input management website](areas/input-management.md) | `apps/profile-api/admin.html`, `admin.mjs` | Local operator workspace and reviewed interviewer handoff. |
| [React web/MCP workspace](areas/react-mcp-workspace.md) | `apps/mcp-server/workspace-widget.tsx`, `workspace-tools.ts` | Shared React controls inside ChatGPT and the local website. |
| [Netlify hosting](areas/netlify-hosting.md) | `netlify.toml`, `scripts/build-management-site.mjs` | Website builds, restricted API gateway and remaining deployment configuration. |
| [Bank/runtime](areas/bank-runtime.md) | `apps/profile-api/bank.ts`, `finance.ts` | Movements, event consumption and deterministic finance. |
| [Habits agent](areas/habits-agent.md) | `apps/habits-agent/server.ts`, `agent.ts` | User-reviewed goals/check-ins and optional on-demand Sol suggestions. |
| [Municipalities/incentives](areas/municipalities-incentives.md) | `apps/mcp-server/tools.ts`, `packages/places/` | Sourced town matching and policy screening. |
| [Shared contracts](areas/shared-contracts.md) | `packages/contracts/` | Validation, units and cross-area handoffs. |
| [Integration/deployment](areas/integration-deployment.md) | Root `package.json` and service entry points | Run services, test connections and release. |
| [Team plugins/skills](areas/team-plugins-skills.md) | `plugins/relocat-team/`, `scripts/package-team-plugin.ts` | One shared versioned bundle and verified teammate rollout. |

```text
Interview / manual answers / reviewed bank aggregates
    -> versioned shared inputs -> profile API -> resolved context
    -> municipality request -> matching + policy functions
    -> structured results -> ChatGPT tools + live board

Synthetic bank movements -> runtime ledger/events -> summaries
    -> polling app/MCP readers -> reviewed financial scenarios
```

Each area guide describes its owner, paths, input/output contract, checks and handoff. Owners describe team responsibilities, not assigned people. Coordinate shared-contract changes before parallel implementation and keep file ownership distinct. The API remains the single writer for its runtime directory; MCP readers use its authenticated HTTP interface.

Start with [integration/deployment](areas/integration-deployment.md) for `npm run dev:stack`, which starts the profile API and connected plugin with one in-memory credential and a synthetic feed. The integration branch implements the connection; release readiness still requires the combined checks and rehearsal. Real bank access and per-user production authorization remain outside the synthetic demo.
