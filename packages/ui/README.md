# packages/ui: the ReloCat design system

One visual identity for every surface: the homepage (`/connect`), the Town Explorer, the workspace,
the journey board, the two chat cards and the local tool tester. Each surface is a single
self-contained HTML document, so the theme lives in one file here and is inlined when a page loads.

| File | What it holds |
|---|---|
| `theme.css` | Design tokens (`--rc-*`) and the shared components (`.rc-*`) |
| `icons.ts` | The icon set, the product mark and the wordmark, as SVG strings |
| `art.ts` | Illustrations drawn in SVG: the fallback for every image slot |
| `images.manifest.ts` | The raster images the product needs and the prompt for each |
| `inline.ts` | Server-side helper that fills a page template (`inlineUi`) |

`packages/ui` imports nothing from `apps`. `icons.ts` and `art.ts` are pure strings, so browser
bundles can import them; `inline.ts` reads files and is for the Node loaders only.

## Tokens

- **Colour.** Warm paper (`--rc-paper`, `--rc-surface`, `--rc-sunken`), ink and muted text, forest
  green for actions (`--rc-accent`), violet as the second voice (`--rc-violet`), gold for rewards
  (`--rc-gold`), and warning and danger pairs. Light and dark values are set together with
  `light-dark()`; a host can force one with `<html data-theme="light">` or `"dark"`.
  Two panels keep their colours in both themes: `--rc-night` (a dark green hero) and `--rc-day`
  (the cream behind an illustration).
- **Type.** `--rc-font-display` is a system serif for `h1` and `h2`; `--rc-font-text` is the system
  sans. Sizes run from `--rc-text-xs` (12 px) to `--rc-text-hero`. A compact widget sets
  `:root { --rc-body-size: 0.9375rem; }`.
- **Space, radii, shadow, motion.** `--rc-space-1` to `--rc-space-20` in 4 px steps;
  `--rc-radius-xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 20, `pill`; `--rc-dur-fast` 150 ms, `--rc-dur`
  200 ms, `--rc-dur-slow` 300 ms with `--rc-ease`. `prefers-reduced-motion` is handled once, in the theme.
- **Components.** `.rc-btn` (`--primary`, `--gold`, `--quiet`, `--sm`, `--block`), `.rc-pill`
  (`--ok`, `--warn`, `--violet`, `--danger`, `--off`, `--gold`), `.rc-card` (`--night`), `.rc-inset`,
  `.rc-field`, `.rc-rows`, `.rc-table`, `.rc-note` (`--warn`, `--error`), `.rc-empty`, `.rc-art`,
  `.rc-skeleton`, `.rc-label`, `.rc-wordmark`, `.rc-icon`, `.rc-sr-only`. Focus rings, `details`
  disclosure arrows and 44 px touch targets come with them.

The product is written **ReloCat**. `relo.cat` appears only as a URL.

## Adopting the theme in a surface

1. Put the placeholder first in the page's `<style>`, then only the layout that is specific to the page:

   ```html
   <style>
   /* THEME */
   main { max-width: 890px; margin: auto; }
   </style>
   ```

2. Pass the template through `inlineUi` in the loader:

   ```ts
   import { inlineUi } from '../../packages/ui/inline.ts';
   const page = inlineUi(readFileSync(new URL('./index.html', import.meta.url), 'utf8'));
   ```

3. Use tokens instead of literal colours, and the shared classes for buttons, pills, fields and notes.

Other placeholders `inlineUi` understands: `<!-- THEME -->` (the theme in its own `<style>`),
`<!-- ICON:pin -->` and `<!-- ICON:warning|Needs checking -->` (an icon, optionally named),
`<!-- MARK -->` (the product mark), `<!-- FAVICON -->`, `{{art:hero-valley}}` (an image slot as a
`data:` URL) and `/* ART */` (custom properties `--rc-art-<id>` for the ids passed in
`inlineUi(html, { art: [...] })`). A page that builds its HTML in code can call `themeCss()` instead.

## Adding an icon

Icons share a 24 px grid, 1.75 px strokes, round caps and joins, no fills and `currentColor`.
Add one entry to `paths` in `icons.ts` with the inner markup of the SVG; the name becomes part of
the `IconName` type. Then use it:

```ts
icon('train');                         // decorative: aria-hidden
labelledIcon('warning', 'Needs checking'); // the icon is the only label
```

In React, `apps/web/components/bits.tsx` exports `<Icon name="train" />` built from the same paths.

## Images

Raster illustrations are listed in `images.manifest.ts` with their size, where they are used and
their full prompt: one shared style paragraph plus a scene per image. Until a file exists, its slot
shows the SVG of the same id from `art.ts`, so nothing is blank.

```sh
npm run images:generate -- --dry-run    # print the plan and the prompts; makes no request
npm run images:generate                 # generate every image that does not exist yet
npm run images:generate -- --only og-card --force
npm run images:generate -- --quality medium
```

Set `OPENAI_API_KEY` in `.env` first (`OPENAI_IMAGE_MODEL` is optional). **This is a paid API
call.** The manifest has five images; two do not exist yet (`workspace-empty`, `og-card`), and the
three homepage illustrations are only regenerated with `--force`. At high quality the published
price for a 1024 px to 1536 px image is roughly 0.15 to 0.25 USD, so a full run of five is on the
order of 1 USD; check the current price list before running. Restart the server afterwards: pages
read their images at start.

To add an image: add an entry to the manifest, draw its fallback under the same id in `art.ts`,
and place it with `{{art:<id>}}` or `/* ART */`.
