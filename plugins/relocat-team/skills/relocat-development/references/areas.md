# ReloCat area routing

Use the current checkout's `docs/README.md` as the maintained index. This bundled routing map allows the workflow to remain understandable without a local repository; source code still requires a checkout or authorized repository tools.

| Area | Entry points | Area guide |
| --- | --- | --- |
| Interview | `apps/board/demo.ts`, `profiles.ts` | `docs/areas/interviewer.md` |
| Frontend/plugin | `apps/board/server.ts`, `widget.ts` | `docs/areas/frontend-plugin.md` |
| Profiles/inputs | `apps/profile-api/server.ts`, `inputs.ts` | `docs/areas/profiles-inputs.md` |
| Bank/runtime | `apps/profile-api/bank.ts`, `runtime.ts`, `finance.ts` | `docs/areas/bank-runtime.md` |
| Habits | `apps/habits-agent/server.ts`, `agent.ts` | `docs/areas/habits-agent.md` |
| Municipalities/incentives | `apps/mcp-server/tools.ts`, `packages/places/` | `docs/areas/municipalities-incentives.md` |
| Contracts | `packages/contracts/` | `docs/areas/shared-contracts.md` |
| Integration | `apps/server/index.ts`, root `package.json` | `docs/areas/integration-deployment.md` |

Root checks: `npm run typecheck`, `npm test`, `npm run data:validate`. Lint and format: `npm run lint`, `npm run format`. Everything at once: `npm run check`. The connected stack starts with `npm run dev` after `npm ci` and `npm run setup:app`. Habits are a separate optional service started with `npm start`.

Repository: https://github.com/itsmanelvelasco/aihousebuyingcompanion
