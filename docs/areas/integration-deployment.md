# Integration and deployment area

**Owner:** integration/demo coordinator. **Purpose:** connect the teams' modules into one repeatable demo and keep publishing separate from local development.

## Service entry points

| Service | Entry point | Role |
| --- | --- | --- |
| Profile/bank API | `apps/profile-api/server.ts` | Authenticated storage, inputs and runtime bank writer; port 3001. |
| Integrated plugin/board | `demo-plugin/server.ts` | Preview and combined ChatGPT-facing tools; port 8787. |
| Interviewer/voice backend | `apps/interviewer/server.mjs` | Separate local backend on 3003 in the stack; proxied through the plugin's `/interviewer/` entry. |
| Standalone places MCP | `apps/mcp-server/index.ts` | Municipality-only development alternative; port 8787 by default. |
| Combined local launcher | `scripts/dev-stack.ts` | Starts profile and interviewer backends, waits for readiness, then starts the connected plugin; stops all three on exit. |

Do not run the integrated plugin and standalone places MCP on port 8787 simultaneously. The connected demo should reuse municipality tools in the plugin's one MCP endpoint. The API remains an internal HTTP service.

## Install and run

Requires Node.js 24+. The shortest connected startup from the repository root is:

```powershell
npm ci
npm run setup:app
npm run dev:stack
```

`dev:stack` builds both widgets and starts the profile API on 3001, interviewer backend on 3003 and unified plugin on 8787. If no `PROFILE_API_TOKEN` was supplied, it generates one and shares it only through child-process environment variables. It defaults the synthetic feed to `user-001`; override `DEMO_BANK_USERS` to choose the startup set. `DEMO_BANK_INTERVAL_MS` controls the feed interval (default 5000 ms). `PROFILE_API_PORT`, `INTERVIEWER_PORT` and `APP_PORT` override the ports, which must all differ. Ctrl+C stops all three services. Open `http://127.0.0.1:8787/interviewer/` for the interviewer through the main app, or use the backend's direct URL. Its bridge accepts only loopback, same-origin requests and never forwards browser credentials. Voice/classification use OpenAI only when explicitly requested and configured in the backend environment.

For separate terminals, first set a private `PROFILE_API_TOKEN` and run root `npm start`. In the plugin terminal set the same token and the API URL:

```powershell
$env:PROFILE_API_URL = 'http://127.0.0.1:3001'
# Set PROFILE_API_TOKEN to the same local value used by the API.
npm --prefix demo-plugin start
```

Without configured connection mode, the prototype remains clearly scripted; configured failures surface instead of falling back silently. Open `http://127.0.0.1:8787/preview`. For ChatGPT, use the plugin's documented HTTPS tunnel setup and keep credentials server-side. Local profile API storage should not be exposed directly through the public tunnel. The standalone municipality MCP can optionally register bank polling tools with `BANK_API_URL` and `BANK_API_TOKEN`; the combined plugin uses its profile connection instead.

## Verification

```powershell
npm run typecheck
npm test
npm run data:validate
npm run check:app
npm run test:app
```

Rehearse grouped interview → persisted context → provisional sourced town shortlist → actual incentive explanation, then bank event → refreshed board aggregate. Bedroom requirements remain pending property-level checks; the screen must not claim a particular property fits. Check backend-unavailable, conflict, missing-data and stopped-feed states. Keep the board's fixed 20-year debt-free illustration separate from cash readiness and actual loan decisions. Do not claim a successful end-to-end connection from independent unit tests alone.

## Release handoff

Use an integration branch and a reviewable pull request. Include changed areas, run commands, checks and remaining demo limits. Preserve current production audience and secrets. The user has requested a PR and merge for this integration; merge after the intended checks pass and verify `main` contains the exact merged result. Runtime files, tokens, generated build artifacts and local logs must stay ignored.
