# ReloCat journey board

The board is the demo surface of ReloCat: four fictional Catalan homeownership stories on one live page that the browser and the chat share. It serves the same MCP tools as the public server (`apps/mcp-server`) and adds two of its own, `open_demo` and `update_demo`.

All accounts, offers, regulation changes, benefits, listings, payments and leaderboard entries on the board are scripted and labelled as such. Town screens and incentives come from the same sourced data as the rest of ReloCat.

## Run it

From the repository root, with Node.js 24 or newer:

```sh
npm ci
npm run dev
```

`npm run dev` starts the profile API and the board together, so answers persist and the simulated bank feed runs. Open [127.0.0.1:8787/preview](http://127.0.0.1:8787/preview).

To run the board alone, with scripted data and no profile API:

```sh
npm run start:board
```

Runs are held in server memory and clear on restart. `PORT` changes the port.

## Two modes

| Mode | When | What changes |
| --- | --- | --- |
| Connected | `PROFILE_API_URL` and `PROFILE_API_TOKEN` are set (`npm run dev` does this) | Interview answers are saved through the profile API, the bank bridge tools are registered, and the four personas map to `user-001` … `user-004`. A backend failure is shown as an error, never replaced by scripted data. |
| Scripted | Neither variable is set | The board runs from in-memory scenes only. |

Both modes expose the same municipality, interview and Town Explorer tools.

## Connect it to ChatGPT

ChatGPT needs an HTTPS endpoint. With the server running, start a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) in a second terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Restart the board with the printed origin so it can link to the shared page:

```sh
PUBLIC_ORIGIN=https://your-tunnel-host.trycloudflare.com npm run start:board
```

In ChatGPT, open **Plugins**, choose **Add custom MCP server**, name it **ReloCat Demo**, enter the tunnel URL ending in `/mcp` and select **No authentication**. Install it, start a new chat, select the plugin and say **“ReloCat, start.”** If the widget is hidden, open the board link the tool returns.

Do not expose the profile API through the tunnel; it is an internal service with a shared demo token.

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
