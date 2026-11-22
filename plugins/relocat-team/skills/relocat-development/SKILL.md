---
name: relocat-development
description: Develop or review the ReloCat monorepo using its shared area ownership, contracts and checks. Use when working in a checkout of aihousebuyingcompanion, not for unrelated repositories.
---

Read the checkout's `AGENTS.md` and `docs/README.md` before changes. The [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) is authoritative for product decisions; code and tests establish what actually runs. If unavailable, disclose that limitation and use the last verified decisions.

See [area routing](references/areas.md) to identify the relevant owner, entry points and checks. Read the corresponding current `docs/areas/*.md` in the checkout before changing its boundary. Use a distinct worktree/branch per parallel feature and preserve unrelated work. Agree shared contracts before overlapping another team's files.

Keep one ChatGPT-facing integrated MCP endpoint. The profile service owns runtime bank writes; other services read its authenticated HTTP API. Keep integer EUR cents in storage and convert explicitly at UI/tool boundaries. Never commit runtime records, credentials or API keys.

Run checks appropriate to the changed area from actual package scripts. Report commands and results; distinguish packaged, installed, connected and verified states. Shipping a ZIP does not install it in another teammate's account or publish it to a workspace.
