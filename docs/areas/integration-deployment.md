# Integration and deployment area

**Owner:** integration/demo coordinator. **Purpose:** keep every module mounted on one server and make releases repeatable.

## One server

`apps/server/index.ts` is the only long-running process. It mounts request handlers from the other apps on a single origin: `http://127.0.0.1:8787` locally, `https://www.relo.cat` in production.

| Path | Handler | Role |
| --- | --- | --- |
| `/mcp` | `apps/mcp-server/tools.ts` via `apps/board/server.ts` | MCP endpoint for ChatGPT and other agents. |
| `/workspace` | `apps/web` (React), served by the board handler | Person, places and savings plan. |
| `/preview` | `apps/board` | Journey board. |
| `/interview/` | `apps/interviewer` | Voice and guided interview. Its paid OpenAI routes are local-only unless `INTERVIEWER_PUBLIC_AI=on`. |
| `/connect`, `/test` | `apps/mcp-server` | Homepage, agent setup guide and local tool tester. |
| `/api/...` | `apps/profile-api`, `apps/habits-agent` | Profiles, inputs, bank ledger, connections, events, webhooks and habits. |
| `/health` | `apps/server` | Readiness, snapshot version and data-source freshness. |

`/api` requires a bearer token, except `/api/webhooks/bank/<provider>`, which a bank calls and which is authenticated by that provider's own signature check. The token is generated at start unless `PROFILE_API_TOKEN` is set, and never leaves the server: the board and MCP tools reach `/api` over loopback.

`apps/board/server.ts` can still run alone (`npm run start:board`) for a scripted rehearsal without the API. The interviewer can also run alone on port 3000 (`npm run start:interviewer`).

## Install and run

Requires Node.js 24+.

```powershell
npm ci
npm run dev
```

`npm run dev` builds the browser bundles and restarts the server on code changes; `npm start` runs it once. Outside production the synthetic bank feed starts for `user-001` unless `DEMO_BANK_USERS` says otherwise. Official data sources are fetched at start and cached under `data/cache/`; `LIVE_DATA=off` serves only the committed snapshot. Every setting is described in `.env.example`.

## Deploying to www.relo.cat

Build the image from the repository root and run it with the public origin:

```powershell
docker build -t relocat .
docker run --rm -p 8787:8787 -e PUBLIC_ORIGIN=https://www.relo.cat -e DEMO_BANK_USERS= relocat
```

Put it behind HTTPS. Runtime data (`data/runtime-users`, `data/runtime-habits`, `data/cache`) lives inside the container unless you mount volumes for it. Before a real launch, note what the demo does not have: per-user authentication and authorization, a consent flow for real banks, and an `Origin` check on `/mcp`.

## Verification

```powershell
npm run check
```

Then rehearse on the running server: `/health` shows fresh sources; `plan_home_savings` returns a plan for `user-001`; `/workspace` updates when the bank feed adds a movement; the board saves interview answers. Do not claim a successful end-to-end connection from unit tests alone, and do not claim a ChatGPT widget works until it has been seen in ChatGPT.

## Release handoff

Use a branch and a reviewable pull request. Include changed areas, run commands, checks and remaining limits. Runtime files, tokens, build output and caches stay ignored.
