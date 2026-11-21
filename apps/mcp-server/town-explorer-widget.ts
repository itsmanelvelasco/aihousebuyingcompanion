import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { municipalityListResult, profileResult } from "../../packages/contracts/places.ts";

type Profile = ReturnType<typeof profileResult.parse>;
type CallTool = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
const app = window.parent !== window ? new App({ name: "Relocat Town Explorer", version: "1.0.0" }) : null;
const townSelect = document.querySelector<HTMLSelectElement>("#town")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const profileView = document.querySelector<HTMLDivElement>("#profile")!;
const euros = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const sampleDay = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const schoolStages = { nursery: "Nursery", infantil: "Infantil", primary: "Primary", eso: "ESO", batxillerat: "Batxillerat", fp: "Vocational" };
const transitModes = { train: "Train", bus: "Bus", bus_and_train: "Bus + train" };
const eligibility = { eligible: "Eligible on supplied facts", ineligible: "Ineligible on supplied facts", needs_verification: "Eligibility needs verification" };
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

function travelTable(estimates: Profile["travelEstimates"]) {
  if (!estimates.length) return "<p class='muted'>No travel estimates in this snapshot.</p>";
  const rows = estimates.map(({ destination, car, publicTransport: transit }) => `
    <tr>
      <th scope="row">${escapeHtml(destination)}</th>
      <td>~${car.durationMinutes} min</td>
      <td>${transit ? `~${transit.durationMinutes} min <small>${transitModes[transit.mode]}</small>` : "<small>No sample</small>"}</td>
    </tr>`).join("");
  const sources = estimates.map(({ destination, car, publicTransport: transit }) => `
    <li><strong>${escapeHtml(destination)}</strong>
      <small>${sourceLink(car.sourceUrl, "Road model")} · ${escapeHtml(car.observedAt)}</small>
      ${transit ? `<small>${day(transit.sampleDate)} · ${escapeHtml(transit.summary)} · ${transit.sourceUrls.map((url, index) =>
        sourceLink(url, `Timetable ${index + 1}`)).join(" · ")}</small>` : ""}
    </li>`).join("");
  return `
    <table aria-labelledby="travel-heading">
      <thead><tr><th scope="col">Destination</th><th scope="col">Car</th><th scope="col">Public transport</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <details><summary>Travel sources and sample dates</summary><ul class="items">${sources}</ul></details>`;
}

function renderProfile(profile: Profile) {
  const { municipality, snapshot, nearbySchools, travelEstimates, incentives } = profile;
  const housing = profile.metrics.find(metric => metric.kind === "resale_eur_per_m2")
    ?? profile.comarcaMetrics.find(metric => metric.kind === "resale_eur_per_m2");
  const schools = nearbySchools.schools.map(({ school }) =>
    `<li>${sourceLink(school.sourceUrl, school.name)}
      <small>${school.stages.map(stage => schoolStages[stage]).join(" · ")}${school.municipalityCode === municipality.code
        ? " · In town" : school.locality ? ` · ${escapeHtml(school.locality)}` : " · Nearby town"}</small></li>`).join("");
  const measures = incentives.map(measure => `<li>${sourceLink(measure.sourceUrl, measure.title)}
    <small>Call ${measure.callStatus} · ${eligibility[measure.eligibilityStatus]}</small></li>`).join("");
  profileView.innerHTML = `
    <div class="overview">
      <div>
        <h2>${escapeHtml(municipality.name)}</h2>
        <p>${escapeHtml(municipality.comarca)} · ${sourceLink(municipality.identity.sourceUrl, `Idescat ${municipality.code}`)}</p>
        <p class="muted">Snapshot ${day(snapshot.generatedOn)}</p>
      </div>
      <div class="metric">
        <small>Average resale price</small>
        <strong>${housing ? `${euros.format(housing.value)}/m²` : "Unavailable"}</strong>
        ${housing ? `<small>${sourceLink(housing.sourceUrl, housing.geographyName)}${housing.geography === "comarca" ? " (comarca)" : ""}
          · ${escapeHtml(housing.observedAt)}</small>` : ""}
      </div>
    </div>
    <section>
      <h3 id="travel-heading">Travel times</h3>
      <p class="muted">Approximate times from the town centre. Driving uses a road model. Public transport uses dated timetable samples.</p>
      ${travelTable(travelEstimates)}
    </section>
    <div class="panels">
      <section>
        <h3>Nearby schools</h3>
        <p class="muted">${sourceLink(nearbySchools.directory.sourceUrl, "Official directory")} · Check admissions with each school.</p>
        ${schools ? `<ul class="items">${schools}</ul>` : "<p class='muted'>No schools listed in this profile.</p>"}
      </section>
      <section>
        <h3>Housing measures</h3>
        ${measures ? `<ul class="items">${measures}</ul>` : "<p class='muted'>No measures listed in this snapshot.</p>"}
      </section>
    </div>`;
}

