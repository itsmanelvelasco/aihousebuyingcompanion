# Homebuying Interviewer

A hackathon prototype that turns bank transactions and a voice interview into a first-home savings plan.

## Run locally

From the repository root, use Node.js 24 or newer:

```powershell
npm ci
npm start
```

Open [the interview](http://127.0.0.1:8787/interview/) in Chrome or Edge. It is part of the one ReloCat server, next to `/preview`, `/connect` and `/mcp`. To run it alone, use `npm run start:interviewer` and open `http://localhost:3000`.

## What is free and what is paid

| Route | What it does | Cost and access |
| --- | --- | --- |
| `/interview/`, `app.js`, `demo.csv` | The page, its script and the fictional statement. | Free. Public. |
| `POST /interview/scenario` | Months to the savings target, calculated by `packages/finance`. | Free. Public. |
| `POST /interview/classify` | OpenAI Decisions categorizes shortened merchant descriptions. | Paid with `OPENAI_API_KEY`. Restricted. |
| `POST /interview/voice` | Exchanges the WebRTC offer for an OpenAI Realtime voice session. | Paid with `OPENAI_API_KEY`. Restricted. |

The guided interview, the demo bank, CSV upload and the plan use only the free routes. The page falls back to local keyword rules and to the guided interview whenever a paid route is unavailable.

The paid routes keep the key on the server and are closed by default:

- Without `OPENAI_API_KEY` they answer 503. Set it in your environment or in a local `.env` file. An existing environment value takes precedence over `.env`. If OpenAI rejects the key, replace it and restart the server.
- By default they answer only a browser on the server's own machine: a `localhost` or `127.0.0.1` address on the server's port, a loopback connection, no proxy or tunnel headers, and an `Origin` equal to that address. A visitor arriving through a tunnel or at `https://www.relo.cat` gets 403 and can still use the guided interview.
- `INTERVIEWER_PUBLIC_AI=on` opens them to visitors of the public site. Requests must still be same-origin (`Origin` matching the request host or `PUBLIC_ORIGIN`). Each visitor address gets `INTERVIEWER_AI_REQUESTS_PER_HOUR` paid requests per hour (default 20) across both routes, all visitors together get ten times that, and further requests answer 429. The body limits stay: 20 kB and 80 descriptors for `/classify`, 64 KiB for `/voice`.

The same-origin check stops other websites from using the routes through a visitor's browser. It does not stop a script that forges the header, so with public AI on, the hourly limits are what bound the spend. A visitor is identified by the address a tunnel or proxy on the same machine reports (`CF-Connecting-IP`, else the last `X-Forwarded-For` entry), otherwise by the connecting address, so visitors behind a remote proxy share one allowance. Counters are in memory and reset when the server restarts. A voice session is billed by OpenAI for as long as it stays open. Set a spending limit on the OpenAI project before switching public AI on.

## Use it

1. Click **Start talking** and allow microphone access. You can start before sharing any financial data. Try “I’d like a flat in Madrid, near a park and a supermarket. I’m open to nearby towns with a train.”
2. Say “I’d like to connect a bank” or open **Add bank data**. Choose **Connect a bank** and confirm the demo account to load three months of fictional euro transactions, or choose **Upload CSV** and select the statement’s currency. You can do this mid-conversation. The interviewer receives the new summary without restarting.
3. Confirm pay and expenses, then give a cash savings goal, current savings and your typical contribution. The interviewer generates the first scenario automatically. A €30,000 target with €6,000 saved and €600 contributed monthly takes 40 months. With the fictional demo account, the habits rules also return optional suggestions for review without adding assumed savings to the timeline. Open **Your plan** to see the result.

The live interview keeps the screen focused on listening and speaking. **Conversation options** lets you show captions, type a reply, or start a **Guided interview** without API calls. **Your plan** also lets you review and edit saved answers. The raw CSV stays in the browser. The saved summary and answers persist locally and are shared along with microphone audio when voice is active.

CSV format is `date,description,amount` with YYYY-MM-DD dates and signed amounts. Semicolon-delimited files and comma decimals are also accepted. The demo account tries the OpenAI Decisions API. For your own CSV, enable **Categorize CSV with OpenAI** before uploading to use it. The request contains up to 80 distinct shortened descriptions and their money-in or money-out direction. Dates, amounts and the raw CSV stay in the browser. The category choices include payroll, other income, housing rent, restaurants and takeout, groceries, utilities and transport. Low-confidence, unavailable, or unclassified results fall back to local keyword rules. Monthly averages include each month represented in the file, so partial months can skew them. Only transfers with recognizable internal-transfer descriptions are excluded.

## Connect the ChatGPT plugin

Run `npm start` to start ReloCat’s shared MCP server at `http://localhost:8787/mcp`. Connect it using a Secure MCP Tunnel or an HTTPS endpoint forwarding to that listener. In ChatGPT Plugins, select **Add custom MCP server**, enter that endpoint and install the plugin. In Work, invoke it and ask “Show me the sample cash flow for a first-time buyer.”

The sample tool displays a cash-flow card and a spending breakdown in ChatGPT. The plugin can also analyze CSV text shared explicitly in chat and compare two savings timelines. Try “Interview me one question at a time using the fictional cash flow, then help me compare two savings timelines.” The Realtime interview runs in the browser page and retains its own profile. Live banking and cross-device accounts are outside the prototype.

[Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) · [Realtime WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc)
