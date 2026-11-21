# relocat places MCP

The relocat backend compares Catalan municipalities for a household considering a move. Its TypeScript MCP server screens housing budgets and school or rail access, returns sourced municipal profiles, and checks a small catalogue of housing incentives from a local snapshot. The pilot covers 17 candidates, including Calaf, Juncosa, Ulldemolins and towns along the FGC Lleida–La Pobla de Segur corridor. Lleida serves as a transport destination.

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
npm run start:mcp
curl http://127.0.0.1:8787/health
```

The Streamable HTTP endpoint is `http://127.0.0.1:8787/mcp`. In MCP Inspector, select **Streamable HTTP** and enter that URL. Run `npm test` to exercise initialization, tool discovery and every tool through the official client. Run `npm run typecheck` and `npm run data:validate` to check the code and snapshot.

For hosting, use `npm run start:mcp` with `HOST=0.0.0.0` and the platform’s `PORT`, or build the included image with `docker build -t relocat-mcp .` and run it with `docker run --rm -p 127.0.0.1:8787:8787 relocat-mcp`. The service speaks HTTP behind the host’s TLS proxy. Connect ChatGPT to the resulting HTTPS `/mcp` URL or use Secure MCP Tunnel. Requests from browser origins are rejected unless their exact origin is listed in `ALLOWED_ORIGINS` as a comma-separated value. [OpenAI’s connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)

The tools are read-only. The application processes supplied household criteria in memory for the duration of the call. The schema takes age, tax-base amounts and qualifying facts. It has no fields for identities, tax IDs or bank details.

## Tools

| Tool | Use |
| --- | --- |
| `search_homes` | Find indexed Idealista examples live through treg; returns links, search timestamps and unverified filter/location status. |
| `list_catalonia_municipalities` | Search pilot coverage by name, comarca or six-digit Idescat code. |
| `recommend_towns` | Apply hard constraints first, then rank with weighted affordability, school, commute and rural preferences. Read `excluded` for constraint failures or missing evidence. |
| `get_town_profile` | Read municipal and comarca indicators, map coordinates, school access, dated rail evidence and geographically relevant policies. |
| `get_nearby_schools` | Find authorized school stages within the municipality or nearby. Filter by stage, estimated journey time or a scheduled rail option. |
| `get_transport_options` | Find dated, direct FGC services between two pilot municipalities and count departures in a requested window. |
| `get_business_activity` | Read resident Social Security, unemployment and historical retail census indicators. |
| `get_applicable_incentives` | Find geographically applicable housing measures, optionally screen confirmed household facts, and return official links, dates and application status. |
| `check_housing_incentives` | Test a housing intent, qualifying event date, property location and confirmed household facts against the catalogue rules. |

### Demo request

Call `recommend_towns` with these arguments to screen an 85 m² purchase up to €130,000 with rail access to ESO. Here the household has explicitly agreed to use comarca price estimates where needed.

```json
{
  "housing": {
    "tenure": "buy",
    "maxBudgetEur": 130000,
    "homeSizeM2": 85,
    "allowComarcaEstimate": true
  },
  "schoolStages": ["eso"],
  "schoolMode": "rail",
  "maxSchoolJourneyMinutes": 50,
  "travelDate": "2026-11-23",
  "ruralOnly": true
}
```

The committed snapshot returns Térmens, Vallfogona de Balaguer and Vilanova de la Barca. Vallfogona has a published municipal resale price. The other two use their respective comarca prices. Call `get_town_profile` for one of the returned codes, then `get_applicable_incentives` with intent `buy` and any confirmed household facts. Use `check_housing_incentives` to explain exclusions as well.

## Data and refresh