async function readTool(call: CallTool, name: string, args: Record<string, unknown>) {
  const result = await call(name, args);
  if (result.isError || !result.structuredContent) throw new Error(`Could not read ${name}`);
  return result.structuredContent;
}

async function selectTown(call: CallTool) {
  const code = townSelect.value;
  const selection = ++latestSelection;
  profileView.replaceChildren();
  if (!code) {
    status.textContent = "Choose a town to view its profile.";
    return;
  }
  const town = townSelect.selectedOptions[0].text;
  status.textContent = `Loading ${town}…`;
  try {
    const profile = profileResult.parse(await readTool(call, "get_town_profile", { municipalityCode: code }));
    if (selection !== latestSelection) return;
    renderProfile(profile);
    status.textContent = "";
  } catch {
    if (selection !== latestSelection) return;
    townSelect.value = "";
    status.textContent = `Could not load ${town}. Choose the town again to retry.`;
  }
}

async function browserCall(): Promise<CallTool> {
  const client = new Client({ name: "relocat-town-explorer-preview", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", window.location.href)), requestOptions);
  return async (name, args) => CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }, undefined, requestOptions),
  );
}

async function start() {
  let call: CallTool;
  let initialTown: Promise<unknown>;
  if (app) {
    initialTown = new Promise(resolve => {
      app.ontoolresult = result => resolve(result.structuredContent?.municipalityCode);
    });
    app.onhostcontextchanged = context => { if (context.theme) applyDocumentTheme(context.theme); };
    await app.connect(undefined, requestOptions);
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
    call = (name, args) => app.callServerTool({ name, arguments: args }, requestOptions);
    profileView.addEventListener("click", event => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a") : null;
      if (!anchor || !app.getHostCapabilities()?.openLinks) return;
      event.preventDefault();
      void app.openLink({ url: anchor.href }, requestOptions).then(result => {
        if (result.isError) throw new Error("The host rejected the link");
      }).catch(() => {
        status.textContent = "The host could not open this source link.";
      });
    });
  } else {
    call = await browserCall();
    initialTown = Promise.resolve(new URLSearchParams(window.location.search).get("town"));
  }

  const { municipalities } = municipalityListResult.parse(await readTool(call, "list_catalonia_municipalities", {}));
  if (!municipalities.length) {
    status.textContent = "There are no municipalities in this snapshot.";
    return;
  }
  const towns = municipalities.slice().sort((a, b) => a.name.localeCompare(b.name, "ca"));
  for (const town of towns) townSelect.add(new Option(town.name, town.code));
  townSelect.disabled = false;
  status.textContent = "Choose a town to view its profile.";
  townSelect.addEventListener("change", () => { void selectTown(call); });
  void initialTown.then(code => {
    if (latestSelection || typeof code !== "string" || !towns.some(town => town.code === code)) return;
    townSelect.value = code;
    return selectTown(call);
  });
}

void start().catch(() => {
  status.textContent = "Could not load the municipality list. Reopen the Town Explorer to retry.";
});
