# relo.cat · ChatGPT hackathon demo

Four fictional Catalan homeownership stories in one MCP plugin. The persona buttons switch users within a demo run, so one ChatGPT login is enough. **Reset persona** restores the current scene. **Reset all four** restores all scenes in your current run. Say **“relo.cat, start”** to open or resume the shared board. It is the same board at the browser preview URL. Runs are held in server memory and clear on restart.

This is an isolated prototype for the [team’s AI Housing Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003). It reuses Homebound's Dot map, percentage bars and achievements, plus Clara's unread-update and relevance mechanics. It uses the team’s Catalonia and simulated banking approach. All accounts, offers, regulation changes, benefits, listings, payments and leaderboard entries are scripted. The rural scene illustrates verifying a Catalan program, school and transport access.

## Get the code

You need access to the team’s GitHub repository and a GitHub SSH key for the clone command below. If you use HTTPS for GitHub, substitute the HTTPS clone URL shown in the repository’s **Code** menu. If you're connecting to a teammate’s running server, skip to [Connect to ChatGPT](#connect-to-chatgpt).

For a fresh checkout:

```sh
git clone --branch hackathon/arrela-demo-plugin git@github.com:itsmanelvelasco/aihousebuyingcompanion.git
cd aihousebuyingcompanion/demo-plugin
```

If you already cloned the repository, start from its root:

```sh
git fetch origin
git switch hackathon/arrela-demo-plugin
git pull --ff-only origin hackathon/arrela-demo-plugin
cd demo-plugin
```

## Install and run locally

