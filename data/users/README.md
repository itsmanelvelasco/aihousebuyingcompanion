# Synthetic Catalunya homebuyer profiles

These 500 profiles are fictional demo households, not real customers, credit records or a statistically representative sample. Every household wants to buy a primary home and has an explicit shortfall in upfront savings. Many also have irregular income, existing debt, missed-payment history or limited credit history. No real bank account number, credentials or numeric credit score is generated.

## Layout and regeneration

Each `user-001` through `user-500` directory contains `details.json`, `preferences.json` and `bank-account.json`. Every file carries `schemaVersion: 1` and `synthetic: true`. Financial amounts use integer EUR cents. `preferences.json` states `purchaseSavingsCents`: what the household says it has set aside for the purchase. It is 60 to 90% of the account balance in whole euros (the rest stays for rent, bills and a reserve), so it is always below the illustrative upfront target. ReloCat never reads an account balance as purchase savings, so without this declared figure a persona's plan would have no savings to start from. Income and expenses describe the whole household, not just the lead adult. Expenses exclude separately recorded debt payments. Negative monthly cash flow is intentional for some scenarios; balances remain nonnegative.

The generator also writes `data/synthetic-users.json` containing all three complete documents per household and `data/synthetic-users.csv` containing a flattened summary of all 500 households. CSV list fields use semicolons inside quoted cells; nested full-fidelity data remains in JSON. Both exports are generated snapshots: regenerate them after editing the generator; API changes to individual profiles do not automatically refresh these exports.

Run `node scripts/generate-users.ts` with Node 24 or later from the repository root. The seed is fixed at `20261121`. `purchaseSavingsCents` is derived from the household's index and balance, not drawn from the seeded generator, so adding it changed no other field of any fixture. The script refuses to replace existing profile directories by default. To deliberately reset these demo fixtures, use `node scripts/generate-users.ts --overwrite`. This replaces the three named files for the 500 demo IDs and must not be used on live user storage.

## The four demo personas

`user-001` to `user-004` are the personas of the public demo (`DEMO_USER_IDS`). On top of the drawn household each carries a hand-written, fictional story (`demoStories` in `scripts/generate-users.ts`), so the demo shows a place benefit and a habit effect without a click. Their folders hold two more generated files, both `synthetic: true`: `demo-inputs.json` (answers the persona "confirmed"; the planner reads a household fact only from a confirmed input) and `demo-habits.json` (saving habits). The exports carry them as `demoInputs` and `demoHabits`.

| Persona | Story | What the plan shows (Balaguer, Talarn, Térmens on 2026-11-23) |
|---|---|---|
| `user-001` | Nothing confirmed, no habit. In development Banc Demo feeds its ledger. | Every measure "needs verification", with the questions that would verify it. |
| `user-002` | Two active habits and a paused one. | 233 months at the baseline, 118 with the habits; no place is credited. |
| `user-003` | One active habit; saves very little each month. | No end at the baseline; 199 months with the habit. |
| `user-004` | Couple with a five-year-old (the drawn couple, aged 40, with one child: the only household field a story changes), the facts of the reduced rural transfer tax confirmed, one habit. | 32 months at the baseline, 27 with the habit, 17 in Talarn and 15 in Térmens; Balaguer stays at 27. The state youth aid stays unverified. |

`tests/demo-personas.test.ts` computes these with the real planner and fails if a fixture change flattens them. Because `user-004` gains a child, the quotas below are off by one for that household type (99 couples without children, 141 with). A benefit tied to the purchase is screened on the day the persona could buy, so the rural rate (in force until 2029-07-16) stops counting for `user-004` once that day passes it.

The three profile documents are copied into a new database by the server; the two story files are written by `seedDemoStories` in `scripts/reseed-demo.ts` (also part of `npm run db:reseed-demo`), into the shared inputs and the habits store, by their own record ids.

A running database keeps the fixtures it was seeded with: the server copies a fixture only for a persona that does not exist yet. After regenerating, `npm run db:reseed-demo` replaces the three profile documents of the demo personas (`DEMO_USER_IDS`, default `user-001` to `user-004`) in `DATABASE_FILE` with the committed ones and writes their story records; `-- --dry-run` shows what it would do. It touches nothing else of a persona (other answers and habits, ledger, connections), never an id outside that list and never a person who belongs to an account. It can run while the server does.

## Demographic grounding and limitations

The categories are informed by these official Idescat census tables, consulted on 21 November 2026:

- [Households by composition and municipality size, 2021](https://www.idescat.cat/pub/?id=censph&lang=en&n=17314&t=202100): motivates coverage of single adults, couples, parents with children and other household arrangements across different settlement sizes.
- [Single-person households by sex and age, 2021](https://www.idescat.cat/pub/?id=censph&lang=en&n=17288&t=202100): motivates including both younger and older adults living alone.
- [Idescat Population and Housing Census open data](https://www.idescat.cat/dades/obertes/censph?lang=en): reference for future calibration using official age, household and economic-activity tables.

These sources inform scenario dimensions; their population frequencies were **not** fitted or reproduced. The hand-chosen demo quotas are 150 single adults, 100 couples without children, 140 couples with children, 70 single parents and 40 multigenerational households. They intentionally broaden interview and recommendation coverage. A profile represents a household decision-maker, so these are not 500 independent people sampled from the population.

Adults span ages 21–72. Current locations span all four Catalan provinces, with selected cities and towns; location counts are not population-weighted. Needs vary by children’s ages, school stages, transport access, commuting, remote work, accessibility, preferred settlement type and housing size. All locations are current residences, not validated relocation recommendations.

Income, expenses, debt, savings, property budgets and credit-history scenarios are **design assumptions**, not measured Catalan distributions. Credit barriers are assigned independently of protected demographic attributes and municipality. There is no claim that a Catalan or Spanish lender uses a particular universal credit-score scale. `numericScore: null` and `mortgageApprovalStatus: not_assessed` make the absence of an actual assessment explicit.

Every household has insufficient savings against an illustrative upfront target of 30% of its desired purchase price. That percentage is only a demo calculation assumption, not verified tax guidance, lender criteria or mortgage approval. Financial instability is represented directly by scenario fields; no ethnicity or nationality is used to infer it. Incentive eligibility stays `needs_verification` for the relocation team’s sourced rule checks.

Treat these fixtures as interview and UI testing material. They must not be used to estimate population hardship, approve credit or claim eligibility for public support.
