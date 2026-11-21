# Arrela · ChatGPT hackathon demo

Four fictional Catalan homeownership stories in one MCP plugin. The persona buttons switch users within a demo run, so one ChatGPT login is enough. **Reset persona** restores the current scene. **Reset all four** restores all scenes in your current run. Opening a demo without a run ID starts a separate run. Runs are held in server memory and clear on restart.

This is an isolated prototype for the [team’s AI Housing Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003). It reuses Homebound's Dot map, percentage bars and achievements, plus Clara's unread-update and relevance mechanics. It uses the team’s Catalonia and simulated banking approach. All accounts, offers, regulation changes, benefits, listings, payments and leaderboard entries are scripted. The rural scene illustrates verifying a Catalan program, school and transport access.

## Start locally

Install Node.js 22.18+ with npm, then run from the repository:

```sh
cd demo-plugin
npm ci
npm start
```

Open [localhost:8787/preview](http://localhost:8787/preview) for the full browser rehearsal. It uses the same scenario functions and board as ChatGPT. The live board is paired to its current demo run and updates after tool calls. Start another terminal for the tunnel or tests. To use a different port, set `PORT`, for example `PORT=8788 npm start`.

## Connect to ChatGPT

1. With the server running, expose the port through an HTTPS tunnel. If you already have [ngrok](https://ngrok.com/) configured, run `ngrok http 8787` in a second terminal. Copy the HTTPS forwarding address. Restart the server with `PUBLIC_ORIGIN=https://your-tunnel-host npm start` so the plugin can return live board links. Append `/mcp` to the forwarding address for the ChatGPT connection.
2. In [ChatGPT Plugins](https://chatgpt.com/plugins), choose **+ → Add custom MCP server**. Name it **Arrela Demo**, enter the tunnel URL ending in `/mcp`, and select **No authentication** for this fictional demo. Review the permissions and create the plugin.
3. Install it from your personal Plugins list. In a fresh ChatGPT Work conversation, type `@`, choose **Arrela Demo**, and use the prompts below. If the connection was already installed and you change the tools, refresh its connection. Update the server URL when the tunnel URL changes.
4. Use **Expand** on the board if the host offers fullscreen. For a voice rehearsal, leave the live browser board beside the conversation. Read the eight-character code at the top and say **“Join Arrela board CODE and start Laia.”** The same board follows completed tool calls and persona switches. If you opened the chat first, ask for its live board link. Refresh the installed connection after upgrading to this version so the new inputs and widget are available.

See OpenAI’s [MCP server and UI quickstart](https://developers.openai.com/plugins/build/app-quickstart) and [plugin connection guide](https://developers.openai.com/plugins/quickstart) for current setup screens. Custom plugin access depends on ChatGPT workspace settings. Leave a publicly reachable tunnel up only while testing with fictional details.

## Rehearse the four scenes

| Persona | What to say in ChatGPT | What to show |
| --- | --- | --- |
| **Laia · Getting started** | “Join my Arrela board using code CODE and start Laia. Ask for related details together.” | Try “We’re three people looking for two bedrooms in Manresa. I work full time.” The board saves all four details together. Say “Connect the sample bank and show my updated plan,” or use the button. The fixture fills €18,400 saved, €2,900 net income and €2,180 spending, producing a €720/month surplus and a 50-month estimate for the sample €54,000 upfront milestone. The board then models a 20-year mortgage term, or 290 months total to owning outright. |
| **Marc · On the trail** | “Switch to Marc. How am I doing so far?” | Dot, a 60% savings bar, XP, achievements and a leaderboard. Join the sample picnic to move Dot and earn Good Neighbor and 100 XP. Open the shareable invite draft. |
| **Núria · Faster routes** | “Open Núria’s demo and tell me if anything needs my attention.” Then say “Yes, read my updates.” | The board opens with **five unread**. Confirm before loading the inbox. Compare the regulation, job, rural move, builder or listing and community options. Choose or keep the current route. The rule example reaches the sample upfront goal with current savings and shows a €200 rent-versus-payment difference before ownership costs. Route comparisons show the upfront timing separately from the modeled finish. |
| **Jordi · Debt-free home** | “Switch to Jordi and show me the finish.” | Jordi opens with 100% repaid, €0 mortgage balance and €0 other demo debt. Use **Replay the last installment** to replay Dot’s final move and the Mortgage-Free badge. |

For voice, select the plugin first. If ChatGPT Live can call it in your account, ask the Laia prompt aloud. Otherwise use the composer microphone to dictate each answer and send it, or type answers. The plugin returns grouped prompts and saves answers through a batch tool. ChatGPT handles speech. The live board updates after each saved turn. Native widget visibility depends on the client, so keep the paired browser view open for voice. ChatGPT might ask for approval for a tool write on screen. Each scene opens on request or via a persona button. The unread prompt appears when you open Núria, so the demo works without background delivery.

To reset by chat, say “Reset all four personas in this Arrela demo run and show Laia.” A new conversation can also start a fresh run by opening the demo without a run ID. For a quick browser start on a specific user, append `?persona=progress`, `?persona=shortcuts`, or `?persona=payoff` to the preview URL.

## Verify

```sh
npm run check
npm test
```

The tests exercise the actual Streamable HTTP MCP endpoint, resource registration, board pairing and sync, batch onboarding validation, the sample bank calculation, XP, the unread inbox, payoff replay, and both reset modes. For manual tool inspection, run `npx @modelcontextprotocol/inspector`, select **Streamable HTTP**, and connect to `http://localhost:8787/mcp`. Call `open_demo` with `{"persona":"shortcuts"}`, then call `update_demo` with the returned `runId` and `"action":"read_inbox"`.

The prototype has no API key requirement. ChatGPT supplies the language model, while TypeScript calculates and stores the demo state. A production connection would use separately consented read-only open banking, authenticated persistent state, verified sources and opt-in alerts.
