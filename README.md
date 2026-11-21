# Relocat — AI House Buying Companion

*Find where you belong. We'll help you get there.*

Relocat is a ChatGPT-native housing and homeownership companion focused on Catalonia. The immediate demo helps people compare suitable municipalities, school and transport access, and verified housing incentives. Financial coaching and property listings are complementary capabilities.

## Source of truth

The [DevDays 2026 — AI Housing Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) is authoritative for product decisions. This repository records implementation and mirrors the Space; when product descriptions disagree, follow the latest explicit Space decision. Check actual code and tests for implementation status rather than treating a planned feature as delivered.

Key references: [MCP architecture and contracts](https://chatgpt.com/space/page_692ac01a0a3c81918ab65c4a0052783f), [product scope](https://chatgpt.com/space/page_047fba29065c819193b15243a7e3ccd8) and [listings integration](https://chatgpt.com/space/page_5cb6c5414e088191827364cd0e43b847). The overview calls the product **Relocat**; older pages, code and the plugin prototype still use **Arrela**. These refer to the same project; existing identifiers are retained until coordinated with their owners.

## Project status

The project includes a connected ChatGPT plugin/live board, local profile/bank API, deterministic financial analysis, 500 synthetic profiles and a sourced municipality backend. Connected mode persists grouped interview answers, reads bank runtime changes and prepares provisional municipality screens. Property bedroom checks remain explicitly unverified until actual listing evidence is available.

The plugin work is integrated under `demo-plugin/`. With `PROFILE_API_URL` and `PROFILE_API_TOKEN`, one `/mcp` endpoint exposes municipality, bank-read and demo-board tools. Without configuration it runs the original scripted rehearsal. Scripted scenes remain visibly separate from sourced town/incentive results; backend errors never silently switch to scripted data.

## Connected demo and development areas

```powershell
npm ci
npm run setup:app
npm run dev:stack
```

Open `http://127.0.0.1:8787/preview`; use `http://127.0.0.1:8787/mcp` as the single local MCP endpoint. The launcher starts the profile API on port 3001, keeps its credential in process memory and enables a clearly synthetic background feed for `user-001`. `DEMO_BANK_USERS` overrides the list (empty disables all feeds). `PROFILE_API_PORT` and `APP_PORT` override ports. Ctrl+C stops the stack. Expose the app through your chosen HTTPS host/tunnel for ChatGPT; the local launcher does not deploy it.

See [the monorepo development map](docs/README.md) for each area's entry points, owners, contracts and checks. `npm run typecheck`, `npm test`, `npm run data:validate`, `npm run check:app` and `npm run test:app` verify the combined code. Runtime bank events persist in the ledger; timers run only while the profile service is running and clients poll for updates. They do not wake ChatGPT or send unsolicited messages.

The separate [habits service](apps/habits-agent/README.md) runs with `npm run start:habits` on port 3002 after setting `HABITS_API_TOKEN`. Local suggestions, goals and check-ins work without an API key. Optional `gpt-6.2-sol` suggestions use server-side `OPENAI_API_KEY`, bounded on-demand calls and no paid background loop. It is not automatically wired into the board or started by `dev:stack`.

## User profiles and API

- [500 fictional profiles](data/users/README.md): each user has `details.json`, `preferences.json` and `bank-account.json`, with varied needs and financial barriers. Demographic categories are informed by official Idescat sources; the dataset is not statistically representative.
- [Combined JSON](data/synthetic-users.json) preserves complete profiles; [CSV](data/synthetic-users.csv) provides a flattened summary.
- [API setup and routes](apps/profile-api/README.md): token-protected local reads, user creation and section replacement. Runtime changes are stored separately from fixture exports.
- [Bank ledger API](apps/profile-api/BANK_API.md): manage accounts and movements, analyse spending/recurring candidates, and compare savings scenarios. Seed three fictional months on demand for any supplied user; no real bank connection or payments.
- [Shared app inputs](apps/profile-api/INPUTS.md): accept partial facts from interview, manual, bank and listing sources; resolve them with provenance and explicit conflicts; prepare municipality-tool inputs when complete.

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

## Municipality MCP backend

Run `npm run start:mcp` from the repository root. The service exposes Streamable HTTP at `http://127.0.0.1:8787/mcp`. See the [MCP setup, demo request and data sources](apps/mcp-server/README.md).

The MCP backend lives in `apps/mcp-server/`. Its tools share Zod schemas in `packages/contracts/` and use the data loading, matching and eligibility code in `packages/places/`. The versioned fixtures in `data/towns.json` and `data/incentives.json` cover 18 municipalities, including Calaf, Juncosa, Ulldemolins and the FGC Lleida–La Pobla de Segur corridor. Tools compute household-specific recommendations and eligibility from the local snapshot.

The core demo calls `recommend_towns`, `get_town_profile`, and `get_applicable_incentives`. Additional tools cover schools, rail, business indicators, municipality lookup, and household eligibility detail. Town results include official codes, match reasons, trade-offs, evidence dates and URLs, and missing data. Incentives include separate application and eligibility statuses.

All 18 municipality profiles include [sample travel estimates](apps/mcp-server/README.md#quick-travel-comparisons) to major stations and airports, with public transport times where the sample timetable supports a journey.

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
