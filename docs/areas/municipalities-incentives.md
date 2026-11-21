# Municipalities and incentives area

**Owner:** Catalunya relocation research/backend team. **Purpose:** recommend towns and screen public support using dated official evidence.

## Entry points

- `apps/mcp-server/tools.ts`: tool registration and structured responses.
- `packages/places/data.ts`: snapshot loading/validation.
- `packages/places/recommend.ts`, `access.ts`, `eligibility.ts`: matching, school/transport access and policy rules.
- `packages/contracts/places.ts`: municipality and tool contracts.
- `data/towns.json`, `data/incentives.json`: versioned pilot evidence.
- `scripts/refresh-data.ts`, `sources.ts`, `validate-data.ts`: refresh and validation workflow.

## Inputs and outputs

Core tools are `recommend_towns`, `get_town_profile` and `get_applicable_incentives`. The backend also exposes school, transport, business and detailed eligibility tools. Pass official six-digit municipality codes, confirmed household criteria and explicit dates. Budget is expressed in euros in this tool interface; the profile adapter converts stored cents once.

Results retain source/observation dates, geography, match reasons, trade-offs and missing data. Separate policy call status from household eligibility. Never infer school vacancies, transport reliability, business health or tax facts from proxy indicators. Comarca price estimates require explicit user agreement. Bedroom availability remains a property-level check, not a town fact.

## Run and verify

```powershell
npm run data:validate
npm run typecheck
npm test
npm run start:mcp
```

Standalone MCP defaults to port 8787. Do not run it on the same port as the integrated plugin; see [integration/deployment](integration-deployment.md). Refresh with `npm run data:refresh` only when deliberately updating evidence and reviewing its sources.

## Handoff

Keep domain functions independent of transport. The integrated plugin reuses this tool factory and structured outputs; UI teams must not duplicate eligibility logic. Report pilot coverage and schedule dates, and make out-of-coverage destinations explicit. See the detailed [MCP service guide](../../apps/mcp-server/README.md).
