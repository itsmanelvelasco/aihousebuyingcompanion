# Interviewer area

**Owner:** interviewer team. **Purpose:** capture confirmed household requirements without repeating answered questions or inventing missing facts.

## Entry points

- `apps/interviewer/server.ts`, `app.mjs`, `index.html`: standalone voice/guided interview on port 3000 (`npm run start:interviewer`). Live voice/API categorization require explicitly configured OpenAI access; guided mode works without paid calls.
- `apps/mcp-server/interview-tools.ts`: interview/cash-flow tools registered by the shared MCP factory. The browser interview retains its own local state; it is not automatically the persisted profile API.
- `apps/board/intake.ts`: expanded demo intake definitions and validation.

- `apps/board/demo.ts`: question groups, validation, `openDemo` and `updateDemo`.
- `apps/board/server.ts`: ChatGPT-facing `open_demo` and `update_demo` wrappers.
- `apps/board/profiles.ts`: connected-answer validation, partial-input persistence and context-to-board adapter.
- `packages/contracts/inputs.ts`: canonical partial facts and confirmation/provenance semantics.
- [Shared input API](../../apps/profile-api/INPUTS.md): submit/read/correct persisted answers.

## Inputs and outputs

Accept grouped answers, including household size, work, income/spending/savings and housing requirements. Persist canonical partial input records rather than replacing whole profile files. Budget/floor area, official commute destination, required school stages and transport mode are needed before a fully constrained town search. `null` is explicitly unknown; omission means no update.

Use integer EUR cents at the API boundary. The UI's debt-inclusive spending must not be added to debt payments a second time: the connected adapter stores that entered total as expenses and zero separate debt for that input. This is a total-spending representation, not proof the household has no debt. A bank summary is evidence to review, not automatic confirmation of every financial fact. Never infer tax eligibility from household demographics.

## Run and verify

From the root, run `npm run typecheck` and `node --test tests/board.test.ts tests/board-connected.test.ts`. Use the [integration guide](integration-deployment.md) to run the connected API and board.

## Handoff

Give the frontend team the current user ID, saved input IDs, unresolved fields and normalized context. Property bedroom requirements must remain visible as a property-level check even when town-level screening proceeds. Test grouped-answer atomicity, corrections, conflicting sources and a partial interview before declaring the connection complete.
