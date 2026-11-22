# Interviewer area

**Owner:** interviewer team. **Purpose:** capture confirmed household requirements without repeating answered questions or inventing missing facts.

## Entry points

- `apps/interviewer/server.ts`, `app.ts`, `index.html`: voice/guided interview, mounted by the one server at `http://127.0.0.1:8787/interview/` (`npm start`) and still runnable alone on port 3000 (`npm run start:interviewer`). `createInterviewerHandler` serves the page, its bundle, the demo CSV and `/scenario` (deterministic, free) to anyone. `/classify` (OpenAI Decisions) and `/voice` (OpenAI Realtime) spend `OPENAI_API_KEY` credits: by default they answer only same-origin requests made on the server's own machine, and `INTERVIEWER_PUBLIC_AI=on` opens them to the public site with a per-visitor hourly limit. Guided mode works without paid calls.
- `apps/interviewer/facts.ts`: the plan facts of the interview, with no page code in it. It asks the shared question set (`packages/model/questions.ts`) after the money questions, keeps the answers in one typed state for the guided and the voice interview, builds the parameters of the Realtime tool `save_plan_facts`, and saves the confirmed answers to the signed-in person's profile with one same-origin `save_my_inputs` call to `/mcp`.
- `apps/mcp-server/interview-tools.ts`: interview/cash-flow tools registered by the shared MCP factory. The browser interview retains its own local state; it reaches the persisted profile only when a signed-in person presses the save button on the main server.
- `apps/board/intake.ts`: expanded demo intake definitions and validation.

- `apps/board/demo.ts`: question groups, validation, `openDemo` and `updateDemo`.
- `apps/board/server.ts`: ChatGPT-facing `open_demo` and `update_demo` wrappers.
- `apps/board/profiles.ts`: connected-answer validation, partial-input persistence and context-to-board adapter.
- `packages/contracts/inputs.ts`: canonical partial facts and confirmation/provenance semantics.
- [Shared input API](../../apps/profile-api/INPUTS.md): submit/read/correct persisted answers.

## Inputs and outputs

Accept grouped answers, including household size, work, income/spending/savings and housing requirements. Persist canonical partial input records rather than replacing whole profile files. Budget/floor area, official commute destination, required school stages and transport mode are needed before a fully constrained town search. `null` is explicitly unknown; omission means no update.

The facts that decide tax measures and aids (date of birth, children and schooling, main home, family status, tax return type and tax bases) are asked from the shared question set, never from a list of the interviewer's own. “I don’t know” is stored as `null`, a skipped question stays unanswered, and a tax or family fact is never worked out from age, income or household size. Standalone or signed out, the page says the answers are only on this device.

Use integer EUR cents at the API boundary. The UI's debt-inclusive spending must not be added to debt payments a second time: the connected adapter stores that entered total as expenses and zero separate debt for that input. This is a total-spending representation, not proof the household has no debt. A bank summary is evidence to review, not automatic confirmation of every financial fact. Never infer tax eligibility from household demographics.

## Run and verify

From the root, run `npm run typecheck` and `node --test tests/board.test.ts tests/board-connected.test.ts tests/interviewer.test.ts` (the interviewer tests need `npm run build` first and never call OpenAI). Use the [integration guide](integration-deployment.md) to run the connected API and board.

## Handoff

Give the frontend team the current user ID, saved input IDs, unresolved fields and normalized context. Property bedroom requirements must remain visible as a property-level check even when town-level screening proceeds. Test grouped-answer atomicity, corrections, conflicting sources and a partial interview before declaring the connection complete.
