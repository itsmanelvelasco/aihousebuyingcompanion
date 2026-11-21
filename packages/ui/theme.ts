import { readFileSync } from 'node:fs';

const theme = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** One offline brand stylesheet for local pages, MCP templates and hosted builds. */
export function applyTheme(html: string) {
  return html.replace('</head>', `<style data-relocat-theme>${theme}</style></head>`);
}
