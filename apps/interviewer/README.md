# Homebuying Interviewer

A hackathon prototype that turns bank transactions and a voice interview into a first-home savings plan.

## Run locally

From the repository root, use Node.js 24 or newer. Set `OPENAI_API_KEY` in your environment or in a local `.env` file for live voice and Decisions. If OpenAI rejects the key, replace the environment value and restart the server. An existing environment value takes precedence over `.env`. Then run:

```powershell
npm.cmd ci
npm.cmd run start:interviewer
```

Open [the local voice demo](http://localhost:3000) in Chrome or Edge.

The connected `npm run dev:stack` starts this backend separately on **3003** and the main plugin on **8787**. Open `http://127.0.0.1:8787/interviewer/` to use the main app's local same-origin bridge to that backend, or open `http://127.0.0.1:3003/` directly. Override `INTERVIEWER_PORT` for the launcher; it must differ from `PROFILE_API_PORT` and `APP_PORT`. The standalone command retains its default port 3000; to use 3003 in a separate terminal set `$env:INTERVIEWER_PORT = '3003'` before `npm run start:interviewer`.

The plugin server's `INTERVIEWER_BASE_URL` defaults to `http://127.0.0.1:3003`. The bridge forwards only the known interviewer assets and voice/classification routes to a loopback backend. It rejects foreign browser origins and public/tunnel hosts; it does not expose the local OpenAI-backed voice service to the public MCP audience. Its relative asset paths work both directly and under `/interviewer/`. OpenAI credentials stay in the backend's environment; the launcher inherits existing environment values but does not automatically load `.env`. Guided mode and fixture checks require no paid API calls.

1. Click **Start talking** and allow microphone access. You can start before sharing any financial data. Try “I’d like a flat in Madrid, near a park and a supermarket. I’m open to nearby towns with a train.”
2. Say “I’d like to connect a bank” or open **Add bank data**. Choose **Connect a bank** and confirm the demo account to load three months of fictional euro transactions, or choose **Upload CSV** and select the statement’s currency. You can do this mid-conversation. The interviewer receives the new summary without restarting.
3. Confirm pay and expenses, then give a cash savings goal, current savings and your typical contribution. The interviewer generates the first scenario automatically. A €30,000 target with €6,000 saved and €600 contributed monthly takes 40 months. With the fictional demo account, the habits rules also return optional suggestions for review without adding assumed savings to the timeline. Open **Your plan** to see the result.

The live interview keeps the screen focused on listening and speaking. **Conversation options** lets you show captions, type a reply, or start a **Guided interview** without API calls. **Your plan** also lets you review and edit saved answers. The raw CSV stays in the browser. The saved summary and answers persist locally and are shared along with microphone audio when voice is active.

CSV format is `date,description,amount` with YYYY-MM-DD dates and signed amounts. Semicolon-delimited files and comma decimals are also accepted. The demo account tries the OpenAI Decisions API. For your own CSV, enable **Categorize CSV with OpenAI** before uploading to use it. The request contains up to 80 distinct shortened descriptions and their money-in or money-out direction. Dates, amounts and the raw CSV stay in the browser. The category choices include payroll, other income, housing rent, restaurants and takeout, groceries, utilities and transport. Low-confidence, unavailable, or unclassified results fall back to local keyword rules. Monthly averages include each month represented in the file, so partial months can skew them. Only transfers with recognizable internal-transfer descriptions are excluded.

## Connect the ChatGPT plugin

Run `npm.cmd run start:mcp` to start Relocat’s shared MCP server at `http://localhost:8787/mcp`. Connect it using a Secure MCP Tunnel or an HTTPS endpoint forwarding to that listener. In ChatGPT Plugins, select **Add custom MCP server**, enter that endpoint and install the plugin. In Work, invoke it and ask “Show me the sample cash flow for a first-time buyer.”

The sample tool displays a cash-flow card and a spending breakdown in ChatGPT. The plugin can also analyze CSV text shared explicitly in chat and compare two savings timelines. Try “Interview me one question at a time using the fictional cash flow, then help me compare two savings timelines.” The local Realtime interview runs in the browser demo and retains its own profile. Live banking and cross-device accounts are outside the prototype.

[Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) · [Realtime WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc)
