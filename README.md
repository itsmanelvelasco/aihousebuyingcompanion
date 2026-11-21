# relo.cat — AI House Buying Companion

*Find where you belong. We'll help you get there.*

relo.cat is a hackathon project for a ChatGPT-native homeownership and relocation companion. It combines everyday financial coaching with evidence-backed recommendations for Catalan municipalities, helping people understand where buying a suitable home could become achievable and how to get there.

## Project status

The four-persona relo.cat prototype lives in [`demo-plugin/`](demo-plugin/) on the `hackathon/arrela-demo-plugin` branch. The product and architecture below describe the broader roadmap from the [DevDays 2026 — AI Housing Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003).

## Try the ChatGPT demo

Follow the [demo setup guide](demo-plugin/README.md) to check out the branch, start the server, and install relo.cat in your own ChatGPT account. If a teammate already has a server running, ask for its HTTPS MCP URL and go straight to [Connect to ChatGPT](demo-plugin/README.md#connect-to-chatgpt).

## The problem

Buying a home requires more than finding a property. People need to understand their savings capacity, purchase costs, commute, schools, local services and potential public incentives. These facts are fragmented across sources, making it difficult to compare realistic options, especially when considering a move from a city to a smaller town.

## Product direction

### Daily homeownership coach

- Use a clearly labelled simulated bank feed for the hackathon to understand balances, recurring expenses and sustainable monthly savings.
- Estimate the cash needed for a purchase, including the deposit, taxes and fees, with visible assumptions.
- Show savings progress and an estimated time to reach the purchase cash target in an interactive card.
- Let users explore changes such as saving more each month or choosing a different town.
- In a future production version, connect accounts through a consent-based, read-only open-banking provider and store financial records in an authenticated backend.

### Place and housing intelligence

- Focus on Catalan municipalities, with sourced profiles covering housing indicators, schools, transport, amenities and local economic signals.
- Filter hard requirements such as budget, school stage, transport needs and maximum travel time before ranking towns by personal preferences.
- Explain recommendations through evidence, trade-offs, missing information and observation dates.
- Check housing incentives using versioned, deterministic rules and official sources.
- Connect a selected town to the savings plan to update the estimated purchase cash target and timeline.

The municipality intelligence backend is the immediate data priority. Production bank connectivity should not block it.

## Demo journey

1. Confirm a fictional household's finances, location preferences and practical constraints in ChatGPT.
2. Load a simulated bank snapshot, identify one useful savings insight and show the initial ownership timeline.
3. Recommend three Catalan towns with a map, comparison cards and evidence for the relevant trade-offs.
4. Select a town and recalculate the savings target and estimated timing.
5. Suggest a concrete next step, such as a local visit, a sustainable savings habit or a draft enquiry to a verified housing office.

Example prompt: “Where could I buy sooner without giving up schools and Barcelona access?”

## Hackathon MVP

- One end-to-end ChatGPT conversation using fictional financial data.
- Approximately 10–15 sourced municipality profiles with stable official municipality codes.
- Housing indicators, nearby schools by stage and a small set of scheduled transport connections.
- A small, verified incentive catalogue, with 1–2 real measures integrated into the end-to-end demo.
- Savings calculations, town matching and interactive progress/comparison views.
- A browser-based preview as a fallback for the demo.

Full bank OAuth, coverage of every municipality, live property listings and government submissions are outside the MVP. Business-register enrichment is a later extension.

## Proposed architecture

Use one TypeScript codebase and one MCP server. Node.js and the official MCP TypeScript SDK expose tools through an HTTPS `/mcp` endpoint. Shared Zod schemas define the contracts. React/Vite widgets provide progress cards, maps and comparisons through the MCP Apps UI bridge. Data tools return structured results separately from UI-rendering tools.

Suggested layout (not yet created):

```text
apps/mcp-server/          # MCP endpoint, tools and API adapters
apps/widget/             # React/Vite progress, map and comparison views
packages/contracts/      # Shared Zod schemas
packages/finance/        # Transaction normalization and savings calculations
packages/places/         # Municipality data, ranking and incentive rules
data/demo-bank.json      # Fictional transactions and balances
data/towns.json          # Sourced municipality profiles
```

Planned tool interfaces:

| Tool | Purpose |
| --- | --- |
| `get_ownership_plan` | Return savings progress, monthly capacity and data freshness. |
| `simulate_ownership` | Recalculate the cash target and timing for a savings change or selected town. |
| `recommend_towns` | Return ranked towns, evidence, trade-offs and source metadata. |
| `check_housing_incentives` | Return rule-backed eligibility or a need for verification, with official links. |
| `render_home_plan` / `render_town_comparison` | Display interactive views of prepared results. |
| `prepare_housing_enquiry` (stretch) | Draft an enquiry to a verified contact for the user to review. |

## Data and evidence

Planned sources include [Idescat municipal statistics](https://www.idescat.cat/dev/api/emex/), [Generalitat open data](https://analisi.transparenciacatalunya.cat/), [official rural municipality classifications](https://analisi.transparenciacatalunya.cat/Sector-P-blic/Municipis-rurals/7gqm-722r), [Catalan tax guidance](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [INCASÒL](https://incasol.gencat.cat/), official education and transport datasets, and OpenStreetMap. These are planned integrations; listing a source here does not imply that its data has been ingested or verified by this repository.

Join records using official municipality codes. Keep the source URL, observation year or date, geographic scope and missing-data status alongside every indicator. Incentive records also need their issuing authority, beneficiary type, applicable locations, rules, effective dates and application deadlines.

## Trust and privacy requirements

- Label synthetic data and confirm current user finances and preferences.
- Treat missing data as unknown, never as zero.
- Separate a programme's application status from a household's eligibility; do not present closed calls as open or municipal infrastructure funding as household aid.
- Do not infer school vacancies from a school's existence, actual transport availability from a nearby stop, or business health from commercial density.
- Distinguish municipal housing averages from actual listings and estimated timelines from mortgage approval.
- Never fabricate grants, eligibility, contacts or bank offers.
- Keep real credentials and raw financial records out of tool responses; prefer aggregated insights for the model.
- Require separate consent for future bank connections and explicit opt-in for scheduled outreach. Enquiries are drafted for review, not sent automatically.

## Demo definition of done

A fictional bank snapshot produces a useful savings insight, three evidence-backed Catalan town recommendations and an updated estimated time to ownership after the user selects a town, with clear assumptions, sources and data freshness throughout.
