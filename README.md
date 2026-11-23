# ReloCat

**Find where you belong. Build a realistic path to your next home.**

ReloCat is a housing companion for people considering a move within Catalonia. It brings together the questions that usually live in separate places: Can I afford to buy? Which towns fit my household? How would I get to work? Are there suitable schools? Is there public support I could apply for?

You describe your needs in a conversation. ReloCat uses sourced local data and financial calculations to help you compare your options and understand what still needs checking.

[Explore ReloCat](https://www.relo.cat) · [Project documentation](docs/README.md) · [Development plan](PLAN.md)

## What can I do with it?

- **Find places that fit your life.** Compare Catalan towns using your budget, household needs, school stages and transport requirements.
- **Understand the trade-offs.** See housing indicators, school information and travel estimates, with sources, dates and gaps in the evidence.
- **Explore housing support.** Check relevant public measures and distinguish whether applications are open from whether your household meets the known criteria.
- **Make a savings plan.** Explore how your savings, monthly contribution and cash target affect the time needed to prepare for a purchase.
- **Talk through your needs.** Use the homebuying interview, with a guided option and optional voice.
- **Use your language.** Every page, widget and tool answer is written in English, Catalan and Spanish.

For example, you could ask:

> “We want to buy our first home. Which towns could fit our budget, with a primary school nearby and a manageable commute?”

The journey is to confirm your needs, compare a shortlist, inspect the evidence and choose a useful next step. A town recommendation is the start of a search; individual homes still need their own checks.

## Try the experience

**Start at [www.relo.cat](https://www.relo.cat).** The public homepage introduces the project and explains how to connect an agent. The main conversational experience uses ChatGPT with the ReloCat MCP connection enabled. You can ask to start a homebuying interview, compare towns or open the Town Explorer map.

There are several views of the project:

| View | What it is for |
| --- | --- |
| Public website | Project introduction and agent connection guide. |
| ChatGPT widgets | The Town Explorer map, the workspace, the journey board and two cards (sample cash flow, Start talking) returned during a conversation. |
| React workspace | The person, the places, the savings plan and a trail of seven checkpoints that shows where the person is, at `/workspace` and as a ChatGPT widget. |
| Interview page | `/interview/`: a guided interview, and a voice interview when the server has an OpenAI key. |
| Local journey board | A developer/demo view with fictional households and simulated financial activity. |

The public deployment can lag behind the repository. The React workspace lives in [`apps/web`](apps/web/) and is served at `/workspace` by the same server, and as a widget through the MCP endpoint.

## What is real, and what is simulated?

This is a working hackathon prototype. It covers every municipality of Catalonia: **947 town profiles, 4647 education centres, 86 rail trips and 12 policy records**. The town data is the committed snapshot in `data/towns.json`, kept current by 8 official sources that the server fetches and caches (see [How the pieces connect](#how-the-pieces-connect)); the policy records in `data/incentives.json` are versioned by hand against official texts. Depth still varies by town: scheduled rail journeys cover the FGC Lleida–La Pobla corridor only, sampled travel times exist for the 18 towns of the first pilot, detailed relocation opportunity research covers three towns, and the 2026 renovation grant was checked against its municipality table for those 18 towns only. Where a figure is not published for a town it is reported as unknown.

The **500 household profiles and demo bank movements are fictional**. They let the team test different needs and financial barriers without using anyone's real bank account. Live property searches are an optional integration; returned links are examples whose availability, location and details still need verification.

ReloCat does not approve mortgages, guarantee grants or submit applications. School presence does not establish vacancies, a travel sample is not a live journey guarantee, and a town's average housing price is not a property listing. Missing information stays visible rather than becoming an assumed answer.

## The technology behind it

ReloCat connects a conversational interface to a set of small, specialised services in one repository.

| Technology | Its role, in plain language |
| --- | --- |
| **TypeScript and Node.js** | Run the backend, data tools and local services. Shared types help the different parts agree on the shape of information. |
| **MCP — Model Context Protocol** | Gives ChatGPT a standard way to call ReloCat's tools, such as looking up a town or checking an incentive. The combined demo exposes one `/mcp` endpoint. |
| **Interactive web widgets** | Present maps, cards and forms inside a supported chat client. The current implementation includes bundled TypeScript widgets and the React workspace in `apps/web`. |
| **Zod validation** | Checks incoming data before the app uses or stores it, including municipality codes, money amounts and household criteria. |
| **Official data, live and pre-cached** | Idescat, Generalitat open data and the FGC timetable are fetched when the server starts, cached on disk and laid over the committed snapshot, which stays the baseline and the fallback. Every value keeps its source and date; `/health` and the `get_data_sources` tool report how fresh each source is. |
| **OpenAI APIs, when enabled** | Support the optional voice interview, transaction classification and bounded AI habit suggestions. Keys stay on the server. |

### How an answer is produced

1. You supply or confirm your household's needs and financial assumptions.
2. ChatGPT calls the relevant ReloCat tool through MCP.
3. The backend validates the request, filters towns against supported requirements and calculates results using the loaded data.
4. The tool returns structured results, evidence and missing-information flags.
5. ChatGPT explains the result; a widget can make it easier to inspect or compare.

**The model helps with the conversation; code performs the calculations and rule checks.** This makes it possible to inspect how a savings estimate or eligibility result was reached. Answers from different sources keep their origin and confirmation status, and conflicting inputs are surfaced for review.

### How the pieces connect

One server serves everything from a single origin: `http://127.0.0.1:8787` locally, `https://www.relo.cat` once deployed.

| Path | What it is |
| --- | --- |
| `/mcp` | The MCP endpoint ChatGPT and other agents connect to. |
| `/workspace` | React workspace: the person, the places, the savings plan and the journey trail. |
| `/preview` | Journey board with the four demo stories. |
| `/interview/` | Voice and guided interview. |
| `/connect` | Homepage and agent setup guide. |
| `/signup`, `/login`, `/account` | Accounts: a person's own profile, bank data and connected assistants. |
| `/oauth/*`, `/.well-known/oauth-*` | OAuth 2.1 for MCP clients such as ChatGPT. |
| `/test` | Local tool-testing page (this machine only). |
| `/api` | Profiles, interview answers, bank ledger, bank events and habits. The operator's admin token, or a signed-in person for their own data only. |
| `/health` | Readiness and the freshness of each data source. |

Two entities sit at the centre (`packages/model`). A **person** is a household with finances and habits. A **place** is a municipality with indicators (population, density, share of foreign residents, prices, services nearby) and benefits. The planner (`packages/planner`, the `plan_home_savings` tool) joins them: how many months until this person has the upfront cash to buy in this place, and how many fewer because of their habits and of what the place offers. A benefit is counted only when its money arrives before the purchase and eligibility is verified; everything else is shown, not counted.

Information comes in through plug-ins, one file each:

- **Official place data** is fetched when the server starts, cached on disk and refreshed in the background. The snapshot committed in `data/` remains the baseline and the fallback. A new source is one file in `packages/sources/definitions/`. The 8 official sources shipped today: `idescat-emex` (Idescat municipal profile), `gencat-equipaments` (facilities), `gencat-municipis-rurals` (rural municipalities), `gencat-centres-docents` (school directory), `gencat-cens-comercial` (retail census), `gencat-compravendes-habitatge` (registered home sales and prices), `gencat-serveis-socials` (social services register) and `fgc-gtfs` (FGC timetable). What each keeps live is in the [municipality guide](docs/areas/municipalities-incentives.md#data-sources).
- **Bank movements** come from providers. A new bank is one file in `packages/banks/providers/` (copy `_template.ts`). Two providers ship, both fictional: the in-process `synthetic` feed and `demo-bank`, which talks HTTP to Banc Demo (`apps/demo-bank`), a fictional bank with a pull API and signed webhooks. No real bank is integrated. How movements arrive, are stored and reach clients is in the [bank guide](docs/areas/bank-runtime.md) and the [bank API](apps/profile-api/BANK_API.md).

### Languages and design

ReloCat is written in English (the source and fallback), Catalan and Spanish. Every text a person reads comes from a catalog next to the code that uses it; money, dates and durations go through one formatter, `createFormat(locale)`. Text written for the model stays in English and tells it to answer in the person's language. [`packages/i18n/README.md`](packages/i18n/README.md) is the contract.

Every surface takes one theme from [`packages/ui`](packages/ui/README.md): the design tokens (`--rc-*`) and components (`.rc-*`) of `theme.css`, the icon set, and Montserrat as the one typeface, embedded so that a widget needs no network request. The illustrations (the homepage scenes and one per checkpoint of the journey trail) are listed with their prompts in `packages/ui/images.manifest.ts` and generated with `npm run images:generate`, a paid OpenAI call; a slot whose file does not exist shows a drawn SVG of the same id instead.

## Use it in ChatGPT

1. Run the server and make `/mcp` reachable over HTTPS: a deployment with `PUBLIC_ORIGIN` set, or a tunnel to your machine ([board guide](apps/board/README.md#connect-it-to-chatgpt)).
2. In ChatGPT, open **Plugins**, choose **Add custom MCP server**, name it **ReloCat** and enter the `https://…/mcp` address. Choose **No authentication** for the public tools and the fictional demo, or **OAuth** to let ChatGPT act for your own account.
3. The personal tools (your profile, your saved answers, your bank data and your own plan) work only with the account connected: create it at `/signup`, then allow the connection when ChatGPT opens the consent page. Without it they answer with a sign-in request and the assistant can still plan from figures given in the chat, which are not stored. The OAuth flow is tested with a scripted client; [`packages/auth/README.md`](packages/auth/README.md) lists what has not been confirmed against a real ChatGPT connection.
4. ChatGPT keeps its own copy of the tool list and of each widget's page. After a deployment that changes a tool or a widget, open the plugin's settings in ChatGPT and choose **Refresh tools**, then start a new chat; until then ChatGPT shows the old widget.

Every widget (Town Explorer, workspace, journey board, the cash-flow card and the Start talking card) is a single HTML document with its script bundled by `npm run build`, and reaches its host through `App` from `@modelcontextprotocol/ext-apps`. A widget whose bundle has not been built is not served.

### Voice

There are two ways to talk to ReloCat:

- **ChatGPT's voice mode.** Select the Voice icon in ChatGPT and say “Use ReloCat to start my homebuying interview.” ChatGPT speaks and listens; ReloCat's tools answer as they do in text. It costs the server nothing.
- **The product's own page, `/interview/`.** The guided interview is free and needs no key. The voice interview uses OpenAI Realtime and needs `OPENAI_API_KEY` on the server. By default the paid routes answer only a browser on the server's own machine; `INTERVIEWER_PUBLIC_AI=on` opens them to visitors of the public site, with an hourly limit per visitor, and spends the key owner's credits. See the [interviewer guide](apps/interviewer/README.md).

## Run the local demo

For developers and teammates, install **Node.js 24 or newer** and run these commands from the repository root:

```sh
npm ci
npm run dev
```

Then open:

| Address | Purpose |
| --- | --- |
| `http://127.0.0.1:8787/workspace?demo=user-001&towns=250404,252542,251207` | React workspace: a fictional demo persona (read-only), or your own plan once signed in (`/signup`, `/login`). |
| `http://127.0.0.1:8787/preview` | Connected journey board. |
| `http://127.0.0.1:8787/connect` | Homepage and agent setup guide. |
| `http://127.0.0.1:8787/test` | Local tool-testing page. |
| `http://127.0.0.1:8787/mcp` | MCP endpoint for a client, rather than a normal webpage. |

One command starts everything. Outside production it also starts Banc Demo, a fictional bank on port 3003, and links `user-001` to it, so new fictional movements keep arriving (`DEMO_BANK=off` switches it off). Stop it with **Ctrl+C**. No API key is needed; [.env.example](.env.example) lists every optional setting, ordered by where each piece of information comes from. Optional voice and AI features may consume API credits.

Agents running on another computer need a reachable HTTPS endpoint; your localhost address only points to your own machine.

For the interviewer, see [voice and guided interview setup](apps/interviewer/README.md). The React workspace needs no extra step: `npm run dev` builds it and serves it at `/workspace`.

## Find your way around the repository

| Folder | What you will find |
| --- | --- |
| [`apps/board/`](apps/board/README.md) | Journey board: the same MCP server plus the live demo page. |
| [`apps/mcp-server/`](apps/mcp-server/README.md) | The MCP server: municipality, interview and bank tools, Town Explorer and agent connection pages. |
| [`apps/interviewer/`](apps/interviewer/README.md) | Voice and guided interview in the browser, mounted at `/interview/`. |
| [`apps/demo-bank/`](apps/demo-bank/README.md) | Banc Demo: a fictional bank with a pull API and signed webhooks, on its own port. |
| [`apps/profile-api/`](apps/profile-api/README.md) | Profile storage, shared inputs, bank movements and financial analysis. |
| [`apps/habits-agent/`](apps/habits-agent/README.md) | Habit suggestions, goals and check-ins, served under `/api`. |
| [`apps/server/`](apps/server/index.ts) | The one server that mounts everything on a single origin. |
| [`apps/web/`](apps/web/) | React workspace: the `/workspace` page and the ChatGPT widget. |
| [`packages/`](packages/) | Shared code: contracts, the person and place entities, the savings planner, bank providers, live data sources, town matching, finance, HTTP helpers and configuration. |
| [`data/`](data/) | Dated municipality/policy snapshots and fictional user fixtures. |
| [`docs/`](docs/README.md) | Area guides, integration notes and team setup. |

Committed demo fixtures stay separate from the runtime database (`data/relocat.db`, ignored by Git). Never commit real financial records, API keys or access tokens.

Every stored person belongs to an account (`/signup`, `/login`, `/account`), and MCP clients such as ChatGPT connect on a person's behalf with OAuth 2.1. No tool takes a user id: personal tools read and write only the caller's own person, and the four fictional personas are a read-only public demo. See [`packages/auth/README.md`](packages/auth/README.md) and [`docs/areas/integration-deployment.md`](docs/areas/integration-deployment.md).

## Contributing and verification

Start with the [development map](docs/README.md) and the relevant area guide. The [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) holds product decisions; [PLAN.md](PLAN.md) tracks implementation work. Code and checks establish what is delivered.

For code changes, the repository checks are:

```sh
npm run check
```

That runs the linter, type checks, tests and data validation. `npm run format` applies the shared code style.

Every script in `package.json`:

| Command | What it does |
| --- | --- |
| `npm run dev` | Builds the browser bundles and starts the one server, restarting when a file in `apps/` or `packages/` changes. |
| `npm start` | The same without the file watcher. |
| `npm run build` | Bundles the widgets, the interview page and the workspace into each app's `dist/`. |
| `npm run start:board`, `npm run start:interviewer` | The journey board or the interview page alone, for a rehearsal without the API. |
| `npm run start:demo-bank`, `npm run demo-bank:connect` | Banc Demo as its own process, and the link from a running ReloCat to it ([Banc Demo](apps/demo-bank/README.md)). |
| `npm run check` | `npm run lint`, `npm run typecheck`, `npm test` and `npm run data:validate`, in that order. |
| `npm run format` | Applies the Biome formatting and safe lint fixes. |
| `npm run data:refresh` | Rebuilds the committed place snapshot from the official sources. |
| `npm run generate:users` | Regenerates the fictional profiles; with `-- --overwrite` it resets the committed fixtures and exports. |
| `npm run db:backup`, `npm run db:import-legacy`, `npm run db:reseed-demo` | Copies the runtime database while the server runs; imports JSON files of a version without a database; realigns the demo personas with the fixtures ([deployment guide](docs/areas/integration-deployment.md)). |
| `npm run package:team-plugin` | Builds the team's skills bundle ([team setup](docs/team-plugin-setup.md)). |
| `npm run images:generate` | Generates the missing illustrations with OpenAI (paid). |

Keep calculations explicit, preserve source links and dates, and show uncertainty where the evidence does not support a conclusion.
