import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const skipped = new Set(['node_modules', 'dist', 'assets']);

function sources(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return skipped.has(entry.name) ? [] : sources(path);
    return /\.(ts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** Relative imports of a source file, resolved to repository paths such as `packages/finance/csv.ts`. */
function imports(file: string) {
  const text = readFileSync(join(root, file), 'utf8');
  return [...text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(([, target]) =>
    relative(root, resolve(root, dirname(file), target))
      .split(sep)
      .join('/'),
  );
}

const area = (path: string) => path.split('/').slice(0, 2).join('/');

test('packages never depend on apps', () => {
  for (const file of sources('packages')) {
    for (const target of imports(file)) assert.ok(!target.startsWith('apps/'), `${file} imports ${target}`);
  }
});

test('apps share code through packages; only the server and the board compose other apps', () => {
  for (const file of sources('apps')) {
    for (const target of imports(file)) {
      if (!target.startsWith('apps/') || area(target) === area(file)) continue;
      // apps/server mounts every service on one origin; apps/board reuses the shared MCP server.
      const composition =
        area(file) === 'apps/server' || (area(file) === 'apps/board' && area(target) === 'apps/mcp-server');
      assert.ok(composition, `${file} imports ${target}; move shared code to packages/`);
    }
  }
});

test('the product has one name', () => {
  const legacy = /\bArrela\b|\bRelocat\b|ui:\/\/(arrela|homebuying)\//;
  for (const file of [...sources('apps'), ...sources('packages'), ...sources('scripts')]) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), legacy, `${file} uses a legacy product name`);
  }
});