| Snapshot data | Provenance |
| --- | --- |
| Municipal identity and statistics | [Idescat EMEX](https://www.idescat.cat/dev/api/emex/) supplies codes, comarques, population, rent, unemployment and resident Social Security indicators. [Generalitat municipal centres](https://analisi.transparenciacatalunya.cat/d/wpyq-we8x) supplies map points. |
| Rural classification | [Generalitat rural municipality list](https://analisi.transparenciacatalunya.cat/d/7gqm-722r) and its DOGC resolutions. |
| Resale housing prices | [Generalitat registered sales workbooks](https://habitatge.gencat.cat/ca/dades/indicadors_estadistiques/estadistiques_de_construccio_i_mercat_immobiliari/estadistica-de-les-compravendes/compravendes-habitatges-Catalunya/) preserve municipal and comarca prices as separate records. |
| Schools, transit and commerce | [Education directory](https://analisi.transparenciacatalunya.cat/d/kvmv-ahh4), [FGC GTFS](https://www.fgc.cat/google/google_transit.zip), [retail census](https://analisi.transparenciacatalunya.cat/d/2dhj-q3r8). |
| Policy catalogue | [ATC IRPF guidance](https://atc.gencat.cat/ca/tributs/irpf/deduccions-tram-irpf/), [ATC reduced ITP rates](https://atc.gencat.cat/ca/tributs/itpajd/tpo/tarifes-tipus/), [rural municipalities statute](https://www.boe.es/eli/es-ct/l/2025/07/30/8/con) and [2026 grant municipality table](https://agenciahabitatge.gencat.cat/monrural2026). |

```sh
npm run data:refresh
npm run data:validate
```

Refresh downloads the public sources and validates identifiers, metric scopes and rail references before replacing `data/towns.json` atomically. A failed source refresh leaves the previous snapshot available. The annual resale workbook defaults to 2025. Use `SALES_YEAR` for a published annual workbook. The server loads the published fixture at startup. Restart or redeploy after refreshing it. Policy changes are reviewed against the linked official rules and updated in `data/incentives.json` and `packages/places/eligibility.ts`.

The committed FGC RL1/RL2 service calendar covers November 19 through December 31, 2026. Calaf, Juncosa and Ulldemolins have school directory coverage. Their local transport schedules are outside the current feed. School journeys use the official directory’s geographic coordinates and FGC stop times, with estimated walks based on straight-line distance from town centres. Admissions, school transport, precise walking routes, disruptions and round trips require separate checks. Missing price and indicator data are reported explicitly. Resale estimates describe historical averages, and retail figures retain their census year. Grant call status is independent of household eligibility.

## Joined relocation opportunity research

`loadData()` validates `data/relocat-pilot-data.json` and joins its three detailed town records to the official `data/towns.json` snapshot using six-character municipality codes. Duplicate town codes or opportunity IDs, unknown municipalities, name mismatches and malformed evidence fail validation. The export's bundled `publicDataSnapshot` and historical leads never replace runtime statistics or policy rules.

`get_town_profile` and every town in `recommend_towns` return `relocation`:

- `coverage`: `researched` or `not_researched`; missing research is not evidence that no opportunities exist.
- `checkedOn`, `sourcePage`, `asOf`: research provenance and the tool's evaluation date, separate from official metric dates.
- `research`: opportunities, sources, rent and business fees, connection evidence, rental-search limitations, visual links and public contacts; null for unresearched towns.
- `opportunityChecks`: preserved closed/filled/proposed availability, otherwise `needs_verification`, plus unresolved household eligibility, earlier check dates, passed known deadlines and conflicting reported deadlines. Source status is retained in `research`; no live availability is inferred.
- `limitations`: scope and interpretation constraints.

For example, call `get_town_profile` with `{"municipalityCode":"251180"}` to receive Juncosa's official statistics and two researched opportunities together. Call it with `{"municipalityCode":"250024"}` for Àger's official profile with `not_researched` coverage. Research never overrides housing budget filters, school or transit constraints, recommendation scores or incentive eligibility.

## Live Idealista example search through treg

`search_homes` runs an on-demand Google search through treg's `treg.google.serp.organic` route, constrained to Idealista listing URLs. It returns **indexed examples, not verified live inventory**. Search results can be stale or refer to another town; each example therefore keeps `municipalityCode: null`, `locationConfidence: unknown`, `availability: unknown` and `filtersVerified: false`. Price and bedroom criteria are search hints. The tool does not infer structured prices or bedrooms from snippets, and examples must not be used to satisfy hard household constraints without checking the listing.

Set `TREG_TOKEN` to a valid treg API key in the environment of the server process, then restart it. This works with both `npm run start:mcp` and the connected `npm run dev:stack`. The ChatGPT treg connector's OAuth session is separate from the app's credentials. If using a personal sign-in token, also set `TREG_ORG` to the intended team slug. No Idealista API key is required for this web-search route. For Docker, pass the variables with `--env TREG_TOKEN` and, if needed, `--env TREG_ORG`; never bake them into the image. Environment files are not automatically loaded by these scripts.

Example tool input:

```json
{"municipalityCodes":["080312","251180"],"operation":"buy","maxPriceEur":150000,"minBedrooms":2,"limitPerTown":3}
```

At most three town queries run per call, each with a USD 0.01 route ceiling and `Cache-Control: no-cache`. Each successful town response includes up to five deduplicated Idealista property URLs, search titles/snippets, the search timestamp and the charge when reported by treg. Missing access returns `provider_unavailable`; authentication, quota, rate limits and transport/schema failures return `provider_error`; a successful search with no accepted links returns `no_indexed_examples`. None means that no properties exist. A Google query link is returned for manual follow-up in every case.

The server forwards only town names/comarcas and the explicit operation, budget and bedroom hints—not profiles, bank data or household identities. It does not fetch listing pages or relay Idealista's official ChatGPT/Claude app. Those apps do not support manual use by other MCP clients. Sources: [treg integration documentation](https://treg.to/llms.txt), [Idealista app documentation](https://idealista.github.io/mcp-app-docs/openai/).

Validation included a live treg search for Calaf on 21 November 2026 (USD 0.00038), followed by adapter normalization of that actual response. Automated tests use injected provider responses and never spend credits. A live end-to-end call from the local server still requires configuring `TREG_TOKEN`.

## Browser test page

Open `http://127.0.0.1:8787/test` after starting either the standalone MCP server or `npm run dev:stack`. Restart an already-running server after updating the code. The page offers town profiles, family/budget recommendations and Idealista example searches, with readable results, source links and an expandable full MCP response. The header reports whether the server process has `TREG_TOKEN` configured; it does not validate the key until a search runs. Never enter a key in the browser.

The page and its API are restricted to localhost hosts, loopback connections and same-origin requests. Its tool allowlist excludes board/bank writes. It calls the real MCP server through an in-memory MCP client; it does not introduce separate recommendation logic. A live search is triggered only by the search button and uses the server's treg account. This is a local test interface, not a publicly deployed user portal.
