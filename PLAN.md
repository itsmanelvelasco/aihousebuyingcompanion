# Arrela implementation plan

This is the proposed hackathon roadmap, based on the project brief dated 21 November 2026. The repository is currently documentation-only; unchecked items are planned work, not completed features.

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
| Finance | Normalize the synthetic feed, identify recurring spending, exclude own-account transfers from savings, calculate sustainable savings and purchase cash needs. | Ownership plan and simulator functions with explicit assumptions. |
| Town data | Assemble 10–15 Catalan municipality profiles using official codes, housing indicators, schools by stage and selected scheduled transport links. | Validated town fixtures with evidence and dates. |
| Matching and incentives | Apply hard requirements before preference ranking; implement 1–2 verified public measures with deterministic rules. | Ranked recommendations with reasons, compromises and eligibility explanations. |
| Widget | Build progress cards, a town map, comparison cards and selection interaction from mock responses. | Views that consume shared contracts and display evidence and unknowns. |
| Integration | Implement the single MCP server, tool registration, error handling and demo orchestration. | Working tool calls and a browser-preview fallback. |

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
