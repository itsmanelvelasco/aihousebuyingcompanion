# Arrela implementation plan

This is the proposed hackathon roadmap, based on the project brief dated 21 November 2026. The repository is currently documentation-only; unchecked items are planned work, not completed features.

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

One ChatGPT conversation takes a fictional bank snapshot, explains a useful savings insight, recommends three evidence-backed Catalan towns, and updates the estimated purchase cash target and timeline after the user selects a town.

## Phase 1 — Agree contracts and scaffold (0–20 minutes)

- [ ] Choose one fictional household and a repeatable demo prompt.
- [ ] Create the TypeScript workspace and document the package manager and actual build, type-check and test commands once configured.
- [ ] Define shared Zod contracts for household preferences, bank summaries, ownership plans, town profiles, recommendations and incentive results.
- [ ] Include source URL, observation date/year, geographic scope and unknown-data status in evidence contracts.
- [ ] Define incentive application status separately from household eligibility.
- [ ] Provide mock tool responses immediately so UI and backend work can proceed independently.

Proposed layout:

```text
apps/mcp-server/       # MCP tools, adapters and HTTPS endpoint
apps/widget/           # React/Vite progress, map and comparisons
packages/contracts/    # Shared schemas and types
packages/finance/      # Deterministic savings and purchase calculations
packages/places/       # Town matching and incentive rules
data/demo-bank.json    # Clearly fictional balances and transactions
data/towns.json        # Sourced Catalan municipality profiles
```

## Phase 2 — Build independent workstreams (20–100 minutes)

Agree shared contracts first, then assign separate file ownership. Finance and municipality data are the core inputs; real bank connectivity must not block either track.

| Workstream | Scope | Handoff |
| --- | --- | --- |
| Interviewer team | Collect and confirm the fictional household's requirements in conversation. | Validated profile with hard constraints, preferences and unknowns. |
| Fake user — project lead | Supply the shared persona, sample answers and synthetic financial snapshot. | Consistent demo inputs across all workstreams. |
| Catalunya relocation team | Assemble 10–15 sourced profiles, demographic indicators and verified housing policies; define matching inputs and rule requirements. | Municipality evidence and versioned incentive rules; confirm ownership of executable matching/eligibility functions. |
| Frontend/setup team | Build the initial plugin views and document setup; expand into progress, map and comparisons using agreed responses. | Interactive views and repeatable plugin connection/run instructions. |
| Finance — owner to assign | Normalize the synthetic feed, exclude internal transfers and calculate savings capacity and purchase cash needs. | Deterministic ownership plan and simulator with explicit assumptions. |
| Integration/contracts — owner to assign | Agree shared schemas and connect the MCP server, domain functions and widgets. | Working end-to-end conversation and browser-preview fallback. |

- [ ] Make financial calculations pure and deterministic; handle a reached target and zero or negative savings explicitly.
- [ ] Mark housing prices as municipal indicators or estimates, distinct from live listings.
- [ ] Preserve unknown requirements as unresolved rather than silently passing them.
- [ ] Return incentive outcomes as eligible, ineligible or needs verification, with rule version and official evidence.
- [ ] Keep closed or unknown calls distinct from open applications.

## Phase 3 — Integrate the conversation (100–145 minutes)

- [ ] Connect `get_ownership_plan` and `simulate_ownership` to the finance functions.
- [ ] Connect `recommend_towns` and `check_housing_incentives` to the places functions.
- [ ] Connect `render_home_plan` and `render_town_comparison` to prepared results; keep calculation and rendering tools separate.
- [ ] Update the target and timeline when the user selects a town.
- [ ] Show synthetic-data labels, assumptions, evidence links, data freshness and missing-data messages in the UI.
- [ ] Run the MCP endpoint and widget together; document the actual run instructions.
- [ ] Verify a browser-based demo fallback if ChatGPT integration is unavailable.

## Phase 4 — Verify and rehearse (145–180 minutes)

- [ ] Test finance boundaries: internal transfers, zero savings, target already reached and changed purchase assumptions.
- [ ] Test matching against hard constraints, absent evidence and deterministic ranking ties.
- [ ] Test incentive thresholds, missing household inputs, geographic exceptions and closed deadlines against verified rules.
- [ ] Validate all demo fixtures against the shared schemas and inspect their source metadata.
- [ ] Run the configured type checks, focused tests and production build; record results and any remaining limitations.
- [ ] Rehearse the full conversation and town-selection update with the fictional household.
- [ ] Check map/card usability, keyboard access and loading, empty and error states.
- [ ] Capture a fallback recording and freeze the demo scope.

## Acceptance criteria

- [ ] The demo returns three relevant town recommendations with understandable trade-offs and source links.
- [ ] A selected town changes the estimated cash target and projected savings timeline consistently.
- [ ] Figures include visible assumptions, source dates and synthetic-data labels where applicable.
- [ ] No output claims mortgage approval, guaranteed grant funding, school vacancies or confirmed journeys without evidence.
- [ ] No real bank credentials, secrets or personal financial records are committed or exposed through tool responses.
- [ ] The README describes what actually runs and how to run it, while clearly identifying remaining proposals.

## Deferred scope

Production bank OAuth, durable financial storage, nationwide coverage, live property listings, comprehensive business-register enrichment, government submissions and proactive outreach are future work. A housing-office enquiry draft is a stretch feature and must remain a user-reviewed draft.
