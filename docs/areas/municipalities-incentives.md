# Municipalities and incentives area

**Owner:** Catalunya relocation research/backend team. **Purpose:** recommend towns and screen public support using dated official evidence.

## Entry points

- `apps/mcp-server/tools.ts`: tool registration and structured responses.
- `packages/places/data.ts`: snapshot loading/validation.
- `packages/places/recommend.ts`, `access.ts`, `eligibility.ts`: matching, school/transport access and policy rules.
- `packages/contracts/places.ts`: municipality and tool contracts.
- `data/towns.json`, `data/incentives.json`: versioned evidence for every municipality of Catalonia (`npm run data:refresh` rebuilds the snapshot from the official list).
- `data/travel-estimates.json`: approximate, dated travel evidence; `data/relocat-pilot-data.json`: separately sourced opportunity research with its own availability/eligibility uncertainty.
- `packages/places/relocation.ts`, `packages/listings/search.ts`: join pilot research without overriding official metrics; retrieve indexed property examples only when the optional provider is configured.
- `apps/mcp-server/town-explorer.ts`, `town-explorer-widget.ts`: interactive Town Explorer and profile-derived recommendations, using the same domain functions/contracts.
- `scripts/refresh-data.ts`, `sources.ts`, `validate-data.ts`: refresh and validation workflow.
- `packages/sources/`: live, pre-cached official sources (one file per source in `definitions/`).

## Inputs and outputs

Core tools are `recommend_towns`, `get_town_profile` and `get_applicable_incentives`. The backend also exposes school, transport, business and detailed eligibility tools. Pass official six-digit municipality codes, confirmed household criteria and explicit dates. Budget is expressed in euros in this tool interface; the profile adapter converts stored cents once.

`search_homes` returns indexed examples with explicit unknown availability/location/filter verification; it cannot satisfy bedroom or live-inventory constraints. `TREG_TOKEN`/optional `TREG_ORG` stay server-side. Missing configuration returns an unavailable result with follow-up links. Paid searches are capped per minute and per day by `packages/listings/budget.ts` (counters in the runtime database); past a cap the search answers `budget_exhausted` with the same follow-up links, and an identical search within ten minutes is answered from a cache. `npm run build` produces every browser bundle; the start scripts run it for you.

Results retain source/observation dates, geography, match reasons, trade-offs and missing data. Separate policy call status from household eligibility. Never infer school vacancies, transport reliability, business health or tax facts from proxy indicators. Comarca price estimates require explicit user agreement. Bedroom availability remains a property-level check, not a town fact.

## Data sources

Data is live but pre-cached. `data/towns.json` is the committed baseline; `packages/sources/` keeps fresher official values in `data/cache/` (ignored by Git) and lays them over it.

- **One file per source.** Copy `packages/sources/definitions/_template.ts` to a new file in the same folder and default-export `defineSource({ id, title, authority, homepage, ttlMs, env?, schema, fetch(ctx), overlay })`. The registry discovers it; files starting with `_` are skipped. `env` names any API key (Catalan open data needs none today).
- **Cache** (`cache.ts`): stale-while-revalidate with one JSON file per source. A read returns at once; a value older than `ttlMs` is refreshed in the background; a failed refresh keeps the last good value and records the error. Values are validated with the source's schema before they are stored. Status is `fresh`, `stale`, `error` or `never`.
- **Live layer** (`live.ts`): `createLiveData({ cacheDir })` returns `current()` (same shape as `loadData()`), `warm()`, `start()`, `stop()` and `status()`. An overlay never changes the list of municipalities, is validated like the snapshot, and is skipped when the cache is older than the committed snapshot.
- **Shipped sources** (all refresh in the background; daily unless noted):

  | Source id | Publisher and dataset | What it keeps live |
  | --- | --- | --- |
  | `idescat-emex` | Idescat municipal profile (EMEX) | Population, rent, unemployment, affiliates, surface `f261`, density `f262`, foreign-nationality share `f184`/`f263` |
  | `gencat-equipaments` | Generalitat facilities directory `8gmd-gz7i` | Primary care, hospitals, libraries, sports facilities |
  | `gencat-municipis-rurals` | Rural municipalities list `7gqm-722r` | Each town's rural category, with the resolution it comes from |
  | `gencat-centres-docents` | School directory `kvmv-ahh4`, latest school year | Every school of Catalonia that lists a stage (journeys consider those within 15 km of a town centre) |
  | `gencat-cens-comercial` | Retail census `2dhj-q3r8`, latest year | Shops and shops per 1,000 residents |
  | `gencat-compravendes-habitatge` | Agència de l'Habitatge annual sales workbooks (weekly) | Second-hand sales and price per m², by town and by comarca |
  | `fgc-gtfs` | FGC GTFS feed | RL1/RL2 stops, trips and service dates |
  | `gencat-serveis-socials` | Social services register `ivft-vegh` | Registered social services and establishments |

