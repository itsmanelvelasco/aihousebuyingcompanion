# One Relocat setup for teammates

The canonical team bundle is **`relocat-team` version `1.1.0`**, sourced from `plugins/relocat-team/`. It includes the same three workflows for every teammate: Relocat demo, Relocat development, and synthetic finance/habits. These workflows do not clone somebody else's ChatGPT account, copy third-party plugins, share credentials, change personal permissions or install anything remotely in another account.

## What is ready

- A portable root `plugin.json` and three bundled skills.
- A repository marketplace at `.agents/plugins/marketplace.json`, pointing to the single canonical plugin source.
- A reproducible ZIP packager with SHA-256 checksums. The default package is skills-only and has no service connection or credential.
- An optional MCP variant generated only when an administrator supplies the actual shared HTTPS `/mcp` endpoint.

**Packaged, available, installed and connected are different states.** This repository does not establish that a teammate has installed the plugin or that the workspace has published it. No teammate accounts or workspace settings were changed by creating these files.

## Build the team artifact

From the repository root:

```powershell
npm ci
npm run package:team-plugin
```

Output: `artifacts/team-plugin/relocat-team-1.1.0-skills-only.zip` and its `.sha256` checksum. Artifacts are ignored by Git. The packager deliberately includes only the manifest and Markdown skills/references, not profiles, runtime state, secrets, application code or dependencies. It does not contact an MCP service or spend OpenAI credits.

To include the team's actual deployed endpoint:

```powershell
npm run package:team-plugin -- --mcp-url https://your-team-host/mcp
```

Replace that example hostname with the real service; it is not a deployed Relocat URL. The alternative `RELOCAT_MCP_URL` environment variable is supported. The MCP variant uses portable `mcp.json` with Streamable HTTP and no credential header. The builder rejects localhost/IP addresses, HTTP, embedded credentials, query strings and fragments. Passing syntactic validation does not prove that the endpoint is reachable, authenticated or authorized for a workspace.

Do not distribute `http://127.0.0.1:8787/mcp` as the team's remote endpoint: localhost refers to each teammate's own computer. Use an approved shared HTTPS deployment or the platform's supported private-tunnel connection flow. The current integrated MCP demonstration uses synthetic data; it is not a production per-user banking service. A production authentication requirement needs the corresponding registered connection/OAuth configuration, not a token baked into a ZIP.

## Publish once, then install per account

For a common ChatGPT workspace, a workspace administrator can import/sync the repository marketplace from GitHub using the workspace's plugin controls, or upload the generated package and publish it to the permitted workspace roles. Use one canonical source and version rather than separate hand-edited copies. Repository marketplace discovery alone is not workspace publication.

For teammates using separate accounts/workspaces, share the same reviewed ZIP/source and checksum. Each person installs it through their supported plugin surface, then completes any service connection required by their own workspace. Workspace-only publication does not grant access to accounts outside that workspace. Local repo marketplace support also varies by surface; follow the current official UI guidance.

After installation/update, start a new chat/session so the bundled skills can load. Verify **Relocat Team** appears in Installed and that the three skill names are available. For the MCP variant, verify tools in the actual connection before running a demo. A skill's mention of a tool is not proof that the connection provides it.

## Teammate acceptance check

For the bank-first interview, update Relocat Team to version 1.1.0 and connect the deployment that exposes `start_homebuying_interview`. Start a new ChatGPT Live voice conversation and say “Use Relocat Team to start my homebuying interview.” ChatGPT asks whether to use a CSV, the fictional demo bank, or spoken estimates. Attach any CSV in the chat. Live availability and plugin access depend on the account and workspace. The same entry point also works in a text chat.

1. Confirm the bundle name/version and SHA-256 match the team's chosen artifact.
2. Confirm all three skills are available in a new session.
3. For connected use, verify `recommend_towns`, `get_town_profile` and `get_applicable_incentives` appear; bank-read and board tools depend on the configured integrated server.
4. Run a fictional demo and check official evidence links, unknown eligibility and synthetic-finance labels. Do not enter real financial credentials.
5. Record **installed** and **connected** only after that teammate verifies those states. Keep existing personal plugins and permissions unchanged.

The standalone habits HTTP API does not yet become an MCP tool merely because its workflow is bundled. Its rules/API setup remains in `apps/habits-agent/README.md`; Sol requests stay optional and separately configured.

## Maintenance and sources

Edit the canonical source, increment `plugin.json` version for a distributed change, regenerate the artifact, review its checksum/content, then update the workspace source or shared ZIP. Ask users to refresh/update and start a new session; do not claim a repo push silently changed every installed account.

- [Official packaging and marketplace guide](https://developers.openai.com/plugins/build/plugins)
- [Official plugin installation/sharing guide](https://learn.chatgpt.com/docs/plugins)
- [Workspace GitHub plugin import](https://learn.chatgpt.com/docs/enterprise/plugin-management)

Current deployment gap: no shared HTTPS MCP URL or workspace-admin publication has been supplied/verified in this change. The skills-only package is immediately buildable; service connectivity and teammate installation require the actual endpoint/account actions above.
