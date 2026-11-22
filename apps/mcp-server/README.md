# relocat places MCP

The relocat backend compares Catalan municipalities for a household considering a move. Its TypeScript MCP server screens housing budgets and school or rail access, returns sourced municipal profiles, and checks a small catalogue of housing incentives from a local snapshot. The pilot covers 17 candidates, including Calaf, Juncosa, Ulldemolins and towns along the FGC Lleida–La Pobla de Segur corridor. Lleida serves as a transport destination.

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
npm start
curl http://127.0.0.1:8787/health
```

The Streamable HTTP endpoint is `http://127.0.0.1:8787/mcp`. In MCP Inspector, select **Streamable HTTP** and enter that URL. Run `npm test` to exercise initialization, tool discovery and every tool through the official client. Run `npm run typecheck` and `npm run data:validate` to check the code and snapshot.

For hosting, use `npm start` with `HOST=0.0.0.0` and the platform’s `PORT`, or build the included image with `docker build -t relocat-mcp .` and run it with `docker run --rm -p why 127.0.0.1:8787:8787 relocat-mcp`. The service speaks HTTP behind the host’s TLS proxy. Connect ChatGPT to the resulting HTTPS `/mcp` URL or use Secure MCP Tunnel. Requests from browser origins are rejected unless their exact origin is listed in `ALLOWED_ORIGINS` as a comma-separated value. [OpenAI’s connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)

The tools are read-only. The application processes supplied household criteria in memory for the duration of the call. The schema takes age, tax-base amounts and qualifying facts. It has no fields for identities, tax IDs or bank details.

## Town Explorer sample plugin

