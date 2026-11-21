import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import type { Zippable } from 'fflate';

export function teamEndpoint(value: string) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/mcp')) throw new Error('Supply a credential-free HTTPS URL ending in /mcp');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':') || /^\d+(\.\d+){3}$/.test(host)) throw new Error('A shared team endpoint must use a remotely reachable HTTPS hostname, not a local/IP address');
  return url.href;
}

export async function packageTeamPlugin(options: { root?: string; outputDirectory?: string; mcpUrl?: string } = {}) {
  const root = resolve(options.root ?? '.');
  const source = join(root, 'plugins', 'relocat-team');
  const output = resolve(options.outputDirectory ?? join(root, 'artifacts', 'team-plugin'));
  const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
  if (manifest.name !== 'relocat-team' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid team plugin identity/version');
  const entries: Record<string, Uint8Array> = { 'plugin.json': strToU8(JSON.stringify(manifest, null, 2) + '\n') };
  async function collect(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are not allowed in the team bundle');
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const markdown = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
        entries[relative(source, path).split(sep).join('/')] = new TextEncoder().encode(markdown);
      }
      else throw new Error('Only Markdown skill/reference files may be bundled');
    }
  }
  await collect(join(source, 'skills'));
  if (options.mcpUrl) entries['mcp.json'] = strToU8(JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { relocat: { type: 'streamable-http', url: teamEndpoint(options.mcpUrl) } }
  }, null, 2) + '\n');
  const files: Zippable = {};
  for (const name of Object.keys(entries).sort()) files[name] = [entries[name], { mtime: new Date('2026-01-01T00:00:00Z') }];
  const archive = zipSync(files, { level: 9 });
  const mode = options.mcpUrl ? 'with-mcp' : 'skills-only';
  const filename = `relocat-team-${manifest.version}-${mode}.zip`;
  const sha256 = createHash('sha256').update(archive).digest('hex');
  await mkdir(output, { recursive: true });
  const path = join(output, filename);
  await writeFile(path, archive);
  await writeFile(`${path}.sha256`, `${sha256}  ${filename}\n`);
  return { path, sha256, mode, version: manifest.version, files: Object.keys(files), installed: false, connected: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--mcp-url')) throw new Error('Usage: npm run package:team-plugin -- [--mcp-url https://your-team-host/mcp]');
  console.log(JSON.stringify(await packageTeamPlugin({ mcpUrl: args[1] ?? process.env.RELOCAT_MCP_URL }), null, 2));
}
