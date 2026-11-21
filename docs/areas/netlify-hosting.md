# Netlify hosting

The repository is prepared to host the management dashboard at `https://relo.cat/` and `/manage`. This preparation does not claim a deployed Netlify site or change DNS. Netlify account access and an authenticated persistent backend are still required.

## Deploy the dashboard

Connect this GitHub repository in the existing Netlify project for relo.cat. Use the repository root as base and select the intended release branch. The tracked `netlify.toml` runs `npm run build:web` on Node 24 and publishes `artifacts/team-plugin/netlify/public`. The generated functions directory is its sibling, outside the public directory. Do not upload the repository directory as the publish directory.

Set `PROFILE_API_ORIGIN` in the Netlify project's runtime function environment to the HTTPS origin of your persistent profile service, for example `https://profiles.example.org`. Do not include a path or credentials. The origin is runtime configuration; rebuilding static files does not embed it. Without valid configuration, API calls return 503. The browser supplies its own profile API bearer token, kept in tab memory; the gateway never injects a shared server token. Netlify Functions follow the official [Request/Response handler convention](https://docs.netlify.com/build/functions/get-started/) and [custom path configuration](https://docs.netlify.com/build/functions/configuration/).

Only explicit profile routes under `/users` are forwarded. Methods are restricted per route, request bodies are limited to 256 KiB, requests time out after 15 seconds, and redirects are rejected. Only the caller's Authorization and Content-Type headers are sent upstream. Cookies, browser Origin, and upstream Set-Cookie are not forwarded; cross-origin browser requests are refused. Keep `PROFILE_API_TOKEN` exclusively in the persistent service and enter it into the management screen when connecting. Use this shared-token access only for the synthetic team demo; individual accounts and authorization remain future work.

## Persistent backend requirement

The existing profile service writes JSON files and runs a background synthetic bank worker. It must run as a persistent Node 24 service with a durable mounted `PROFILE_DATA_DIR`, one writer, HTTPS ingress, and server-side `PROFILE_API_TOKEN`. Netlify Functions and temporary `/tmp` storage cannot replace that backend. The current entry point binds loopback; put an HTTPS ingress on the same host or provide an explicit hosting adapter. Do not publish the profile data directory as static files. Deploy and verify this backend separately before claiming the dashboard is connected.

## Interviewer limitation

The build copies the interviewer HTML and application modules under `/interviewer/` for the browser-local guided experience. It does not publish the bank CSV fixture, user fixtures, runtime data, environment files, or API credentials. Sample-bank loading that needs the omitted fixture is unavailable on this host.

Hosted `/interviewer/voice` and `/interviewer/classify` explicitly return 503. They never proxy paid requests, even if an `INTERVIEWER_API_ORIGIN` is supplied. The current interviewer browser does not attach authorization, and its backend accepts only its local origin. An authenticated public adapter, access controls and a reviewed credential flow are required before enabling hosted paid voice or classification; setting an origin alone is insufficient. The existing local `dev:stack` connection remains available for that flow.

## Verify and release

Run `npm run build:web`, `node --test tests/netlify-site.test.ts` and `npm run typecheck`. The build publishes an explicit file list and refuses unexpected files in its output; it never recursively deletes an output directory. Open the Netlify preview and check narrow layouts, token-required state, backend-unconfigured errors, actual authenticated read/write against the persistent service, guided interview and paid-endpoint 503 responses. Then attach relo.cat using the existing Netlify domain configuration and verify the returned production deployment. Account login, backend provisioning and this hosted verification are not completed by a local build.
