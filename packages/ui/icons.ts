/**
 * The ReloCat icon set. One style for every surface: a 24 px grid, 1.75 px strokes, round caps and
 * joins, no fills, `currentColor`. Each entry is the inner markup of the `<svg>`; `icon()` wraps it.
 * Pure strings with no imports, so the browser bundles and the Node loaders share this one file.
 */
const paths = {
  // Product and navigation
  home: '<path d="M4 11.2 12 4l8 7.2"/><path d="M6 9.6V20h12V9.6"/><path d="M10 20v-5.5h4V20"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.4"/>',
  map: '<path d="m3.5 6.5 5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2Z"/><path d="M9 4.5v13M15 6.5v13"/>',
  compare: '<path d="M4 8h13.5M14 4.5 17.5 8 14 11.5"/><path d="M20 16H6.5M10 12.5 6.5 16l3.5 3.5"/>',
  // People
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.6-3.7 3.4-5.8 7-5.8s6.4 2.1 7 5.8"/>',
  household:
    '<circle cx="8.5" cy="8.5" r="3"/><path d="M2.8 19.5c.5-3.1 2.7-4.9 5.7-4.9s5.2 1.8 5.7 4.9"/><circle cx="17" cy="9.5" r="2.3"/><path d="M16.4 14.8c2.6-.2 4.4 1.4 4.9 4.2"/>',
  // Money
  wallet:
    '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17v3"/><path d="M4 7.5V17a2.5 2.5 0 0 0 2.5 2.5H20V8H6.5A2.5 2.5 0 0 1 4 7.5Z"/><circle cx="16" cy="13.75" r="1.1"/>',
  bank: '<path d="M3.5 9.5 12 4.5l8.5 5"/><path d="M4.5 9.5h15"/><path d="M6.5 12.5v5M10.2 12.5v5M13.8 12.5v5M17.5 12.5v5"/><path d="M3.5 20h17"/>',
  aid: '<path d="M4.5 11.5h15V20h-15Z"/><path d="M3.5 8h17v3.5h-17Z"/><path d="M12 8v12"/><path d="M12 8c-1.2-3.3-5.2-3.8-5.2-1.5C6.8 8 9.5 8 12 8Zm0 0c1.2-3.3 5.2-3.8 5.2-1.5C17.2 8 14.5 8 12 8Z"/>',
  tax: '<path d="M6 3.5h12v17l-2.4-1.5-2.4 1.5-2.4-1.5-2.4 1.5L6 20.5Z"/><path d="m9.5 14 5-5"/><circle cx="9.7" cy="9.2" r=".9"/><circle cx="14.3" cy="13.8" r=".9"/>',
  // Habits and status
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
  tick: '<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>',
  pulse: '<path d="M3 12.5h4l2.2-6 4 11 2.3-5H21"/>',
  warning: '<path d="M12 4 3.5 19h17Z"/><path d="M12 10v4.2"/><path d="M12 16.7v.2"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.9"/><path d="M12 16.6v.2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.7v.2"/>',
  star: '<path d="m12 4 2.4 5 5.4.7-4 3.8 1 5.4-4.8-2.6-4.8 2.6 1-5.4-4-3.8 5.4-.7Z"/>',
  key: '<circle cx="8" cy="15.5" r="3.5"/><path d="m10.6 13 8.4-8.5"/><path d="m15.5 8 2.5 2.5M18 5.5 20 7.5"/>',
  trophy:
    '<path d="M8 4.5h8v5a4 4 0 0 1-8 0Z"/><path d="M8 6H5c0 3 1.2 4.5 3.3 4.8M16 6h3c0 3-1.2 4.5-3.3 4.8"/><path d="M12 13.5V17M8.5 20h7M9.5 17h5v3h-5Z"/>',
  sparkle: '<path d="M12 4c.6 4.4 3.6 7.4 8 8-4.4.6-7.4 3.6-8 8-.6-4.4-3.6-7.4-8-8 4.4-.6 7.4-3.6 8-8Z"/>',
  // Services in a place
  school:
    '<path d="M2.5 9.5 12 5l9.5 4.5L12 14Z"/><path d="M6.5 11.5v4.3c1.4 1.4 3.3 2.2 5.5 2.2s4.1-.8 5.5-2.2v-4.3"/><path d="M21.5 9.5v5"/>',
  health:
    '<path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10Z"/><path d="M12 10v4.5M9.75 12.25h4.5"/>',
  hospital:
    '<path d="M5 20.5V5.5A1.5 1.5 0 0 1 6.5 4h11A1.5 1.5 0 0 1 19 5.5v15"/><path d="M3.5 20.5h17"/><path d="M12 7.5v5M9.5 10h5"/><path d="M10 20.5V16h4v4.5"/>',
  pharmacy: '<path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5Z"/>',
  library:
    '<path d="M12 6.5C10 5 7 4.5 3.5 5v13.5C7 18 10 18.5 12 20c2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5Z"/><path d="M12 6.5V20"/>',
  sports:
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17"/><path d="M5.8 6.2c2.2 1.5 3.3 3.4 3.3 5.8s-1.1 4.3-3.3 5.8M18.2 6.2c-2.2 1.5-3.3 3.4-3.3 5.8s1.1 4.3 3.3 5.8"/>',
  train:
    '<path d="M7.5 4h9A2.5 2.5 0 0 1 19 6.5v8a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 14.5v-8A2.5 2.5 0 0 1 7.5 4Z"/><path d="M5 10.5h14"/><path d="M8.5 13.8v.2M15.5 13.8v.2"/><path d="m8.5 17-2 3.5M15.5 17l2 3.5"/>',
  shop: '<path d="M5 10.5V20h14v-9.5"/><path d="M4 5h16l1 4a2.8 2.8 0 0 1-5.6.3 2.8 2.8 0 0 1-5.6 0A2.8 2.8 0 0 1 3 9Z"/><path d="M10 20v-5h4v5"/>',
  // Time and sources
  calendar: '<path d="M4.5 6h15v14h-15Z"/><path d="M4.5 10h15"/><path d="M8.5 3.5v4M15.5 3.5v4"/>',
  link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  external: '<path d="M13.5 5H19v5.5"/><path d="m19 5-8 8"/><path d="M17 14v5H5V7h5"/>',
  copy: '<path d="M9 9h10.5v10.5H9Z"/><path d="M15 9V4.5H4.5V15H9"/>',
  mic: '<path d="M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3Z"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v2.5"/>',
  'mic-off':
    '<path d="M9 9.5v2a3 3 0 0 0 4.7 2.5M15 10.5v-4a3 3 0 0 0-5.6-1.5"/><path d="M5.5 11.5a6.5 6.5 0 0 0 10.7 5M18.5 11.5a6.5 6.5 0 0 1-.5 2.5"/><path d="M12 18v2.5"/><path d="m4.5 4.5 15 15"/>',
  keyboard:
    '<path d="M5.5 6.5h13a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"/><path d="M7.5 10.4v.2M10.5 10.4v.2M13.5 10.4v.2M16.5 10.4v.2"/><path d="M8.5 14h7"/>',
  stop: '<path d="M8 6.5h8A1.5 1.5 0 0 1 17.5 8v8a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 16V8A1.5 1.5 0 0 1 8 6.5Z"/>',
  // Controls
  add: '<path d="M12 5v14M5 12h14"/>',
  remove: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  expand: '<path d="m6 9 6 6 6-6"/>',
  collapse: '<path d="m6 15 6-6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  fullscreen: '<path d="M4.5 9.5v-5h5M19.5 9.5v-5h-5M4.5 14.5v5h5M19.5 14.5v5h-5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  // Everyday habits (board quests)
  coffee:
    '<path d="M5 9.5h11V14a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5Z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8.5 3.5c-.8 1 .8 1.8 0 3M12.5 3.5c-.8 1 .8 1.8 0 3"/>',
  pot: '<path d="M5 10.5h14V16a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 5 16Z"/><path d="M2.5 12.5H5M19 12.5h2.5"/><path d="M4 7.5h16"/><path d="M12 7.5V5"/>',
  basket: '<path d="M3.5 10h17l-1.8 9.5H5.3Z"/><path d="m8 10 3-5.5M16 10l-3-5.5"/><path d="M9.5 13.5v3M14.5 13.5v3"/>',
} as const;

