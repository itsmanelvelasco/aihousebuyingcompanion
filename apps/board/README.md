# ReloCat journey board

The board is the demo surface of ReloCat: four fictional Catalan homeownership stories on one live page that the browser and the chat share. It serves the same MCP tools as the public server (`apps/mcp-server`) and adds two of its own, `open_demo` and `update_demo`.

All accounts, offers, regulation changes, benefits, listings, payments and leaderboard entries on the board are scripted and labelled as such. Town screens and incentives come from the same sourced data as the rest of ReloCat.

## Run it

From the repository root, with Node.js 24 or newer:

```sh
npm ci
npm run dev
```

`npm run dev` starts the one server, which mounts the board next to the profile API, so answers persist and the fictional bank feed runs. Open [127.0.0.1:8787/preview](http://127.0.0.1:8787/preview).

To run the board alone, with scripted data and no profile API, stop `npm run dev` first (both listen on port 8787) or give this one another `PORT`:

```sh
npm run start:board
```

Started alone, runs are held in server memory and clear on restart. Under `npm run dev` they are rows of the runtime database (`board_runs`) and survive a restart.

## What the board can and cannot do

The board is a demo: four scripted stories. Every action changes only the run's own scripted state. Answers typed into it are **not** saved to any stored person, and it cannot start, stop or seed a bank feed.

| Mode | When | What changes |
| --- | --- | --- |
| Public demo | Under the one server (`npm run dev`) with `PUBLIC_DEMO` on | Each persona maps to one fictional stored person (`user-001` … `user-004`). The board adds a read-only panel with that persona's bank feed (ledger revision, cash-flow summary) and a provisional town screen from its stored preferences (`apps/board/profiles.ts`). |
| Scripted | `npm run start:board`, or `PUBLIC_DEMO=off` | The board runs from in-memory scenes only. |

A run is addressed by its unguessable id (`/preview?run=<id>`). `SHARED_BOARD` adds one board that every visitor without a run id joins and may restart: a convenience for a local demo, on only outside production and without a `PUBLIC_ORIGIN`. On a public origin each visitor gets a private run, nobody can reset or read another visitor's run, and new runs are limited per address so the store cannot be filled to push runs out. `/preview/state` is same-origin only; inside a chat host the widget re-reads its run through `open_demo`.

A signed-in person does not get a "connected" board: their own figures are in the workspace (`/workspace`) and the personal MCP tools.

## Connect it to ChatGPT

ChatGPT needs an HTTPS endpoint. With the server running, start a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) in a second terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Stop the server and start it again with the printed origin so it can link to the shared page (or put `PUBLIC_ORIGIN` in `.env`):

```sh
PUBLIC_ORIGIN=https://your-tunnel-host.trycloudflare.com npm run dev
```

The tunnel runs on the same machine, so the rate limiter recognises it without further settings.

In ChatGPT, open **Plugins**, choose **Add custom MCP server**, name it **ReloCat**, enter the tunnel URL ending in `/mcp` and select **No authentication** for the demo and the public tools, or **OAuth** to let ChatGPT use your own account (see `docs/areas/integration-deployment.md`). Install it, start a new chat, select the plugin and say **“ReloCat, start.”** If the widget is hidden, open the board link the tool returns. If ChatGPT shows an older version of a widget after you changed it, choose **Refresh tools** in the plugin's settings and start a new chat.

The tunnel exposes the whole origin, including `/api`. `/api` answers only to the admin token, which stays on the server (random per start unless you set `PROFILE_API_TOKEN`), or to a signed-in person for their own data; never put the admin token in a page, a URL or a chat. A tunnel hostname other than `PUBLIC_ORIGIN` must be listed in `ALLOWED_HOSTS`.

## The four stories

| Persona | Say | What it shows |
| --- | --- | --- |
| **Laia · Getting started** | “ReloCat, start.” | Grouped interview answers saved in one call, then a first savings route. |
| **Marc · On the trail** | “Show Marc.” | Progress, a habit quest and its estimated monthly benefit. |
| **Núria · Faster routes** | “Show Núria.” | Previewing alternative routes on the map before choosing one. |
| **Jordi · Debt-free home** | “Show Jordi.” | The final payment and the credits. |

**Reset persona** restores the current scene; **Reset all four** restores the whole run. The board always separates the upfront-cash milestone from owning outright: the comparison adds a fixed 240-month repayment illustration, which is not a loan offer.

## Files

| File | Role |
| --- | --- |
| `server.ts` | HTTP preview, MCP endpoint and board tools. |
| `demo.ts` | Persona and run state, interview transitions. |
| `intake.ts` | Interview question groups and validation. |
| `profiles.ts` | Profile API bridge and the provisional sourced town screen. |
| `widget.ts`, `widget.html`, `map.ts` | Board rendering, bundled to `dist/widget.js` by `npm run build`. |

## Verify

```sh
npm run typecheck
node --test tests/board.test.ts tests/board-connected.test.ts
```