- **One implementation.** `npm run data:refresh` runs these same definitions, so the script and the live layer cannot drift apart. Only the list of municipalities, their names and their centres (Idescat nodes, geography dataset `wpyq-we8x`) are fetched by the script alone: the live layer never changes them.
- **Joins without a code.** The retail census and the social services register name the municipality and comarca but carry no official code. `names.ts` joins them by normalised name and comarca and accepts clean matches only; a town without one keeps the kind unknown.
- **Rural list.** Categories come from the dataset's own label and are never edited by hand. On 2026-11-22 the dataset (rows last changed 2026-10-06) already holds the twelve municipalities added by Resolució PRE/3375/2026, under "Municipi amb aplicació de les mesures del règim especial", a class of 28 municipalities. The dataset does not date entries, so the whole class gets the later date, 2026-09-29; no pilot town is in it.
- **Sale prices** use the sheet for the latest complete calendar year (`SALES_YEAR` pins another). The quarterly sheets of the year in progress cover other periods and are not read.
- **Heavy sources.** The GTFS archive and the workbooks are parsed during the background refresh (the timetable in slices that give the event loop back), and the overlay is recomputed when a refresh lands, not when a request arrives. Each source refreshes on its own: a slow or failing one never delays or undoes another.
- **Service counts** live in `snapshot.services`. Schools, FGC rail stops and shops are derived from the schools, timetable and retail metric, and are recomputed whenever one of those changes. A kind that is absent is unknown, never zero: pharmacies have no official open dataset yet.
- `npm run data:refresh` rebuilds the whole snapshot. `npm run data:refresh -- --sources-only` keeps the committed municipalities and refetches everything the definitions cover. Add `--out <file>` to write the result elsewhere and diff it first.

## Run and verify

```powershell
npm run data:validate
npm run typecheck
npm test
npm start
```

`npm start` runs the one server on port 8787, with the MCP endpoint at `/mcp`; there is no separate municipality server to start. See [integration/deployment](integration-deployment.md). Refresh with `npm run data:refresh` only when deliberately updating evidence and reviewing its sources.

## Handoff

Keep domain functions independent of transport. The integrated plugin reuses this tool factory and structured outputs; UI teams must not duplicate eligibility logic. Report pilot coverage and schedule dates, and make out-of-coverage destinations explicit. See the detailed [MCP service guide](../../apps/mcp-server/README.md).

## Rural and depopulation aid

Checked against official pages on 2026-11-22. `data/incentives.json` holds the twelve household measures below: eight for rural or small municipalities and four reduced transfer-tax rates that apply anywhere in Catalonia; `packages/places/eligibility.ts` screens them. Call status and household eligibility are separate fields, and a missing fact is reported as unknown.

