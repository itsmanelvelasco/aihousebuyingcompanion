import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { packageTeamPlugin, teamEndpoint } from '../scripts/package-team-plugin.ts';

test('team bundle is reproducible and includes only portable skills with no runtime/account state', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'relocat-plugin-'));
  try {
    const first = await packageTeamPlugin({ outputDirectory });
    const second = await packageTeamPlugin({ outputDirectory });
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.installed, false);
    const files = unzipSync(await readFile(first.path));
    assert.equal(JSON.parse(strFromU8(files['plugin.json'])).version, '1.0.0');
    assert.equal(files['mcp.json'], undefined);
    assert.equal(Object.keys(files).filter(name => name.endsWith('/SKILL.md')).length, 3);
    for (const name of Object.keys(files)) assert.ok(name === 'plugin.json' || /^skills\/[a-z-]+\/(SKILL\.md|references\/[a-z-]+\.md)$/.test(name), name);
    for (const name of Object.keys(files).filter(name => name.endsWith('/SKILL.md'))) {
      const markdown = strFromU8(files[name]);
      assert.match(markdown, /^---\nname: [a-z-]+\ndescription: .+\n---\n/);
      assert.ok(!markdown.includes('TODO'));
    }
    const marketplace = JSON.parse(await readFile('.agents/plugins/marketplace.json', 'utf8'));
    assert.equal(marketplace.plugins[0].source.path, './plugins/relocat-team');
    assert.equal(marketplace.plugins[0].policy.installation, 'AVAILABLE');
  } finally { await rm(outputDirectory, { recursive: true, force: true }); }
});

test('MCP variant uses a supplied remote endpoint and never stores a header credential', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'relocat-plugin-mcp-'));
  try {
    const built = await packageTeamPlugin({ outputDirectory, mcpUrl: 'https://team.example/mcp' });
    const files = unzipSync(await readFile(built.path));
    const mcp = JSON.parse(strFromU8(files['mcp.json']));
    assert.deepEqual(mcp.mcpServers.relocat, { type: 'streamable-http', url: 'https://team.example/mcp' });
    assert.equal(built.connected, false);
    for (const url of ['http://localhost:8787/mcp', 'https://127.0.0.1/mcp', 'https://localhost/mcp', 'https://u:password@team.example/mcp', 'https://team.example/mcp?token=secret', 'https://team.example/other']) assert.throws(() => teamEndpoint(url));
  } finally { await rm(outputDirectory, { recursive: true, force: true }); }
});
