# Team plugins and skills

**Owner:** team integration/distribution maintainer; workspace publication is performed by an authorized workspace administrator. Teammates manage their own account installation/connection.

**Entry points:** `plugins/relocat-team/plugin.json`, `plugins/relocat-team/skills/`, `.agents/plugins/marketplace.json`, `scripts/package-team-plugin.ts`.

**Contract:** one versioned portable bundle, skills discovered from root `skills/`, optional root `mcp.json` only when a real HTTPS endpoint is supplied. No credentials, runtime bank records, hooks or automatic cross-account settings changes are bundled.

**Commands:** `npm run package:team-plugin`; optional `-- --mcp-url https://actual-team-host/mcp`. Run `npm run typecheck` and `node --test tests/team-plugin.test.ts` for packaging checks. Output is ignored under `artifacts/team-plugin/`.

**Handoff:** use [the team rollout guide](../team-plugin-setup.md) for admin publication and per-account verification. Packaging is not installation. A repo marketplace is not universal public-directory publication. Skills-only works without a backend; connected tools need an actual authorized endpoint.
