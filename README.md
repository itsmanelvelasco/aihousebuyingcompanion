# Relocat — AI House Buying Companion

*Find where you belong. We'll help you get there.*

Relocat is a ChatGPT-native housing and homeownership companion focused on Catalonia. The immediate demo helps people compare suitable municipalities, school and transport access, and verified housing incentives. Financial coaching and property listings are complementary capabilities.

## Source of truth

The [DevDays 2026 — AI Housing Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) is authoritative for product decisions. This repository records implementation and mirrors the Space; when product descriptions disagree, follow the latest explicit Space decision. Check actual code and tests for implementation status rather than treating a planned feature as delivered.

Key references: [MCP architecture and contracts](https://chatgpt.com/space/page_692ac01a0a3c81918ab65c4a0052783f), [product scope](https://chatgpt.com/space/page_047fba29065c819193b15243a7e3ccd8) and [listings integration](https://chatgpt.com/space/page_5cb6c5414e088191827364cd0e43b847). The overview calls the product **Relocat**; older pages, code and the plugin prototype still use **Arrela**. These refer to the same project; existing identifiers are retained until coordinated with their owners.

## Project status

Implemented so far: a local TypeScript user-profile API and 500 synthetic household profiles in per-user JSON, combined JSON and CSV formats. The coaching, matching, MCP integration and widgets below remain proposed. This description follows the implementation plan dated 21 November 2026 in the [DevDays 2026 — AI Housing Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003).

The separate `hackathon/arrela-demo-plugin` branch contains a scripted four-persona MCP/widget prototype. It is not merged into `main` and does not yet consume the profile API. Its fictional incentives and listings do not satisfy the sourced municipality demo requirement.

## User profiles and API

- [500 fictional profiles](data/users/README.md): each user has `details.json`, `preferences.json` and `bank-account.json`, with varied needs and financial barriers. Demographic categories are informed by official Idescat sources; the dataset is not statistically representative.
- [Combined JSON](data/synthetic-users.json) preserves complete profiles; [CSV](data/synthetic-users.csv) provides a flattened summary.
- [API setup and routes](apps/profile-api/README.md): token-protected local reads, user creation and section replacement. Runtime changes are stored separately from fixture exports.

Requires Node.js 24+. From the repository root in PowerShell:

```powershell
npm install
$env:PROFILE_API_TOKEN = [guid]::NewGuid().ToString('N')
npm start
```

Run `npm run typecheck` and `npm test` for validation. The server listens on `http://127.0.0.1:3001` and requires the token on every request. All supplied financial data is fictional; this demo API does not implement production per-user authorization or real bank connectivity.

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

1. Confirm a household's budget, school stages, transport needs and relocation preferences in ChatGPT; use a fictional profile for the demo.
2. Call `recommend_towns` and show three Catalan municipalities with evidence, trade-offs and missing information.
3. Call `get_town_profile` for a selected municipality and compare school and scheduled transport access.
4. Call `get_applicable_incentives`, distinguish call status from household eligibility, and explain one actual measure with an official source.
5. Offer a verified next step. Optionally connect a simulated savings plan or authorized property links after the core journey works.

Example prompt: “Where could I buy sooner without giving up schools and Barcelona access?”

## Hackathon MVP

- One end-to-end ChatGPT conversation calling the municipality MCP backend; bank access is not required.
- Approximately 10–15 sourced municipality profiles with stable official municipality codes.
- Housing indicators, nearby schools by stage and a small set of scheduled transport connections.
- A small, verified incentive catalogue, with 1–2 real measures integrated into the end-to-end demo.
- Deterministic town matching and incentive checks; optional interactive maps/comparison cards.
- A browser-based preview as a fallback for the demo.

Full bank OAuth, coverage of every municipality and government submissions are outside the MVP. Live property opportunities are an approved complementary stream: use an authorized provider if access exists, otherwise clearly dated verified links or permitted search links. Listings and savings features must not block the town/incentive demo. Business-register enrichment is a later extension.

## Proposed architecture

Use one TypeScript codebase and one MCP server. Node.js and the official MCP TypeScript SDK expose tools through an HTTPS `/mcp` endpoint. Shared Zod schemas define the contracts. React/Vite widgets provide progress cards, maps and comparisons through the MCP Apps UI bridge. Data tools return structured results separately from UI-rendering tools.

The Space's latest architecture suggests the layout below; these town/MCP paths are proposed, not created. The existing `apps/profile-api/`, `data/users/` and export files remain in place. Coordinate with the plugin team before adopting paths or relocating code.

```text
src/data/                # Normalization, joins and validation
src/matching/            # Hard filters and preference ranking
src/eligibility/         # Versioned deterministic policy checks
src/tools/               # Thin domain-tool wrappers
src/mcp-server.ts        # One Streamable HTTP /mcp endpoint
widget/                 # Optional map and town cards
data/municipalities.json # Official municipality index
data/town-metrics.json   # Evidence with observation periods
data/schools.json
data/transport.json
data/incentives.json
```

Planned tool interfaces:

| Tool | Purpose |
| --- | --- |
| `recommend_towns` | Return ranked towns, evidence, trade-offs and source metadata. |
| `get_town_profile` | Return sourced housing, schools, transit, services and local indicators. |
| `get_applicable_incentives` | Return applicable measures, call status, eligibility, missing criteria and official links. |

Those three tools are the core MVP. Dedicated school/transport tools, savings simulation, UI rendering tools and housing enquiries can follow. Earlier references to `check_housing_incentives` need an agreed adapter to the current `get_applicable_incentives` contract.

Town results use official municipality codes, `matchReasons`, `tradeoffs`, `metrics` with `observedAt` and `sourceUrl`, and `dataMissing`. Incentives use separate `callStatus` and `eligibilityStatus`. Chat and widget views must consume the same prepared results. Cache versioned municipal evidence; compute household-specific matching and eligibility on request.

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

A single ChatGPT conversation calls the municipality MCP backend, shows three sourced Catalan town recommendations, compares schools and transport, and explains one actual housing incentive with its source and application status. Keep a browser or recorded fallback. Savings timelines and authorized property opportunities extend this core journey.
