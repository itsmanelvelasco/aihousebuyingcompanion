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
| `/signup`, `/login`, `/logout`, `/account` | `apps/server` (`account-routes.ts`, `pages.ts`) | Accounts: server-rendered forms, no script. |
| `/oauth/*`, `/.well-known/oauth-*` | `apps/server`, logic in `packages/auth` | OAuth 2.1 for MCP clients. |
| `/api/...` | `apps/profile-api`, `apps/habits-agent` | Profiles, inputs, bank ledger, connections, events, webhooks and habits. |
| `/health` | `apps/server` | Readiness, snapshot version, data-source freshness, database path and schema version. |

`apps/server/index.ts` reads the environment, opens the database and listens; `apps/server/app.ts` is the request handler (`createApp`), which tests build over a temporary database.

## Accounts, identity and the public demo

Every stored person belongs to an account, and nothing reads or writes a person without that account's authority. The model, the flows and what is deliberately missing (email verification, password reset, MFA) are in [`packages/auth/README.md`](../../packages/auth/README.md).

- **Identity is resolved once per request, in `createApp`.** `/mcp` accepts an OAuth access token in `Authorization: Bearer`, or the session cookie of a page on this same origin. The MCP tools then receive a `Caller` (`apps/mcp-server/identity.ts`) with a handle bound to that caller's own person. No tool takes a user id from the model, and the tools reach the stores in-process: the loopback calls that carried the service token for any caller are gone.
- **Personal tools** (`get_person`, `get_my_inputs`, `save_my_inputs`, `get_bank_summary`, `get_bank_updates`, `get_bank_runtime`, and `plan_home_savings` with `me: true`) answer `401` with `WWW-Authenticate` when nobody is signed in, and `403` when the token lacks the scope. Everything about places, incentives, schools, transport, the calculators and an inline `plan_home_savings` stays anonymous.
- **`/api`** accepts the admin token (`PROFILE_API_TOKEN`, operators and tests) for everything. A person's own OAuth token or session reaches only `/users/<their own id>/…`: every read, and writes to `inputs` and `habits` (a session write also needs the `X-CSRF-Token` header). Anything else is `403`, whether or not the other id exists. `/api/webhooks/bank/<provider>` keeps its provider-signature check and has its own rate limit, applied before the signature is verified.
- **Public demo** (`PUBLIC_DEMO`, on outside production, off in production unless set to `on`): the personas in `DEMO_USER_IDS` (default `user-001` to `user-004`) are readable without an account through `get_demo_person`, `get_demo_bank_summary`, `get_demo_bank_updates`, `get_demo_bank_runtime`, `plan_home_savings` with `demoId`, and the journey board. These paths can name only an allowlisted id that no account owns, and none of them writes.
- **Journey board**: every action changes only the run's own scripted state; answers typed into it are never saved to a stored person, and it cannot start or stop a bank feed. A run is addressed by its unguessable id. `SHARED_BOARD` (one board everybody joins and may restart) is on only outside production and without a `PUBLIC_ORIGIN`; otherwise each visitor gets a private run and new runs are limited per address. `/preview/state` sends no CORS header.
- **Hosts**: a request whose `Host` is not the `PUBLIC_ORIGIN` host, `localhost`/`127.0.0.1`/`[::1]` on the listening port, or an entry of `ALLOWED_HOSTS` is refused with `421`, so DNS rebinding cannot pass the same-origin checks. Links, cookies' `Secure` flag and the OAuth issuer come from `PUBLIC_ORIGIN`, never from the header.

### Connecting ChatGPT (or another MCP client) with OAuth

1. Deploy behind HTTPS with `PUBLIC_ORIGIN` set to the public origin; it is the OAuth issuer and `<origin>/mcp` is the resource.
2. In the client, add a custom MCP server with the URL `<origin>/mcp` and choose **OAuth**. The client discovers `/.well-known/oauth-protected-resource`, registers itself at `/oauth/register` and opens `/oauth/authorize`.
3. The person signs in (or creates an account at `/signup`), reads the consent page and allows the connection. `/account` lists connected clients and removes any of them.
4. With **No authentication** the same URL still works for every public tool and the demo; personal tools then answer with the sign-in challenge.