Install [Node.js](https://nodejs.org/en/download) 22.18 or newer with npm. If your shell says `npm: command not found`, install Node.js and open a new terminal. From `demo-plugin/`:

```sh
node --version
npm --version
npm ci
npm start
```

Open [localhost:8787/preview](http://localhost:8787/preview) to check the board. The local preview works on its own. To connect it to ChatGPT on the web, continue with the HTTPS setup. If port 8787 is in use, choose a different port with `PORT=8788 npm start` and forward that same port in the next step.

## Give ChatGPT an HTTPS endpoint

If you're hosting the demo, [install `cloudflared`](https://developers.cloudflare.com/tunnel/downloads/), leave the server running, and start a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) in a second terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Copy the printed HTTPS origin, such as `https://your-tunnel-host.trycloudflare.com`. Keep the tunnel running. Stop the local server with **Ctrl+C** and restart it from `demo-plugin/` with that origin so the plugin can link to the shared board:

```sh
PUBLIC_ORIGIN=https://your-tunnel-host.trycloudflare.com npm start
```

Replace the example hostname with your actual tunnel hostname. If you changed the port, include the same `PORT` setting when restarting. Use the HTTPS origin plus **`/mcp`** as the ChatGPT Server URL, and the origin plus **`/preview`** for the browser board. Share the current MCP URL with teammates who want to connect to your running server. The tunnel URL can change when restarted.

## Connect to ChatGPT

Use the active HTTPS MCP URL from the server you started or from a teammate.

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins) in your own account and choose **+ → Add custom MCP server**.
2. Name it **relo.cat Demo**. Enter the HTTPS Server URL ending in `/mcp`, then select **No authentication**. Review the connection and choose **Create as a plugin**.
3. Open **relo.cat Demo** under your personal plugins and select **+** to install it.
4. Start a new **Work** chat, type `@`, select **relo.cat Demo**, and send **“relo.cat, start.”** Then try **“Show Marc.”** If the widget is hidden, open the server's `/preview` URL beside the chat. The board follows the same session without a pairing code.

If **Add custom MCP server** is missing, check that your account or workspace allows custom MCP connections. If ChatGPT cannot connect, check the active tunnel and the HTTPS URL ending in `/mcp`. After updating the server, open the plugin connection, choose **Refresh**, and test in a new chat. If the tunnel address changed, update the connection URL first. The plugin may still appear under the name you originally chose. Use that installed connection or name a new one **relo.cat**.

Use fictional details on the shared demo board and stop the public tunnel when you finish testing. See [OpenAI’s plugin connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) for setup and refresh details.

## Rehearse the four scenes

| Persona | What to say in ChatGPT | What to show |
| --- | --- | --- |
| **Laia · Getting started** | “relo.cat, start.” If the board has moved on, say “Switch to Laia.” | Try “We’re three people looking for two bedrooms in Manresa. I work full time.” The board saves all four details together. Open **Refine your household and housing profile** for budget, floor area, schools, commute, debt and emergency cash. Say “Connect the sample bank and show my updated plan,” or use the button. The fixture fills €18,400 saved, €2,900 net income and €2,180 spending, producing a €720/month surplus and a 50-month estimate for the sample €54,000 upfront milestone. The board then models a 20-year mortgage term, or 290 months total to owning outright. |
| **Marc · On the trail** | “Switch to Marc. How am I doing so far?” | Start the coffee quest (€20 → €10 per month), then check in with **I tried it** to earn 100 XP and Coffee Saver. Cooking at home and the free picnic are additional habits. Estimated savings stay separate from the account balance. |
| **Núria · Faster routes** | “Open Núria’s demo and tell me if anything needs my attention.” Then say “Yes, read my updates.” | The board opens with **five unread**. Confirm to open a time-by-stage view. Green shows years already passed, purple shows the selected future, and gray shows other options. Selecting a route highlights its waypoint and changes the projected mortgage and payoff dates. Say “Preview Route B,” then “Take it” or “Keep my current route.” A is the lower deposit, B is Manresa and C is the hybrid job. Two more options sit below the map. Selecting a preview leaves the active route unchanged. The rule example reaches the sample upfront goal with current savings and shows a €200 rent-versus-payment difference before ownership costs. Route comparisons show the upfront timing separately from the modeled finish. |
| **Jordi · Debt-free home** | “Switch to Jordi and show me the finish.” | Jordi opens at 100% repaid and offers to roll the credits. Say “Yes, show the credits” or click **Roll the credits** to see the animated finale, recap, and achievements. Use **Replay the last installment** to watch Dot’s final move again. |

For voice, select the plugin first. If ChatGPT Live can call it in your account, ask the Laia prompt aloud. Otherwise use the composer microphone to dictate each answer and send it, or type answers. The plugin returns grouped prompts and saves answers through a batch tool. ChatGPT handles speech. The live board updates after each saved turn. Native widget visibility depends on the client, so keep the shared browser board open for voice. ChatGPT might ask for approval for a tool write on screen. Each scene opens on request or via a persona button. The unread prompt appears when you open Núria, so the demo works without background delivery.

To reset by chat, say “Reset all four personas in this relo.cat demo run and show Laia.” Starting relo.cat again resumes the same board. For an independent rehearsal, explicitly request a separate run or use `open_demo { newRun: true }` in MCP Inspector. For a quick browser start on a specific user, append `?persona=progress`, `?persona=shortcuts`, or `?persona=payoff` to the preview URL.

## Verify

```sh
npm run check
npm test
```

The tests exercise the actual Streamable HTTP MCP endpoint, resource registration, shared board sync, batch onboarding validation, the sample bank calculation, housing and finance fields, habit check-ins and XP, route timing, preview and confirmation, payoff credits and replay, and both reset modes. For manual tool inspection, run `npx @modelcontextprotocol/inspector`, select **Streamable HTTP**, and connect to `http://localhost:8787/mcp`. Call `open_demo` with `{"persona":"shortcuts"}`, then call `update_demo` with the returned `runId` and `"action":"read_inbox"`.

The prototype has no API key requirement. ChatGPT supplies the language model, while TypeScript calculates and stores the demo state. A production connection would use separately consented read-only open banking, authenticated persistent state, verified sources and opt-in alerts.

Laia’s optional fields follow the team’s shared profile contract on `main`. The demo collects those preferences in memory. The purchase budget uses a 30% planning assumption unless you enter a custom upfront goal, and the emergency reserve stays outside the cash available for the purchase.

## Deck artwork

The four animated illustrations in `assets/deck/` come from the team's `ReloCat-DevDays-2026-Animated.pptx`. The GIFs match the deck's embedded artwork from slides 3 (Laia), 6 (savings), 4 (route scout), and 7 (keys). The JPEGs are first-frame previews for reduced motion and for widgets without a configured public asset origin.
