# Shared app input contract

The interviewer, frontend, bank-analysis client and property-selection flow can submit partial structured facts without replacing whole profile files. The shared Zod contract lives in `packages/contracts/inputs.ts`. It uses the same authentication and local server as the [profile API](README.md), and serves both the fictional demo personas and people who belong to an account.

## Endpoints

| Method | Route | Result |
| --- | --- | --- |
| POST | `/users/:id/inputs` | Atomically import `{ "inputs": [...] }`, 1–50 records per request. A record whose ID is new is added; the same ID with the same content is an idempotent retry; the same ID with different content replaces the stored record, so a client can update its own record. Answers `{ inserted, replaced, duplicates, pruned }`. |
| GET | `/users/:id/inputs` | Read stored source records. |
| PUT | `/users/:id/inputs/:inputId` | Replace a complete source record to correct it; ID must match. |
| DELETE | `/users/:id/inputs/:inputId` | Remove a source record; older values may become visible again. |
| GET | `/users/:id/context` | Read normalized data, field provenance, conflicts, warnings, the bank snapshot balance as its own fact and a prepared municipality-tool input. No recommendation call is executed. |

Source records are rows of the `input_records` table of the runtime SQLite database (`DATABASE_FILE`), at most 500 per user. Each request is one transaction: all of its records are stored, or none. Existing body limits and shared-token demo limitations apply. Committed profile fixtures and aggregate exports are unchanged by input events. Replacements use last-write-wins.

## The `synthetic` flag

`synthetic` is a required boolean on every record: `true` for a fabricated record, `false` for something a real person stated or a real source reported. It has no default, and it is stored and returned per record.

- A fixture or demo persona and everything written for it is `true`.
- What is written by or for a person who belongs to an account is stored as `false`, whatever the client sent: clients built when the flag was the literal `true` keep working, and a real person's answers are never labelled synthetic. The one exception is `source: "bank"`, which keeps the flag it arrives with, because a real person can be connected to a fictional bank.
- Aggregates say "all synthetic" only when everything behind them is. The `synthetic` of `GET /inputs` and of `GET /context` is `true` only for a fictional person whose every contributing record is fabricated; a real person with no records yet is `false`. Each provenance entry of the context carries the flag of its own record.

## Retention: what happens at 500 records

Reaching the cap does not lock the profile. After a write that takes a user past 500 records, the server deletes **superseded** records until 500 remain, and reports how many in `pruned`:

- A record is superseded when every field it carries has a strictly newer observation (`observedAt`) from the same `source`. Such a record no longer takes part in resolution, so `/context` is the same with or without it.
- Superseded records of the sources just written go first, then those of other sources; within each group the oldest observation goes first. Records of the request itself are never pruned.
- A record that holds the newest observation of its source for even one field is never deleted, whether it is confirmed or not. The winning value of a field, confirmed or not, is therefore never dropped, and neither is a candidate of an open conflict.
- Only when 500 stored records each still decide some field is the write refused, with 409 and a message asking to delete records. That takes hundreds of records sharing one timestamp, or far more distinct fields than the contract has.

One consequence: after pruning, deleting the newest record of a field no longer brings back a value older than the ones that were pruned. Below the cap nothing is pruned and `DELETE` behaves as described above.

## Example: several inputs in one request

```json
{
  "inputs": [
    {
      "id": "interview-001",
      "source": "interview",
      "observedAt": "2026-11-21T12:00:00Z",
      "confirmed": true,
      "synthetic": true,
      "data": {
        "household": { "size": 3, "dependants": 1 },
        "housing": { "tenure": "buy", "budgetCents": 13000000, "homeSizeM2": 85 },
        "school": { "stages": ["eso"], "mode": "rail", "maxJourneyMinutes": 50 },
        "rural": { "required": true }
      }
    },
    {
      "id": "bank-review-001",
      "source": "bank",
      "observedAt": "2026-11-21T12:05:00Z",
      "confirmed": false,
      "synthetic": true,
      "data": { "finance": { "monthlyIncomeCents": 240000, "monthlyExpensesCents": 170000, "debtPaymentsCents": 10000 } }
    },
    {
      "id": "consent-001",
      "source": "manual",
      "observedAt": "2026-11-21T12:10:00Z",
      "confirmed": true,
      "synthetic": true,
      "data": { "housing": { "allowComarcaEstimate": true } }
    }
  ]
}
```

`source` is `interview`, `manual`, `bank` or `listing`. `profile` and ID `profile-snapshot` are reserved for the server's unconfirmed baseline. `confirmed` records an explicit confirmation reported by the client; it is not proof of bank verification, consent authentication or legal eligibility. Send aggregates from bank analysis, not raw movements, credentials or account identifiers. A `listing` source can supply known property facts in the same fields; this does not implement a listings-provider connector or verify availability.

