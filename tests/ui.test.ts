import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { voiceCard } from '../apps/mcp-server/voice-card.messages.ts';
import { renderVoiceCard } from '../apps/mcp-server/voice-card.ts';
import { fallbackArt } from '../packages/ui/art.ts';
import { icon, iconNames, labelledIcon, markDataUrl, wordmark } from '../packages/ui/icons.ts';
import { imagePrompt, imageStyle, images } from '../packages/ui/images.manifest.ts';
import { imageDataUrl, inlineUi, themeCss } from '../packages/ui/inline.ts';
import { generateImages, imagesEndpoint, parseArguments } from '../scripts/generate-images.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('the theme is one self-contained stylesheet with light and dark tokens', () => {
  const css = themeCss();
  for (const token of [
    '--rc-paper',
    '--rc-accent',
    '--rc-violet',
    '--rc-font-display',
    '--rc-radius-md',
    '--rc-space-4',
  ]) {
    assert.match(css, new RegExp(`${token}:`), `${token} is defined`);
  }
  assert.match(css, /color-scheme: light dark/);
  assert.match(css, /light-dark\(/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  for (const component of [
    '.rc-btn',
    '.rc-pill',
    '.rc-card',
    '.rc-field',
    '.rc-rows',
    '.rc-wordmark',
    ':focus-visible',
  ]) {
    assert.ok(css.includes(component), `${component} is styled`);
  }
  // Widgets run under a CSP with no external requests: no imports and no remote fonts or images.
  // The one typeface is embedded as a data: URL on the first line; nothing else is a URL.
  const [fontFace, ...rest] = css.split('\n');
  assert.match(fontFace, /^@font-face\{font-family:"Montserrat";[^}]*src:url\("data:font\/woff2;base64,[\w+/=]+"\) /);
  assert.doesNotMatch(rest.join('\n'), /@import|@font-face|url\(|https?:/i);
  assert.match(css, /--rc-font-text: "Montserrat",/);
});

test('the icon set covers what the surfaces need, in one style', () => {
  const required = [
    'home',
    'pin',
    'person',
    'household',
    'wallet',
    'check',
    'bank',
    'pulse',
    'school',
    'health',
    'hospital',
    'library',
    'sports',
    'train',
    'shop',
    'aid',
    'tax',
    'calendar',
    'link',
    'warning',
    'help',
    'compare',
    'add',
    'remove',
    'expand',
    'collapse',
    'external',
  ];
  for (const name of required) assert.ok((iconNames as string[]).includes(name), `icon "${name}" exists`);
  for (const name of iconNames) {
    const svg = icon(name);
    assert.match(
      svg,
      /^<svg class="rc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"/,
    );
    assert.match(svg, /aria-hidden="true"/);
    assert.doesNotMatch(svg, /fill="#|stroke="#|<script|href=/, `${name} uses currentColor only`);
  }
  const labelled = labelledIcon('warning', 'Needs "checking" <now>');
  assert.match(labelled, /role="img" aria-label="Needs &quot;checking&quot; &lt;now&gt;"/);
  assert.doesNotMatch(labelled, /aria-hidden/);
});

test('the product is written ReloCat on every surface, with shared theme and no glyph icons', () => {
  assert.match(
    wordmark({ href: '/connect' }),
    /class="rc-wordmark" href="\/connect" aria-label="ReloCat home".*Relo<b>Cat<\/b>/,
  );
  assert.match(markDataUrl, /^data:image\/svg\+xml,/);
  const templates = [
    'apps/mcp-server/connect.html',
    'apps/mcp-server/town-explorer.html',
    'apps/mcp-server/cash-flow-widget.html',
    'apps/mcp-server/test-ui.html',
    'apps/web/workspace.html',
    'apps/board/widget.html',
  ];
  for (const path of templates) {
    const template = read(path);
    assert.match(template, /\/\* THEME \*\//, `${path} takes the shared theme`);
    assert.doesNotMatch(template, /relo<span>\.cat/, `${path} uses the ReloCat wordmark`);
    const page = inlineUi(template, { art: ['hero-valley', 'workspace-empty'] });
    assert.match(page, /--rc-paper:/);
    assert.doesNotMatch(
      page,
      /\/\* THEME \*\/|\/\* ART \*\/|<!-- (ICON|MARK|FAVICON)/,
      `${path} has no placeholder left`,
    );
  }
  assert.match(renderVoiceCard(null), /--rc-paper:[\s\S]*class="rc-btn rc-btn--gold"/);
  // Emoji and block glyphs used to stand in for icons; the SVG set replaces them.
  const glyphs = /[⌂▂▅█★✓☕]|\p{Extended_Pictographic}️?/u;
  for (const path of [
    ...templates,
    'apps/board/widget.ts',
    'apps/mcp-server/voice-card.ts',
    'apps/mcp-server/town-explorer-widget.ts',
    'apps/web/Workspace.tsx',
    'apps/web/components/bits.tsx',
    'apps/web/components/BankStrip.tsx',
    'apps/web/components/PersonPanel.tsx',
    'apps/web/components/PlacesPanel.tsx',
    'apps/web/components/Notes.tsx',
  ]) {
    const text = read(path).replace(/[©®™]/g, '');
    assert.doesNotMatch(text, glyphs, `${path} uses icons from packages/ui, not glyphs`);
  }
});

test('the retired name "ReloCat Team" appears nowhere a person or the model reads', () => {
  // Identifiers keep `relocat-team` (the bundle's folder and archive); the display name is ReloCat.
  const skipped = new Set(['node_modules', 'dist', '.git', 'cache', 'artifacts']);
  const offenders: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) walk(path);
      } else if (/\.(ts|tsx|html|md|json|css)$/.test(entry.name) && /ReloCat\s+Team/.test(read(path)))
        offenders.push(path);
    }
  };
  for (const folder of ['apps', 'packages', 'plugins', 'docs', 'scripts']) walk(folder);
  for (const file of ['README.md', 'PLAN.md', 'AGENTS.md', 'package.json'])
    if (/ReloCat\s+Team/.test(read(file))) offenders.push(file);
  assert.deepEqual(offenders, []);

  const manifest = JSON.parse(read('plugins/relocat-team/plugin.json'));
  assert.equal(manifest.extensions['com.openai'].interface.displayName, 'ReloCat');
  // The sentence people are told to say names the product, in the three languages.
  assert.match(voiceCard.en.instructions, /“Use ReloCat to start my homebuying interview\.”/);
  assert.match(
    voiceCard.ca.instructions,
    /«Fes servir ReloCat per començar la meva entrevista de compra d’habitatge\.»/,
  );
  assert.match(voiceCard.es.instructions, /«Usa ReloCat para empezar mi entrevista de compra de vivienda\.»/);
});

