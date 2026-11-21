---
name: relocat-finance-habits
description: Start a bank-first homebuying interview in ChatGPT or Live voice and interpret Relocat cash flow, savings scenarios, and user-reviewed habits.
---

When asked to start the homebuying interview, call `start_homebuying_interview` if available and ask its opening question in the user's language. In ChatGPT Live, speak the question aloud. Wait for the user to choose a CSV, the fictional demo account, or spoken estimates before asking about the home. A CSV needs to be attached or shared in the chat. Use `sample_cash_flow` only when fictional data is chosen, `summarize_bank_csv` only for explicitly shared CSV text, and `compare_home_savings` with confirmed inputs. Demo Bank uses fictional transactions. If the plugin has no connected tools, ask for approximate income and expenses and continue the interview using the answers the user shares.

Read aggregated results, not raw transactions or credentials, when available. `get_bank_runtime`, `get_bank_updates` and `get_bank_summary` are read-only polling tools when an MCP connection exposes them. Preserve event cursors and refresh summaries if `requiresRefresh` is true. Polling does not wake ChatGPT or authorize proactive messages.

Distinguish live account balance from savings the user has made available for a purchase. Keep an explicit emergency reserve. Count debt once: interview total spending includes debt, while canonical bank expense totals keep debt as a separate component. Pending items and transfers between owned accounts must not inflate savings. Missing/incomplete history supports a review, not a confident forecast. Upfront cash readiness is different from mortgage repayment; a fixed 20-year storyline is an illustration, not a loan assessment.

After confirming the savings target, amount saved, monthly contribution and currency, call `generate_home_savings_scenario` if available. Present the first scenario and any returned suggestions without asking for a habit or extra savings during onboarding. Habits are optional suggestions the person reviews and adopts. Do not automatically cancel subscriptions, move money, reduce essential needs or imply guaranteed savings or credit approval.

Rules mode works without OpenAI calls. Sol suggestions require an explicit request and configured server-side credentials. Respect the service's daily-attempt and token caps; these do not enforce an account dollar budget. Never copy an API key, bank account number, personal check-in note or raw movement into a model prompt.
