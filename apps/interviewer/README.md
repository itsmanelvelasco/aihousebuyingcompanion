# Homebuying Interviewer

The product's own voice page: bank transactions and a voice or guided interview that end in the same plan as the workspace and the chat.

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
| `POST /interview/scenario` | Plain savings arithmetic from `packages/finance`, for other clients. The page does not call it: its plan is `plan_home_savings`. | Free. Public. |
| `POST /interview/classify` | OpenAI Decisions categorizes shortened merchant descriptions. | Paid with `OPENAI_API_KEY`. Restricted. |
| `POST /interview/voice` | Exchanges the WebRTC offer for an OpenAI Realtime voice session. | Paid with `OPENAI_API_KEY`. Restricted. |

The guided interview, the demo bank and CSV upload use only the free routes; the plan, the question order and saving use `/mcp` on the same origin. The page falls back to local keyword rules and to the guided interview whenever a paid route is unavailable.

The paid routes keep the key on the server and are closed by default:

- Without `OPENAI_API_KEY` they answer 503. Set it in your environment or in a local `.env` file. An existing environment value takes precedence over `.env`. If OpenAI rejects the key, replace it and restart the server.
- By default they answer only a browser on the server's own machine: a `localhost` or `127.0.0.1` address on the server's port, a loopback connection, no proxy or tunnel headers, and an `Origin` equal to that address. A visitor arriving through a tunnel or at `https://www.relo.cat` gets 403 and can still use the guided interview.
- `INTERVIEWER_PUBLIC_AI=on` opens them to visitors of the public site. Requests must still be same-origin (`Origin` matching the request host or `PUBLIC_ORIGIN`). Each visitor address gets `INTERVIEWER_AI_REQUESTS_PER_HOUR` paid requests per hour (default 20) across both routes, all visitors together get ten times that, and further requests answer 429. The body limits stay: 20 kB and 80 descriptors for `/classify`, 64 KiB for `/voice`.

The same-origin check stops other websites from using the routes through a visitor's browser. It does not stop a script that forges the header, so with public AI on, the hourly limits are what bound the spend. The limit is the shared limiter in `packages/http/rate-limit.ts` with this route's stricter numbers. By default a visitor is identified by the last `X-Forwarded-For` entry when the request arrives through a tunnel or proxy on the same machine, otherwise by the connecting address; a `CF-Connecting-IP` header is believed only when `CLIENT_IP_HEADER=cf-connecting-ip` says Cloudflare writes it. Behind a remote proxy, set `CLIENT_IP_HEADER=x-forwarded-for` (and `TRUSTED_PROXY_HOPS` when there is more than one proxy), or every visitor shares one allowance. Counters are in memory and reset when the server restarts. A voice session is billed by OpenAI for as long as it stays open. Set a spending limit on the OpenAI project before switching public AI on.

## Use it

1. Click **Start talking** and allow microphone access. The interviewer starts with bank data: upload a CSV, connect the fictional demo bank, or give rough figures by voice. Say "I'd like to connect a bank" or open **Add bank data** at any time; the interviewer receives the new summary without restarting.
2. Answer one question at a time. Say "I earn 3,100 and spend 2,050": the interviewer repeats the figures and, once you confirm, saves them as monthly income and monthly spending. Name a town ("Talarn"): it is chosen only when it is exactly a town of the pilot and you confirm it.
3. Ask for the plan, or open **Your plan**. It is the answer of `plan_home_savings`: the shortest timeline, the next question, the aid counted and the aid awaiting verification with the question that would verify it, and what the estimate assumes. **Open the workspace** carries the same towns to `/workspace`.

### One question set, one order, one plan

