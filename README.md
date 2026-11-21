# ReloCat

**Find where you belong. Build a realistic path to your next home.**

ReloCat is a housing companion for people considering a move within Catalonia. It brings together the questions that usually live in separate places: Can I afford to buy? Which towns fit my household? How would I get to work? Are there suitable schools? Is there public support I could apply for?

You describe your needs in a conversation. ReloCat uses sourced local data and financial calculations to help you compare your options and understand what still needs checking.

[Explore ReloCat](https://www.relo.cat) · [Project documentation](docs/README.md) · [Development plan](PLAN.md)

## What can I do with it?

- **Find places that fit your life.** Compare Catalan towns using your budget, household needs, school stages and transport requirements.
- **Understand the trade-offs.** See housing indicators, school information and travel estimates, with sources, dates and gaps in the evidence.
- **Explore housing support.** Check relevant public measures and distinguish whether applications are open from whether your household meets the known criteria.
- **Make a savings plan.** Explore how your savings, monthly contribution and cash target affect the time needed to prepare for a purchase. Choose **Try the Savings Coach** on the homepage to try a plan with fictional data.
- **Talk through your needs.** Use the homebuying interview, with a guided option and optional voice.

For example, you could ask:

> “We want to buy our first home. Which towns could fit our budget, with a primary school nearby and a manageable commute?”

The journey is to confirm your needs, compare a shortlist, inspect the evidence and choose a useful next step. A town recommendation is the start of a search; individual homes still need their own checks.

## Try the experience

**Start at [www.relo.cat](https://www.relo.cat).** The homepage, browser savings demo and Town Explorer open in Catalan. Choose **English** in the navigation to switch languages. The main conversational experience uses ChatGPT with the ReloCat MCP connection enabled. You can ask to start a homebuying interview, compare towns or open the Town Explorer map.

There are several views of the project:

| View | What it is for |
| --- | --- |
| Public website | Project introduction and agent connection guide. |
| ChatGPT widgets | Interactive interview cards, town maps and comparisons returned during a conversation. |
| Local journey board | A developer/demo view with fictional households and simulated financial activity. |

The public deployment and local development branches can contain different features. The [React workspace in PR #18](https://github.com/itsmanelvelasco/aihousebuyingcompanion/pull/18) adds profile/input management, bank controls and reviewed interviews to both a local web view and an MCP widget; it is separate from the features currently merged into `main`.

## What is real, and what is simulated?

This is a working hackathon prototype. Its municipality pilot includes **18 town profiles, 238 education centres, 86 rail trips and six policy records**, drawn from dated datasets. Coverage is limited: one profile is the Lleida transport destination, and detailed relocation opportunity research currently covers three towns.

The **500 household profiles and demo bank movements are fictional**. They let the team test different needs and financial barriers without using anyone's real bank account. Town Explorer compares local resale prices or rents, active housing measures in the pilot catalogue and schools in the official directory. Five pilot towns also have dated Idealista listing cards for sale. Check current prices and availability on Idealista. The listing cards, direct portal links and Google search links work without a Treg key. **Find indexed examples** can surface more links when the optional search provider is available.

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

The connected local demo combines the web board and MCP tools on port **8787**. The profile/bank API on **3001** stores runtime edits and produces financial summaries. The optional habits service runs separately on **3002**; the standalone interviewer defaults to **3000**. Feature branches may extend this startup arrangement.

Bank movements are stored separately from profile balance snapshots. A simulated worker can add movements while the service runs; clients poll for changes. It does not independently wake ChatGPT or send messages.

## Run the local demo

For developers and teammates, install **Node.js 24 or newer** and run these commands from the repository root:

```sh
npm ci
npm run setup:app
npm run dev:stack
```

Then open:

| Address | Purpose |
| --- | --- |
| `http://127.0.0.1:8787/preview` | Connected journey board. |
| `http://127.0.0.1:8787/connect` | Homepage and agent setup guide. |
| `http://127.0.0.1:8787/test` | Local tool-testing page. |
| `http://127.0.0.1:8787/mcp` | MCP endpoint for a client, rather than a normal webpage. |

The launcher starts the profile API and board, shares a server-side token between them, and enables the synthetic feed for `user-001`. Stop both services with **Ctrl+C**. This demo does not need an OpenAI API key. Optional live voice and AI features require additional setup and may consume API credits.

To run only the municipality MCP service, use `npm run start:mcp` instead. Both commands default to port 8787, so run one at a time. Agents running on another computer need a reachable HTTPS endpoint; your localhost address only points to your own machine.

For the separate interviewer, see [voice and guided interview setup](apps/interviewer/README.md). For the React workspace, follow [PR #18](https://github.com/itsmanelvelasco/aihousebuyingcompanion/pull/18) and its branch instructions.

## Find your way around the repository

| Folder | What you will find |
| --- | --- |
| [`demo-plugin/`](demo-plugin/) | Connected journey board and combined MCP demo server. |
| [`apps/mcp-server/`](apps/mcp-server/README.md) | Municipality tools, Town Explorer and agent connection pages. |
| [`apps/interviewer/`](apps/interviewer/README.md) | Voice/guided interview and savings scenario tools. |
| [`apps/profile-api/`](apps/profile-api/README.md) | Profile storage, shared inputs, bank movements and financial analysis. |
| [`apps/habits-agent/`](apps/habits-agent/README.md) | Optional habit suggestions, goals and check-ins. |
| [`packages/`](packages/) | Shared validation contracts, matching logic and policy calculations. |
| [`data/`](data/) | Dated municipality/policy snapshots and fictional user fixtures. |
| [`docs/`](docs/README.md) | Area guides, integration notes and team setup. |

Committed demo fixtures stay separate from ignored runtime records. Never commit real financial records, API keys or access tokens. The shared-token demo is not production per-user access control.

## Contributing and verification

Start with the [development map](docs/README.md) and the relevant area guide. The [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) holds product decisions; [PLAN.md](PLAN.md) tracks implementation work. Code and checks establish what is delivered.

For code changes, the repository checks are:

```sh
npm run typecheck
npm test
npm run data:validate
npm run check:app
npm run test:app
```

Keep calculations explicit, preserve source links and dates, and show uncertainty where the evidence does not support a conclusion.