Town Explorer is a read-only MCP App on the same `/mcp` endpoint. `show_town_explorer` opens a map of Catalonia with cards for a recommendation or the pilot directory. Selecting a pin or card loads sourced housing indicators, sample driving and public transport times, schools, and housing measures through the MCP Apps host bridge. It runs with no profile API, bank data, or OpenAI API key. [OpenAI’s MCP Apps UI guide](https://developers.openai.com/plugins/build/chatgpt-ui)

After either recommendation tool, pass its name and exact arguments to `show_town_explorer`. The widget reruns that read-only query against the same snapshot, preserving filters, result order, and the travel date. For example, if the original call was `recommend_towns` with `{"schoolStages":["eso"],"limit":3}`, pass:

```json
{
  "recommendation": {
    "tool": "recommend_towns",
    "arguments": { "schoolStages": ["eso"], "limit": 3 }
  }
}
```

The map uses the pilot’s sourced town centres and simplified ICGC provincial boundaries (20 January 2026, 1:1,000,000). The illustration and boundaries are bundled with the widget. [ICGC boundary data](https://www.icgc.cat/en/Geoinformation-and-Maps/Data-and-products/Cartographic-geoinformation/Administrative-boundaries) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

### Preview in a browser

```sh
npm ci
ALLOWED_ORIGINS=http://127.0.0.1:8787 npm start
```

Open [the preview](http://127.0.0.1:8787/preview) to try a sample ESO shortlist, or [start on Calaf](http://127.0.0.1:8787/preview?town=080312). Pick any visible card or pin to fetch its profile from the running MCP. Use the same host and port in the preview URL and the origin allowlist. If port 8787 is occupied, set `PORT` and update both URLs.

### Try in ChatGPT

1. Run the municipality server and make its `/mcp` endpoint available over HTTPS or with a supported private tunnel. Keep bank connection variables unset for this sample.
2. In [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add custom MCP server**, enter your `https://…/mcp` URL, and name the personal plugin **ReloCat Town Explorer**. Choose **No authentication** for the public-data sample. Install or refresh the connection. [Official setup guide](https://developers.openai.com/plugins/quickstart)
3. In a new ChatGPT Work conversation, select the plugin and ask “Open ReloCat Town Explorer for Calaf. Show me the travel estimates to Barcelona and Girona.” Switch to Camarasa in the widget to see how a town with driving estimates and no transit samples appears.

## Tools

| Tool | Use |
| --- | --- |
| `search_homes` | Find indexed Idealista examples live through treg; returns links, search timestamps and unverified filter/location status. |
| `list_catalonia_municipalities` | Search pilot coverage by name, comarca or six-digit Idescat code. |
| `recommend_towns` | Apply hard constraints first, then rank with weighted affordability, school, commute and rural preferences. Read `excluded` for constraint failures or missing evidence. |
| `recommend_towns_for_profile` | Shortlist towns from household and lifestyle facts. Returns ranked or exploratory towns and what to verify. |
| `get_town_profile` | Read municipal and comarca indicators, map coordinates, school access, dated rail evidence, sample travel estimates and geographically relevant policies. |
| `show_town_explorer` | Open the Town Explorer map and cards with a recommendation query or a preselected six-digit municipality code. |
| `get_nearby_schools` | Find authorized school stages within the municipality or nearby. Filter by stage, estimated journey time or a scheduled rail option. |
| `get_transport_options` | Find dated, direct FGC services between two pilot municipalities and count departures in a requested window. |
| `get_business_activity` | Read resident Social Security, unemployment and historical retail census indicators. |
| `get_applicable_incentives` | Find geographically applicable housing measures, optionally screen confirmed household facts, and return official links, dates and application status. |
| `check_housing_incentives` | Test a housing intent, qualifying event date, property location and confirmed household facts against the catalogue rules. |

### Recommend towns from a household profile

Call `recommend_towns_for_profile` with a household profile and an optional result limit. This example ranks suitable towns by school access and the stated rural preference.

```json
{
  "profile": {
    "householdType": "family",
    "hasChildren": true,
    "schoolStages": ["eso"],
    "hasDog": true,
    "workMode": "remote",
    "preferredSetting": "rural"
  },
  "limit": 3
}
```

Use `householdType` values `single`, `couple`, `family` or `shared`, and `workMode` values `remote`, `hybrid` or `on_site`. Omit facts that are unknown. With children and no required stages, the tool ranks by the range of stages in the in-town school directory. An explicit `larger_town` preference uses published population. Remote work prompts address-level broadband verification, and a dog prompts property-level pet checks. Results marked `exploratory` give starting points and a follow-up question.

Use `recommend_towns` for a housing budget, a maximum school journey or a timed commute. The profile shortlist reports skipped criteria in `profileAssessment.ignoredCriteria` when older clients still supply them.

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

### Quick travel comparisons

`get_town_profile` returns `travelEstimates` for all 18 mapped municipalities. The endpoints are Lleida-Pirineus and its bus station, Barcelona Sants, Barcelona Airport T1 and T2, Girona railway station, and Girona-Costa Brava Airport.

Car estimates use an OpenStreetMap-based road model from the town centre, rounded to five minutes. Traffic and parking can change the time. [FOSSGIS OSRM service and OpenStreetMap attribution](https://routing.openstreetmap.de/about.html)

Public transport estimates use published journeys from November 23, 2026. The rounded time includes sampled transfer waits and starts at the first station or bus stop. Each result includes the mode, sample count and sources. The T1 estimate adds an allowance for walking and the published shuttle from T2. A null value means this snapshot lacks a verified sample for that destination and mode. Treat the estimates as comparisons and use a current timetable to plan a specific journey. [Aena terminal shuttle](https://www.aena.es/en/josep-tarradellas-barcelona-el-prat/airport-services/free-transport-between-terminals.html)

The samples live in `data/travel-estimates.json`. Town snapshot refreshes run independently of the travel samples.

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

Set `TREG_TOKEN` to a valid treg API key in the environment of the server process, then restart it. This works with both `npm start` and the connected `npm run dev`. The ChatGPT treg connector's OAuth session is separate from the app's credentials. If using a personal sign-in token, also set `TREG_ORG` to the intended team slug. No Idealista API key is required for this web-search route. For Docker, pass the variables with `--env TREG_TOKEN` and, if needed, `--env TREG_ORG`; never bake them into the image. Environment files are not automatically loaded by these scripts.

Example tool input:

```json
{"municipalityCodes":["080312","251180"],"operation":"buy","maxPriceEur":150000,"minBedrooms":2,"limitPerTown":3}
```

At most three town queries run per call, each with a USD 0.01 route ceiling and `Cache-Control: no-cache`. Each successful town response includes up to five deduplicated Idealista property URLs, search titles/snippets, the search timestamp and the charge when reported by treg. Missing access returns `provider_unavailable`; authentication, quota, rate limits and transport/schema failures return `provider_error`; a successful search with no accepted links returns `no_indexed_examples`. None means that no properties exist. A Google query link is returned for manual follow-up in every case.

The server forwards only town names/comarcas and the explicit operation, budget and bedroom hints—not profiles, bank data or household identities. It does not fetch listing pages or relay Idealista's official ChatGPT/Claude app. Those apps do not support manual use by other MCP clients. Sources: [treg integration documentation](https://treg.to/llms.txt), [Idealista app documentation](https://idealista.github.io/mcp-app-docs/openai/).

Validation included a live treg search for Calaf on 21 November 2026 (USD 0.00038), followed by adapter normalization of that actual response. Automated tests use injected provider responses and never spend credits. A live end-to-end call from the local server still requires configuring `TREG_TOKEN`.

## Browser test page

Open `http://127.0.0.1:8787/test` after starting either the standalone MCP server or `npm run dev`. Restart an already-running server after updating the code. The page offers town profiles, family/budget recommendations and Idealista example searches, with readable results, source links and an expandable full MCP response. The header reports whether the server process has `TREG_TOKEN` configured; it does not validate the key until a search runs. Never enter a key in the browser.

The page and its API are restricted to localhost hosts, loopback connections and same-origin requests. Its tool allowlist excludes board/bank writes. It calls the real MCP server through an in-memory MCP client; it does not introduce separate recommendation logic. A live search is triggered only by the search button and uses the server's treg account. This is a local test interface, not a publicly deployed user portal.

## Connect an agent

Open `/connect` on the connected demo or standalone MCP server for the ReloCat agent setup guide. It includes ChatGPT, Claude, Hermes, OpenClaw, Codex, Cursor, Gemini CLI and a generic Streamable HTTP path; Meta Muse is explicitly marked unverified. The page provides editable endpoint configuration, copyable examples and links to official client documentation. Localhost is for clients on the same machine; cloud clients need an operator-provided HTTPS endpoint or supported tunnel. This page does not deploy the server or add authentication. Brand logos load from Brandfetch and official provider sites.
