import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  municipalityListResult,
  profileRecommendationResult,
  profileResult,
  recommendationResult,
} from '../../packages/contracts/places.ts';
import { icon } from '../../packages/ui/icons.ts';
import type { ExplorerResult } from './town-explorer-contract.ts';
import { explorerResult } from './town-explorer-contract.ts';
import { mountTownMap } from './town-map.ts';

type Profile = ReturnType<typeof profileResult.parse>;
type Pilot = ReturnType<typeof municipalityListResult.parse>;
type Shortlist = ReturnType<typeof recommendationResult.parse>;
type Assessment = ReturnType<typeof profileRecommendationResult.parse>['profileAssessment'];
type Match = Shortlist['towns'][number];
type Town = Pilot['municipalities'][number];
type CallTool = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
const app = window.parent !== window ? new App({ name: 'ReloCat Town Explorer', version: '1.0.0' }) : null;
const townSelect = document.querySelector<HTMLSelectElement>('#town')!;
const chooser = townSelect.closest('label')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const profileView = document.querySelector<HTMLDivElement>('#profile')!;
const list = document.querySelector<HTMLOListElement>('#town-list')!;
const resultsTitle = document.querySelector<HTMLHeadingElement>('#results-title')!;
const resultCount = document.querySelector<HTMLSpanElement>('#count')!;
const resultsStatus = document.querySelector<HTMLParagraphElement>('#results-status')!;
const retry = document.querySelector<HTMLButtonElement>('#retry-results')!;
const snapshotInfo = document.querySelector<HTMLParagraphElement>('#snapshot')!;
const allButton = document.querySelector<HTMLButtonElement>('#show-all')!;
const resultsButton = document.querySelector<HTMLButtonElement>('#show-results')!;
const euros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const sampleDay = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });
const schoolStages = {
  nursery: 'Nursery',
  infantil: 'Infantil',
  primary: 'Primary',
  eso: 'ESO',
  batxillerat: 'Batxillerat',
  fp: 'Vocational',
};
const transitModes = { train: 'Train', bus: 'Bus', bus_and_train: 'Bus + train' };
const eligibility = {
  eligible: 'Eligible on supplied facts',
  ineligible: 'Ineligible on supplied facts',
  needs_verification: 'Eligibility needs verification',
};
const calls = { open: 'Open', closed: 'Closed', upcoming: 'Upcoming', unknown: 'Unknown' };
const requestOptions = { timeout: 15_000 };
let latestSelection = 0;

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