## Available groups

All listed fields are optional and nullable. Each record must contain at least one leaf field; unknown keys are rejected.

| Group | Fields |
| --- | --- |
| `housing` | `tenure` (`buy`/`rent`), `budgetCents`, `homeSizeM2`, `minimumBedrooms`, `allowComarcaEstimate` |
| `household` | `size`, `dependants`, `employmentStatus` |
| `school` | `stages` (`nursery`, `infantil`, `primary`, `eso`, `batxillerat`, `fp`), `mode` (`car_free`/`rail`), `maxJourneyMinutes` |
| `transport` | `destinationCode` (six-digit official code), `maxCommuteMinutes`, `travelDate` (ISO date) |
| `finance` | `currentSavingsCents`, `monthlyIncomeCents`, `monthlyExpensesCents`, `debtPaymentsCents`, `targetCashCents`, `emergencyReserveCents` |
| `location` | `currentMunicipality`, `selectedMunicipalityCode` |
| `rural` | `required` (boolean) |

Money uses integer EUR cents. Finance amounts are nonnegative; debt payments are separate from monthly expenses. The contract rejects negative finance aggregates; a negative cash-flow result belongs in the bank analysis response, not an income/expense input. `homeSizeM2` is floor area, not inferred from bedroom count. Omitted fields mean “no update”; `null` means explicitly unknown. Empty school lists, zero financial values and `false` are preserved.

## Resolution rules

For each field, use the latest observation **within each source type**. If those latest source candidates include confirmed values, compare only confirmed candidates. Matching values resolve together with their provenance. Different values remain a conflict, and that field resolves to null. Equal timestamps with different values within a source also conflict. Source labels have no hidden priority. School-stage arrays are normalized as sets.

A newer unconfirmed observation replaces an older confirmed observation within the same source type before cross-source comparison. Use confirmation carefully and correct erroneous source records with PUT/DELETE, or by posting the record again under the same ID. `observedAt` is supplied by the client, so submitting a future timestamp can dominate that source; this demo does not independently attest timestamps. There is no automatic expiration.

The context also reads current saved details/preferences/bank snapshot as an unconfirmed baseline. Known stage aliases such as `ESO` and `primaria` are normalized. Invalid saved fields are omitted with a warning; they are not treated as verified. A missing profile date uses a documented 1970 ordering sentinel. Profile bank values are snapshot totals, not live ledger results: submit reviewed bank-analysis aggregates explicitly. Confirmed input values can supersede the baseline. Remaining disagreements are exposed.

### Savings for the purchase are never taken from a balance

The balance of the bank snapshot (`bank-account.balanceCents`) is **not** proposed as `finance.currentSavingsCents`. An account balance also holds rent, bills and the emergency reserve, so treating it as money available for the purchase would overstate it. The context returns it separately:

```json
"bankSnapshot": { "balanceCents": 4498200, "observedAt": "2026-11-21", "confirmed": false, "synthetic": true }
```

`finance.currentSavingsCents` comes only from a declaration: an input record (the interview, the workspace form, `save_my_inputs`), or the optional `preferences.purchaseSavingsCents` of the profile, which is proposed unconfirmed like the rest of the baseline. While neither exists the context carries a warning, the person has `currentSavingsCents: null` and the plan reports `person.finances.currentSavingsCents` in `dataMissing` instead of inventing a timeline. The committed fixtures in `data/users/` do not declare `purchaseSavingsCents`, so a demo persona has no timeline until savings are declared for it.

## Preparing tool calls

`context.recommendation` contains `ready`, `input`, `missingFields` and `unsupportedFields`. The adapter uses the existing municipality recommendation schema and converts budget cents to euros at the boundary. It requires tenure/budget, floor area for buying, and complete destination/time constraints when transport requirements are supplied. School requirements must specify stages and a mode when stages are nonempty. Explicit confirmed consent is required before enabling comarca estimates.

Any unresolved conflict blocks a prepared call. Bedroom requirements also block readiness because the municipality backend cannot verify a property's bedroom count. Household, finance and selected-place facts remain in context and are reported as unsupported by this particular tool; they are not silently turned into tax eligibility or affordability claims. There is no automatic tax-fact inference. A later listing/finance adapter must handle those domains explicitly.

When `ready` is true, pass `recommendation.input` to `recommend_towns`. When false, ask about `missingFields`, resolve conflicts and handle unsupported hard constraints before calling. This does not yet wire the separate frontend plugin to the profile API; it gives both teams a versioned shared interface.
