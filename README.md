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

For example, you could ask:

> “We want to buy our first home. Which towns could fit our budget, with a primary school nearby and a manageable commute?”

The journey is to confirm your needs, compare a shortlist, inspect the evidence and choose a useful next step. A town recommendation is the start of a search; individual homes still need their own checks.

## Try the experience

**Start at [www.relo.cat](https://www.relo.cat).** The public homepage introduces the project and explains how to connect an agent. The main conversational experience uses ChatGPT with the ReloCat MCP connection enabled. You can ask to start a homebuying interview, compare towns or open the Town Explorer map.

There are several views of the project:

| View | What it is for |
| --- | --- |
| Public website | Project introduction and agent connection guide. |
| ChatGPT widgets | Interactive interview cards, town maps and comparisons returned during a conversation. |
| Local journey board | A developer/demo view with fictional households and simulated financial activity. |

The public deployment and local development branches can contain different features. The [React workspace in PR #18](https://github.com/itsmanelvelasco/aihousebuyingcompanion/pull/18) adds profile/input management, bank controls and reviewed interviews to both a local web view and an MCP widget; it is separate from the features currently merged into `main`.

## What is real, and what is simulated?

This is a working hackathon prototype. Its municipality pilot includes **18 town profiles, 238 education centres, 86 rail trips and six policy records**, drawn from dated datasets. Coverage is limited: one profile is the Lleida transport destination, and detailed relocation opportunity research currently covers three towns.

The **500 household profiles and demo bank movements are fictional**. They let the team test different needs and financial barriers without using anyone's real bank account. Live property searches are an optional integration; returned links are examples whose availability, location and details still need verification.

ReloCat does not approve mortgages, guarantee grants or submit applications. School presence does not establish vacancies, a travel sample is not a live journey guarantee, and a town's average housing price is not a property listing. Missing information stays visible rather than becoming an assumed answer.

## The technology behind it

ReloCat connects a conversational interface to a set of small, specialised services in one repository.

| Technology | Its role, in plain language |
| --- | --- |
| **TypeScript and Node.js** | Run the backend, data tools and local services. Shared types help the different parts agree on the shape of information. |
| **MCP — Model Context Protocol** | Gives ChatGPT a standard way to call ReloCat's tools, such as looking up a town or checking an incentive. The combined demo exposes one `/mcp` endpoint. |
| **Interactive web widgets** | Present maps, cards and forms inside a supported chat client. The current implementation includes bundled TypeScript widgets; the React workspace is developed in PR #18. |
| **Zod validation** | Checks incoming data before the app uses or stores it, including municipality codes, money amounts and household criteria. |
| **Official data snapshots** | Keep municipal facts, policy rules and evidence dates available for repeatable comparisons. They are not assumed to be live feeds. |
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
| `/workspace` | React workspace: the person, the places and the savings plan. |
| `/preview` | Journey board with the four demo stories. |
| `/connect` | Homepage and agent setup guide. |
| `/api` | Profiles, interview answers, bank ledger, bank events and habits. Bearer token, server-side only. |
| `/health` | Readiness and the freshness of each data source. |

Two entities sit at the centre. A **person** is a household with finances and habits. A **place** is a municipality with indicators (population, density, share of foreign residents, prices, services nearby) and benefits. The planner joins them: how many months until this person has the upfront cash to buy in this place, and how many fewer because of their habits and of what the place offers. A benefit is counted only when its money arrives before the purchase and eligibility is verified; everything else is shown, not counted.

Information comes in through plug-ins, one file each:

- **Official place data** is fetched when the server starts, cached on disk and refreshed in the background. The snapshot committed in `data/` remains the baseline and the fallback. A new source is one file in `packages/sources/definitions/`.
- **Bank movements** come from providers. A new bank is one file in `packages/banks/providers/` implementing a handful of functions. Banks announce new movements at `/api/webhooks/bank/<provider>`, and clients receive them through a live event stream. Only the synthetic demo provider ships today.

## Run the local demo

For developers and teammates, install **Node.js 24 or newer** and run these commands from the repository root:

```sh
npm ci
npm run dev
```

Then open:

| Address | Purpose |
| --- | --- |
| `http://127.0.0.1:8787/workspace?user=user-001&towns=250404,252542,251207` | React workspace: person, places and the savings plan. |
| `http://127.0.0.1:8787/preview` | Connected journey board. |
| `http://127.0.0.1:8787/connect` | Homepage and agent setup guide. |
| `http://127.0.0.1:8787/test` | Local tool-testing page. |
| `http://127.0.0.1:8787/mcp` | MCP endpoint for a client, rather than a normal webpage. |

One process starts everything and enables the synthetic bank feed for `user-001`. Stop it with **Ctrl+C**. No API key is needed; [.env.example](.env.example) lists every optional setting, ordered by where each piece of information comes from. Optional voice and AI features may consume API credits.

Agents running on another computer need a reachable HTTPS endpoint; your localhost address only points to your own machine.

For the separate interviewer, see [voice and guided interview setup](apps/interviewer/README.md). For the React workspace, follow [PR #18](https://github.com/itsmanelvelasco/aihousebuyingcompanion/pull/18) and its branch instructions.

## Find your way around the repository

| Folder | What you will find |
| --- | --- |
| [`apps/board/`](apps/board/README.md) | Journey board: the same MCP server plus the live demo page. |
| [`apps/mcp-server/`](apps/mcp-server/README.md) | The MCP server: municipality, interview and bank tools, Town Explorer and agent connection pages. |
| [`apps/interviewer/`](apps/interviewer/README.md) | Standalone voice and guided interview in the browser. |
| [`apps/profile-api/`](apps/profile-api/README.md) | Profile storage, shared inputs, bank movements and financial analysis. |
| [`apps/habits-agent/`](apps/habits-agent/README.md) | Optional habit suggestions, goals and check-ins. |
| [`apps/server/`](apps/server/index.ts) | The one server that mounts everything on a single origin. |
| [`apps/web/`](apps/web/) | React workspace widget for ChatGPT. |
| [`packages/`](packages/) | Shared code: contracts, the person and place entities, the savings planner, bank providers, live data sources, town matching, finance, HTTP helpers and configuration. |
| [`data/`](data/) | Dated municipality/policy snapshots and fictional user fixtures. |
| [`docs/`](docs/README.md) | Area guides, integration notes and team setup. |

Committed demo fixtures stay separate from ignored runtime records. Never commit real financial records, API keys or access tokens. The shared-token demo is not production per-user access control.

## Contributing and verification

Start with the [development map](docs/README.md) and the relevant area guide. The [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) holds product decisions; [PLAN.md](PLAN.md) tracks implementation work. Code and checks establish what is delivered.

For code changes, the repository checks are:

```sh
npm run check
```

That runs the linter, type checks, tests and data validation. `npm run format` applies the shared code style.

Keep calculations explicit, preserve source links and dates, and show uncertainty where the evidence does not support a conclusion.