| Measure (`id`) | Authority | What it does | Where | Status on 2026-11-22 | Source |
| --- | --- | --- | --- | --- | --- |
| Moving deduction (`irpf_move`) | Agència Tributària de Catalunya | €750 rural, €1,000 special attention; doubled for single-parent families | Rural municipalities under Llei 8/2025 | In force for tax year 2026, filed in 2027; no call | [ATC](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [art. 57](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a5-9) |
| Purchase deduction (`irpf_buy`) | Agència Tributària de Catalunya | 15% or 20% of yearly payments, €6,000 base | Same | In force for tax year 2026; no call | [ATC](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [art. 58](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a5-10) |
| Rent deduction (`irpf_rent`) | Agència Tributària de Catalunya | 15% or 20% of the rent paid, with no cap on the rent; the deduction is at most €600 a year (€1,200 joint) | Same | In force for tax year 2026; no call | [ATC](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [art. 61](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a6-3) |
| Rehabilitation deduction (`irpf_renovate`) | Agència Tributària de Catalunya | 15% or 20% of yearly payments, €6,000 base, home built before 1970 | Same | In force for tax year 2026; no call | [ATC](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [art. 59](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a5-11) |
| Reduced ITP, family home (`itp_buy`, TMR / TEA) | Agència Tributària de Catalunya | 4% rural or 3% special attention instead of the general tariff (10% up to €600,000); needs a child up to 16 schooled locally | Same; attached nuclei only in Artesa de Segre and Tremp | In force 2025-08-20 to 2029-07-16; no call | [ATC](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/), [art. 62](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a6-4) |
| Reduced ITP, home to rehabilitate (`itp_rehab_buy`, TRR / TRA) | Agència Tributària de Catalunya | 4% or 3% on a pre-1970 home bought to rehabilitate as a primary home; no child requirement; buyer's tax base at most €36,000 | Same | In force 2025-08-20 to 2029-07-16; no call | [ATC](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/), [art. 63](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a6-5) |
| Rural rehabilitation grant (`renovation_grant_2026`) | Agència de l'Habitatge de Catalunya | Own residence: 10% to 40% of the budget, capped at €10,000 to €20,000 per dwelling | Municipalities in Resolució PRE/415/2026 | Call closed on 2026-09-10 at 14:00 | [Tràmits](https://tramits.gencat.cat/ca/tramits/tramits-temes/Rehabilitacio_entorn_rural), [call](https://dogc.gencat.cat/ca/document-del-dogc?documentId=1043506), [bases](https://dogc.gencat.cat/ca/document-del-dogc/?documentId=1039620) |
| State youth purchase aid (`youth_purchase_small_town`) | Ministerio de Vivienda y Agenda Urbana; calls by the Agència de l'Habitatge | At most the lower of €15,000 and 20% of the price; buyer aged 35 or younger; price at most €300,000 in Catalonia | Municipalities or nuclei of 10,000 residents or fewer | Decree in force since 2026-04-24; no Catalan call found, so call status is unknown | [RD 326/2026, arts. 140-145](https://www.boe.es/eli/es/rd/2026/04/22/326/con), [Generalitat purchase aid](https://habitatge.gencat.cat/ca/normativa/bases-convocatories-ajuts/ajuts-a-ladquisicio-de-lhabitatge/) |

Notes for whoever maintains these rules:

- The youth purchase aid can never screen as `eligible` while `callWindow` is `null`. When the Generalitat publishes a call, set `callWindow` to its dates and re-read the bases, which may add conditions. Its `municipalityCodes` are the pilot towns at or below 10,000 residents in the snapshot's 2025 population; refresh them with the population data.
- The IRPF deductions are encoded for tax year 2026 only. The law's first transitional provision keeps them for four years from its approval (30 July 2025); the ATC page describes 2026 only, so later years screen as `needs_verification`.
- Since 2026-09-29 twelve more municipalities count as rural for the ITP rates under the special regime ([Resolució PRE/3375/2026](https://dogc.gencat.cat/ca/document-del-dogc/?documentId=1055370)): Alguaire, Arbeca, Avià, Bagà, Bellvís, Falset, el Perelló, el Pont de Suert, Prats de Lluçanès, Santa Coloma de Queralt, Sort and Torregrossa. None is a pilot town, so `data/towns.json` is unaffected today.
- Each policy's `effect` holds only figures stated in its verified text. The rent deduction is capped by amount, so its effect has `maxAmountEur` (`individual` 600, `joint` 1200) and no `maxBaseEur`. The youth purchase aid is `one_off_rate_of_price` (rate 0.2, `maxAmountEur` 15000): a ceiling, the lower of the two.
- The planner never counts the rent deduction (the person entity does not hold the rent paid) nor the youth purchase aid (no call: `callWindow` is `null`), whatever options are switched on.

### Transfer tax: general tariff and rates that apply anywhere

Read on the [ATC rates page](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/) and in the [Codi tributari de Catalunya, book six](https://www.boe.es/eli/es-ct/dlg/2024/03/12/1/con) (consolidated text updated 2026-07-13) on 2026-11-22.

General tariff ([art. 641-1](https://www.boe.es/eli/es-ct/dlg/2024/03/12/1/con#a6-85)), for purchases from 2025-06-27: 10% when the property's total value does not exceed €600,000. Above that the tax is the average of a tariff by value, encoded as `standardTariff` in every `transfer_tax_rate` effect:

| Total value from | Rate on that part |
| --- | --- |
| €0 | 10% |
| €600,000 | 11% |
| €900,000 | 12% |
| €1,500,000 | 13% |

The ATC example: €700,000 pays €60,000 + 11% of €100,000 = €71,000. From 2017-03-31 to 2025-06-26 the 10% reached €1,000,000 and 11% applied above; that tariff is not encoded.

Reduced rates for a habitual residence in any municipality (`territory: "catalonia"`), all 5% flat on the whole value:

| Measure (`id`) | Who | Tax-base limit on the last IRPF return | Since | Source |
| --- | --- | --- | --- | --- |
| Young buyer (`itp_young_buyer`, TUJ) | Buyer aged 35 or younger when the tax accrues | Buyer's own base at most €36,000 | 35 years from 2025-06-27 (32 before); €36,000 from 2023-03-18 | [ATC](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/), [art. 641-5](https://www.boe.es/eli/es-ct/dlg/2024/03/12/1/con#a6-89) |
| Large family (`itp_large_family`, TUF) | Member of a large family (Llei 40/2003) | Family members' bases at most €36,000, plus €14,000 per child above the legal minimum | 2023-03-18 | [ATC](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/), [art. 641-2](https://www.boe.es/eli/es-ct/dlg/2024/03/12/1/con#a6-86) |
| Single-parent family (`itp_single_parent`, TMP) | Member of a single-parent family (Llei 18/2003) | Family members' bases at most €36,000, plus €14,000 per child above the special-category minimum | 2023-03-18 | [ATC](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/), [art. 641-3](https://www.boe.es/eli/es-ct/dlg/2024/03/12/1/con#a6-87) |
| Disability (`itp_disability`, TUM) | Buyer or a family-unit member with a recognised disability of 65% or more | Family unit's bases at most €36,000 | 2023-03-18 | [ATC](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/), [art. 641-4](https://www.boe.es/eli/es-ct/dlg/2024/03/12/1/con#a6-88) |

All four need the home to be occupied within twelve months and kept as the habitual residence for three years, are provisional until then, and exclude bare ownership. The law gives no end date; `effectiveThrough` is `2099-12-31` to say so.

How the savings planner uses them (`packages/planner/plan.ts`):

- The general tax comes from the data: `standardRate`, and `standardTariff` when the price is above its first bracket. The price is taken as the property's total value.
- A person's baseline transfer tax is the lowest rate of a `territory: "catalonia"` policy whose every condition is verified (`eligible`), otherwise the general tax. `transferTax` on each plan reports `standardCents`, `baselineCents`, `baselinePolicyId` and `couldBeLower`.
- A rural place is credited only with the difference between that baseline and its own rate: a verified 30-year-old saves 5% − 4% (or 3%), not 10% − 4%.
- An unknown age, tax base or family status never lowers the baseline. The plan keeps the general tax, sets `couldBeLower` and adds a `dataMissing` line saying the baseline could be as low as 5%. `includeUnverifiedBenefits` does not change this.
- Every rate considered is listed in `benefits`. Catalonia-wide rates have `scope: "anywhere"` and are never `counted`, because they are not a saving of the place.
- For the large-family and single-parent rates only the €36,000 limit is screened; a family above it is `needs_verification`, since the €14,000 increases depend on a child count the screen does not hold.

Read but not encoded: the 5% rate for victims of gender violence (TVV, [art. 641-5 bis](https://www.boe.es/eli/es-ct/dlg/2024/03/12/1/con#a6-138), from 2025-06-27) and the 7% rate for officially protected housing (THP), which depends on the property; the 20% rate for large holders and whole-building purchases (TGT, TEH), which does not concern a household buying its home. The ATC example rounds the averaged rate (10.1430% for €700,000); the planner sums the brackets exactly, so a bill above €600,000 can differ by a few euros.

Verified but not encoded, because they are not specific to rural or small municipalities:

- Rent subsidy for people aged 35 or younger, Agència de l'Habitatge: €50 to €250 a month for two years; rent limit €600 a month in the Lleida demarcation and Terres de l'Ebre, €700 in Tarragona, €750 in Girona and central Catalonia. The 2026 call ran from 29 June to 10 July 2026 and is closed. [Tràmits](https://agenciahabitatge.gencat.cat/lloguer-joves), [Resolució TER/1990/2026](https://dogc.gencat.cat/ca/document-del-dogc/?documentId=1047710).
- Fons Públic d'Emancipació loans for a first home, up to 20% of the value and €50,000: [Generalitat page](https://habitatge.gencat.cat/ca/ajuts/prestecs-per-a-lemancipacio-dels-joves/). The page describes the 2025 call, open until its budget runs out; whether funds remain was not confirmed.
- 75% ITP rebate on title-regularisation deeds for property in a rural municipality ([art. 64](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a6-6)). Read in the law only; it does not help with a purchase or a move.

Unverified leads (not encoded):

- A Catalan call for the state youth purchase aid. Press reports mention other regions' calls; nothing was found on gencat.cat. Watch the [Generalitat purchase-aid page](https://habitatge.gencat.cat/ca/normativa/bases-convocatories-ajuts/ajuts-a-ladquisicio-de-lhabitatge/).
- Bo Lloguer Jove: listed on the [Generalitat housing aid menu](https://habitatge.gencat.cat/ca/ajuts/ajuts-pagament-habitatge/subvencions-bo-lloguer-jove/); current amounts and call dates were not read.
- "Pla de pobles" and a rural housing pool managed by the Agència de l'Habitatge: press reports only; no official programme page was found, and the reported lines fund town councils.
- Diputació de Lleida "repte demogràfic" housing grants: press reports describe grants to town councils; the official page returned an error.

Out of scope because they do not pay households: the Odisseu practicum aid (AGAUR, paid placements in rural businesses; [call closed 3 July 2026](https://tramits.gencat.cat/ca/tramits/tramits-temes/Ajuts-practicum-Odisseum-ODISSEU)), LEADER business grants, and MITECO "reto demográfico" project grants. The last two were not read on an official page.
