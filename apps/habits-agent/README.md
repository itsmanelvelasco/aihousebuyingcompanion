# Habits agent

An independent synthetic-data service for optional money habits, explicit goals and check-ins. It uses aggregate spending categories, not transaction descriptions, bank identifiers or personal demographics. Rules work without OpenAI or paid calls. Suggestions never create goals, cancel commitments, move money or assess credit automatically.

## Entry point and local setup

Requires Node.js 24+. From the repository root in PowerShell:

```powershell
npm ci
$env:HABITS_API_TOKEN = [guid]::NewGuid().ToString('N')
npm run start:habits
```

The server listens on `127.0.0.1:3002`. Every endpoint requires `Authorization: Bearer <HABITS_API_TOKEN>`. `HABITS_PORT` changes the port. `PROFILE_DATA_DIR` defaults to committed synthetic profiles in `data/users`; point it at `data/runtime-users` to share the profile API's current user directory. Profiles are read only. Habit state belongs in the separately ignored `HABITS_DATA_DIR` (`data/runtime-habits` by default).

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/limits` | Model configuration and token/call caps; no keys returned. |
| GET | `/users/:id/habits` | Goals and check-ins. |
| POST | `/users/:id/habits/suggestions` | `{source:"rules"\|"openai", summary:{...}}`; rules is the default. |
| POST | `/users/:id/habits` | Adopt a user-reviewed goal. |
| PUT | `/users/:id/habits/:goalId` | Replace a goal, including setting `active:false`. |
| POST | `/users/:id/habits/:goalId/checkins` | Record an explicit check-in; identical ID/data retries are idempotent. |

Goals use `{id,title,action,category,targetDaysPerWeek,plannedMonthlySavingCents:null,active:true}`. Categories follow the bank API's expense categories. Planned savings are optional user-supplied assumptions, never generated savings guarantees. Check-ins use `{id,date:"2026-11-21",completed:true,note?:"..."}`. Notes remain local and are never included in AI prompts. A check-in ID reused with different content returns 409. To avoid overstating daily progress, consumers should count distinct completed dates rather than rows. There are at most 20 goals and 1000 check-ins per user.

## Aggregate input

```json
{
  "source": "rules",
  "summary": {
    "synthetic": true,
    "currency": "EUR",
    "from": "2026-08-01",
    "to": "2026-10-31",
    "monthCount": 3,
    "dataStatus": "observed",
    "incomeCents": 600000,
    "expenseCents": 580000,
    "spendingByCategory": {"subscriptions": 9000, "food": 90000},
    "recurringCategoryCounts": {"subscriptions": 2}
  }
}
```

Use integer EUR cents for totals over the specified period. Send only the allowlisted fields from the bank summary, converting recurring candidates into category counts and removing descriptions/account IDs. The service does not independently attest that the aggregate history is complete. `partial`/`unknown` data yields a review habit without assuming spending reductions. No identities or protected attributes are used to assign habits.

## Optional Sol suggestions and cost controls

The official [model catalog](https://developers.openai.com/api/docs/models/gpt-6.2-sol) lists **`gpt-6.2-sol`**, supporting the Responses API and structured outputs. It is the configured default; `OPENAI_HABITS_MODEL` can explicitly override it. Setup follows the [API quickstart](https://developers.openai.com/api/docs/quickstart) and [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create). Live account access was not exercised while building this branch.

Set `OPENAI_API_KEY` only in the server environment, then submit `source:"openai"` for an explicitly requested AI suggestion. See [placeholder configuration](.env.example). The service never reads the key from a request or returns it. It sends an allowlisted aggregate capped at 6000 characters, requests `store:false`, low reasoning effort and strict JSON output, and validates returned suggestions locally.

Default caps: 1024 output tokens per request (including reasoning) and 20 attempted API calls per UTC day across the service. Token cap is configurable from 128 to 2048; daily cap from 1 to 100. Attempt reservations are durable across restarts; failed requests consume an attempt. There are no automatic retries, timers or background paid calls. A 15-second timeout bounds waiting. Returned token usage is reported when available.

These limits **do not enforce a $100 dollar budget** or know the account credit balance. Use OpenAI project usage/budget controls as well. Pricing and actual token consumption depend on the selected model. No paid requests were made in tests; the API path was tested with a mock. OpenAI failures are explicit and do not silently switch providers/models. The user can separately request rules mode.

## Storage and integration boundaries

State is stored atomically in `data/runtime-habits/users/:id.json`; the global attempt counter is separate. Writes are serialized within one process. Run one habits process per data directory. This is a shared-token local demo; production per-user authorization, audited history, provider consent and multi-process database transactions are not implemented. The service does not initiate check-in reminders or send messages.

The profile/bank service remains the authoritative writer of bank data. A frontend or server adapter can read bank aggregates, request habit suggestions and allow the person to adopt a goal. This branch deliberately avoids changing the other teams' MCP/widget code. No MCP registration or frontend wiring is claimed here.

Run `npm run typecheck` and `npm test`. Focused tests: `node --test tests/habits.test.ts`.