test('page templates fail loudly on an unknown icon or image slot', () => {
  assert.match(inlineUi('<p><!-- ICON:pin --></p>'), /<p><svg class="rc-icon"/);
  assert.match(inlineUi('<!-- ICON:warning|Check this -->'), /role="img" aria-label="Check this"/);
  assert.throws(() => inlineUi('<!-- ICON:unicorn -->'), /Unknown icon "unicorn"/);
  assert.throws(() => inlineUi('<img src="{{art:nothing}}">'), /Unknown image slot "nothing"/);
});

test('every image slot has a prompt, a valid size and a drawn fallback', () => {
  assert.ok(images.length >= 4 && images.length <= 16, 'the manifest is a short list');
  assert.equal(new Set(images.map(image => image.id)).size, images.length);
  for (const spec of images) {
    const [width, height] = spec.size.split('x').map(Number);
    assert.ok(width % 16 === 0 && height % 16 === 0, `${spec.id}: edges divisible by 16`);
    assert.ok(width / height <= 3 && height / width <= 3, `${spec.id}: aspect ratio within 3:1`);
    assert.ok(width * height >= 655_360 && width * height <= 8_294_400, `${spec.id}: pixel count in range`);
    assert.match(spec.path, /^apps\/mcp-server\/assets\/(steps\/)?[a-z-]+\.(jpg|png|webp)$/);
    assert.ok(imagePrompt(spec).startsWith(imageStyle), `${spec.id}: shares the family style`);
    assert.match(spec.scene, /^Scene: /);
    const fallback = fallbackArt[spec.id]();
    assert.match(fallback, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox=/);
    assert.doesNotMatch(fallback, /NaN|undefined|<script|href=/);
    // The slot shows the generated file when it exists and the drawing otherwise.
    const expected = existsSync(join(root, spec.path))
      ? /^data:image\/(jpeg|png|webp);base64,/
      : /^data:image\/svg\+xml,/;
    assert.match(imageDataUrl(spec.id), expected);
  }
});

// --- The generation script, with an injected fetch: no network, no real key. -----------------

const key = 'sk-test-0000-not-a-real-key';
const pixels = Buffer.from('fake image bytes');

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'relocat-images-'));
  return { directory, done: () => rmSync(directory, { recursive: true, force: true }) };
}

function recorder(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, fetcher };
}

