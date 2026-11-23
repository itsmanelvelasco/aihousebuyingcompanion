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
import { browserLocale } from '../../packages/i18n/browser.ts';
import { createFormat } from '../../packages/i18n/format.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { type MessageValues, translator } from '../../packages/i18n/messages.ts';
import { icon } from '../../packages/ui/icons.ts';
import { type ExplorerKey, explorer } from './town-explorer.messages.ts';
import type { ExplorerResult } from './town-explorer-contract.ts';
import { explorerResult } from './town-explorer-contract.ts';
import { mountTownMap } from './town-map.ts';
import { applyMessages, mountLanguages, readLocalizedTool } from './widget-i18n.ts';

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
const schoolStages = {
  nursery: 'stageNursery',
  infantil: 'stageInfantil',
  primary: 'stagePrimary',
  eso: 'stageEso',
  batxillerat: 'stageBatxillerat',
  fp: 'stageFp',
} as const;
const transitModes = { train: 'modeTrain', bus: 'modeBus', bus_and_train: 'modeBusAndTrain' } as const;
const eligibility = {
  eligible: 'eligible',
  ineligible: 'ineligible',
  needs_verification: 'needsVerification',
} as const;
const calls = { open: 'callOpen', closed: 'callClosed', upcoming: 'callUpcoming', unknown: 'callUnknown' } as const;
/** The tools that answer in the language of their `locale` argument. */
const localizedTools = new Set(['recommend_towns', 'recommend_towns_for_profile', 'get_town_profile']);
const requestOptions = { timeout: 15_000 };
let latestSelection = 0;

// ------------------------------------------------------------------ language
// The language is decided here, in the browser: what the address or an earlier choice says, then
// the chat host, then the browser. Text a tool returns is asked for in that language and shown as
// received.
let locale: Locale = browserLocale();
let t = translator(explorer, locale);
let format = createFormat(locale);
/** Set once the person picks a language here: the host's language no longer replaces it. */
let languageChosen = false;
/** Reloads what is on screen after the language changed; set once the widget is connected. */
let reload = () => {};

/** Status lines written through `say` are rewritten when the language changes. */
const said = new Map<HTMLElement, () => string>();
function say(element: HTMLElement, text: (() => string) | string = '') {
  if (typeof text === 'string') said.delete(element);
  else said.set(element, text);
  element.textContent = typeof text === 'string' ? text : text();
}

const map = mountTownMap(
  code => selectFromMap(code),
  () => ({ t, format }),
);
let selectFromMap = (_code: string) => {};

const markLanguage = mountLanguages(document.querySelector<HTMLElement>('#languages')!, next => {
  languageChosen = true;
  setLocale(next);
});

