/**
 * Illustrations drawn in SVG, in the palette of theme.css. They are the fallback for every image
 * slot of `images.manifest.ts`: a slot shows the generated raster when it exists and one of these
 * otherwise, so nothing is blank before `npm run images:generate` has run.
 * Pure strings with no imports.
 */
const sky = '#fbefdc';
const sun = '#f6c95c';
const hillFar = '#d9cfe9';
const hillMid = '#b9d6b0';
const hillNear = '#8fc39a';
const field = '#f3dc9a';
const forest = '#2f8f63';
const deep = '#17593d';
const violet = '#663e91';
const terracotta = '#d98a5f';
const wall = '#fff6e6';
const ink = '#143326';
/** The product typeface first; an SVG shown as an image cannot load it, so system fonts follow. */
const fontStack = 'Montserrat,ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif';

const svg = (width: number, height: number, body: string, label?: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice" ${
    label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'
  }>${body}</svg>`;

/** A small house: walls, a pitched roof, a door and a window. `x`,`y` is the bottom-left corner. */
function house(x: number, y: number, w: number, h: number, roof: string, tall = false) {
  const top = y - h;
  const peak = top - w * (tall ? 0.62 : 0.42);
  return (
    `<path d="M${x} ${y}V${top}h${w}V${y}Z" fill="${wall}"/>` +
    `<path d="M${x - w * 0.1} ${top}L${x + w / 2} ${peak}L${x + w * 1.1} ${top}Z" fill="${roof}"/>` +
    `<rect x="${x + w * 0.38}" y="${y - h * 0.5}" width="${w * 0.24}" height="${h * 0.5}" rx="${w * 0.05}" fill="${violet}" opacity=".75"/>` +
    `<rect x="${x + w * 0.12}" y="${top + h * 0.18}" width="${w * 0.18}" height="${h * 0.22}" rx="2" fill="${sun}"/>`
  );
}

const cypress = (x: number, y: number, s: number) =>
  `<path d="M${x} ${y}c${-9 * s} ${-18 * s} ${-7 * s} ${-52 * s} 0 ${-70 * s}c${7 * s} ${18 * s} ${9 * s} ${52 * s} 0 ${70 * s}Z" fill="${deep}"/>`;

const tree = (x: number, y: number, s: number) =>
  `<rect x="${x - 2 * s}" y="${y - 16 * s}" width="${4 * s}" height="${16 * s}" fill="#7a5a48"/><circle cx="${x}" cy="${y - 26 * s}" r="${15 * s}" fill="${forest}"/>`;

/** The valley town: cream sky, a low sun, three ranges of hills, a village and a winding path. */
function valley(width: number, height: number) {
  const w = width;
  const h = height;
  const p = (fx: number, fy: number) => `${Math.round(fx * w)} ${Math.round(fy * h)}`;
  const town = [
    house(w * 0.52, h * 0.6, w * 0.05, h * 0.075, terracotta),
    house(w * 0.575, h * 0.585, w * 0.042, h * 0.07, violet),
    house(w * 0.622, h * 0.6, w * 0.05, h * 0.07, terracotta),
    // The church tower, taller than the rest.
    house(w * 0.672, h * 0.59, w * 0.03, h * 0.16, violet, true),
    house(w * 0.705, h * 0.605, w * 0.055, h * 0.075, terracotta),
    house(w * 0.765, h * 0.62, w * 0.045, h * 0.065, violet),
    house(w * 0.56, h * 0.665, w * 0.055, h * 0.07, violet),
    house(w * 0.63, h * 0.675, w * 0.06, h * 0.075, terracotta),
    house(w * 0.71, h * 0.68, w * 0.05, h * 0.065, terracotta),
  ].join('');
  const scale = w / 1600;
  return (
    `<rect width="${w}" height="${h}" fill="${sky}"/>` +
    `<circle cx="${w * 0.8}" cy="${h * 0.2}" r="${h * 0.19}" fill="${sun}" opacity=".28"/>` +
    `<circle cx="${w * 0.8}" cy="${h * 0.2}" r="${h * 0.105}" fill="${sun}"/>` +
    `<path d="M0 ${h * 0.5}C${p(0.14, 0.3)} ${p(0.26, 0.3)} ${p(0.38, 0.44)}S${p(0.62, 0.24)} ${p(0.76, 0.4)}S${p(0.94, 0.34)} ${w} ${h * 0.42}V${h}H0Z" fill="${hillFar}"/>` +
    `<path d="M0 ${h * 0.62}C${p(0.16, 0.46)} ${p(0.3, 0.5)} ${p(0.44, 0.58)}S${p(0.7, 0.42)} ${p(0.86, 0.54)}S${p(0.97, 0.5)} ${w} ${h * 0.52}V${h}H0Z" fill="${hillMid}"/>` +
    `<path d="M0 ${h * 0.78}C${p(0.2, 0.6)} ${p(0.36, 0.66)} ${p(0.5, 0.68)}S${p(0.8, 0.62)} ${w} ${h * 0.7}V${h}H0Z" fill="${hillNear}"/>` +
    `<path d="M${p(0.3, 0.72)}C${p(0.36, 0.68)} ${p(0.44, 0.69)} ${p(0.49, 0.72)}S${p(0.4, 0.78)} ${p(0.3, 0.77)}Z" fill="${field}"/>` +
    `<path d="M${p(0.82, 0.7)}C${p(0.88, 0.66)} ${p(0.95, 0.67)} ${w} ${h * 0.7}V${h * 0.78}C${p(0.94, 0.77)} ${p(0.87, 0.76)} ${p(0.82, 0.7)}Z" fill="${field}"/>` +
    town +
    cypress(w * 0.5, h * 0.62, 1.5 * scale) +
    cypress(w * 0.825, h * 0.64, 1.7 * scale) +
    cypress(w * 0.845, h * 0.65, 1.2 * scale) +
    tree(w * 0.46, h * 0.7, 1.6 * scale) +
    tree(w * 0.79, h * 0.7, 1.4 * scale) +
    `<path d="M0 ${h * 0.92}C${p(0.2, 0.74)} ${p(0.42, 0.8)} ${p(0.6, 0.86)}S${p(0.88, 0.8)} ${w} ${h * 0.86}V${h}H0Z" fill="${forest}"/>` +
    `<path d="M${p(0.36, 1)}C${p(0.42, 0.9)} ${p(0.56, 0.9)} ${p(0.6, 0.82)}S${p(0.6, 0.74)} ${p(0.64, 0.7)}" fill="none" stroke="${sky}" stroke-width="${22 * scale}" stroke-linecap="round"/>` +
    `<path d="M${p(0.36, 1)}C${p(0.42, 0.9)} ${p(0.56, 0.9)} ${p(0.6, 0.82)}S${p(0.6, 0.74)} ${p(0.64, 0.7)}" fill="none" stroke="${sun}" stroke-width="${3 * scale}" stroke-dasharray="${10 * scale} ${14 * scale}" stroke-linecap="round"/>` +
    tree(w * 0.12, h * 0.9, 2.6 * scale) +
    tree(w * 0.93, h * 0.92, 2.2 * scale)
  );
}

/**
 * The mascot, as in the painted illustrations: a round green house under one violet pitched roof.
 * Drawn in a 400×400 box; `extra` is placed behind the arms (a waving hand, a map, a signpost).
 */
function mascotBody(extra: string) {
  return (
    `<ellipse cx="200" cy="356" rx="118" ry="14" fill="${ink}" opacity=".12"/>` +
    `<path d="M150 318v26M250 318v26" stroke="${deep}" stroke-width="16" stroke-linecap="round"/>` +
    extra +
    `<rect x="256" y="96" width="30" height="56" rx="7" fill="#4f2f72"/>` +
    `<rect x="104" y="168" width="192" height="164" rx="72" fill="${forest}"/>` +
    `<path d="M58 192 184 80c9-8 23-8 32 0l126 112c10 9 4 26-10 26H68c-14 0-20-17-10-26Z" fill="${violet}"/>` +
    `<circle cx="166" cy="258" r="11" fill="${ink}"/><circle cx="234" cy="258" r="11" fill="${ink}"/>` +
    `<circle cx="170" cy="254" r="3.5" fill="#fff"/><circle cx="238" cy="254" r="3.5" fill="#fff"/>` +
    `<path d="M182 284c10 12 26 12 36 0" fill="none" stroke="${ink}" stroke-width="6" stroke-linecap="round"/>` +
    `<circle cx="140" cy="282" r="11" fill="#f3a9a0" opacity=".7"/><circle cx="260" cy="282" r="11" fill="#f3a9a0" opacity=".7"/>`
  );
}

const arm = (d: string) => `<path d="${d}" fill="none" stroke="${deep}" stroke-width="16" stroke-linecap="round"/>`;

const backdrop = `<rect width="400" height="400" fill="${sky}"/><circle cx="200" cy="210" r="168" fill="${sun}" opacity=".2"/>`;

/** A journey step: the mascot beside a checkpoint flag, with the emblem of the step at the upper right. */
const checkpointArt = (emblem: string) =>
  svg(
    400,
    400,
    backdrop +
      `<path d="M72 344V200" stroke="#7a5a48" stroke-width="8" stroke-linecap="round"/><path d="M72 204h54l-14 18 14 18H72Z" fill="${sun}" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>` +
      `<g transform="translate(-6 40) scale(.84)">${mascotBody(arm('M300 252c26-10 40-34 44-62') + arm('M100 262c-20 6-34 20-40 36'))}</g>` +
      emblem,
  );

/** Each fallback, keyed by the id of the image slot it stands in for. */
export const fallbackArt = {
  'hero-valley': () => svg(1600, 900, valley(1600, 900)),
  'mascot-welcome': () =>
    svg(400, 400, backdrop + mascotBody(arm('M300 252c26-10 40-34 44-62') + arm('M100 262c-20 6-34 20-40 36'))),
  'mascot-guide': () =>
    svg(
      400,
      400,
      backdrop +
        mascotBody(arm('M100 262c-18 10-24 24-24 40') + arm('M300 262c18 10 24 24 24 40')) +
        `<g transform="rotate(-6 200 318)"><path d="M118 292l54-12 56 12 54-12v62l-54 12-56-12-54 12Z" fill="${wall}" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/>` +
        `<path d="M172 280v62M228 292v62" stroke="${ink}" stroke-width="4" opacity=".5"/>` +
        `<path d="M138 326c18-14 30 6 50-6s28-10 42 2 28-4 40-10" fill="none" stroke="${violet}" stroke-width="5" stroke-dasharray="3 9" stroke-linecap="round"/>` +
        `<circle cx="258" cy="306" r="8" fill="${terracotta}"/></g>`,
    ),
  'workspace-empty': () =>
    svg(
      400,
      400,
      backdrop +
        `<path d="M0 330c80-36 170-40 250-18s110 12 150-6v94H0Z" fill="${hillNear}"/>` +
        `<path d="M318 344V168" stroke="#7a5a48" stroke-width="10" stroke-linecap="round"/>` +
        `<path d="M318 184h62l14 16-14 16h-62Z" fill="${wall}" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>` +
        `<path d="M318 232h-52l-14 16 14 16h52Z" fill="${sun}" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>` +
        `<g transform="translate(-52 34) scale(.86)">${mascotBody(arm('M300 252c26-10 40-34 44-62') + arm('M100 262c-20 6-34 20-40 36'))}</g>`,
    ),
  'og-card': () =>
    svg(
      1200,
      624,
      valley(1200, 624) +
        `<rect width="1200" height="624" fill="url(#fade)"/><defs><linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="${sky}"/><stop offset=".42" stop-color="${sky}" stop-opacity=".94"/><stop offset=".7" stop-color="${sky}" stop-opacity="0"/></linearGradient></defs>` +
        `<text x="72" y="118" font-family="${fontStack}" font-size="44" font-weight="800" letter-spacing="-1.5" fill="${deep}">Relo<tspan fill="${violet}">Cat</tspan></text>` +
        `<text x="72" y="300" font-family="${fontStack}" font-size="92" font-weight="700" letter-spacing="-3" fill="#163d2b">Find your place</text>` +
        `<text x="72" y="398" font-family="${fontStack}" font-size="92" font-weight="700" font-style="italic" letter-spacing="-3" fill="${violet}">in Catalonia.</text>` +
        `<text x="72" y="474" font-family="${fontStack}" font-size="30" fill="#304e3d">Towns, school journeys and housing support, compared.</text>`,
      'ReloCat. Find your place in Catalonia.',
    ),
  'step-profile': () =>
    checkpointArt(
      `<rect x="286" y="150" width="64" height="80" rx="8" fill="${wall}" stroke="${ink}" stroke-width="5"/><path d="M300 176h36M300 196h36M300 214h22" stroke="${ink}" stroke-width="4" stroke-linecap="round" opacity=".55"/>`,
    ),
  'step-money': () =>
    checkpointArt(
      `<circle cx="318" cy="190" r="34" fill="${sun}" stroke="${ink}" stroke-width="5"/><circle cx="318" cy="190" r="18" fill="none" stroke="${ink}" stroke-width="4" opacity=".45"/>`,
    ),
  'step-bank': () =>
    checkpointArt(
      `<path d="M278 176l40-26 40 26Z" fill="${violet}" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/><path d="M290 184v40M318 184v40M346 184v40M278 230h80" stroke="${ink}" stroke-width="7" stroke-linecap="round"/>`,
    ),
  'step-places': () =>
    checkpointArt(
      `<path d="M270 226c20-30 40-30 56 0Z" fill="${hillNear}"/><path d="M316 226c18-36 44-36 60 0Z" fill="${hillNear}"/><path d="M288 198l12-12 12 12v14h-24Z" fill="${terracotta}" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/><path d="M336 192l12-12 12 12v14h-24Z" fill="${terracotta}" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>`,
    ),
  'step-aid': () =>
    checkpointArt(
      `<rect x="282" y="186" width="72" height="44" rx="6" fill="#7a5a48" stroke="${ink}" stroke-width="5"/><path d="M282 186c0-22 72-22 72 0" fill="${terracotta}" stroke="${ink}" stroke-width="5"/><path d="M318 150l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1Z" fill="${sun}"/>`,
    ),
  'step-habits': () =>
    checkpointArt(
      `<path d="M318 232v-56" stroke="${ink}" stroke-width="6" stroke-linecap="round"/><path d="M318 196c-26 0-34-16-34-28 20 0 34 8 34 28ZM318 184c24 0 32-14 32-26-18 0-32 8-32 26Z" fill="${hillNear}" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/><circle cx="318" cy="152" r="10" fill="${sun}" stroke="${ink}" stroke-width="3"/>`,
    ),
  'step-ready': () =>
    checkpointArt(
      `<circle cx="318" cy="168" r="20" fill="none" stroke="${sun}" stroke-width="12"/><path d="M318 188v48M318 216h16M318 232h12" stroke="${sun}" stroke-width="12" stroke-linecap="round"/>`,
    ),
} as const satisfies Record<string, () => string>;

export type ArtId = keyof typeof fallbackArt;

/** A fallback illustration as a `data:` URL without quotes, safe inside `url(...)` and attributes. */
export const fallbackDataUrl = (id: ArtId) => `data:image/svg+xml,${encodeURIComponent(fallbackArt[id]())}`;
