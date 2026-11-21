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

For hosting, use `npm run start:mcp` with `HOST=0.0.0.0` and the platform’s `PORT`, or build the included image with `docker build -t relocat-mcp .` and run it with `docker run --rm -p why 127.0.0.1:8787:8787 relocat-mcp`. The service speaks HTTP behind the host’s TLS proxy. Connect ChatGPT to the resulting HTTPS `/mcp` URL or use Secure MCP Tunnel. Requests from browser origins are rejected unless their exact origin is listed in `ALLOWED_ORIGINS` as a comma-separated value. [OpenAI’s connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)

The tools are read-only. The application processes supplied household criteria in memory for the duration of the call. The schema takes age, tax-base amounts and qualifying facts. It has no fields for identities, tax IDs or bank details.

## Town Explorer sample plugin

Town Explorer is a read-only MCP App on the same `/mcp` endpoint. `show_town_explorer` opens the widget, optionally on a specified town. The iframe calls `list_catalonia_municipalities` and `get_town_profile` through the standard MCP Apps host bridge. It shows the 18 mapped municipalities with sourced resale indicators, sample driving and public transport times, schools, and housing measures. It runs with no profile API, bank data, or OpenAI API key. [OpenAI’s MCP Apps UI guide](https://developers.openai.com/plugins/build/chatgpt-ui)

### Preview in a browser

```sh
npm ci
ALLOWED_ORIGINS=http://127.0.0.1:8787 npm run start:mcp
```

Open [the preview on Calaf](http://127.0.0.1:8787/preview?town=080312). Pick another town to fetch its profile from the running MCP. Use the same host and port in the preview URL and the origin allowlist. If port 8787 is occupied, set `PORT` and update both URLs.

### Try in ChatGPT

1. Run the municipality server and make its `/mcp` endpoint available over HTTPS or with a supported private tunnel. Keep bank connection variables unset for this sample.
2. In [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add custom MCP server**, enter your `https://…/mcp` URL, and name the personal plugin **Relocat Town Explorer**. Choose **No authentication** for the public-data sample. Install or refresh the connection. [Official setup guide](https://developers.openai.com/plugins/quickstart)
3. In a new ChatGPT Work conversation, select the plugin and ask “Open Relocat Town Explorer for Calaf. Show me the travel estimates to Barcelona and Girona.” Switch to Camarasa in the widget to see how a town with driving estimates and no transit samples appears.

## Tools

| Tool | Use |
| --- | --- |
| `list_catalonia_municipalities` | Search pilot coverage by name, comarca or six-digit Idescat code. |
| `recommend_towns` | Apply hard constraints first, then rank with weighted affordability, school, commute and rural preferences. Read `excluded` for constraint failures or missing evidence. |
| `recommend_towns_for_profile` | Shortlist towns from household and lifestyle facts. Returns ranked or exploratory towns and what to verify. |
| `get_town_profile` | Read municipal and comarca indicators, map coordinates, school access, dated rail evidence, sample travel estimates and geographically relevant policies. |
| `show_town_explorer` | Open the Town Explorer widget, optionally preselected to a six-digit municipality code. |
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
