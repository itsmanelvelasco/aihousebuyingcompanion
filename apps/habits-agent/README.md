# Habits agent

Optional money habits, explicit goals and check-ins, for the fictional demo users and for people who belong to an account. It is a request handler (`createHabitsHandler` in `server.ts`) that the one ReloCat server mounts under `/api`, next to the profile and bank routes; it is not a process of its own. It uses aggregate spending categories, not transaction descriptions, bank identifiers or personal demographics. Rules work without OpenAI or paid calls. Suggestions never create goals, cancel commitments, move money or assess credit automatically.

## Entry point and local setup

Requires Node.js 24+. From the repository root in PowerShell:

```powershell
npm ci
$env:PROFILE_API_TOKEN = [guid]::NewGuid().ToString('N')
npm start
```

The routes below are served at `http://127.0.0.1:8787/api` (`PORT` changes the port). Every endpoint requires `Authorization: Bearer <PROFILE_API_TOKEN>`, the same token as the rest of `/api`; when the variable is unset the server invents a token for that run, so set it when something outside the server must call these routes. Users are the ones in the runtime database (seeded from `data/users/`); an unknown user is a 404. Profiles are read only here.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/limits` | Model configuration and token/call caps; no keys returned. |
| GET | `/users/:id/habits` | Goals and check-ins. |
| POST | `/users/:id/habits/suggestions` | `{source:"rules"\|"openai", summary:{...}}`; rules is the default. |
| POST | `/users/:id/habits` | Adopt a user-reviewed goal. |
| PUT | `/users/:id/habits/:goalId` | Replace a goal, including setting `active:false`. |
| POST | `/users/:id/habits/:goalId/checkins` | Record an explicit check-in; identical ID/data retries are idempotent. |

Goals use `{id,title,action,category,targetDaysPerWeek,plannedMonthlySavingCents:null,active:true,startedOn:null}`. Categories follow the bank API's expense categories.

`startedOn` (`YYYY-MM-DD` or `null`) is the day the habit started. The planner needs it: when a person's monthly spending was observed in bank movements, a habit that was already running is inside that figure, so it is added on top only when it started after the observed period, and a habit without a start day is shown but not counted. The store keeps the day so that this works without the client doing anything:

- a goal created active starts on the day it is created, unless the request states a day;
- a goal switched back on (`active:false` to `active:true`) starts on that day, unless the request states a day other than the stored one;
- any other replacement keeps the stored day when the request does not state one, so a client that does not know the field never erases it;
- a goal created with `active:false` has no day until it is switched on, and a day more than one day in the future is refused (400).

Goals stored before the field existed have `startedOn: null`: neither their start nor their creation time was recorded, so the day is unknown rather than guessed. Stating the real day with a `PUT` makes such a habit count. Planned savings are optional user-supplied assumptions, never generated savings guarantees. Check-ins use `{id,date:"2026-11-21",completed:true,note?:"..."}`. Notes remain local and are never included in AI prompts. A check-in ID reused with different content returns 409. To avoid overstating daily progress, consumers should count distinct completed dates rather than rows. There are at most 20 goals and 1000 check-ins per user.

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

`synthetic` is a required boolean taken from the bank summary: `true` only when every movement behind the totals is fabricated, `false` when real bank data is included. Suggestions are returned with the same flag. The state returned by `GET /users/:id/habits` carries `synthetic: true` for a demo persona and `false` for a person who belongs to an account.

Use integer EUR cents for totals over the specified period. Send only the allowlisted fields from the bank summary, converting recurring candidates into category counts and removing descriptions/account IDs. The service does not independently attest that the aggregate history is complete. `partial`/`unknown` data yields a review habit without assuming spending reductions. No identities or protected attributes are used to assign habits.

## Optional Sol suggestions and cost controls

The official [model catalog](https://developers.openai.com/api/docs/models/gpt-6.2-sol) lists **`gpt-6.2-sol`**, supporting the Responses API and structured outputs. It is the configured default; `OPENAI_HABITS_MODEL` can explicitly override it. Setup follows the [API quickstart](https://developers.openai.com/api/docs/quickstart) and [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create). Live account access was not exercised while building this branch.

Set `OPENAI_API_KEY` only in the server environment, then submit `source:"openai"` for an explicitly requested AI suggestion. See [placeholder configuration](../../.env.example). The service never reads the key from a request or returns it. It sends an allowlisted aggregate capped at 6000 characters, requests `store:false`, low reasoning effort and strict JSON output, and validates returned suggestions locally.

Default caps: 1024 output tokens per request (including reasoning) and 20 attempted API calls per UTC day across the service. Token cap is configurable from 128 to 2048; daily cap from 1 to 100. Attempt reservations are durable across restarts; failed requests consume an attempt. There are no automatic retries, timers or background paid calls. A 15-second timeout bounds waiting. Returned token usage is reported when available.

These limits **do not enforce a $100 dollar budget** or know the account credit balance. Use OpenAI project usage/budget controls as well. Pricing and actual token consumption depend on the selected model. No paid requests were made in tests; the API path was tested with a mock. OpenAI failures are explicit and do not silently switch providers/models. The user can separately request rules mode.

## Storage and integration boundaries

Goals and check-ins are rows of the runtime SQLite database (`DATABASE_FILE`, default `data/relocat.db`): tables `habit_goals` and `habit_checkins`, written through `packages/db/habits.ts`, each change in one transaction. The daily counter of paid calls is a row of `ai_usage`, so it survives a restart. `HABITS_DATA_DIR` (`data/runtime-habits`) is only a legacy import source: JSON files an earlier version wrote there are imported once into an empty database and left untouched; a file that was skipped can be imported after repair with `npm run db:import-legacy` (see the profile API README). A write that finds the database busy is answered with 503 and `Retry-After`. This is a shared-token local demo; production per-user authorization, audited history and provider consent are not implemented. The service does not initiate check-in reminders or send messages.

The profile/bank service remains the authoritative writer of bank data. A frontend or server adapter can read bank aggregates, request habit suggestions and allow the person to adopt a goal. No MCP registration or frontend wiring is claimed here.

Run `npm run typecheck` and `npm test`. Focused tests: `node --test tests/habits.test.ts`.