- **Questions.** The page asks the shared question set of `packages/model/questions.ts` and nothing else: income, spending and savings are those questions, each asked once. The order is the planner's: after each answer the page calls `get_next_questions` on `/mcp` of the same origin, with the page language, `me: true` when signed in or the answers of this device as an inline person otherwise, and the towns chosen (possibly none). What a timeline needs comes first, then the town, then who will live in the home, then the rest as the planner ranks it. Running on its own port there is no planner, and the set is asked in its own order.
- **Page details.** Three answers are not in the shared set and each has an input path: the people in the home (`household.size`), your own cash target when you state one (`finance.targetCashCents`) and the town (`location.selectedMunicipalityCode`). The earlier fields with no input path (home type, amenities, nearby areas, lifestyle, notes, monthly contribution) are gone.
- **Town.** A spoken or typed name is matched against `list_catalonia_municipalities`. Only an exact name (accents and case aside) resolves; anything else returns the similar names and stores nothing.
- **Plan.** The page does no savings arithmetic. `POST /interview/scenario` still exists for other clients; the page does not call it.
- **Trail.** Under the heading, the checkpoint to work on with its illustration and "n of 7 reached": the seven steps of the workspace's trail, judged from the same plan result with the same rules.

### Where the answers go

The page says which of these applies:

- **On the main server, signed in:** each answer you confirm, by voice or in the guided interview, is saved at once to your profile: one `save_my_inputs` call to `/mcp` on the same origin with the session cookie, source `interview`, confirmed, "I don't know" as `null`. No button is involved. If a save fails the answer stays on this device, marked, and **Save my answers to my ReloCat profile** appears to try again.
- **On the main server, signed out:** the answers stay in this browser. The assistant says so once, with how to sign in, and the page shows **Sign in to save them**. After signing in, what was answered before is saved on return.
- **On its own port:** the answers stay in this browser and there is no plan.

### Voice

The Realtime session gets six functions (`voice.ts`): `save_interview_answers` (every shared question plus `householdSize` and `targetCash`; amounts in euros as spoken, stored as cents), `save_place`, `show_plan`, `open_workspace`, `save_to_profile` and `show_interview_panel` (bank data). Each is answered by the same code as the guided form (`session.ts`).

The instructions are English and name the page's buttons with the label of the language shown, so the assistant says "Añade datos bancarios", not "Add bank data". With Catalan or Spanish chosen, the session also states that language for transcription (`audio.input.transcription.language`), so Catalan is not transcribed as Spanish; with English, the page default, no language is stated and the person is followed. If the service refuses the settings, they are sent once more without transcription. The session is told which questions are answered (ids only) and which comes next; the values of answers typed in the guided interview are not sent to OpenAI. The classification call carries merchant descriptions and nothing else.

The live interview keeps the screen focused on listening and speaking. **Conversation options** lets you show captions, type a reply, or start a **Guided interview** without API calls. **Your plan** lists your answers, each with **Change**. The raw CSV stays in the browser. The statement summary and the answers persist locally.

CSV format is `date,description,amount` with YYYY-MM-DD dates and signed amounts. Semicolon-delimited files and comma decimals are also accepted. The demo account tries the OpenAI Decisions API. For your own CSV, enable **Categorize CSV with OpenAI** before uploading to use it. The request contains up to 80 distinct shortened descriptions and their money-in or money-out direction. Dates, amounts and the raw CSV stay in the browser. The category choices include payroll, other income, housing rent, restaurants and takeout, groceries, utilities and transport. Low-confidence, unavailable, or unclassified results fall back to local keyword rules. Monthly averages include each month represented in the file, so partial months can skew them. Only transfers with recognizable internal-transfer descriptions are excluded.

## Connect the ChatGPT plugin

Run `npm start` to start ReloCat’s shared MCP server at `http://localhost:8787/mcp`. Connect it using a Secure MCP Tunnel or an HTTPS endpoint forwarding to that listener. In ChatGPT Plugins, select **Add custom MCP server**, name it **ReloCat**, enter that endpoint and install the plugin. In Work, invoke it and ask “Show me the sample cash flow for a first-time buyer.” To speak instead, select ChatGPT's Voice icon and say “Use ReloCat to start my homebuying interview.” After a deployment that changes a card, choose **Refresh tools** in the plugin's settings: ChatGPT keeps its own copy of each widget.

The sample tool displays a cash-flow card and a spending breakdown in ChatGPT. The plugin can also analyze CSV text shared explicitly in chat and compare two savings timelines. Try “Interview me one question at a time using the fictional cash flow, then help me compare two savings timelines.” The Realtime interview runs in the browser page and keeps its answers in that browser until a signed-in person saves them to their profile (above). No real bank is integrated.

[Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) · [Realtime WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc)
