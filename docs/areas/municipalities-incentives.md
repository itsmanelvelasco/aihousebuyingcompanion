# Municipalities and incentives area

**Owner:** Catalunya relocation research/backend team. **Purpose:** recommend towns and screen public support using dated official evidence.

## Entry points

- `apps/mcp-server/tools.ts`: tool registration and structured responses.
- `packages/places/data.ts`: snapshot loading/validation.
- `packages/places/recommend.ts`, `access.ts`, `eligibility.ts`: matching, school/transport access and policy rules.
- `packages/contracts/places.ts`: municipality and tool contracts.
- `data/towns.json`, `data/incentives.json`: versioned pilot evidence.
- `data/travel-estimates.json`: approximate, dated travel evidence; `data/relocat-pilot-data.json`: separately sourced opportunity research with its own availability/eligibility uncertainty.
- `packages/places/relocation.ts`, `packages/listings/search.ts`: join pilot research without overriding official metrics; retrieve indexed property examples only when the optional provider is configured.
- `apps/mcp-server/town-explorer.ts`, `town-explorer-widget.ts`: interactive Town Explorer and profile-derived recommendations, using the same domain functions/contracts.
- `scripts/refresh-data.ts`, `sources.ts`, `validate-data.ts`: refresh and validation workflow.
- `packages/sources/`: live, pre-cached official sources (one file per source in `definitions/`).

## Inputs and outputs

Core tools are `recommend_towns`, `get_town_profile` and `get_applicable_incentives`. The backend also exposes school, transport, business and detailed eligibility tools. Pass official six-digit municipality codes, confirmed household criteria and explicit dates. Budget is expressed in euros in this tool interface; the profile adapter converts stored cents once.

`search_homes` returns indexed examples with explicit unknown availability/location/filter verification; it cannot satisfy bedroom or live-inventory constraints. `TREG_TOKEN`/optional `TREG_ORG` stay server-side. Missing configuration returns an unavailable result with follow-up links. `npm run build` produces every browser bundle; the start scripts run it for you.

Results retain source/observation dates, geography, match reasons, trade-offs and missing data. Separate policy call status from household eligibility. Never infer school vacancies, transport reliability, business health or tax facts from proxy indicators. Comarca price estimates require explicit user agreement. Bedroom availability remains a property-level check, not a town fact.

## Data sources

Data is live but pre-cached. `data/towns.json` is the committed baseline; `packages/sources/` keeps fresher official values in `data/cache/` (ignored by Git) and lays them over it.

- **One file per source.** Copy `packages/sources/definitions/_template.ts` to a new file in the same folder and default-export `defineSource({ id, title, authority, homepage, ttlMs, env?, schema, fetch(ctx), overlay })`. The registry discovers it; files starting with `_` are skipped. `env` names any API key (Catalan open data needs none today).
- **Cache** (`cache.ts`): stale-while-revalidate with one JSON file per source. A read returns at once; a value older than `ttlMs` is refreshed in the background; a failed refresh keeps the last good value and records the error. Values are validated with the source's schema before they are stored. Status is `fresh`, `stale`, `error` or `never`.
- **Live layer** (`live.ts`): `createLiveData({ cacheDir })` returns `current()` (same shape as `loadData()`), `warm()`, `start()`, `stop()` and `status()`. An overlay never changes the list of municipalities, is validated like the snapshot, and is skipped when the cache is older than the committed snapshot.
- **Shipped sources:** `idescat-emex` (Idescat municipal profile: population, rent, unemployment, affiliates, surface `f261`, density `f262`, foreign-nationality share `f184`/`f263`) and `gencat-equipaments` (Generalitat facilities directory `8gmd-gz7i`: primary care, hospitals, libraries, sports facilities).
- **Service counts** live in `snapshot.services`. Schools, FGC rail stops and shops are derived from data already in the snapshot. A kind that is absent is unknown, never zero: pharmacies and social services have no official open dataset with municipality codes yet.
- `npm run data:refresh` rebuilds the whole snapshot using the same source definitions. `npm run data:refresh -- --sources-only` refetches only what the definitions cover and leaves schools, rail and housing untouched.

## Run and verify

```powershell
npm run data:validate
npm run typecheck
npm test
npm start
```

Standalone MCP defaults to port 8787. Do not run it on the same port as the integrated plugin; see [integration/deployment](integration-deployment.md). Refresh with `npm run data:refresh` only when deliberately updating evidence and reviewing its sources.

## Handoff

Keep domain functions independent of transport. The integrated plugin reuses this tool factory and structured outputs; UI teams must not duplicate eligibility logic. Report pilot coverage and schedule dates, and make out-of-coverage destinations explicit. See the detailed [MCP service guide](../../apps/mcp-server/README.md).

