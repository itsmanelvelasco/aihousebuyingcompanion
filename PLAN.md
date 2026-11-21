# Relocat implementation plan

This is the hackathon roadmap, based on the project brief dated 21 November 2026. Unchecked items are planned work, not completed features.

## Authority and current priority

The [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) is authoritative. Its current overview and [MCP architecture](https://chatgpt.com/space/page_692ac01a0a3c81918ab65c4a0052783f) prioritize Catalonia-only town recommendations, school/transit access and verified incentives. This supersedes older bank-first demo sequences. The overview uses Relocat; Arrela remains a legacy code/prototype name.

The three required MCP tools are `recommend_towns`, `get_town_profile` and `get_applicable_incentives`. Bank-informed coaching and [authorized property listings](https://chatgpt.com/space/page_5cb6c5414e088191827364cd0e43b847) are complementary streams, not prerequisites for demo success.

## Integration gaps to resolve

- [ ] Coordinate with the frontend/setup team on `hackathon/arrela-demo-plugin`; its four scripted personas and in-memory state are not yet connected to the 500-user API on `main`.
- [ ] Agree a profile adapter: stable user ID; household size and school needs; bedrooms, commute and transport; purchase budget; explicit unknowns.
- [ ] Convert integer EUR cents from profile storage to the plugin's euro values at the boundary. Its total spending must include `monthlyExpensesCents + debtPaymentsCents` exactly once.
- [ ] Replace scripted policy/listing examples with sourced results before presenting them as actual opportunities; retain fictional labels for demo scenes.
- [x] Expose `get_applicable_incentives` with optional household checks, and retain `check_housing_incentives` for eligibility and exclusions.
- [ ] Keep existing profile storage paths; agree shared contracts and the town/MCP layout with team owners before moving files.

## Delivered profile foundation

- [x] Generate 500 fictional homebuyer households with varied preferences, demographics and financial/credit barriers, with documented Idescat grounding and explicit sampling limitations.
- [x] Store each profile in separate details, preferences and bank-account JSON documents; provide full JSON and flattened CSV exports.
- [x] Add a token-protected local API to list/read/create users and replace sections, using isolated runtime storage and atomic file writes.
- [x] Verify dataset/export consistency, API authorization, invalid inputs, persistence and runtime edit preservation with automated tests and TypeScript checks.
- [x] Add synthetic bank accounts and movement import/correction/deletion with idempotent IDs and serialized atomic ledger persistence.
- [x] Implement monthly cash-flow/category analysis, recurring-expense candidates and savings scenarios with explicit reserves, assumptions and unknown-data handling.
- [x] Add versioned multi-source app inputs, normalized context, explicit conflict reporting and a municipality recommendation-input adapter; frontend wiring remains to be integrated.
- [x] Build a complementary browser voice interviewer with demo bank and CSV intake, optional OpenAI Decisions classification, and a local savings plan. Shared profile API integration remains pending.
- [ ] Project lead selects or customizes a canonical demo persona from the candidate profiles and confirms it with the interviewer team.
- [ ] Teams agree stricter domain schemas; the API currently validates document provenance and IDs while allowing evolving fields.

See [profile API instructions](apps/profile-api/README.md) and [dataset assumptions](data/users/README.md). No real bank connection or production per-user authorization is implemented.

## Current team ownership

The team allocation below reflects work already underway and supersedes the earlier suggested five-person split. Work in progress does not mean that code or datasets have landed in this repository.

| Owner | Current responsibility | Integration handoff |
| --- | --- | --- |
| Interviewer team | Build the conversational interview that gathers and confirms the household's needs. | Structured household profile: budget, household composition, work/commute constraints, school stages, transport needs, preferences and unresolved questions. |
| ChatGPT plugin frontend/setup team | Build the first frontend pass and establish how to configure and run the ChatGPT plugin. | Initial interactive views, setup instructions, connection requirements and agreed tool/UI contracts. |
| Project lead (user) | Create the fake user for the shared demo. | One explicitly fictional persona, consistent financial snapshot and sample interview answers used by every team. |
| Catalunya relocation team | Analyse candidate towns/cities, demographics, government incentives and new legislation affecting relocation. | Sourced municipality profiles and policy rules with official codes, observation years, effective dates, geographic scope and verification status. |

Financial calculations, shared contracts and final end-to-end integration still need an explicitly agreed owner. Do not assume an existing team has taken those responsibilities.

### Immediate coordination checklist

- [ ] Share the fake user's profile with the interviewer and relocation teams so they use the same household.
- [ ] Agree a minimal household-profile contract between the interviewer and recommendation logic before implementing separate formats.
- [ ] Agree a town/recommendation response contract with the frontend team; provide mock responses while research continues.
- [ ] Record each team's actual files or branch before editing in its area; avoid duplicating the interviewer, frontend setup or municipality research.
- [ ] Assign owners for finance calculations, shared contracts and integration.

### Fake-user handoff

The project lead owns this fixture. Agree its final file location and schema with the teams before creating competing versions. Include a stable fictional ID, household ages/dependants, current location, employment/work location, commute frequency, transport access, required school stages, housing preferences, purchase budget, savings, income, recurring expenses and relocation priorities. Use explicit EUR units and a snapshot date; leave undecided facts unknown rather than inventing them.

Provide representative interview answers and a small, clearly synthetic bank snapshot if the savings demo needs transactions. Candidate towns and incentive eligibility must come from the relocation team's evidence and rule checks, rather than being asserted as facts in the persona.

## How to use the project documents

- [README.md](README.md) explains the product, scope and trust requirements.
- [AGENTS.md](AGENTS.md) gives coding agents repository-wide working instructions: architecture boundaries, evidence handling, implementation discipline and verification.
- This file describes the delivery sequence and acceptance criteria. Update its checkboxes as work is verified; keep all three documents consistent when scope changes.

## Target outcome

One ChatGPT conversation confirms household needs, calls the municipality MCP backend, recommends three sourced Catalan towns, compares schools and transport, and explains one real housing incentive with official evidence, call status and eligibility uncertainty. No bank connection is required.

## Phase 1 — Agree contracts and scaffold (0–20 minutes)

- [ ] Choose one fictional household and a repeatable demo prompt.
- [ ] Create the TypeScript workspace and document the package manager and actual build, type-check and test commands once configured.
- [ ] Define shared Zod contracts for household preferences, bank summaries, ownership plans, town profiles, recommendations and incentive results.
- [x] Include source URL, observation date/year, geographic scope and unknown-data status in evidence contracts.
- [x] Define incentive application status separately from household eligibility.
- [ ] Provide mock tool responses immediately so UI and backend work can proceed independently.

The municipality MCP service lives in `apps/mcp-server/`, with contracts in `packages/contracts/`, domain logic in `packages/places/`, and snapshots in `data/towns.json` and `data/incentives.json`. See the [local demo steps](apps/mcp-server/README.md).

## Phase 2 — Build independent workstreams (20–100 minutes)

Agree shared contracts first, then assign separate file ownership. Household requirements, municipality evidence and policy rules are the core inputs. Finance and listings can progress independently without blocking them.

| Workstream | Scope | Handoff |
| --- | --- | --- |
| Interviewer team | Collect and confirm the fictional household's requirements in conversation. | Validated profile with hard constraints, preferences and unknowns. |
| Fake user — project lead | Supply the shared persona, sample answers and synthetic financial snapshot. | Consistent demo inputs across all workstreams. |
| Catalunya relocation team | Assemble 10–15 sourced profiles, demographic indicators and verified housing policies; define matching inputs and rule requirements. | Municipality evidence and versioned incentive rules; confirm ownership of executable matching/eligibility functions. |
| Frontend/setup team | Build the initial plugin views and document setup; expand into progress, map and comparisons using agreed responses. | Interactive views and repeatable plugin connection/run instructions. |
| Finance — owner to assign | Normalize the synthetic feed, exclude internal transfers and calculate savings capacity and purchase cash needs. | Deterministic ownership plan and simulator with explicit assumptions. |
| Integration/contracts — owner to assign | Agree shared schemas and connect the MCP server, domain functions and widgets. | Working end-to-end conversation and browser-preview fallback. |

- [x] Make financial calculations pure and deterministic; handle a reached target and zero or negative savings explicitly.
- [ ] Keep financial calculations in the complementary track; the core town journey must also work without a bank snapshot.
- [ ] Mark housing prices as municipal indicators or estimates, distinct from live listings.
- [ ] Preserve unknown requirements as unresolved rather than silently passing them.
- [x] Return `eligibilityStatus` as `eligible`, `ineligible` or `needs_verification`, with rule version and official evidence; use separate `callStatus`.
- [x] Keep closed or unknown calls distinct from open applications.

## Phase 3 — Integrate the conversation (100–145 minutes)

- [x] Connect `recommend_towns`, `get_town_profile` and `get_applicable_incentives` to domain functions through one Streamable HTTP `/mcp` endpoint.
- [x] Return official municipality codes, `matchReasons`, `tradeoffs`, `metrics` with `observedAt` and `sourceUrl`, and `dataMissing`.
- [x] Supply incentives with separate `callStatus`, `eligibilityStatus`, missing criteria and official legal sources.
- [ ] Share prepared results between chat and optional town-comparison widgets; keep calculations separate from rendering.
- [ ] Optionally connect `get_ownership_plan`/`simulate_ownership` and update the target/timeline after selection once the core flow works.
- [ ] Show synthetic-data labels, assumptions, evidence links, data freshness and missing-data messages in the UI.
- [ ] Run the MCP endpoint and widget together; document the actual run instructions.
- [ ] Verify a browser-based demo fallback if ChatGPT integration is unavailable.

## Phase 4 — Verify and rehearse (145–180 minutes)

- [x] Test finance boundaries: internal transfers, zero savings, target already reached and changed purchase assumptions.
- [ ] Test matching against hard constraints, absent evidence and deterministic ranking ties.
- [x] Test incentive thresholds, missing household inputs, geographic exceptions and closed deadlines against verified rules.
- [ ] Validate all demo fixtures against the shared schemas and inspect their source metadata.
- [ ] Run the configured type checks, focused tests and production build; record results and any remaining limitations.
- [ ] Rehearse the full conversation and town-selection update with the fictional household.
- [ ] Check map/card usability, keyboard access and loading, empty and error states.
- [ ] Capture a fallback recording and freeze the demo scope.

## Acceptance criteria

- [ ] The demo returns three relevant town recommendations with understandable trade-offs and source links.
- [ ] Selecting a town exposes sourced school/transit details and one actual housing incentive with application status and clearly qualified eligibility.
- [ ] The core flow works without bank access or a listings provider; complementary savings estimates remain internally consistent when enabled.
- [ ] Figures include visible assumptions, source dates and synthetic-data labels where applicable.
- [ ] No output claims mortgage approval, guaranteed grant funding, school vacancies or confirmed journeys without evidence.
- [ ] No real bank credentials, secrets or personal financial records are committed or exposed through tool responses.
- [ ] The README describes what actually runs and how to run it, while clearly identifying remaining proposals.

## Deferred scope

Production bank OAuth, durable real-financial-data storage, nationwide coverage, comprehensive business-register enrichment, government submissions and proactive outreach are future work. Live property opportunities are an approved complementary stream: query authorized providers on demand for shortlisted towns if access is available; otherwise show verified timestamped links or permitted search links. Never fabricate inventory or treat provider failures as no available homes. A housing-office enquiry draft is a stretch feature and must remain a user-reviewed draft.
