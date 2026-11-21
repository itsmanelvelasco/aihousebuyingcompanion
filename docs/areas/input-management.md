# Input management website

Entry points: `apps/profile-api/admin.html`, `admin.mjs` and the local profile API `/manage` route. Open `http://127.0.0.1:3001/manage` (or the configured profile port), enter `PROFILE_API_TOKEN`, and select a fictional user. The token is kept in tab memory only.

The website manages the three profile documents, source-record CRUD, resolved context/conflicts, synthetic bank accounts and movements, and background feed controls. JSON imports enter a reviewable editor before saving. Writes go to ignored runtime storage; committed user fixtures are preserved. Bank reads use bounded pagination, with the first 100 movements and first 50 events displayed.

## Interview handoff

1. Select a user and choose **Tell us what you need**. The link opens `/interviewer/?userId=<selected-id>` through the same-origin interviewer proxy. Voice starts only after the interviewer Start control and uses configured OpenAI API credits.
2. Interview answers are saved in browser storage under `homebuying-interviewer-v1:<userId>`. Standalone interviews without a valid user ID retain their legacy unscoped key. The management website never falls back to an unscoped interview.
3. Return to the website and choose **Review interview inputs**. This creates an unsaved draft, with source `interview`, confirmation `false`, the current review timestamp and explicit synthetic provenance.
4. Review the draft, then save explicitly. Only this step writes an input through the authenticated profile API. The raw interview remains unchanged in browser storage and can be downloaded with **Export raw interview**.

The adapter maps `householdSize` to `household.size`; `saved`, `target` and `confirmedSalary` map to current savings, target cash and monthly income in integer euro cents. Financial values must be finite, nonnegative, within API limits, and explicitly denominated in EUR (profile currency takes precedence over statement currency). No currency conversion is performed.

Unsupported exact field names appear in the review warning. Home type, preferred location, amenities, nearby areas, lifestyle, contribution amounts, habit fields and notes remain in the raw interview/export; they do not become municipality filters. A preferred area is never treated as a current residence. Contribution amounts are not inferred to be expenses; a cash savings target is not a home purchase budget. The browser cash-flow summary is not imported as ledger transactions or canonical financial values.

## Deployment boundary

This is a localhost development administration surface for labelled fictional data, using the existing shared-token API. It is not a hosted multi-user administration service. Hosting requires an authenticated per-user/role backend, durable private storage, server-side interviewer persistence and an approved connection to the interviewer service. A hosted page cannot reach these localhost services from other teammates' computers. Browser interview drafts are origin-specific: keep the same host and port for the website and its interviewer proxy.
