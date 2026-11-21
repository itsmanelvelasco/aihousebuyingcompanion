# React web and ChatGPT workspace

The React workspace shares the existing profile/bank API with the website. It is served locally at `http://127.0.0.1:8787/workspace` and registered as the MCP resource `ui://relocat/input-workspace-v1.html`. In ChatGPT, ask to open the ReloCat input workspace; `open_input_workspace` returns the native app template. The journey board also provides an entry button.

## Entry points

- `apps/mcp-server/workspace-widget.tsx` and `workspace.html`: React views for profiles, reviewed interviews, source inputs, resolved context, bank activity and sourced towns.
- `workspace-tools.ts`: app-only `workspace_request` bridge to the existing authenticated profile API. Records are returned in result `_meta.workspace`, with generic model-facing status text.
- `workspace-page.ts`: shared HTML/bundle loader, server configuration and local page handler.
- `packages/ui/theme.css`: shared ReloCat palette for both environments.

`PROFILE_API_URL` and `PROFILE_API_TOKEN` configure the server-side connection. The standalone MCP server can also use `BANK_API_URL` and `BANK_API_TOKEN`. `npm run dev:stack` configures the connected services. The browser never receives these credentials. Missing configuration produces an unavailable state rather than fabricated data.

## Feature parity and persistence

Profile sections, source-input CRUD, context/provenance/conflicts, bank accounts/movements and synthetic runtime controls use the same routes and validation as the management website. JSON imports are reviewed before explicit saves. Guided/voice answers remain drafts until reviewed and saved as interview inputs; money uses integer euro cents. Municipality discovery uses the existing sourced tools and preserves unknowns and unsupported requirements.

React uses `App.callServerTool` when embedded; the browser preview uses bounded same-origin local transports. Raw records are not added to model context automatically. The existing journey board, town explorer and headless calculation tools remain available.

## Voice and host support

Microphone permission is requested for the app resource. Voice starts only after an explicit click and uses the configured interviewer backend/OpenAI API credits. The host and browser control microphone availability; denial leaves the guided interview usable. Closing the component stops tracks and the WebRTC connection. Never embed or commit an API key in the widget.

This remains a fictional-data, shared-token development workspace. App-only visibility is a host routing feature, not production per-user authorization. Production deployment still needs authenticated access and durable backend storage. Installation refresh, actual ChatGPT rendering and live paid voice require target-client verification.

## Run and check

Use `npm ci`, `npm run setup:app`, `npm run dev:stack`. Build with `npm run build:mcp-ui`; check with `npm run typecheck`, `npm test`, `npm run check:app` and `npm run test:app`. No paid calls are needed for automated tests.