This flow is verified end to end with a scripted client (`tests/auth.test.ts`); it has not been run against a real ChatGPT connection. `packages/auth/README.md` lists what that leaves unconfirmed.

`apps/board/server.ts` can still run alone (`npm run start:board`) for a scripted rehearsal without the API. It listens on the same `PORT` (8787 by default), so stop `npm run dev` first or give it another port. The interviewer can also run alone on port 3000 (`npm run start:interviewer`). Outside production the server also starts Banc Demo (`apps/demo-bank`) as a second listener on port 3003 (`DEMO_BANK_PORT`); it is a fictional bank, not part of the public origin.

## Install and run

Requires Node.js 24+.

```powershell
npm ci
npm run dev
```

`npm run dev` builds the browser bundles and restarts the server on code changes; `npm start` runs it once. Both read `.env` when it exists. Outside production Banc Demo starts with the server and `user-001` is linked to it, so fictional movements keep arriving by webhook; `DEMO_BANK=off` returns `user-001` to the older in-process synthetic feed, and `DEMO_BANK_USERS` starts that feed for the users it lists. `NODE_ENV=production` (set in the Docker image) starts neither. Official data sources are fetched at start and cached under `data/cache/`; `LIVE_DATA=off` serves only the committed snapshot. Every setting is described in `.env.example`.

## Deploying to www.relo.cat

Build the image from the repository root and run it with the public origin:

```powershell
docker build -t relocat .
docker run --rm -p 8787:8787 -e PUBLIC_ORIGIN=https://www.relo.cat relocat
```

Put it behind HTTPS. Runtime state is one SQLite database (`DATABASE_FILE`; `data/db/relocat.db` in the image) that the server opens at start, migrates forward and closes on shutdown; it refuses a database written by a newer build. It lives inside the container, like `data/cache`, unless you mount volumes for `/app/data/db` and `/app/data/cache`. Back it up while the server runs with `npm run db:backup -- <file>`. `data/runtime-users` and `data/runtime-habits` matter only when upgrading a deployment that kept JSON files there: they are imported once into an empty database and left untouched. The image sets `NODE_ENV=production`, so no demo bank feed runs in it.

Behind a reverse proxy, tell the server which header carries the visitor's address, or every visitor shares one rate-limit allowance: `CLIENT_IP_HEADER=x-forwarded-for` with `TRUSTED_PROXY_HOPS` set to the number of proxies you run in front (default 1), or `CLIENT_IP_HEADER=cf-connecting-ip` when Cloudflare is the only way in. A proxy or tunnel on the same machine needs no setting. Each client gets `RATE_LIMIT_PER_MINUTE` requests a minute and all clients together twenty times that. `/mcp` already refuses browser requests from other origins: only the site's own pages, `PUBLIC_ORIGIN` and the origins in `ALLOWED_ORIGINS` may call it, while agents, which send no `Origin`, are not affected. If `TREG_TOKEN` is set, `search_homes` spends money on behalf of anyone who can reach `/mcp`; `LISTINGS_DAILY_LIMIT` and `LISTINGS_PER_MINUTE_LIMIT` bound it.

Set `ALLOWED_HOSTS` when the server is reached under a name other than the `PUBLIC_ORIGIN` host or `localhost:<PORT>` (a tunnel hostname, or `localhost:8080` when Docker publishes another port). The server exits with a non-zero status when its port is taken or after an uncaught exception, so a supervisor restarts it; a failed background job is logged and does not stop it.

Before a real launch, note what is still missing: email verification, password reset and MFA (no mail service exists), and a consent flow for real banks. In production the public demo and the shared board are off unless `PUBLIC_DEMO=on` or `SHARED_BOARD=on`.

## Verification

```powershell
npm run check
```

Then rehearse on the running server: `/health` shows fresh sources; `plan_home_savings` returns a plan for `user-001`; `/workspace` updates when the bank feed adds a movement; the board saves interview answers. Do not claim a successful end-to-end connection from unit tests alone, and do not claim a ChatGPT widget works until it has been seen in ChatGPT.

## Release handoff

Use a branch and a reviewable pull request. Include changed areas, run commands, checks and remaining limits. Runtime files, tokens, build output and caches stay ignored.
