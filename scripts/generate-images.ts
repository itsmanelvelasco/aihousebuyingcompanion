import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envString } from '../packages/config/env.ts';
import { type ImageSpec, imagePrompt, images } from '../packages/ui/images.manifest.ts';

/**
 * Generates the raster illustrations listed in packages/ui/images.manifest.ts with the OpenAI
 * Images API. This is a paid call per image; nothing runs without OPENAI_API_KEY.
 *
 *   npm run images:generate                 every image that does not exist yet
 *   npm run images:generate -- --dry-run    print prompts and target paths, make no request
 *   npm run images:generate -- --only hero-valley --force
 *   npm run images:generate -- --quality medium
 *
 * API reference checked on 2026-11-22: https://developers.openai.com/api/reference/resources/images
 * ("Create image", POST /v1/images/generations) and the guide
 * https://developers.openai.com/api/docs/guides/image-generation.
 * GPT image models always answer with base64 in `data[].b64_json`; `size` accepts custom
 * WIDTHxHEIGHT values (edges divisible by 16) from gpt-image-2 onwards; `output_format` is
 * png, jpeg or webp; `output_compression` applies to jpeg and webp; `background` is
 * transparent, opaque or auto.
 */
export const imagesEndpoint = 'https://api.openai.com/v1/images/generations';
export const defaultImageModel = 'gpt-image-2.5-sunburst';
const qualities = ['low', 'medium', 'high', 'auto'] as const;
type Quality = (typeof qualities)[number];

export type GenerateOptions = {
  only?: string[];
  force?: boolean;
  dryRun?: boolean;
  quality?: Quality;
  /** Repository root the manifest paths are resolved against. */
  root?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
};

export type GenerateResult = {
  id: string;
  path: string;
  status: 'planned' | 'skipped' | 'written' | 'failed';
  detail?: string;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The key must never reach a log, even when the API echoes it back in an error message. */
const redact = (text: string, key: string | undefined) => (key ? text.split(key).join('[redacted key]') : text);

async function requestImage(
  spec: ImageSpec,
  settings: { key: string; model: string; quality: Quality; fetch: typeof fetch; timeoutMs: number },
) {
  const response = await settings.fetch(imagesEndpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      prompt: imagePrompt(spec),
      n: 1,
      size: spec.size,
      quality: settings.quality,
      background: 'opaque',
      output_format: spec.format,
      ...(spec.format === 'png' ? {} : { output_compression: 88 }),
    }),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });
  const text = await response.text();
  let body: { data?: { b64_json?: string }[]; error?: { message?: string; code?: string } } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // A proxy or gateway page; reported through the status below.
  }
  if (!response.ok) {
    const reason = body.error?.message ?? (text.slice(0, 200) || 'no details');
    throw new Error(`Images API answered ${response.status}: ${reason}`);
  }
  const encoded = body.data?.[0]?.b64_json;
  if (!encoded) throw new Error('Images API answered without image data (data[0].b64_json is missing)');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) throw new Error('Images API returned an empty image');
  return bytes;
}

export async function generateImages(options: GenerateOptions = {}): Promise<GenerateResult[]> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const root = options.root ?? repositoryRoot;
  const key = envString('OPENAI_API_KEY', env);
  const model = envString('OPENAI_IMAGE_MODEL', env) ?? defaultImageModel;
  const quality = options.quality ?? 'high';

  const unknown = (options.only ?? []).filter(id => !images.some(image => image.id === id));
  if (unknown.length) {
    throw new Error(`Unknown image id: ${unknown.join(', ')}. Known ids: ${images.map(image => image.id).join(', ')}`);
  }
  const selected = options.only?.length ? images.filter(image => options.only?.includes(image.id)) : images;
  const todo = selected.filter(spec => options.force || !existsSync(resolve(root, spec.path)));
  if (!options.dryRun && todo.length > 0 && !key) {
    throw new Error(
      'OPENAI_API_KEY is not set. Add it to .env (see .env.example) or run with --dry-run to see the plan.',
    );
  }

  const results: GenerateResult[] = [];
  for (const spec of selected) {
    const target = resolve(root, spec.path);
    if (!todo.includes(spec)) {
      log(`skip     ${spec.id}  ${spec.path} already exists (use --force to replace it)`);
      results.push({ id: spec.id, path: spec.path, status: 'skipped' });
      continue;
    }
    if (options.dryRun) {
      log(`plan     ${spec.id}  ->  ${spec.path}  (${spec.size} ${spec.format}, ${model}, quality ${quality})`);
      log(`         used in: ${spec.usedIn}`);
      log(`         prompt: ${imagePrompt(spec).replaceAll('\n', '\n                 ')}\n`);
      results.push({ id: spec.id, path: spec.path, status: 'planned' });
      continue;
    }
    try {
      log(`request  ${spec.id}  (${spec.size} ${spec.format}, ${model}, quality ${quality})`);
      const bytes = await requestImage(spec, {
        key: key!,
        model,
        quality,
        fetch: options.fetch ?? fetch,
        timeoutMs: options.timeoutMs ?? 240_000,
      });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      log(`written  ${spec.id}  ${spec.path}  (${Math.round(bytes.length / 1024)} kB)`);
      results.push({ id: spec.id, path: spec.path, status: 'written' });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const detail = redact(
        timedOut ? 'The request timed out.' : error instanceof Error ? error.message : String(error),
        key,
      );
      log(`failed   ${spec.id}  ${detail}`);
      results.push({ id: spec.id, path: spec.path, status: 'failed', detail });
    }
  }
  return results;
}

export function parseArguments(argv: string[]): GenerateOptions {
  const options: GenerateOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--force') options.force = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--only') {
      const value = argv[++index];
      if (!value) throw new Error('--only needs an image id, for example --only hero-valley');
      options.only = [...(options.only ?? []), ...value.split(',').filter(Boolean)];
    } else if (argument === '--quality') {
      const value = argv[++index] as Quality;
      if (!qualities.includes(value)) throw new Error(`--quality must be one of ${qualities.join(', ')}`);
      options.quality = value;
    } else throw new Error(`Unknown option ${argument}. Options: --dry-run, --force, --only <id>, --quality <level>`);
  }
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const results = await generateImages(options);
    const count = (status: GenerateResult['status']) => results.filter(result => result.status === status).length;
    console.log(
      options.dryRun
        ? `Dry run: ${count('planned')} to generate, ${count('skipped')} already present. No request was made.`
        : `${count('written')} written, ${count('skipped')} skipped, ${count('failed')} failed.`,
    );
    if (count('failed') > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
