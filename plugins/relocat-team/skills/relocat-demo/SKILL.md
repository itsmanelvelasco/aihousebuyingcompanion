---
name: relocat-demo
description: Run or explain the Relocat synthetic housing demo and interpret its town, school, transport and bank results. Use for Relocat demo requests, not general real-world housing advice.
---

Use the team's [project Space](https://chatgpt.com/spaces/page_space_480ff4de354881918c3539e063a2e003) for current product decisions. The core journey confirms household needs, compares sourced Catalan municipalities and explains an actual housing measure with its evidence and application status.

If connected tools are available, use `open_demo`/`update_demo` for the board and grouped interview. Reuse the returned run ID. Save the answers the user actually supplied and ask only for unresolved facts. Do not claim to know a person's ChatGPT memory or finances.

Use `recommend_towns`, `get_town_profile` and `get_applicable_incentives` when exposed by the installed MCP connection. Check its listed tool schemas rather than inventing parameters. Cite source links and observation dates. Distinguish municipality screening from an actual home match: bedroom count, live availability, school vacancies and property condition require separate evidence. Do not silently drop those constraints.

Keep call status separate from household eligibility. Missing facts mean unknown, not ineligible or zero. Use comarca prices only with explicit confirmation. Keep scripted offers visibly separate from official incentives.

This plugin can be distributed skills-only. If tools or the team endpoint are missing, explain that connection is not configured and use the shared setup guide; do not pretend a tool ran or send API credentials through chat. Localhost URLs on a teammate's computer are not a shared team service.