## Rural and depopulation aid

Checked against official pages on 2026-11-22. `data/incentives.json` holds the eight household measures below; `packages/places/eligibility.ts` screens them. Call status and household eligibility are separate fields, and a missing fact is reported as unknown.

| Measure (`id`) | Authority | What it does | Where | Status on 2026-11-22 | Source |
| --- | --- | --- | --- | --- | --- |
| Moving deduction (`irpf_move`) | Agència Tributària de Catalunya | €750 rural, €1,000 special attention; doubled for single-parent families | Rural municipalities under Llei 8/2025 | In force for tax year 2026, filed in 2027; no call | [ATC](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [art. 57](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a5-9) |
| Purchase deduction (`irpf_buy`) | Agència Tributària de Catalunya | 15% or 20% of yearly payments, €6,000 base | Same | In force for tax year 2026; no call | [ATC](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [art. 58](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a5-10) |
| Rent deduction (`irpf_rent`) | Agència Tributària de Catalunya | 15% or 20% of rent, at most €600 a year (€1,200 joint) | Same | In force for tax year 2026; no call | [ATC](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [art. 61](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a6-3) |
| Rehabilitation deduction (`irpf_renovate`) | Agència Tributària de Catalunya | 15% or 20% of yearly payments, €6,000 base, home built before 1970 | Same | In force for tax year 2026; no call | [ATC](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [art. 59](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a5-11) |
| Reduced ITP, family home (`itp_buy`, TMR / TEA) | Agència Tributària de Catalunya | 4% rural or 3% special attention instead of the 10% general rate; needs a child up to 16 schooled locally | Same; attached nuclei only in Artesa de Segre and Tremp | In force 2025-08-20 to 2029-07-16; no call | [ATC](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/), [art. 62](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a6-4) |
| Reduced ITP, home to rehabilitate (`itp_rehab_buy`, TRR / TRA) | Agència Tributària de Catalunya | 4% or 3% on a pre-1970 home bought to rehabilitate as a primary home; no child requirement; buyer's tax base at most €36,000 | Same | In force 2025-08-20 to 2029-07-16; no call | [ATC](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/), [art. 63](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con#a6-5) |
| Rural rehabilitation grant (`renovation_grant_2026`) | Agència de l'Habitatge de Catalunya | Own residence: 10% to 40% of the budget, capped at €10,000 to €20,000 per dwelling | Municipalities in Resolució PRE/415/2026 | Call closed on 2026-09-10 at 14:00 | [Tràmits](https://tramits.gencat.cat/ca/tramits/tramits-temes/Rehabilitacio_entorn_rural), [call](https://dogc.gencat.cat/ca/document-del-dogc?documentId=1043506), [bases](https://dogc.gencat.cat/ca/document-del-dogc/?documentId=1039620) |
| State youth purchase aid (`youth_purchase_small_town`) | Ministerio de Vivienda y Agenda Urbana; calls by the Agència de l'Habitatge | Up to €15,000 and at most 20% of the price; buyer aged 35 or younger; price at most €300,000 in Catalonia | Municipalities or nuclei of 10,000 residents or fewer | Decree in force since 2026-04-24; no Catalan call found, so call status is unknown | [RD 326/2026, arts. 140-145](https://www.boe.es/eli/es/rd/2026/04/22/326/con), [Generalitat purchase aid](https://habitatge.gencat.cat/ca/normativa/bases-convocatories-ajuts/ajuts-a-ladquisicio-de-lhabitatge/) |

Notes for whoever maintains these rules:

- The youth purchase aid can never screen as `eligible` while `callWindow` is `null`. When the Generalitat publishes a call, set `callWindow` to its dates and re-read the bases, which may add conditions. Its `municipalityCodes` are the pilot towns at or below 10,000 residents in the snapshot's 2025 population; refresh them with the population data.
- The IRPF deductions are encoded for tax year 2026 only. The law's first transitional provision keeps them for four years from its approval (30 July 2025); the ATC page describes 2026 only, so later years screen as `needs_verification`.
- Since 2026-09-29 twelve more municipalities count as rural for the ITP rates under the special regime ([Resolució PRE/3375/2026](https://dogc.gencat.cat/ca/document-del-dogc/?documentId=1055370)): Alguaire, Arbeca, Avià, Bagà, Bellvís, Falset, el Perelló, el Pont de Suert, Prats de Lluçanès, Santa Coloma de Queralt, Sort and Torregrossa. None is a pilot town, so `data/towns.json` is unaffected today.
- Each policy's `effect` holds only figures stated in its verified text. The rent deduction is capped by amount (€600), which `annual_rate_of_cost` cannot express; its base is set to €3,000 so the effect never exceeds the cap.

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