test('a dry run prints the plan and makes no request, with or without a key', async () => {
  const { directory, done } = workspace();
  try {
    const { calls, fetcher } = recorder(() => new Response('{}'));
    const lines: string[] = [];
    const results = await generateImages({
      dryRun: true,
      root: directory,
      env: {},
      fetch: fetcher,
      log: line => lines.push(line),
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(
      results.map(result => result.status),
      images.map(() => 'planned'),
    );
    const output = lines.join('\n');
    for (const spec of images) assert.ok(output.includes(spec.path) && output.includes(spec.scene.slice(0, 40)));
    assert.equal(existsSync(join(directory, images[0].path)), false);
  } finally {
    done();
  }
});

test('a run writes the decoded image to its target path', async () => {
  const { directory, done } = workspace();
  try {
    const { calls, fetcher } = recorder(() => Response.json({ data: [{ b64_json: pixels.toString('base64') }] }));
    const spec = images.find(image => image.id === 'workspace-empty')!;
    const lines: string[] = [];
    const results = await generateImages({
      only: [spec.id],
      root: directory,
      env: { OPENAI_API_KEY: key, OPENAI_IMAGE_MODEL: 'test-image-model' },
      fetch: fetcher,
      log: line => lines.push(line),
    });
    assert.deepEqual(results, [{ id: spec.id, path: spec.path, status: 'written' }]);
    assert.deepEqual(readFileSync(join(directory, spec.path)), pixels);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, imagesEndpoint);
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), `Bearer ${key}`);
    assert.ok(calls[0].init.signal instanceof AbortSignal, 'the request has a timeout');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'test-image-model');
    assert.equal(body.size, spec.size);
    assert.equal(body.output_format, spec.format);
    assert.equal(body.n, 1);
    assert.equal(body.prompt, imagePrompt(spec));
    assert.ok(!lines.join('\n').includes(key), 'the key is never logged');
  } finally {
    done();
  }
});

test('an API error is reported without leaking the key, and the run continues', async () => {
  const { directory, done } = workspace();
  try {
    const { calls, fetcher } = recorder(() =>
      Response.json({ error: { message: `Incorrect API key provided: ${key}.` } }, { status: 401 }),
    );
    const lines: string[] = [];
    const results = await generateImages({
      only: ['workspace-empty', 'og-card'],
      root: directory,
      env: { OPENAI_API_KEY: key },
      fetch: fetcher,
      log: line => lines.push(line),
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(
      results.map(result => result.status),
      ['failed', 'failed'],
    );
    assert.match(results[0].detail ?? '', /Images API answered 401: Incorrect API key provided: \[redacted key\]/);
    assert.ok(!JSON.stringify(results).includes(key) && !lines.join('\n').includes(key));
    assert.equal(existsSync(join(directory, images[0].path)), false);
  } finally {
    done();
  }
});

test('existing files are skipped unless forced, and a missing key is a clear error', async () => {
  const { directory, done } = workspace();
  try {
    const spec = images[0];
    mkdirSync(dirname(join(directory, spec.path)), { recursive: true });
    writeFileSync(join(directory, spec.path), 'already here');
    const { calls, fetcher } = recorder(() => Response.json({ data: [{ b64_json: pixels.toString('base64') }] }));
    const quiet = () => {};

    // Nothing to do: no key is needed and no request is made.
    const skipped = await generateImages({ only: [spec.id], root: directory, env: {}, fetch: fetcher, log: quiet });
    assert.deepEqual(skipped, [{ id: spec.id, path: spec.path, status: 'skipped' }]);
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(join(directory, spec.path), 'utf8'), 'already here');

    await assert.rejects(
      generateImages({ only: [spec.id], force: true, root: directory, env: {}, fetch: fetcher, log: quiet }),
      /OPENAI_API_KEY is not set/,
    );
    assert.equal(calls.length, 0);

    const forced = await generateImages({
      only: [spec.id],
      force: true,
      root: directory,
      env: { OPENAI_API_KEY: key },
      fetch: fetcher,
      log: quiet,
    });
    assert.equal(forced[0].status, 'written');
    assert.deepEqual(readFileSync(join(directory, spec.path)), pixels);

    await assert.rejects(
      generateImages({ only: ['no-such-image'], root: directory, env: {}, log: quiet }),
      /Unknown image id/,
    );
  } finally {
    done();
  }
});

test('command-line options are parsed strictly', () => {
  assert.deepEqual(parseArguments(['--dry-run', '--only', 'og-card', '--force']), {
    dryRun: true,
    only: ['og-card'],
    force: true,
  });
  assert.throws(() => parseArguments(['--only']), /--only needs an image id/);
  assert.throws(() => parseArguments(['--quality', 'ultra']), /--quality must be one of/);
  assert.throws(() => parseArguments(['--key', 'x']), /Unknown option --key/);
});
