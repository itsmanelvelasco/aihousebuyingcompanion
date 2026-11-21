---
name: relocat-finance-habits
description: Interpret Relocat synthetic bank summaries, savings scenarios and user-reviewed habit suggestions. Use for the Relocat finance or habits workflow, not credit decisions or real banking actions.
---

Read aggregated results, not raw transactions or credentials, when available. `get_bank_runtime`, `get_bank_updates` and `get_bank_summary` are read-only polling tools when an MCP connection exposes them. Preserve event cursors and refresh summaries if `requiresRefresh` is true. Polling does not wake ChatGPT or authorize proactive messages.

Distinguish live account balance from savings the user has made available for a purchase. Keep an explicit emergency reserve. Count debt once: interview total spending includes debt, while canonical bank expense totals keep debt as a separate component. Pending items and transfers between owned accounts must not inflate savings. Missing/incomplete history supports a review, not a confident forecast. Upfront cash readiness is different from mortgage repayment; a fixed 20-year storyline is an illustration, not a loan assessment.

Habits are optional suggestions the person reviews and adopts. Do not automatically cancel subscriptions, move money, reduce essential needs or imply guaranteed savings/credit approval. The standalone habits API is not automatically exposed as an MCP tool: use only operations that are actually available in the user's connection.

Rules mode works without OpenAI calls. Sol suggestions require an explicit request and configured server-side credentials. Respect the service's daily-attempt and token caps; these do not enforce an account dollar budget. Never copy an API key, bank account number, personal check-in note or raw movement into a model prompt.
