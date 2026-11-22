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
| `/signup`, `/login`, `/logout`, `/account` | `apps/server` (`account-routes.ts`, `pages.ts`) | Accounts: server-rendered forms, no script. `/account` also holds the person's own bank data (connect, fetch, disconnect, import a statement, list and correct movements), the password change, the download of everything stored, connected assistants and the deletion. |
| `/bank/consent/callback` | `apps/server`, logic in `packages/banks/sync.ts` | Where a bank sends a person back after they allowed or refused access. |
| `/oauth/*`, `/.well-known/oauth-*` | `apps/server`, logic in `packages/auth` | OAuth 2.1 for MCP clients. |
| `/api/...` | `apps/profile-api`, `apps/habits-agent` | Profiles, inputs, bank ledger, connections, events, webhooks and habits. |
| `/health` | `apps/server` | Readiness, snapshot version, data-source freshness, the database schema version (never its path) and `clientAddress`: how visitor addresses are determined and whether requests are arriving without one. |

`apps/server/index.ts` reads the environment, opens the database and listens; `apps/server/app.ts` is the request handler (`createApp`), which tests build over a temporary database.

## Accounts, identity and the public demo

Every stored person belongs to an account, and nothing reads or writes a person without that account's authority. The model, the flows and what is deliberately missing (email verification, password reset, MFA) are in [`packages/auth/README.md`](../../packages/auth/README.md).

