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
| `list_catalonia_municipalities` | Search pilot coverage by name, comarca or six-digit Idescat code. |
| `recommend_towns` | Apply hard constraints first, then rank with weighted affordability, school, commute and rural preferences. Read `excluded` for constraint failures or missing evidence. |
| `get_town_profile` | Read municipal and comarca indicators, map coordinates, school access, dated rail evidence, sample travel estimates and geographically relevant policies. |
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