function setLocale(next: Locale, force = false) {
  const changed = next !== locale;
  if (!changed && !force) return;
  locale = next;
  t = translator(explorer, next);
  format = createFormat(next);
  document.documentElement.lang = next;
  document.title = t('title');
  applyMessages(document, t);
  markLanguage(next);
  map.relabel();
  for (const [element, text] of said) element.textContent = text();
  if (changed) reload();
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

/** A message as HTML text. Use plain `t` only for the messages that take a link as a value. */
const text = (key: ExplorerKey, values?: MessageValues) => escapeHtml(t(key, values));
/** A price in whole euros; the tools state euros, the formatter takes cents. */
const euros = (amount: number) => format.euros(Math.round(amount * 100));

function sourceLink(url: string, label: string) {
  const source = new URL(url);
  if (source.protocol !== 'https:' && source.protocol !== 'http:') return escapeHtml(label);
  return `<a href="${escapeHtml(source.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function travelTable(estimates: Profile['travelEstimates']) {
  if (!estimates.length) return `<p class='muted'>${text('noTravel')}</p>`;
  const rows = estimates
    .map(
      ({ destination, car, publicTransport: transit }) => `
    <tr>
      <th scope="row">${escapeHtml(destination)}</th>
      <td>${text('aboutMinutes', { minutes: car.durationMinutes })}</td>
      <td>${
        transit
          ? `${text('aboutMinutes', { minutes: transit.durationMinutes })} <small>${text(transitModes[transit.mode])}</small>`
          : `<small>${text('noSample')}</small>`
      }</td>
    </tr>`,
    )
    .join('');
  const sources = estimates
    .map(
      ({ destination, car, publicTransport: transit }) => `
    <li><strong>${escapeHtml(destination)}</strong>
      <small>${sourceLink(car.sourceUrl, t('roadModel'))} · ${escapeHtml(car.observedAt)}</small>
      ${
        transit
          ? `<small>${escapeHtml(format.date(transit.sampleDate))} · ${escapeHtml(transit.summary)} · ${transit.sourceUrls
              .map((url, index) => sourceLink(url, t('timetable', { number: index + 1 })))
              .join(' · ')}</small>`
          : ''
      }
    </li>`,
    )
    .join('');
  return `
    <table aria-labelledby="travel-heading">
      <thead><tr><th scope="col">${text('destination')}</th><th scope="col">${text('car')}</th><th scope="col">${text('publicTransport')}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <details><summary>${text('travelSources')}</summary><ul class="items">${sources}</ul></details>`;
}

function renderMatch(match: Match) {
  const { matchReasons, tradeoffs, commute, housingEstimate } = match;
  if (!matchReasons.length && !tradeoffs.length && !commute && !housingEstimate) return '';
  return `<section class="evidence">
    <h3>${text('shortlistEvidence')}</h3>
    ${
      housingEstimate
        ? `<p>${t(housingEstimate.metric.geography === 'comarca' ? 'purchaseEstimateComarca' : 'purchaseEstimate', {
            amount: escapeHtml(euros(housingEstimate.amountEur)),
            source: sourceLink(housingEstimate.metric.sourceUrl, housingEstimate.metric.geographyName),
            observed: escapeHtml(housingEstimate.metric.observedAt),
          })}</p>`
        : ''
    }
    ${
      commute
        ? `<p>${t('commuteEstimate', {
            destination: escapeHtml(commute.rail.to.name),
            minutes: commute.estimatedMinutes,
            source: sourceLink(commute.rail.sourceUrl, t('railTimetable')),
          })}</p>`
        : ''
    }
    ${matchReasons.length ? `<ul class="match-list">${matchReasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
    ${tradeoffs.length ? `<p class="muted"><strong>${text('whatToCheck')}</strong></p><ul class="match-list">${tradeoffs.map(tradeoff => `<li>${escapeHtml(tradeoff)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function renderProfile(profile: Profile, match?: Match) {
  const { municipality, snapshot, nearbySchools, travelEstimates, incentives } = profile;
  const housing =
    profile.metrics.find(metric => metric.kind === 'resale_eur_per_m2') ??
    profile.comarcaMetrics.find(metric => metric.kind === 'resale_eur_per_m2');
  const schools = nearbySchools.schools
    .map(({ school }) => {
      const where =
        school.municipalityCode === municipality.code
          ? text('inTown')
          : school.locality
            ? escapeHtml(school.locality)
            : text('nearbyTown');
      return `<li>${sourceLink(school.sourceUrl, school.name)}
      <small>${[...school.stages.map(stage => text(schoolStages[stage])), where].join(' · ')}</small></li>`;
    })
    .join('');
  const measures = incentives
    .map(
      measure => `<li>${sourceLink(measure.sourceUrl, measure.title)}
    <small>${text('applicationStatus', { status: t(calls[measure.callStatus]) })}</small>
    <small>${text(eligibility[measure.eligibilityStatus])}</small></li>`,
    )
    .join('');
  const housingSource = housing ? sourceLink(housing.sourceUrl, housing.geographyName) : '';
  profileView.innerHTML = `
    <div class="overview">
      <div>
        <h2>${escapeHtml(municipality.name)}</h2>
        <p>${escapeHtml(municipality.comarca)} · ${sourceLink(municipality.identity.sourceUrl, `Idescat ${municipality.code}`)}</p>
        <p class="muted">${text('snapshotDate', { date: format.date(snapshot.generatedOn) })}</p>
      </div>
      <div class="metric">
        <small>${text('averageResale')}</small>
        <strong>${housing ? text('perSquareMetre', { amount: euros(housing.value) }) : text('unavailable')}</strong>
        ${
          housing
            ? `<small>${housing.geography === 'comarca' ? t('comarcaSource', { source: housingSource }) : housingSource}
          · ${escapeHtml(housing.observedAt)}</small>`
            : ''
        }
      </div>
    </div>
    ${match ? renderMatch(match) : ''}
    <section class="evidence">
      <h3 id="travel-heading">${icon('train')}${text('travelTimes')}</h3>
      <p class="muted">${text('travelNote')}</p>
      ${travelTable(travelEstimates)}
    </section>
    <div class="panels">
      <section class="evidence">
        <h3>${icon('school')}${text('nearbySchools')}</h3>
        <p class="muted">${t('schoolsNote', { directory: sourceLink(nearbySchools.directory.sourceUrl, t('officialDirectory')) })}</p>
        ${schools ? `<ul class="items">${schools}</ul>` : `<p class='muted'>${text('noSchools')}</p>`}
      </section>
      <section class="evidence">
        <h3>${icon('aid')}${text('housingMeasures')}</h3>
        ${measures ? `<ul class="items">${measures}</ul>` : `<p class='muted'>${text('noMeasures')}</p>`}
      </section>
    </div>`;
}

function readTool(call: CallTool, name: string, args: Record<string, unknown>) {
  return readLocalizedTool(call, name, args, localizedTools.has(name) ? locale : null);
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
    if (context.locale && !languageChosen) setLocale(browserLocale(context.locale));
  };
  await app.connect(undefined, requestOptions);
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (!languageChosen) setLocale(browserLocale(context?.locale));
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
        say(status, () => t('linkFailed'));
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
    return t(estimate.metric.geography === 'comarca' ? 'highlightEstimateComarca' : 'highlightEstimateMunicipal', {
      amount: euros(estimate.amountEur),
    });
  if (resale)
    return t(resale.geography === 'comarca' ? 'highlightResaleComarca' : 'highlightResaleMunicipal', {
      amount: euros(resale.value),
    });
  return t('highlightUnavailable');
}

function cardAccess(match?: Match) {
  if (!match) return '';
  if (match.commute) return t('accessRail', { minutes: match.commute.estimatedMinutes });
  const school = match.schools.find(journey => journey.mode !== 'unknown' && journey.estimatedMinutes !== null);
  if (!school) return match.matchReasons[0] ?? '';
  return t(school.mode === 'scheduled_rail_with_estimated_walk' ? 'accessSchoolRail' : 'accessSchoolWalk', {
    minutes: school.estimatedMinutes ?? format.unknown,
  });
}

async function start() {
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
    say(status, town ? () => t('loadingTown', { town: town.name }) : '');
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
      say(status);
    } catch {
      if (selection !== latestSelection) return;
      say(status, () => t('townFailed', { town: town.name }));
    }
  }
  selectFromMap = code => {
    void selectTown(code, true);
  };

  async function renderView(results: boolean, preferred = active) {
    const view = ++latestSelection;
    showShortlist = results;
    towns = [];
    active = null;
    chooser.hidden = true;
    list.replaceChildren();
    say(snapshotInfo);
    profileView.replaceChildren();
    say(status);
    map.setTowns([], results);
    say(resultCount);
    say(resultsTitle, () => t(results ? (preview ? 'sampleShortlist' : 'townResults') : 'pilotTowns'));
    resultsButton.closest('.views')!.toggleAttribute('hidden', !recommendation);
    resultsButton.setAttribute('aria-pressed', String(results));
    allButton.setAttribute('aria-pressed', String(!results));
    retry.hidden = true;
    resultsStatus.classList.remove('hint');
    say(resultsStatus, () => t(results ? 'loadingResults' : 'loadingPilot'));

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
      say(resultsStatus, () => t(results ? 'resultsFailed' : 'pilotFailed'));
      retry.hidden = false;
      retry.onclick = () => {
        void renderView(results, preferred);
      };
      return;
    }
    if (view !== latestSelection) return;

    const matches = results ? (shortlist?.towns ?? []) : [];
    towns = results ? matches.map(match => match.municipality) : (pilot?.municipalities ?? []);
    if (assessment?.status === 'exploratory' && results) say(resultsTitle, () => t('townsToExplore'));
    const snapshot = results ? shortlist?.snapshot : pilot?.snapshot;
    if (snapshot) say(snapshotInfo, () => t('dataSnapshot', { date: format.date(snapshot.generatedOn) }));
    if (!towns.length) {
      say(resultsStatus, () => t(results ? 'noMatches' : 'noMunicipalities'));
      return;
    }

    const count = towns.length;
    say(resultCount, () => t('countTowns', { count }));
    say(resultsStatus, preview && results ? () => t('sampleSearch') : '');
    if (results && assessment?.status === 'exploratory' && assessment.followUps.length) {
      // A question the tool wrote, in the language it was asked for.
      say(resultsStatus, assessment.followUps[0]);
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
    else if (preferred) say(status, () => t('outsidePilot'));
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
  // A new language: the shortlist carries text the tool wrote, so it is asked for again.
  reload = () => {
    shortlist = undefined;
    assessment = undefined;
    void renderView(showShortlist, active);
  };
  await renderView(showShortlist, launch.municipalityCode);
}

say(resultsTitle, () => t('exploreCatalonia'));
say(resultsStatus, () => t('loadingTowns'));
setLocale(locale, true);
void start().catch(() => {
  say(resultsStatus, () => t('connectFailed'));
});