- **Identity is resolved once per request, in `createApp`.** `/mcp` accepts an OAuth access token in `Authorization: Bearer`, or the session cookie of a page on this same origin. The MCP tools then receive a `Caller` (`apps/mcp-server/identity.ts`) with a handle bound to that caller's own person. No tool takes a user id from the model, and the tools reach the stores in-process: the loopback calls that carried the service token for any caller are gone.
- **Personal tools** (`get_person`, `get_my_inputs`, `save_my_inputs`, `get_bank_summary`, `get_bank_updates`, `get_bank_runtime`, the own-bank tools `list_connectable_banks`, `list_my_bank_connections`, `get_my_bank_accounts`, `list_my_statement_imports`, `connect_my_bank`, `disconnect_my_bank`, `sync_my_bank`, `preview_statement_import`, `confirm_statement_import`, `delete_statement_import`, and `plan_home_savings` with `me: true`) answer `401` with `WWW-Authenticate` when nobody is signed in, and `403` when the token lacks the scope. The tools that change bank data need `bank:manage`. No tool returns an individual movement: those are shown to their owner on `/account` and through `/api`. Everything about places, incentives, schools, transport, the calculators and an inline `plan_home_savings` stays anonymous.
- **`/api`** accepts the admin token (`PROFILE_API_TOKEN`, operators and tests) for everything. A person's own OAuth token or session reaches only `/users/<their own id>/…`: every read (`person:read`), writes to `inputs` and `habits` (`person:write`), and their own bank data (`bank:manage`): connecting and disconnecting a bank, syncing, importing a statement by preview then confirmation, correcting a category, deleting a movement they imported, and `GET /users/<id>/export`. A session write also needs the `X-CSRF-Token` header. Anything else is `403`, whether or not the other id exists; raw ledger writes, the demo feed and the provider registry stay with the admin token. The routes are in [`apps/profile-api/BANK_API.md`](../../apps/profile-api/BANK_API.md#a-persons-own-bank-data). `/api/webhooks/bank/<provider>` keeps its provider-signature check and has its own rate limit, applied before the signature is verified.
- **Public demo** (`PUBLIC_DEMO`, on outside production, off in production unless set to `on`): the personas in `DEMO_USER_IDS` (default `user-001` to `user-004`) are readable without an account through `get_demo_person`, `get_demo_bank_summary`, `get_demo_bank_updates`, `get_demo_bank_runtime`, `plan_home_savings` with `demoId`, and the journey board. These paths can name only an allowlisted id that no account owns, and none of them writes.
- **Journey board**: every action changes only the run's own scripted state; answers typed into it are never saved to a stored person, and it cannot start or stop a bank feed. A run is addressed by its unguessable id. `SHARED_BOARD` (one board everybody joins and may restart) is on only outside production and without a `PUBLIC_ORIGIN`; otherwise each visitor gets a private run and new runs are limited per address. `/preview/state` sends no CORS header.
- **Hosts**: a request whose `Host` is not the `PUBLIC_ORIGIN` host, `localhost`/`127.0.0.1`/`[::1]` on the listening port, or an entry of `ALLOWED_HOSTS` is refused with `421`, so DNS rebinding cannot pass the same-origin checks. Links, cookies' `Secure` flag and the OAuth issuer come from `PUBLIC_ORIGIN`, never from the header. Only the exact `PUBLIC_ORIGIN` host is served: with `https://www.relo.cat`, a request for `relo.cat` gets `421`, so redirect the apex domain to `www` at the proxy. `/connect` offers `<PUBLIC_ORIGIN>/mcp` as the address to paste into an agent.
- **Throttling and housekeeping**: sign-in, sign-up and client registration are slowed per visitor address, without locking an account from outside; the rules and what they leave open are in [`packages/auth/README.md`](../../packages/auth/README.md#throttling). The server runs one housekeeping pass every ten minutes (expired sessions, counters, OAuth codes, tokens, dead grants, idle clients, bank consents nobody finished and statements nobody confirmed) on a timer that stops at shutdown.
- **Connecting a bank**: a person presses Connect on `/account`, approves on the bank's own page and is sent back to `/bank/consent/callback`. The callback is accepted once, only in the browser session that started it, for ten minutes. What the bank returns is stored encrypted (see [`DATA_ENCRYPTION_KEY`](#bank-credentials-data_encryption_key)). Outside production the fictional Banc Demo is such a bank; no real bank is integrated.
- **A busy database**: when another process holds the database's write lock for longer than a quarter of a second, the request is answered `503` with `Retry-After: 1` instead of waiting, on every route: `/api` from its own handlers, everything else (pages, OAuth endpoints, the caller lookup of `/mcp`) from one place in `apps/server/app.ts`. Nothing was written, so the same request can be sent again. A tool that meets the same condition while it runs reports it as a tool error, and the journey board's own routes answer with their generic error.

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

`npm run dev` builds the browser bundles and restarts the server on code changes; `npm start` runs it once. Both read `.env` when it exists. Outside production each address may make 3000 requests a minute (`RATE_LIMIT_PER_MINUTE`; 300 on a public deployment): on a developer's machine every tab, the journey board with its poll a second per tab and the test tools all arrive from `127.0.0.1`, and 300 a minute is five board tabs. Outside production Banc Demo starts with the server and `user-001` is linked to it, so fictional movements keep arriving by webhook; `DEMO_BANK=off` returns `user-001` to the older in-process synthetic feed, and `DEMO_BANK_USERS` starts that feed for the users it lists. `NODE_ENV=production` (set in the Docker image) starts neither. Official data sources are fetched at start and cached under `data/cache/`; `LIVE_DATA=off` serves only the committed snapshot. Every setting is described in `.env.example`.

## Deploying to www.relo.cat

Build the image from the repository root and run it with the public origin:

```powershell
docker build -t relocat .
docker run --rm -p 127.0.0.1:8787:8787 -v relocat-db:/app/data/db -v relocat-cache:/app/data/cache -e PUBLIC_ORIGIN=https://www.relo.cat -e CLIENT_IP_HEADER=x-forwarded-for relocat
```

The server speaks plain HTTP: put a reverse proxy that terminates HTTPS in front of it, configured as described under [The reverse proxy](#the-reverse-proxy). Publishing the port on `127.0.0.1` keeps visitors from reaching the server around that proxy.

Runtime state is one SQLite database (`DATABASE_FILE`; `data/db/relocat.db` in the image) that the server opens at start, migrates forward and closes on shutdown; it refuses a database written by a newer build. It lives inside the container, like `data/cache`, unless you mount volumes for `/app/data/db` and `/app/data/cache` as above. `data/runtime-users` and `data/runtime-habits` matter only when upgrading a deployment that kept JSON files there: they are imported once into an empty database and left untouched. The image sets `NODE_ENV=production`, so no demo bank feed runs in it.

### Bank credentials: `DATA_ENCRYPTION_KEY`

What a bank's consent flow returns for a person's connection is stored encrypted with this key (AES-256-GCM). Generate 32 random bytes and keep them with the other secrets of the deployment:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Pass it to the container as one more `-e DATA_ENCRYPTION_KEY=<the value>` on the run command above.

- **With `NODE_ENV=production` the server refuses to start without it while a bank that people connect by consent is configured** (it names the bank and exits with status 1). The image ships no such bank configured: Banc Demo does not start in production and its provider is `unconfigured` without its three variables, so a deployment that connects no bank needs no key.
- A value that is not 32 bytes (64 hex characters, or base64) stops the start in any mode.
- Outside production, without the variable, a development key is created the first time it is needed and kept in the database itself; the log says so once. That is no protection against somebody who has the database file.
- **Keep the key with the backups' owner, not in the backup.** A database restored without its key still works; only the stored bank credentials cannot be read. Those connections then show an error and each person connects their bank again. Changing the key has the same effect; there is no rotation command.

### Demo personas after the fixtures change

The server copies a fixture from `data/users/` only for a persona that does not exist yet, so a database keeps the profile documents it was first seeded with. The fixtures now state each household's purchase savings (`purchaseSavingsCents`); a database seeded before that shows the demo personas with "savings unknown". To bring them up to date, on the machine or in the container that owns the database:

```powershell
npm run db:reseed-demo -- --dry-run   # what would change
npm run db:reseed-demo                # replace the profile documents of the demo personas
```

It replaces the three profile documents of the ids in `DEMO_USER_IDS` (default `user-001` to `user-004`) and nothing else: answers saved to a persona, its ledger and its connections stay; an id outside the list is not touched; an id that belongs to an account is a person and is always skipped. It can run while the server does, and the next request reads the new documents.

The image carries only the backup script, and in production the public demo is off unless `PUBLIC_DEMO=on`. For a containerised deployment that shows the demo, run the command from a checkout of the same version with `DATABASE_FILE` pointing at the database file, or copy `scripts/reseed-demo.ts` into the image next to `scripts/backup-db.ts`.

### Backups

Back the database up while the server runs with `npm run db:backup -- <file>`. In the image, write into the database volume so the copy outlives the container:

```powershell
docker exec <container> npm run db:backup -- data/db/backups/relocat-2026-11-22.db
```

The command writes to `<file>.partial`, runs SQLite's integrity check on the copy and only then renames it, so `<file>` is either absent or a complete backup in a single file (no `-wal` or `-shm` beside it). A failed run removes what it wrote and exits with status 1; an existing `<file>` is never overwritten. To restore, stop the server, replace `DATABASE_FILE` with the backup (and delete any `-wal`/`-shm` files of the old database), then start it.

### Client addresses: `CLIENT_IP_HEADER` is required in production

The rate limits and the sign-in throttle count per visitor address. Behind a proxy, or in a container, the connecting address is the proxy or the Docker bridge, never the visitor, so the server has to be told where the address is:

| Setting | When |
| --- | --- |
| `CLIENT_IP_HEADER=x-forwarded-for` | Your reverse proxy appends the visitor to `X-Forwarded-For`. Set `TRUSTED_PROXY_HOPS` to the number of proxies you run in front (default 1; a CDN in front of a load balancer is 2). |
| `CLIENT_IP_HEADER=cf-connecting-ip` (or another header name) | One proxy overwrites that single-value header on every request, and visitors cannot reach the server around it. |
| `CLIENT_IP_HEADER=none` | Nothing states the address. Every visitor behind the proxy is counted as one client. |

**With `NODE_ENV=production` or a `PUBLIC_ORIGIN`, the server refuses to start while `CLIENT_IP_HEADER` is unset or `auto`**: it prints the three choices and exits with status 1. A deployment that silently counted every visitor as one would let a single stranger use up everybody's allowance, and nobody would notice until it happened, so the choice has to be made on purpose. `auto` remains the default for local work.

When requests still arrive without a usable address (the header is missing, or `none` was chosen and a proxy is in front), the server keeps working in a degraded mode and says so: a `WARNING` line in the log, repeated at most every five minutes while it goes on, and `clientAddress.ok: false` with a count in `/health`. In that mode all such visitors share one `RATE_LIMIT_PER_MINUTE` allowance, nobody is locked out as an "address", sign-in is slowed per account only, and failed sign-ins through that address meet a ceiling of 300 per five minutes. Fix the proxy rather than run like this.

Every request is counted, including requests from the machine the server runs on; a proxy on the same machine that adds no forwarding header is not exempt. Only calls that carry the admin token (`PROFILE_API_TOKEN`) are not counted. Each client gets `RATE_LIMIT_PER_MINUTE` requests a minute and all clients together twenty times that. An IPv6 visitor is counted by /64 network.

### The reverse proxy

The proxy must do two things, and neither is nginx's default:

1. **Pass the original `Host` header.** nginx's `proxy_pass` replaces it with the upstream's (`127.0.0.1:8787`). The server then believes it was reached as `http://127.0.0.1:8787`, and every form (sign-up, sign-in, consent, account) answers `403`, because the browser's `Origin` is the public site. The page says so when that is the cause.
2. **State the visitor's address** in the header named by `CLIENT_IP_HEADER`, replacing or appending to whatever the visitor sent.

nginx, on the same machine as the server (`CLIENT_IP_HEADER=x-forwarded-for`, `TRUSTED_PROXY_HOPS=1`):

```nginx
server {
  listen 443 ssl;
  server_name www.relo.cat;
  # ssl_certificate and ssl_certificate_key go here.

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Bank events are server-sent: do not buffer them.
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}

server {
  listen 443 ssl;
  server_name relo.cat;
  return 308 https://www.relo.cat$request_uri;
}
```

Caddy passes `Host` unchanged and writes `X-Forwarded-For` itself, so the same settings need only:

```caddyfile
www.relo.cat {
  reverse_proxy 127.0.0.1:8787
}

relo.cat {
  redir https://www.relo.cat{uri} 308
}
```

At start the server logs the origin it checks forms against, the `Host` values it accepts and where it takes client addresses from; compare those three lines with the proxy when something answers `403` or `421`.

`/mcp` already refuses browser requests from other origins: only the site's own pages, `PUBLIC_ORIGIN` and the origins in `ALLOWED_ORIGINS` may call it, while agents, which send no `Origin`, are not affected. If `TREG_TOKEN` is set, `search_homes` spends money on behalf of anyone who can reach `/mcp`; `LISTINGS_DAILY_LIMIT` and `LISTINGS_PER_MINUTE_LIMIT` bound it.

Set `ALLOWED_HOSTS` when the server is reached under a name other than the `PUBLIC_ORIGIN` host or `localhost:<PORT>` (a tunnel hostname, or `localhost:8080` when Docker publishes another port). The server exits with a non-zero status when its port is taken or after an uncaught exception, so a supervisor restarts it; a failed background job is logged and does not stop it.

Before a real launch, note what is still missing: email verification, password reset and MFA (no mail service exists), and a real bank: the consent flow and the sealed credentials run against the fictional Banc Demo only, and [the bank API guide](../../apps/profile-api/BANK_API.md#what-a-production-bank-still-needs) lists what a real one still needs. In production the public demo and the shared board are off unless `PUBLIC_DEMO=on` or `SHARED_BOARD=on`.

## Verification

```powershell
npm run check
```

Then rehearse on the running server: `/health` shows fresh sources and `clientAddress.ok: true`; `plan_home_savings` returns a plan for `user-001` that starts from its declared savings; `/workspace` updates when the bank feed adds a movement; the board saves interview answers. As a person: sign up, connect Banc Demo from `/account` (approve on the bank's page), see a movement arrive, import a statement, download the export, change the password and delete the account. Do not claim a successful end-to-end connection from unit tests alone, and do not claim a ChatGPT widget works until it has been seen in ChatGPT.

## Release handoff

Use a branch and a reviewable pull request. Include changed areas, run commands, checks and remaining limits. Runtime files, tokens, build output and caches stay ignored.
