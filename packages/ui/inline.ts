import { existsSync, readFileSync } from 'node:fs';
import { type ArtId, fallbackArt, fallbackDataUrl } from './art.ts';
import { type IconName, icon, iconPaths, markDataUrl, markSvg } from './icons.ts';
import { images } from './images.manifest.ts';

/**
 * Server-side helpers that put the shared design system into a self-contained HTML document.
 * Every surface is one file with its CSS inlined by its loader; the loader calls `inlineUi` so the
 * theme, the icons and the illustrations each exist once, here in `packages/ui`.
 */
const root = new URL('../../', import.meta.url);
let cachedTheme: string | undefined;

/** The shared stylesheet as text, safe to place inside a `<style>` element. */
export function themeCss() {
  cachedTheme ??= readFileSync(new URL('./theme.css', import.meta.url), 'utf8').replace(/<\/style/gi, '<\\/style');
  return cachedTheme;
}

const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

/** The generated file of an image slot, or `null` while it has not been generated. */
export function generatedImage(id: ArtId) {
  const spec = images.find(image => image.id === id);
  if (!spec) return null;
  const file = new URL(spec.path, root);
  return existsSync(file) ? { type: mime[spec.format], bytes: readFileSync(file) } : null;
}

/** An image slot as a `data:` URL: the generated raster when present, the SVG fallback otherwise. */
export function imageDataUrl(id: ArtId) {
  const generated = generatedImage(id);
  return generated ? `data:${generated.type};base64,${generated.bytes.toString('base64')}` : fallbackDataUrl(id);
}

/** The same choice as bytes with a content type, for a route that serves the image itself. */
export function imageFile(id: ArtId) {
  return generatedImage(id) ?? { type: 'image/svg+xml', bytes: Buffer.from(fallbackArt[id](), 'utf8') };
}

const isArt = (id: string): id is ArtId => id in fallbackArt;
const isIcon = (name: string): name is IconName => name in iconPaths;

/**
 * Fills the placeholders of a page template:
 *
 *   /* THEME *\/            inside a <style>: the shared stylesheet
 *   <!-- THEME -->          outside one: the stylesheet in its own <style>
 *   /* ART *\/              inside a <style>: `--rc-art-<id>` custom properties for `options.art`
 *   {{art:<id>}}            an image slot as a data: URL, for <img src>
 *   <!-- ICON:<name> -->    an inline icon; `<!-- ICON:<name>|Label -->` when it needs a name
 *   <!-- MARK -->           the product mark
 *   <!-- FAVICON -->        <link rel="icon"> with the mark
 *
 * An unknown icon or image id throws, so a typo fails at start instead of shipping a blank.
 */
export function inlineUi(html: string, options: { art?: ArtId[] } = {}) {
  const art = (options.art ?? []).map(id => `--rc-art-${id}: url("${imageDataUrl(id)}");`).join('\n');
  return html
    .replace('/* THEME */', () => themeCss())
    .replace('<!-- THEME -->', () => `<style>${themeCss()}</style>`)
    .replace('/* ART */', () => (art ? `:root {\n${art}\n}` : ''))
    .replace(/\{\{art:([a-z-]+)\}\}/g, (_, id: string) => {
      if (!isArt(id)) throw new Error(`Unknown image slot "${id}" in a page template`);
      return imageDataUrl(id);
    })
    .replace(/<!-- ICON:([a-z-]+)(?:\|([^>]*?))? -->/g, (_, name: string, label?: string) => {
      if (!isIcon(name)) throw new Error(`Unknown icon "${name}" in a page template`);
      return icon(name, label ? { label } : {});
    })
    .replaceAll('<!-- MARK -->', markSvg)
    .replace('<!-- FAVICON -->', `<link rel="icon" type="image/svg+xml" href="${markDataUrl}">`);
}
