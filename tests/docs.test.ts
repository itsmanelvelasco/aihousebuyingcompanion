import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadData } from '../packages/places/data.ts';
import { sources } from '../packages/sources/registry.ts';

/**
 * Keeps the documentation true: a command, a path or an environment variable that a document
 * names must exist, and a variable the code reads must be documented in `.env.example`.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const skippedDirectories = new Set(['node_modules', '.git', 'dist', 'cache', 'runtime-users', 'runtime-habits']);

/** Every file under `directory` (relative to the repository) whose name passes `wanted`. */
function files(directory: string, wanted: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name) && !/^runtime-users\.bak/.test(entry.name))
          walk(join(folder, entry.name));
      } else if (wanted(entry.name)) found.push(relative(root, join(folder, entry.name)).replaceAll('\\', '/'));
    }
  };
  if (existsSync(join(root, directory))) walk(join(root, directory));
  return found.sort();
}
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const markdown = files('.', name => name.endsWith('.md'));
const pages = files('apps', name => name.endsWith('.html'));
const documents = [...markdown, ...pages];
const scripts = Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>);

test('every npm script a document mentions exists', () => {
  assert.ok(markdown.includes('README.md') && pages.length > 0, 'the documents were found');
  const unknown: string[] = [];
  for (const path of documents)
    for (const match of read(path).matchAll(/npm run ([a-z][a-z0-9:_-]*)/g))
      if (!scripts.includes(match[1])) unknown.push(`${path}: npm run ${match[1]}`);
  assert.deepEqual(unknown, []);
});

/** Paths that exist only at run time or after a build, so they cannot be checked in a clean checkout. */
const generatedPaths = [
  /^data\/(db\/)?relocat\.db/,
  /^data\/runtime-(users|habits)\b/,
  /^data\/(cache|backups)\b/,
  /^data\/demo-bank\.json$/,
  /^apps\/[a-z-]+\/dist\b/,
  /^apps\/mcp-server\/assets\/agents\/[a-z-]+\.png$/,
];
const repositoryPath = /^(apps|packages|tests|scripts|docs|plugins|data|\.github|\.claude-plugin)\/[A-Za-z0-9_./@-]+$/;

