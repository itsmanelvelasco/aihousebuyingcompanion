# Synthetic Catalunya homebuyer profiles

These 500 profiles are fictional demo households, not real customers, credit records or a statistically representative sample. Every household wants to buy a primary home and has an explicit shortfall in upfront savings. Many also have irregular income, existing debt, missed-payment history or limited credit history. No real bank account number, credentials or numeric credit score is generated.

## Layout and regeneration

Each `user-001` through `user-500` directory contains `details.json`, `preferences.json` and `bank-account.json`. Every file carries `schemaVersion: 1` and `synthetic: true`. Financial amounts use integer EUR cents. Income and expenses describe the whole household, not just the lead adult. Expenses exclude separately recorded debt payments. Negative monthly cash flow is intentional for some scenarios; balances remain nonnegative.

The generator also writes `data/synthetic-users.json` containing all three complete documents per household and `data/synthetic-users.csv` containing a flattened summary of all 500 households. CSV list fields use semicolons inside quoted cells; nested full-fidelity data remains in JSON. Both exports are generated snapshots: regenerate them after editing the generator; API changes to individual profiles do not automatically refresh these exports.

Run `node scripts/generate-users.ts` with Node 24 or later from the repository root. The seed is fixed at `20261121`. The script refuses to replace existing profile directories by default. To deliberately reset these demo fixtures, use `node scripts/generate-users.ts --overwrite`. This replaces the three named files for the 500 demo IDs and must not be used on live user storage.

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