function sourceLink(url: string, label: string) {
  const source = new URL(url);
  if (source.protocol !== 'https:' && source.protocol !== 'http:') return escapeHtml(label);
  return `<a href="${escapeHtml(source.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function day(date: string) {
  return sampleDay.format(new Date(`${date}T00:00:00Z`));
}

function travelTable(estimates: Profile['travelEstimates']) {
  if (!estimates.length) return "<p class='muted'>No travel estimates in this snapshot.</p>";
  const rows = estimates
    .map(
      ({ destination, car, publicTransport: transit }) => `
    <tr>
      <th scope="row">${escapeHtml(destination)}</th>
      <td>~${car.durationMinutes} min</td>
      <td>${transit ? `~${transit.durationMinutes} min <small>${transitModes[transit.mode]}</small>` : '<small>No sample</small>'}</td>
    </tr>`,
    )
    .join('');
  const sources = estimates
    .map(
      ({ destination, car, publicTransport: transit }) => `
    <li><strong>${escapeHtml(destination)}</strong>
      <small>${sourceLink(car.sourceUrl, 'Road model')} · ${escapeHtml(car.observedAt)}</small>
      ${
        transit
          ? `<small>${day(transit.sampleDate)} · ${escapeHtml(transit.summary)} · ${transit.sourceUrls
              .map((url, index) => sourceLink(url, `Timetable ${index + 1}`))
              .join(' · ')}</small>`
          : ''
      }
    </li>`,
    )
    .join('');
  return `
    <table aria-labelledby="travel-heading">
      <thead><tr><th scope="col">Destination</th><th scope="col">Car</th><th scope="col">Public transport</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <details><summary>Travel sources and sample dates</summary><ul class="items">${sources}</ul></details>`;
}

function renderMatch(match: Match) {
  const { matchReasons, tradeoffs, commute, housingEstimate } = match;
  if (!matchReasons.length && !tradeoffs.length && !commute && !housingEstimate) return '';
  return `<section class="evidence">
    <h3>Shortlist evidence</h3>
    ${
      housingEstimate
        ? `<p>Estimated purchase price ${euros.format(housingEstimate.amountEur)} · ${sourceLink(
            housingEstimate.metric.sourceUrl,
            housingEstimate.metric.geographyName,
          )} ${housingEstimate.metric.geography === 'comarca' ? '(comarca) ' : ''}· ${escapeHtml(housingEstimate.metric.observedAt)}</p>`
        : ''
    }
    ${commute ? `<p>Estimated commute to ${escapeHtml(commute.rail.to.name)} · ${commute.estimatedMinutes} min · ${sourceLink(commute.rail.sourceUrl, 'Rail timetable')}</p>` : ''}
    ${matchReasons.length ? `<ul class="match-list">${matchReasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
    ${tradeoffs.length ? `<p class="muted"><strong>What to check</strong></p><ul class="match-list">${tradeoffs.map(tradeoff => `<li>${escapeHtml(tradeoff)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function renderProfile(profile: Profile, match?: Match) {
  const { municipality, snapshot, nearbySchools, travelEstimates, incentives } = profile;
  const housing =
    profile.metrics.find(metric => metric.kind === 'resale_eur_per_m2') ??
    profile.comarcaMetrics.find(metric => metric.kind === 'resale_eur_per_m2');
  const schools = nearbySchools.schools
    .map(
      ({ school }) =>
        `<li>${sourceLink(school.sourceUrl, school.name)}
      <small>${school.stages.map(stage => schoolStages[stage]).join(' · ')}${
        school.municipalityCode === municipality.code
          ? ' · In town'
          : school.locality
            ? ` · ${escapeHtml(school.locality)}`
            : ' · Nearby town'
      }</small></li>`,
    )
    .join('');
  const measures = incentives
    .map(
      measure => `<li>${sourceLink(measure.sourceUrl, measure.title)}
    <small>Application status · ${calls[measure.callStatus]}</small>
    <small>${eligibility[measure.eligibilityStatus]}</small></li>`,
    )
    .join('');
  profileView.innerHTML = `
    <div class="overview">
      <div>
        <h2>${escapeHtml(municipality.name)}</h2>
        <p>${escapeHtml(municipality.comarca)} · ${sourceLink(municipality.identity.sourceUrl, `Idescat ${municipality.code}`)}</p>
        <p class="muted">Snapshot ${day(snapshot.generatedOn)}</p>
      </div>
      <div class="metric">
        <small>Average resale price</small>
        <strong>${housing ? `${euros.format(housing.value)}/m²` : 'Unavailable'}</strong>
        ${
          housing
            ? `<small>${sourceLink(housing.sourceUrl, housing.geographyName)}${housing.geography === 'comarca' ? ' (comarca)' : ''}
          · ${escapeHtml(housing.observedAt)}</small>`
            : ''
        }
      </div>
    </div>
    ${match ? renderMatch(match) : ''}
    <section class="evidence">
      <h3 id="travel-heading">${icon('train')}Travel times</h3>
      <p class="muted">Approximate times from the town centre. Driving uses a road model. Public transport uses dated timetable samples.</p>
      ${travelTable(travelEstimates)}
    </section>
    <div class="panels">
      <section class="evidence">
        <h3>${icon('school')}Nearby schools</h3>
        <p class="muted">${sourceLink(nearbySchools.directory.sourceUrl, 'Official directory')} · Check admissions with each school.</p>
        ${schools ? `<ul class="items">${schools}</ul>` : "<p class='muted'>No schools listed in this profile.</p>"}
      </section>
      <section class="evidence">
        <h3>${icon('aid')}Housing measures</h3>
        ${measures ? `<ul class="items">${measures}</ul>` : "<p class='muted'>No measures listed in this snapshot.</p>"}
      </section>
    </div>`;
}

async function readTool(call: CallTool, name: string, args: Record<string, unknown>) {
  const result = await call(name, args);
  if (result.isError || !result.structuredContent) throw new Error(`Could not read ${name}`);
  return result.structuredContent;
}

async function browserCall(): Promise<CallTool> {
  const client = new Client({ name: 'relocat-town-explorer-preview', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', window.location.href)), requestOptions);
  return async (name, args) =>
    CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined, requestOptions));
}

async function connect() {
  const preview = !app;
  if (!app) {
    const municipalityCode = new URLSearchParams(window.location.search).get('town');
    const launch: ExplorerResult = municipalityCode
      ? { municipalityCode }
      : {
          municipalityCode: null,
          recommendation: { tool: 'recommend_towns', arguments: { schoolStages: ['eso'], limit: 3 } },
        };
    return { call: await browserCall(), launch, preview };
  }

  const initial = new Promise<ExplorerResult>(resolve => {
    app.ontoolresult = result => {
      const launch = explorerResult.safeParse(result.structuredContent);
      resolve(launch.success ? launch.data : { municipalityCode: null });
    };
  });
  app.onhostcontextchanged = context => {
    if (context.theme) applyDocumentTheme(context.theme);
  };
  await app.connect(undefined, requestOptions);
  const theme = app.getHostContext()?.theme;
  if (theme) applyDocumentTheme(theme);
  document.querySelector('main')!.addEventListener('click', event => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || !app.getHostCapabilities()?.openLinks) return;
    event.preventDefault();
    void app
      .openLink({ url: anchor.href }, requestOptions)
      .then(response => {
        if (response.isError) throw new Error('The host rejected the link');
      })
      .catch(() => {
        status.textContent = 'The host could not open this source link.';
      });
  });
  const call: CallTool = (name, args) => app.callServerTool({ name, arguments: args }, requestOptions);
  let timeout = 0;
  const launch = await Promise.race([
    initial,
    new Promise<never>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error('No Town Explorer launch received')), requestOptions.timeout);
    }),
  ]).finally(() => window.clearTimeout(timeout));
  return { call, launch, preview };
}

function cardHighlight(match?: Match) {
  if (!match) return '';
  const estimate = match.housingEstimate;
  const resale = match.metrics.find(metric => metric.kind === 'resale_eur_per_m2');
  if (estimate)
    return `${euros.format(estimate.amountEur)} estimated · ${estimate.metric.geography === 'comarca' ? 'Comarca' : 'Municipal'} price basis`;
  if (resale)
    return `${euros.format(resale.value)}/m² · ${resale.geography === 'comarca' ? 'Comarca' : 'Municipal'} resale average`;
  return 'Resale price unavailable in this shortlist';
}

function cardAccess(match?: Match) {
  if (!match) return '';
  if (match.commute) return `Rail commute · about ${match.commute.estimatedMinutes} min`;
  const school = match.schools.find(journey => journey.mode !== 'unknown' && journey.estimatedMinutes !== null);
  if (!school) return match.matchReasons[0] ?? '';
  const mode = school.mode === 'scheduled_rail_with_estimated_walk' ? 'rail and walk' : 'walk';
  return `School access · about ${school.estimatedMinutes} min by ${mode}`;
}

async function start() {
  const map = mountTownMap(code => {
    void selectTown(code, true);
  });
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
    townSelect.value = active ?? '';
    map.select(active);
    for (const card of list.querySelectorAll('button')) {
      const selected = card.dataset.code === active;
      card.setAttribute('aria-pressed', String(selected));
      if (selected && revealCard) {
        const cardBounds = card.getBoundingClientRect();
        const listBounds = list.getBoundingClientRect();
        if (cardBounds.top < listBounds.top) list.scrollTop += cardBounds.top - listBounds.top;
        else if (cardBounds.bottom > listBounds.bottom) list.scrollTop += cardBounds.bottom - listBounds.bottom;
      }
    }
    profileView.replaceChildren();
    status.textContent = town ? `Loading ${town.name}…` : '';
    if (!town) return;

    const match = showShortlist ? shortlist?.towns.find(item => item.municipality.code === code) : undefined;
    try {
      const profile = profileResult.parse(
        await readTool(call, 'get_town_profile', {
          municipalityCode: code,
          ...(match && shortlist ? { travelDate: shortlist.travelDate } : {}),
        }),
      );
      if (selection !== latestSelection) return;
      renderProfile(profile, match);
      status.textContent = '';
    } catch {
      if (selection !== latestSelection) return;
      status.textContent = `Could not load ${town.name}. Select its card or map pin to retry.`;
    }
  }

  async function renderView(results: boolean, preferred = active) {
    const view = ++latestSelection;
    showShortlist = results;
    towns = [];
    active = null;
    chooser.hidden = true;
    list.replaceChildren();
    snapshotInfo.textContent = '';
    profileView.replaceChildren();
    status.textContent = '';
    map.setTowns([], results);
    resultCount.textContent = '';
    resultsTitle.textContent = results ? (preview ? 'Sample shortlist' : 'Town results') : 'Pilot towns';
    resultsButton.closest('.views')!.toggleAttribute('hidden', !recommendation);
    resultsButton.setAttribute('aria-pressed', String(results));
    allButton.setAttribute('aria-pressed', String(!results));
    retry.hidden = true;
    resultsStatus.classList.remove('hint');
    resultsStatus.textContent = results ? 'Loading town results…' : 'Loading pilot towns…';

    try {
      if (results && recommendation && !shortlist) {
        const response = await readTool(call, recommendation.tool, recommendation.arguments);
        if (recommendation.tool === 'recommend_towns_for_profile') {
          const parsed = profileRecommendationResult.parse(response);
          shortlist = parsed;
          assessment = parsed.profileAssessment;
        } else {
          shortlist = recommendationResult.parse(response);
        }
      } else if (!results && !pilot) {
        pilot = municipalityListResult.parse(await readTool(call, 'list_catalonia_municipalities', {}));
        pilot.municipalities.sort((a, b) => a.name.localeCompare(b.name, 'ca'));
      }
    } catch {
      if (view !== latestSelection) return;
      resultsStatus.textContent = results ? 'Could not load the town results.' : 'Could not load the pilot towns.';
      retry.hidden = false;
      retry.onclick = () => {
        void renderView(results, preferred);
      };
      return;
    }
    if (view !== latestSelection) return;

    const matches = results ? (shortlist?.towns ?? []) : [];
    towns = results ? matches.map(match => match.municipality) : (pilot?.municipalities ?? []);
    if (assessment?.status === 'exploratory' && results) resultsTitle.textContent = 'Towns to explore';
    const snapshot = results ? shortlist?.snapshot : pilot?.snapshot;
    if (snapshot) snapshotInfo.textContent = `Data snapshot · ${day(snapshot.generatedOn)}`;
    if (!towns.length) {
      resultsStatus.textContent = results
        ? 'No towns met these requirements in the pilot data.'
        : 'This snapshot has no municipalities to browse.';
      return;
    }

    resultCount.textContent = `${towns.length} ${towns.length === 1 ? 'town' : 'towns'}`;
    resultsStatus.textContent = preview && results ? 'Sample search for towns with access to ESO schools.' : '';
    if (results && assessment?.status === 'exploratory' && assessment.followUps.length) {
      resultsStatus.textContent = assessment.followUps[0];
    }
    resultsStatus.classList.add('hint');
    townSelect.options.length = 1;
    for (const town of towns) townSelect.add(new Option(town.name, town.code));
    townSelect.disabled = false;
    chooser.hidden = results;
    const ranked = results && assessment?.status !== 'exploratory';
    list.innerHTML = towns
      .map((town, index) => {
        const highlight = cardHighlight(matches[index]);
        const access = cardAccess(matches[index]);
        return `<li><button class="town-card" type="button" data-code="${town.code}" aria-pressed="false">
        <span class="rank" aria-hidden="true">${ranked ? index + 1 : ''}</span>
        <span><strong>${escapeHtml(town.name)}</strong><small class="region">${escapeHtml(town.comarca)}</small>
          ${highlight ? `<small class="highlight">${escapeHtml(highlight)}</small>` : ''}
          ${access ? `<small class="access">${escapeHtml(access)}</small>` : ''}</span>
        <span class="card-arrow" aria-hidden="true"></span>
      </button></li>`;
      })
      .join('');
    map.setTowns(towns, results, ranked);
    if (preferred && towns.some(town => town.code === preferred)) void selectTown(preferred, true);
    else if (results) void selectTown(towns[0].code);
    else if (preferred) status.textContent = 'That town is outside the pilot snapshot. Choose one of the towns shown.';
  }

  list.addEventListener('click', event => {
    const card = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-code]') : null;
    if (card?.dataset.code) void selectTown(card.dataset.code);
  });
  townSelect.addEventListener('change', () => {
    void selectTown(townSelect.value, true);
  });
  resultsButton.addEventListener('click', () => {
    if (!showShortlist) void renderView(true);
  });
  allButton.addEventListener('click', () => {
    if (showShortlist) void renderView(false);
  });
  await renderView(showShortlist, launch.municipalityCode);
}

void start().catch(() => {
  resultsStatus.textContent = 'Could not connect to the town data. Reopen the Town Explorer to retry.';
});
