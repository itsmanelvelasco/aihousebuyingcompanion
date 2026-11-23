# Frontend and ChatGPT plugin area

**Owner:** frontend/plugin setup team. **Purpose:** show one consistent conversation, workspace and live board backed by shared results.

## Entry points

- `apps/web/`: the React workspace (`/workspace` and the `show_workspace` widget): person, places, the plan and the journey trail (`journey.ts`, seven checkpoints read from what the planner and the bank tools returned; nothing is scored). It does no money maths and reads everything through MCP tools.
- `apps/mcp-server/workspace.ts`, `town-explorer.ts`, `cash-flow.ts`, `voice-card.ts`: the loaders that turn a template into one self-contained document (theme, icons, illustrations and the bundled script inlined).
- `apps/board/server.ts`: HTTP preview, MCP registration and paired-board state.
- `apps/board/demo.ts`: persona/run state and interview transitions.
- `apps/board/profiles.ts`: authenticated profile bridge, persisted-answer mapping and provisional town screen.
- `apps/board/widget.ts`, `widget.html`, `map.ts`: board rendering and interaction.
- `apps/mcp-server/tools.ts`: municipality MCP tool factory.
- `apps/mcp-server/bank-tools.ts`: read-only bank polling bridge.

## Contracts and boundaries

The integrated server exposes existing municipality tools alongside board tools and the configured bank bridge, using one MCP endpoint. The profile API is supporting HTTP storage, not another MCP server. Backend tokens stay in server environment variables; never embed them in widgets, board URLs or tool results.

Configured profile mode uses persisted user IDs, canonical input records and sourced town results. The four persona slots map to `user-001` through `user-004`; persona/run state remains separate from durable user records. Scripted scenes remain explicitly labelled synthetic. A failed configured backend surfaces an error rather than silently substituting a fictional bank or grant.

The live board polls its own server for fresh state. MCP bank tools fetch event cursors/status when called; they do not make ChatGPT wake up or send unsolicited messages. Preserve the distinction between purchase cash readiness and the prototype's fixed 20-year mortgage-payoff illustration. Adding 240 months is not a loan offer, underwriting model or approved repayment term.

## Widgets

- **One handshake.** Every widget script creates `App` from `@modelcontextprotocol/ext-apps` and calls `connect()`: the Town Explorer, the workspace, the board, the cash-flow card and the Start talking card. Nothing posts `ui/initialize` by hand; ChatGPT refuses a widget that does not complete that exchange. `tests/i18n-pages.test.ts` runs the two card bundles against a scripted host.
- **One build.** `npm run build` (`scripts/build.ts`) bundles each widget script into its app's `dist/`; the loader inlines it. Without the bundle a widget is not served (the Town Explorer and the workspace are not registered, the board does not start, and reading a card fails with the instruction to build).
- **One theme.** Templates take `/* THEME */` from `packages/ui` (tokens, components, Montserrat embedded as a `data:` font) and their icons and illustrations through `inlineUi`; see the [design system](../../packages/ui/README.md).
- **Three languages.** A template is written in English with `data-i18n` keys; its script picks the language with `browserLocale` and fills a `.rc-lang` switcher (`apps/mcp-server/widget-i18n.ts`). Amounts and dates go through `createFormat`. The contract is [`packages/i18n/README.md`](../../packages/i18n/README.md).
- **ChatGPT caches widget pages.** After a deployment that changes a widget or a tool, open the plugin's settings in ChatGPT and choose **Refresh tools**, then start a new chat.
- **Personal tools need the account connected.** With **No authentication** the widgets show public data and the fictional demo; a person's own plan needs the OAuth connection ([how](integration-deployment.md#connecting-chatgpt-or-another-mcp-client-with-oauth)).

## Run and verify

```powershell
npm run build
npm run typecheck
node --test tests/board.test.ts tests/board-connected.test.ts tests/workspace.test.ts tests/journey.test.ts tests/ui.test.ts tests/i18n-pages.test.ts tests/widget-contract.test.ts
```

See [integration/deployment](integration-deployment.md) for configuration and startup. Verify configured and explicitly scripted modes separately, including backend failure and stopped-feed behavior.

## Handoff

Expose user/run mapping, data freshness, unresolved input conflicts and pending property-level constraints in the view model. The bridge's sourced town screen is provisional: a bedroom requirement remains a pending property-level check and is not represented as satisfied by a municipality. Reuse structured municipality/incentive output for both chat and board; do not reimplement eligibility or financial formulas in rendering code.
