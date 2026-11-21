import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { homeSearchResult } from "../../packages/contracts/listings.ts";
import type { HomeSearchInput } from "../../packages/contracts/listings.ts";
import { getCheckedListings } from "../../packages/listings/checked.ts";
import { homeSearchLinks } from "../../packages/listings/links.ts";
import { municipalityListResult, profileRecommendationResult, profileResult, recommendationResult } from "../../packages/contracts/places.ts";
import { explorerResult } from "./town-explorer-contract.ts";
import type { ExplorerResult } from "./town-explorer-contract.ts";
import { mountTownMap } from "./town-map.ts";
import { catalanDestinations, catalanMatchEvidence, catalanMeasures } from "./town-explorer-copy.ts";
import landscapeUrl from "./assets/town-explorer.jpg";

type Profile = ReturnType<typeof profileResult.parse>;
type Pilot = ReturnType<typeof municipalityListResult.parse>;
type Shortlist = ReturnType<typeof recommendationResult.parse>;
type Assessment = ReturnType<typeof profileRecommendationResult.parse>["profileAssessment"];
type Match = Shortlist["towns"][number];
type Town = Pilot["municipalities"][number];
type Comparison = NonNullable<Pilot["comparison"]>[string];
type CallTool = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
const app = window.parent !== window ? new App({ name: "Relocat Town Explorer", version: "1.0.0" }) : null;
const townSelect = document.querySelector<HTMLSelectElement>("#town")!;
const chooser = townSelect.closest("label")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const profileView = document.querySelector<HTMLDivElement>("#profile")!;
const list = document.querySelector<HTMLOListElement>("#town-list")!;
const resultsTitle = document.querySelector<HTMLHeadingElement>("#results-title")!;
const resultCount = document.querySelector<HTMLSpanElement>("#count")!;
const resultsStatus = document.querySelector<HTMLParagraphElement>("#results-status")!;
const retry = document.querySelector<HTMLButtonElement>("#retry-results")!;
const snapshotInfo = document.querySelector<HTMLParagraphElement>("#snapshot")!;
const comparisonNote = document.querySelector<HTMLParagraphElement>("#comparison-note")!;
const allButton = document.querySelector<HTMLButtonElement>("#show-all")!;
const resultsButton = document.querySelector<HTMLButtonElement>("#show-results")!;
document.querySelector<HTMLElement>(".hero-art")!.style.backgroundImage = `url("${landscapeUrl}")`;
const catalan = document.documentElement.lang === "ca";
const t = (ca: string, en: string) => catalan ? ca : en;
const euros = new Intl.NumberFormat(t("ca-ES", "en-IE"), { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const sampleDay = new Intl.DateTimeFormat(t("ca-ES", "en"), { dateStyle: "medium", timeZone: "UTC" });
const searchTime = new Intl.DateTimeFormat(t("ca-ES", "en"), { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Madrid" });
const schoolStages = { nursery: t("Escola bressol", "Nursery"), infantil: "Infantil", primary: t("Primària", "Primary"), eso: "ESO", batxillerat: "Batxillerat", fp: t("Formació professional", "Vocational") };
const transitModes = { train: t("Tren", "Train"), bus: t("Autobús", "Bus"), bus_and_train: t("Autobús i tren", "Bus + train") };
const eligibility = {
  eligible: t("Compleix els requisits segons les dades facilitades", "Eligible on supplied facts"),
  ineligible: t("No compleix els requisits segons les dades facilitades", "Ineligible on supplied facts"),
  needs_verification: t("Cal comprovar els requisits", "Eligibility needs verification"),
};
const calls = { open: t("Oberta", "Open"), closed: t("Tancada", "Closed"), upcoming: t("Propera", "Upcoming"), unknown: t("Desconeguda", "Unknown") };
const taxStatus = {
  active: t("Mesura fiscal vigent", "Active tax measure"), ended: t("Mesura fiscal finalitzada", "Tax measure ended"),
  upcoming: t("Propera mesura fiscal", "Upcoming tax measure"), needs_verification: t("Cal comprovar les dates de la mesura fiscal", "Check tax measure dates"),
};
const requestOptions = { timeout: 15_000 };
let latestSelection = 0;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function sourceLink(url: string, label: string) {
  const source = new URL(url);
  if (source.protocol !== "https:" && source.protocol !== "http:") return escapeHtml(label);
  return `<a href="${escapeHtml(source.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function day(date: string) {
  return sampleDay.format(new Date(`${date}T00:00:00Z`));
}

function evidenceText(value: string) {
  if (!catalan) return escapeHtml(value);
  return catalanMatchEvidence[value] ? escapeHtml(catalanMatchEvidence[value]) : `<span lang="en">${escapeHtml(value)}</span>`;
}

function travelTable(estimates: Profile["travelEstimates"]) {
  if (!estimates.length) return `<p class="muted">${t("No hi ha estimacions de trajecte en aquestes dades.", "No travel estimates in this snapshot.")}</p>`;
  const rows = estimates.map(({ destinationId, destination, car, publicTransport: transit }) => `
    <tr>
      <th scope="row">${escapeHtml(t(catalanDestinations[destinationId], destination))}</th>
      <td>~${car.durationMinutes} min</td>
      <td>${transit ? `~${transit.durationMinutes} min <small>${transitModes[transit.mode]}</small>` : `<small>${t("Sense mostra", "No sample")}</small>`}</td>
    </tr>`).join("");
  const sources = estimates.map(({ destinationId, destination, car, publicTransport: transit }) => `
    <li><strong>${escapeHtml(t(catalanDestinations[destinationId], destination))}</strong>
      <small>${sourceLink(car.sourceUrl, t("Model viari", "Road model"))} · ${escapeHtml(car.observedAt)}</small>
      ${transit ? `<small>${day(transit.sampleDate)} · ${catalan ? `${transit.sampleCount} ${transit.sampleCount === 1 ? "trajecte consultat" : "trajectes consultats"}` : escapeHtml(transit.summary)} · ${transit.sourceUrls.map((url, index) =>
        sourceLink(url, `${t("Horari", "Timetable")} ${index + 1}`)).join(" · ")}</small>` : ""}
    </li>`).join("");
  return `
    <table aria-labelledby="travel-heading">
      <thead><tr><th scope="col">${t("Destinació", "Destination")}</th><th scope="col">${t("Cotxe", "Car")}</th><th scope="col">${t("Transport públic", "Public transport")}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <details><summary>${t("Fonts i dates dels trajectes", "Travel sources and sample dates")}</summary><ul class="items">${sources}</ul></details>`;
}

function renderMatch(match: Match) {
  const { matchReasons, tradeoffs, commute, housingEstimate } = match;
  if (!matchReasons.length && !tradeoffs.length && !commute && !housingEstimate) return "";
  return `<section class="evidence">
    <h3>${t("Per què encaixa", "Shortlist evidence")}</h3>
    ${match.score === null ? "" : `<p><strong>${match.score}/100</strong> ${t("punts d’encaix", "match score")}</p>`}
    ${housingEstimate ? `<p>${t("Preu de compra estimat", "Estimated purchase price")} ${euros.format(housingEstimate.amountEur)} · ${sourceLink(housingEstimate.metric.sourceUrl,
      housingEstimate.metric.geographyName)} ${housingEstimate.metric.geography === "comarca" ? "(comarca) " : ""}· ${escapeHtml(housingEstimate.metric.observedAt)}</p>` : ""}
    ${commute ? `<p>${t("Trajecte estimat a", "Estimated commute to")} ${escapeHtml(commute.rail.to.name)} · ${commute.estimatedMinutes} min · ${sourceLink(commute.rail.sourceUrl, t("Horari de tren", "Rail timetable"))}</p>` : ""}
    ${matchReasons.length ? `<ul class="match-list">${matchReasons.map(reason => `<li>${evidenceText(reason)}</li>`).join("")}</ul>` : ""}
    ${tradeoffs.length ? `<p class="muted"><strong>${t("Què cal comprovar", "What to check")}</strong></p><ul class="match-list">${tradeoffs.map(tradeoff => `<li>${evidenceText(tradeoff)}</li>`).join("")}</ul>` : ""}
  </section>`;
}

function listingCards(cards: string[]) {
  return cards.length ? `<ul class="listing-cards">${cards.join("")}</ul>` : "";
}

function renderProfile(profile: Profile, listingInput: HomeSearchInput, match?: Match) {
  const { municipality, snapshot, nearbySchools, travelEstimates, incentives } = profile;
  const { idealistaSearchUrl, searchUrl } = homeSearchLinks(municipality, listingInput);
  const buy = listingInput.operation === "buy";
  const priceKind = buy ? "resale_eur_per_m2" : "rent_eur_per_month";
  const housing = profile.metrics.find(metric => metric.kind === priceKind)
    ?? profile.comarcaMetrics.find(metric => metric.kind === priceKind);
  const checkedListings = getCheckedListings(municipality.code, listingInput);
  const cards = checkedListings.map(example => `<li class="listing-card">
    <strong class="listing-price">${euros.format(example.askingPriceEur)}</strong>
    ${sourceLink(example.url, t(example.titleCa, example.title))}
    <p class="listing-facts">${example.bedrooms} ${example.bedrooms === 1 ? t("habitació", "bedroom") : t("habitacions", "bedrooms")} · ${example.areaM2} m²</p>
    <small>Idealista · ${t("Consultat el", "Checked")} ${day(example.checkedOn)}</small>
  </li>`);
  const schools = nearbySchools.schools.map(({ school }) =>
    `<li>${sourceLink(school.sourceUrl, school.name)}
      <small>${school.stages.map(stage => schoolStages[stage]).join(" · ")}${school.municipalityCode === municipality.code
        ? t(" · Al municipi", " · In town") : school.locality ? ` · ${escapeHtml(school.locality)}` : t(" · Municipi proper", " · Nearby town")}</small></li>`).join("");
  const measures = incentives.map(measure => `<li>${sourceLink(measure.sourceUrl, t(catalanMeasures[measure.id] ?? measure.title, measure.title))}
    <small>${measure.mechanism === "grant" ? `${t("Convocatòria", "Grant call")} · ${calls[measure.callStatus]}` : taxStatus[measure.measureStatus]}
      ${measure.geographicStatus === "needs_verification" ? t(" · Comprova quin nucli hi està inclòs", " · Check covered locality") : ""}</small>
    <small>${eligibility[measure.eligibilityStatus]}</small></li>`).join("");
  profileView.innerHTML = `
    <div class="overview">
      <div>
        <h2>${escapeHtml(municipality.name)}</h2>
        <p>${escapeHtml(municipality.comarca)} · ${sourceLink(municipality.identity.sourceUrl, `Idescat ${municipality.code}`)}</p>
        <p class="muted">${t("Dades del", "Snapshot")} ${day(snapshot.generatedOn)}</p>
      </div>
      <div class="metric">
        <small>${buy ? t("Preu mitjà de segona mà", "Resale average") : t("Lloguer mitjà", "Rent average")}</small>
        <strong>${housing ? `${euros.format(housing.value)}${buy ? "/m²" : t("/mes", "/mo")}` : t("Sense dades", "Unavailable")}</strong>
        ${housing ? `<small>${sourceLink(housing.sourceUrl, housing.geographyName)}${housing.geography === "comarca" ? " (comarca)" : ""}
          · ${escapeHtml(housing.observedAt)}</small>` : ""}
      </div>
    </div>
    ${match ? renderMatch(match) : ""}
    <section class="evidence property-examples" aria-labelledby="listings-heading">
      <div class="listing-heading">
        <h3 id="listings-heading">${buy ? t("Habitatges en venda", "Homes for sale") : t("Habitatges de lloguer", "Homes to rent")}</h3>
        <div class="listing-links">
          ${idealistaSearchUrl ? sourceLink(idealistaSearchUrl, t("Consulta Idealista", "Browse Idealista")) : ""}
          ${sourceLink(searchUrl, t("Cerca anuncis d’Idealista a Google", "Search Google for Idealista listings"))}
        </div>
      </div>
      ${listingCards(cards)}
      <p class="muted listing-note">${cards.length
        ? t("Comprova el preu actual i la disponibilitat a Idealista.", "Check current prices and availability on Idealista.")
        : t("No tenim exemples datats per a aquesta cerca. Obre els enllaços per consultar els anuncis.", "No dated examples for this search. Open the search links to browse listings.")}</p>
      <button class="retry" id="find-homes" type="button">${t("Cerca anuncis indexats", "Find indexed examples")}</button>
      <p id="listing-status" class="muted" role="status"></p>
      <div id="listing-results"></div>
    </section>
    <div class="panels">
      <section class="evidence">
        <h3>${t("Mesures d’habitatge", "Housing measures")}</h3>
        ${measures ? `<ul class="items">${measures}</ul>` : `<p class="muted">${t("El catàleg no recull mesures per a aquest municipi.", "No measures listed in this snapshot.")}</p>`}
      </section>
      <section class="evidence">
        <h3>${t("Centres educatius propers", "Nearby schools")}</h3>
        <p class="muted">${sourceLink(nearbySchools.directory.sourceUrl, t("Directori oficial", "Official directory"))} · ${t("Comprova l’admissió amb cada centre.", "Check admissions with each school.")}</p>
        ${schools ? `<ul class="items">${schools}</ul>` : `<p class="muted">${t("A la fitxa no hi consta cap centre educatiu.", "No schools listed in this profile.")}</p>`}
      </section>
    </div>
    <section class="evidence">
      <h3 id="travel-heading">${t("Temps de trajecte", "Travel times")}</h3>
      <p class="muted">${t("Temps aproximats des del centre del municipi. Els temps en cotxe provenen d’un model viari i els de transport públic, d’horaris consultats en dates concretes.", "Approximate times from the town centre. Driving uses a road model. Public transport uses dated timetable samples.")}</p>
      ${travelTable(travelEstimates)}
    </section>`;
}

function wireListingSearch(call: CallTool, input: HomeSearchInput) {
  const button = profileView.querySelector<HTMLButtonElement>("#find-homes")!;
  const feedback = profileView.querySelector<HTMLParagraphElement>("#listing-status")!;
  const results = profileView.querySelector<HTMLDivElement>("#listing-results")!;
  button.onclick = async () => {
    button.disabled = true;
    feedback.textContent = t("Cercant anuncis indexats…", "Searching for indexed examples…");
    results.replaceChildren();
    try {
      const response = homeSearchResult.parse(await readTool(call, "search_homes", input));
      const search = response.searches.find(item => item.municipalityCode === input.municipalityCodes[0]);
      if (!search) throw new Error("Missing search results for this town");
      const checkedIds = new Set(search.checkedExamples.map(example => example.listingId));
      const indexed = search.examples.filter(example => !checkedIds.has(example.listingId));
      const count = indexed.length;
      const states = {
        ok: count ? `${count} ${count === 1 ? t("altre anunci indexat", "more indexed example") : t("altres anuncis indexats", "more indexed examples")} · ${t("cerca del", "searched")} ${searchTime.format(new Date(response.searchedAt))}`
          : t("No s’han trobat més anuncis indexats.", "No additional indexed examples found."),
        no_indexed_examples: t("La cerca no ha trobat anuncis indexats per a aquest municipi.", "The search found no indexed examples for this town."),
        provider_unavailable: t("Aquest servidor no té disponibles els anuncis indexats.", "Indexed examples are unavailable on this server."),
        provider_error: t("El proveïdor no ha pogut carregar els anuncis indexats.", "The provider could not load indexed examples."),
      };
      feedback.textContent = states[search.status];
      results.innerHTML = listingCards(indexed.map(example => `<li class="listing-card">
        ${sourceLink(example.url, example.title)}
        <small>${t("Idealista · Anunci indexat", "Idealista · Indexed example")}</small>
        <small>${t("Cal comprovar el lloc, el preu i la disponibilitat", "Location, price and availability need checking")}</small>
      </li>`));
    } catch {
      feedback.textContent = t("No s’han pogut carregar els anuncis. Torna-ho a provar.", "Could not load listing examples. Try again.");
    } finally {
      button.disabled = false;
    }
  };
}

async function readTool(call: CallTool, name: string, args: Record<string, unknown>) {
  const result = await call(name, args);
  if (result.isError || !result.structuredContent) throw new Error(`Could not read ${name}`);
  return result.structuredContent;
}

async function browserCall(): Promise<CallTool> {
  const client = new Client({ name: "relocat-town-explorer-preview", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", window.location.href)), requestOptions);
  return async (name, args) => CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }, undefined, requestOptions),
  );
}

async function connect() {
  const preview = !app;
  if (!app) {
    const previewUrl = new URL(window.location.href);
    const municipalityCode = previewUrl.searchParams.get("town");
    if (catalan) previewUrl.searchParams.set("lang", "en");
    else previewUrl.searchParams.delete("lang");
    document.querySelector<HTMLAnchorElement>("#preview-language")!.href = previewUrl.href;
    document.querySelector<HTMLElement>("#preview-nav")!.hidden = false;
    const launch: ExplorerResult = municipalityCode ? { municipalityCode } : {
      municipalityCode: null,
      recommendation: { tool: "recommend_towns", arguments: { schoolStages: ["eso"], limit: 3 } },
    };
    return { call: await browserCall(), launch, preview };
  }

  const initial = new Promise<ExplorerResult>(resolve => {
    app.ontoolresult = result => {
      const launch = explorerResult.safeParse(result.structuredContent);
      resolve(launch.success ? launch.data : { municipalityCode: null });
    };
  });
  app.onhostcontextchanged = context => { if (context.theme) applyDocumentTheme(context.theme); };
  await app.connect(undefined, requestOptions);
  const theme = app.getHostContext()?.theme;
  if (theme) applyDocumentTheme(theme);
  document.querySelector("main")!.addEventListener("click", event => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor || !app.getHostCapabilities()?.openLinks) return;
    event.preventDefault();
    void app.openLink({ url: anchor.href }, requestOptions).then(response => {
      if (response.isError) throw new Error("The host rejected the link");
    }).catch(() => {
      status.textContent = t("No s’ha pogut obrir l’enllaç a la font.", "The host could not open this source link.");
    });
  });
  const call: CallTool = (name, args) => app.callServerTool({ name, arguments: args }, requestOptions);
  let timeout = 0;
  const launch = await Promise.race([initial, new Promise<never>((_, reject) => {
    timeout = window.setTimeout(() => reject(new Error("No Town Explorer launch received")), requestOptions.timeout);
  })]).finally(() => window.clearTimeout(timeout));
  return { call, launch, preview };
}

function cardFacts(comparison: Comparison | undefined, operation: HomeSearchInput["operation"]) {
  if (!comparison) return "";
  const buy = operation === "buy";
  const price = buy ? comparison.resale : comparison.rent;
  const priceLabel = buy ? t("Segona mà", "Resale avg.") : t("Lloguer mitjà", "Rent avg.");
  const verifyLocation = comparison.activeHousingMeasures === 0 && comparison.housingMeasuresToVerify > 0;
  return `<span class="town-facts">
    <span><b>${price ? `${euros.format(price.value)}${buy ? "/m²" : t("/mes", "/mo")}` : t("Sense dades", "No data")}</b><small>${priceLabel}</small></span>
    <span><b>${verifyLocation ? comparison.housingMeasuresToVerify : comparison.activeHousingMeasures}</b>
      <small>${verifyLocation ? t("Mesures per comprovar", "Measures to verify") : t("Mesures d’habitatge", "Housing measures")}</small></span>
    <span><b>${comparison.localSchools}</b><small>${t("Centres al municipi", "Listed schools")}</small></span>
  </span>`;
}

function cardAccess(match?: Match) {
  if (!match) return "";
  if (match.commute) return t(`En tren · uns ${match.commute.estimatedMinutes} min`, `Rail commute · about ${match.commute.estimatedMinutes} min`);
  const school = match.schools.find(journey => journey.mode !== "unknown" && journey.estimatedMinutes !== null);
  if (!school) return "";
  const rail = school.mode === "scheduled_rail_with_estimated_walk";
  return t(`A l’escola · uns ${school.estimatedMinutes} min ${rail ? "en tren i a peu" : "a peu"}`,
    `School access · about ${school.estimatedMinutes} min by ${rail ? "rail and walk" : "walk"}`);
}

async function start() {
  const map = mountTownMap(code => { void selectTown(code, true); });
  const { call, launch, preview } = await connect();
  const recommendation = launch.recommendation;
  let showShortlist = Boolean(recommendation);
  let shortlist: Shortlist | undefined;
  let assessment: Assessment | undefined;
  let pilot: Pilot | undefined;
  let towns: Town[] = [];
  let active: string | null = null;

  async function selectTown(code: string, revealCard = false) {
    const town = towns.find(candidate => candidate.code === code);
    const selection = ++latestSelection;
    active = town?.code ?? null;
    townSelect.value = active ?? "";
    map.select(active);
    for (const card of list.querySelectorAll("button")) {
      const selected = card.dataset.code === active;
      card.setAttribute("aria-pressed", String(selected));
      if (selected && revealCard) {
        const cardBounds = card.getBoundingClientRect();
        const listBounds = list.getBoundingClientRect();
        if (cardBounds.top < listBounds.top) list.scrollTop += cardBounds.top - listBounds.top;
        else if (cardBounds.bottom > listBounds.bottom) list.scrollTop += cardBounds.bottom - listBounds.bottom;
      }
    }
    profileView.replaceChildren();
    status.textContent = town ? t(`Carregant la fitxa de ${town.name}…`, `Loading ${town.name}…`) : "";
    if (!town) return;

    const match = showShortlist ? shortlist?.towns.find(item => item.municipality.code === code) : undefined;
    try {
      const profile = profileResult.parse(await readTool(call, "get_town_profile", {
        municipalityCode: code,
        ...(match && shortlist ? { travelDate: shortlist.travelDate } : {}),
      }));
      if (selection !== latestSelection) return;
      const housing = match && recommendation?.tool === "recommend_towns" ? recommendation.arguments.housing : undefined;
      const listingInput: HomeSearchInput = {
        municipalityCodes: [code], operation: housing?.tenure ?? "buy", limitPerTown: 3,
        ...(housing ? { maxPriceEur: housing.maxBudgetEur } : {}),
      };
      renderProfile(profile, listingInput, match);
      wireListingSearch(call, listingInput);
      status.textContent = "";
    } catch {
      if (selection !== latestSelection) return;
      status.textContent = t(`No s’ha pogut carregar la fitxa de ${town.name}. Torna a seleccionar el municipi.`,
        `Could not load ${town.name}. Select its card or map pin to retry.`);
    }
  }

  async function renderView(results: boolean, preferred = active) {
    const view = ++latestSelection;
    showShortlist = results;
    towns = [];
    active = null;
    chooser.hidden = true;
    list.replaceChildren();
    snapshotInfo.textContent = "";
    comparisonNote.hidden = true;
    profileView.replaceChildren();
    status.textContent = "";
    map.setTowns([], results);
    resultCount.textContent = "";
    resultsTitle.textContent = results ? (preview ? t("Selecció d’exemple", "Sample shortlist") : t("Municipis recomanats", "Town results")) : t("Municipis de la prova pilot", "Pilot towns");
    resultsButton.closest(".views")!.toggleAttribute("hidden", !recommendation);
    resultsButton.setAttribute("aria-pressed", String(results));
    allButton.setAttribute("aria-pressed", String(!results));
    retry.hidden = true;
    resultsStatus.classList.remove("hint");
    resultsStatus.textContent = results ? t("Carregant les recomanacions…", "Loading town results…") : t("Carregant els municipis…", "Loading pilot towns…");

    try {
      if (results && recommendation && !shortlist) {
        const response = await readTool(call, recommendation.tool, recommendation.arguments);
        if (recommendation.tool === "recommend_towns_for_profile") {
          const parsed = profileRecommendationResult.parse(response);
          shortlist = parsed;
          assessment = parsed.profileAssessment;
        } else {
          shortlist = recommendationResult.parse(response);
        }
      } else if (!results && !pilot) {
        pilot = municipalityListResult.parse(await readTool(call, "list_catalonia_municipalities", {}));
        pilot.municipalities.sort((a, b) => a.name.localeCompare(b.name, "ca"));
      }
    } catch {
      if (view !== latestSelection) return;
      resultsStatus.textContent = results ? t("No s’han pogut carregar les recomanacions.", "Could not load the town results.") : t("No s’han pogut carregar els municipis de la prova pilot.", "Could not load the pilot towns.");
      retry.hidden = false;
      retry.onclick = () => { void renderView(results, preferred); };
      return;
    }
    if (view !== latestSelection) return;

    const matches = results ? shortlist?.towns ?? [] : [];
    towns = results ? matches.map(match => match.municipality) : pilot?.municipalities ?? [];
    if (assessment?.status === "exploratory" && results) resultsTitle.textContent = t("Municipis per explorar", "Towns to explore");
    const snapshot = results ? shortlist?.snapshot : pilot?.snapshot;
    const comparison = results ? shortlist?.comparison : pilot?.comparison;
    const operation = results && recommendation?.tool === "recommend_towns" ? recommendation.arguments.housing?.tenure ?? "buy" : "buy";
    if (snapshot) snapshotInfo.textContent = `${t("Dades del", "Data snapshot")} · ${day(snapshot.generatedOn)}`;
    comparisonNote.hidden = !comparison;
    if (!towns.length) {
      resultsStatus.textContent = results ? t("Amb les dades disponibles, cap municipi de la prova pilot compleix aquests requisits.", "No towns met these requirements in the pilot data.") : t("No hi ha municipis per consultar en aquestes dades.", "This snapshot has no municipalities to browse.");
      return;
    }

    resultCount.textContent = `${towns.length} ${towns.length === 1 ? t("municipi", "town") : t("municipis", "towns")}`;
    resultsStatus.textContent = preview && results ? t("Cerca d’exemple de municipis amb accés a centres d’ESO.", "Sample search for towns with access to ESO schools.") : "";
    if (results && assessment?.status === "exploratory" && assessment.followUps.length) {
      resultsStatus.textContent = assessment.followUps[0];
    }
    resultsStatus.classList.add("hint");
    townSelect.options.length = 1;
    for (const town of towns) townSelect.add(new Option(town.name, town.code));
    townSelect.disabled = false;
    chooser.hidden = results;
    const ranked = results && assessment?.status !== "exploratory";
    list.innerHTML = towns.map((town, index) => {
      const access = cardAccess(matches[index]);
      return `<li><button class="town-card" type="button" data-code="${town.code}" aria-pressed="false">
        <span class="town-card-header">
          ${ranked ? `<span class="rank" aria-hidden="true">${index + 1}</span>` : ""}
          <span><strong>${escapeHtml(town.name)}</strong><small class="region">${escapeHtml(town.comarca)}</small></span>
          <span class="card-arrow" aria-hidden="true"></span>
        </span>
        ${cardFacts(comparison?.[town.code], operation)}
        ${access ? `<small class="access">${escapeHtml(access)}</small>` : ""}
      </button></li>`;
    }).join("");
    map.setTowns(towns, results, ranked);
    if (preferred && towns.some(town => town.code === preferred)) void selectTown(preferred, true);
    else if (results) void selectTown(towns[0].code);
    else if (preferred) status.textContent = t("Aquest municipi queda fora de la prova pilot. Tria’n un dels que es mostren.", "That town is outside the pilot snapshot. Choose one of the towns shown.");
  }

  list.addEventListener("click", event => {
    const card = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-code]") : null;
    if (card?.dataset.code) void selectTown(card.dataset.code);
  });
  townSelect.addEventListener("change", () => { void selectTown(townSelect.value, true); });
  resultsButton.addEventListener("click", () => { if (!showShortlist) void renderView(true); });
  allButton.addEventListener("click", () => { if (showShortlist) void renderView(false); });
  await renderView(showShortlist, launch.municipalityCode);
}

void start().catch(() => {
  resultsStatus.textContent = t("No s’ha pogut connectar amb les dades dels municipis. Recarrega el mapa per tornar-ho a provar.", "Could not connect to the town data. Reopen the Town Explorer to retry.");
});