export type IconName = keyof typeof paths;
export const iconNames = Object.keys(paths) as IconName[];

/** Inner markup of an icon, for a renderer that builds its own `<svg>` (the React `Icon`). */
export const iconPaths: Record<IconName, string> = paths;

/** Attributes every icon shares; exported so React and string renderers cannot drift apart. */
export const iconAttributes = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const escapeAttribute = (text: string) =>
  text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

/**
 * An icon as an SVG string. Decorative by default (`aria-hidden`); pass `label` when the icon is
 * the only thing saying what a control or a status means.
 */
export function icon(name: IconName, options: { label?: string; className?: string } = {}) {
  const classes = options.className ? `rc-icon ${options.className}` : 'rc-icon';
  const accessibility = options.label
    ? `role="img" aria-label="${escapeAttribute(options.label)}"`
    : 'aria-hidden="true" focusable="false"';
  return `<svg class="${classes}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${accessibility}>${paths[name]}</svg>`;
}

/** Shorthand for an icon that carries meaning on its own. */
export const labelledIcon = (name: IconName, label: string) => icon(name, { label });

/**
 * The product mark: the ReloCat mascot's face, a round green house under a violet pitched roof.
 * Colours are fixed so the mark is the same on every background; it is also the favicon.
 */
export const markSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
  '<rect width="32" height="32" rx="8" fill="#fbefdc"/>' +
  '<rect x="20.5" y="6.5" width="3.5" height="6" rx="1" fill="#4f2f72"/>' +
  '<rect x="7.5" y="14" width="17" height="13.5" rx="5.5" fill="#2f8f63"/>' +
  '<path d="M3.9 16.3 14.5 6.2c.8-.8 2.2-.8 3 0l10.6 10.1c.8.8.2 2.2-.9 2.2H4.8c-1.1 0-1.7-1.4-.9-2.2Z" fill="#663e91"/>' +
  '<circle cx="12.8" cy="22.6" r="1.3" fill="#143326"/><circle cx="19.2" cy="22.6" r="1.3" fill="#143326"/>' +
  '</svg>';

/** The mark as a `data:` URL, for `<link rel="icon">` and `<img>`. */
export const markDataUrl = `data:image/svg+xml,${encodeURIComponent(markSvg)}`;

/** The wordmark as markup: the mark, then "ReloCat" with "Cat" in the second colour. */
export function wordmark(options: { tag?: 'a' | 'p' | 'span'; href?: string; mark?: boolean } = {}) {
  const tag = options.tag ?? (options.href ? 'a' : 'span');
  const link = tag === 'a' ? ` href="${escapeAttribute(options.href ?? '/')}" aria-label="ReloCat home"` : '';
  return `<${tag} class="rc-wordmark"${link}>${options.mark === false ? '' : markSvg}<span>Relo<b>Cat</b></span></${tag}>`;
}
