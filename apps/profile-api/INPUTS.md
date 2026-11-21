# Shared app input contract

The interviewer, frontend, bank-analysis client and property-selection flow can submit partial structured facts without replacing whole profile files. The shared Zod contract lives in `packages/contracts/inputs.ts`. This is a synthetic-data demo interface using the same authentication and local server as the [profile API](README.md).

## Endpoints

| Method | Route | Result |
| --- | --- | --- |
| POST | `/users/:id/inputs` | Atomically import `{ "inputs": [...] }`, 1–50 records per request. Identical ID/data retries are idempotent; conflicting ID reuse returns 409. |
| GET | `/users/:id/inputs` | Read stored source records. |
| PUT | `/users/:id/inputs/:inputId` | Replace a complete source record to correct it; ID must match. |
| DELETE | `/users/:id/inputs/:inputId` | Remove a source record; older values may become visible again. |
| GET | `/users/:id/context` | Read normalized data, field provenance, conflicts, warnings and a prepared municipality-tool input. No recommendation call is executed. |

Up to 500 source records are stored in each runtime user's `app-inputs.json`. Writes are atomic and serialized per user within one API process. Existing body limits and shared-token demo limitations apply. Original profile files and aggregate exports are unchanged by input events. Full replacements use last-write-wins; multiple server processes need database-level coordination.

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

A newer unconfirmed observation replaces an older confirmed observation within the same source type before cross-source comparison. Use confirmation carefully and correct erroneous source records with PUT/DELETE. `observedAt` is supplied by the client, so submitting a future timestamp can dominate that source; this demo does not independently attest timestamps. There is no automatic expiration.

The context also reads current saved details/preferences/bank snapshot as an unconfirmed baseline. Known stage aliases such as `ESO` and `primaria` are normalized. Invalid saved fields are omitted with a warning; they are not treated as verified. A missing profile date uses a documented 1970 ordering sentinel. Profile bank values are snapshot totals, not live ledger results: submit reviewed bank-analysis aggregates explicitly. Confirmed input values can supersede the baseline. Remaining disagreements are exposed.

## Preparing tool calls

`context.recommendation` contains `ready`, `input`, `missingFields` and `unsupportedFields`. The adapter uses the existing municipality recommendation schema and converts budget cents to euros at the boundary. It requires tenure/budget, floor area for buying, and complete destination/time constraints when transport requirements are supplied. School requirements must specify stages and a mode when stages are nonempty. Explicit confirmed consent is required before enabling comarca estimates.

Any unresolved conflict blocks a prepared call. Bedroom requirements also block readiness because the municipality backend cannot verify a property's bedroom count. Household, finance and selected-place facts remain in context and are reported as unsupported by this particular tool; they are not silently turned into tax eligibility or affordability claims. There is no automatic tax-fact inference. A later listing/finance adapter must handle those domains explicitly.

When `ready` is true, pass `recommendation.input` to `recommend_towns`. When false, ask about `missingFields`, resolve conflicts and handle unsupported hard constraints before calling. This does not yet wire the separate frontend plugin to the profile API; it gives both teams a versioned shared interface.
