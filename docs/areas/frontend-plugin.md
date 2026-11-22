# Frontend and ChatGPT plugin area

**Owner:** frontend/plugin setup team. **Purpose:** show one consistent conversation and live board backed by shared results.

## Entry points

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

## Run and verify

```powershell
npm run build
npm run typecheck
node --test tests/board.test.ts tests/board-connected.test.ts
```

See [integration/deployment](integration-deployment.md) for configuration and startup. Verify configured and explicitly scripted modes separately, including backend failure and stopped-feed behavior.

## Handoff

Expose user/run mapping, data freshness, unresolved input conflicts and pending property-level constraints in the view model. The bridge's sourced town screen is provisional: a bedroom requirement remains a pending property-level check and is not represented as satisfied by a municipality. Reuse structured municipality/incentive output for both chat and board; do not reimplement eligibility or financial formulas in rendering code.