test('every repository path a document puts in backticks exists', () => {
  const missing: string[] = [];
  let checked = 0;
  for (const path of documents) {
    for (const match of read(path).matchAll(/`([^`\s]+)`/g)) {
      // `path:12` and `path#anchor` point into a file; a trailing slash or dot is punctuation.
      const candidate = match[1].replace(/[:#].*$/, '').replace(/[/.,]+$/, '');
      if (!repositoryPath.test(candidate) || generatedPaths.some(pattern => pattern.test(candidate))) continue;
      checked++;
      if (!existsSync(join(root, candidate))) missing.push(`${path}: ${match[1]}`);
    }
  }
  assert.ok(checked > 50, 'the check found paths to verify');
  assert.deepEqual(missing, []);
});

test('every relative link in a Markdown file points at something that exists', () => {
  const broken: string[] = [];
  for (const path of markdown) {
    for (const match of read(path).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1].replace(/#.*$/, '');
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
      const file = resolve(root, dirname(path), decodeURIComponent(target));
      if (
        !existsSync(file) &&
        !generatedPaths.some(pattern => pattern.test(relative(root, file).replaceAll('\\', '/')))
      )
        broken.push(`${path}: ${match[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});

/**
 * Variables the code reads that do not belong in `.env.example`: set by the runtime, the shell or
 * the hosting platform, or only by tests.
 */
const runtimeVariables = new Set(['NODE_ENV', 'PATH', 'HOME', 'CI', 'NODE_TEST_CONTEXT']);

/** Names assigned in `.env.example`, including the ones shown commented out. */
function documentedVariables() {
  return new Set([...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]));
}

/** Names the code reads: `process.env.X`, `env.X`, `env['X']`, and `X` passed to an `env*` helper. */
function variablesRead() {
  const found = new Map<string, string>();
  const sources = ['apps', 'packages', 'scripts'].flatMap(directory =>
    files(directory, name => /\.(ts|tsx)$/.test(name) && !name.startsWith('_')),
  );
  const variable = '([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)';
  const patterns = [
    new RegExp(`\\benv\\.${variable}\\b`, 'g'),
    new RegExp(`\\benv\\[['"]${variable}['"]\\]`, 'g'),
    new RegExp(`\\benv[A-Z][A-Za-z]*\\(\\s*['"]${variable}['"]`, 'g'),
  ];
  // Helpers and plug-ins name their variables as plain strings: any constant-case string in the
  // configuration module, and the `name` of a provider's or a source's variable.
  const declared = /['"]([A-Z][A-Z0-9_]{3,})['"]/g;
  const named = new RegExp(`\\bname:\\s*['"]${variable}['"]`, 'g');
  for (const path of sources) {
    const text = read(path);
    const all = [...patterns];
    if (path === 'packages/config/env.ts') all.push(declared);
    if (/^packages\/(banks\/providers|sources\/definitions)\//.test(path)) all.push(named);
    for (const pattern of all) for (const match of text.matchAll(pattern)) found.set(match[1], path);
  }
  return found;
}

test('.env.example and the variables the code reads agree', () => {
  const documented = documentedVariables();
  const used = variablesRead();
  assert.ok(documented.size > 20 && used.size > 20, 'both lists were found');
  const undocumented = [...used]
    .filter(([name]) => !documented.has(name) && !runtimeVariables.has(name))
    .map(([name, path]) => `${name} (read in ${path})`)
    .sort();
  assert.deepEqual(undocumented, [], 'read by the code but missing from .env.example');
  const unread = [...documented].filter(name => !used.has(name)).sort();
  assert.deepEqual(unread, [], 'named in .env.example but read nowhere');
});

test('npm scripts that read .env settings load the file', () => {
  const packageScripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  const documented = documentedVariables();
  const forgetful: string[] = [];
  for (const [name, command] of Object.entries(packageScripts)) {
    const entry = command.match(/node (?:--[^\s]+ )*((?:scripts|apps)\/[^\s]+\.ts)/);
    if (!entry || command.includes('--env-file')) continue;
    const text = read(entry[1]);
    const reads = [...text.matchAll(/\b(?:process\.)?env(?:[A-Z][A-Za-z]*\(\s*['"]|\.)([A-Z][A-Z0-9_]+)/g)]
      .map(match => match[1])
      .filter(variable => documented.has(variable));
    if (reads.length) forgetful.push(`${name} reads ${[...new Set(reads)].join(', ')} without --env-file`);
  }
  assert.deepEqual(forgetful, []);
});

test('.env.example names each variable once', () => {
  // A second assignment of the same name silently wins when the file is copied to `.env`.
  const seen = new Map<string, number>();
  for (const [index, line] of read('.env.example').split(/\r?\n/).entries()) {
    const name = /^#?\s?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (!name) continue;
    if (seen.has(name)) assert.fail(`${name} is set on line ${seen.get(name)} and again on line ${index + 1}`);
    seen.set(name, index + 1);
  }
  assert.ok(seen.size > 20, 'the variables were found');
});

test('every documented way to run the image says where client addresses come from', () => {
  // The image sets NODE_ENV=production, where the server refuses to start without CLIENT_IP_HEADER.
  const commands = markdown.flatMap(path =>
    read(path)
      .split(/\r?\n/)
      .flatMap(line => [...line.matchAll(/docker run [^`\n]*/g)].map(match => ({ path, command: match[0] }))),
  );
  assert.ok(commands.length >= 2, 'the commands were found');
  const missing = commands.filter(({ command }) => !/-e CLIENT_IP_HEADER=\S+/.test(command));
  assert.deepEqual(missing, []);
  assert.match(read('Dockerfile'), /COPY [^\n]*scripts\/backup-db\.ts/, 'the image can run npm run db:backup');
  // /health reports the schema version of the database, never where the file is.
  assert.doesNotMatch(read('docs/areas/integration-deployment.md'), /database path/);
});

// ------------------------------------------------- facts the documents state

test('the figures the README gives for the pilot are the ones in the data', () => {
  const { snapshot, policies } = loadData();
  const actual: Record<string, number> = {
    'town profiles': snapshot.municipalities.length,
    'education centres': snapshot.schools.length,
    'rail trips': snapshot.rail.trips.length,
    'policy records': policies.length,
    'official sources': sources.length,
  };
  const readme = read('README.md');
  for (const [thing, count] of Object.entries(actual))
    assert.match(readme, new RegExp(`\\b${count} ${thing}\\b`), `README.md says ${count} ${thing}`);
  // Wherever a document counts one of these, in digits or in words, it gives the real number.
  const words = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
  ];
  const wrong: string[] = [];
  for (const path of markdown)
    for (const [thing, count] of Object.entries(actual))
      for (const match of read(path).matchAll(new RegExp(`\\b(\\d+|${words.join('|')}) ${thing}\\b`, 'gi'))) {
        const stated = /^\d+$/.test(match[1]) ? Number(match[1]) : words.indexOf(match[1].toLowerCase());
        if (stated !== count) wrong.push(`${path}: "${match[0]}", the data has ${count}`);
      }
  assert.deepEqual(wrong, []);
});

test('the documents name every official source of the registry, and only those', () => {
  const ids = sources.map(source => source.id).sort();
  assert.ok(ids.length >= 8, 'the registry was read');
  for (const path of ['README.md', 'docs/areas/municipalities-incentives.md']) {
    const text = read(path);
    const missing = ids.filter(id => !text.includes(`\`${id}\``));
    assert.deepEqual(missing, [], `${path} names every source`);
    // An id written like a source's (`gencat-…`, `idescat-…`, `fgc-…`) must be one.
    const named = [...text.matchAll(/`((?:gencat|idescat|fgc)-[a-z-]+)`/g)].map(match => match[1]);
    assert.deepEqual(
      [...new Set(named)].filter(id => !ids.includes(id)),
      [],
      `${path} names no source that does not exist`,
    );
  }
});

test('the README lists every npm script', () => {
  const readme = read('README.md');
  const unlisted = scripts.filter(
    // `pretest` runs by itself before `npm test`.
    name => name !== 'pretest' && !new RegExp(`npm (run )?${name}(?![\\w:-])`).test(readme),
  );
  assert.deepEqual(unlisted, []);
});

test('claims the code has outgrown do not come back', () => {
  const stale: [RegExp, string][] = [
    [/ReloCat Team/, 'the product is ReloCat'],
    [/not assumed to be live feeds/, 'official place data is live and pre-cached'],
    [/per-user (production )?authori[sz]ation (is|remains?|are) (not|outside)/i, 'every person belongs to an account'],
    [/Production auth[^.]*(is|are) later work/i, 'accounts and OAuth exist'],
    [/integration remains pending|remains to be integrated/i, 'the profile API is integrated'],
  ];
  const found: string[] = [];
  for (const path of [...markdown, ...files('plugins', name => name.endsWith('.json'))])
    for (const [pattern, why] of stale) if (pattern.test(read(path))) found.push(`${path}: ${pattern} (${why})`);
  assert.deepEqual(found, []);
  // The two ways to speak and the widget cache are things a person setting ReloCat up must be told.
  const readme = read('README.md');
  for (const fact of [
    'Refresh tools',
    'OPENAI_API_KEY',
    'INTERVIEWER_PUBLIC_AI=on',
    'packages/i18n/README.md',
    'Montserrat',
  ])
    assert.ok(readme.includes(fact), `README.md mentions ${fact}`);
});
