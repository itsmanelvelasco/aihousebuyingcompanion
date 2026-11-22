# packages/auth: accounts, sessions and OAuth for MCP

Every stored person belongs to an account, and nothing reads or writes a person without that
account's authority. This package holds the logic; `apps/server` holds the HTTP routes and pages.

| File | What it holds |
| --- | --- |
| `passwords.ts` | scrypt hashing (`node:crypto`), a random salt per password, constant-time verification |
| `secrets.ts` | random secrets, their SHA-256 hashes, the CSRF token of a session, the PKCE check |
| `accounts.ts` | sign-up, sign-in, browser sessions, changing the password, account deletion, and the rules that slow guessing |
| `throttle.ts` | the counters behind those rules: budgets per window and waits that double |
| `oauth.ts` | the OAuth 2.1 authorization server for MCP clients |

SQL lives in `packages/db/auth.ts`; the tables are migration 2 in `packages/db/schema.ts`. Which tables hold something about a person is one list, `packages/db/person-data.ts`, that the export and the deletion both read. Nothing
here imports `node:http`: functions take plain values (an email, a cookie value, form fields) and
return plain values, so they are tested without a server (`tests/auth.test.ts`).

## The model

- **Account**: an email (lower-cased) and a password hash (`scrypt$N$r$p$salt$hash`, N = 2^15).
  Passwords are 10 to 200 characters. An unknown email costs one hash too, so the answer takes the
  same time either way.
- **Person**: each account owns exactly one `users` row with an unguessable id (`p-` and 120 random
  bits), created at sign-up from an empty template, never copied from a fixture. A `users` row
  without an account is a fictional persona of the public demo.
- **Session**: a random id in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` and the `__Host-`
  prefix over HTTPS). Only its SHA-256 is stored. It ends after 14 days idle or 30 days in total.
  Sign-in always creates a new session and ends the one the browser arrived with.
- **CSRF**: every form carries an HMAC keyed with the session id (before sign-in, with a
  pre-session cookie). A cross-site page cannot read the cookie, so it cannot compute the token.
  Form posts whose `Origin` is another site are refused as well.
- **Throttling**: guessing is slowed for whoever guesses, and no account is ever locked from
  outside. The rules are under [Throttling](#throttling) below.
- **Changing the password**: `/account`, with the current password. A wrong current password is counted for the session that sends it, on a counter of its own. On success every other session of the account ends, and so does every OAuth grant with its access and refresh tokens: each assistant has to be connected again. The browser that made the change stays signed in. There is still no reset for a forgotten password.
- **Export**: `/account` offers one JSON download (`GET /api/users/<own id>/export` gives the same) with every row stored about the person, table by table. Columns that hold hashes of secrets (password, session, tokens, codes, consent states) and sealed bank credentials are left out and named in the file. `tests/db.test.ts` fails when a table is added without being listed as person-owned or as holding nothing about a person, and when a table with a `user_id`, `account_id` or `grant_id` column is not exported and deleted.
- **Deletion**: `/account` deletes the account after the password is confirmed. The password check
  is counted for the session that sends it and has nothing to do with the sign-in counters, so
  nobody else can stand between a person and deleting their account. First the person's bank
  connections are taken out of the running sync engine (timers, retries and queued notifications
  go, and the bank reference is free again at once) and their event streams are closed; then one
  transaction removes the account, its sessions, grants, codes and tokens, and every row of its
  person: profile documents, inputs, ledger, accounts, movements, events, bank connections with
  their sealed credentials, bank consents in progress, statements imported or waiting to be
  confirmed, queued bank notifications, habit goals and check-ins.
- **Event streams** (`/api/users/<id>/bank/events/stream`) are authorised when they open. A person
  may have five open; they are closed when the person signs out, when a grant of theirs is revoked
  and when the account is deleted. A client that is still allowed connects again.

## Throttling

There is no password reset (no mail service), so a lock that a stranger can cause is a lock nobody
can lift. The design therefore never refuses a person because of what somebody else did:

| What is counted | Limit | What happens past it |
| --- | --- | --- |
| Wrong passwords for one account **from one address** | 5 free | That address waits before its next try for that account: 30 seconds, doubling with every further failure up to 15 minutes. Forgotten after an hour without a failure. |
| Wrong passwords from one address across all accounts | 20 free | The same doubling wait, for that address. |
| Wrong passwords for one account from all addresses | 100 an hour | The account turns *careful*: every address gets one wrong try and then the 15-minute wait. A right password from an address that is not waiting still signs in. |
| Wrong passwords on the delete-account form | 5 free per session | The same doubling wait, for that session only. |
| Wrong current passwords on the change-password form | 5 free per session | The same doubling wait, for that session only, on a counter apart from the delete form's. |
| Sign-ups from one address | 10 per 15 minutes | Refused until the window ends. |
| Sign-ups from everybody | 300 an hour | Refused until the window ends. |
| OAuth client registrations | 60 an hour per address, 600 an hour in all | `429` with `Retry-After`. |

A request is refused without looking at its password only when its own (account, address) pair, or
its own address, is waiting. An IPv6 visitor is one /64 network. Counter keys hold a hash of the
email, never the text somebody typed. The counters are rows of `auth_throttle`; the table is swept
every ten minutes and bounded at 50,000 rows (oldest first).

**When the server cannot tell visitors apart** (the request is counted under this machine's or a
private network's address, or the proxy's configured header is missing: see
[`CLIENT_IP_HEADER`](../../docs/areas/integration-deployment.md#client-addresses-client_ip_header-is-required-in-production)),
that address is never made to wait as an address. Sign-in is then slowed per account only, failed
sign-ins through it meet a ceiling of 300 per five minutes (a pause that ends with the window), and
sign-ups through it get 60 per 15 minutes. In production the server refuses to start in the
configuration that leads here by accident, and warns in the log and in `/health` when it happens
anyway.

What this leaves open, stated plainly:

- **Guessing is slowed, not stopped.** One address gets about five guesses an hour per account
  once it is waiting. An attacker with many addresses gets five each until the account turns
  careful, then one per address per 15 minutes; a botnet of ten thousand addresses still gets ten
  thousand guesses per quarter of an hour at one account. The 10-character minimum is the only
  other defence: there is no breached-password check, no MFA and no notification to the person.
- **A person who shares an address with an attacker waits with them.** Behind the same NAT, office
  or VPN exit, the attacker's failures for the person's own account count against the pair they
  share, and their failures across accounts against the address. The wait is at most 15 minutes.
- **While visitors cannot be told apart, a stranger can slow one person down.** Per-account
  throttling is all that is left then, so wrong passwords for a known email make that person wait
  up to 15 minutes at a time for as long as the stranger keeps going, and a sustained flood of one
  failed sign-in a second pauses sign-in for everybody behind that address. That is the reason the
  server does not start that way in production without being told to (`CLIENT_IP_HEADER=none`).
- **Sign-up and registration ceilings can be used up.** Somebody who rotates addresses can spend
  the hourly sign-up or registration budget of everybody; existing accounts and registered clients
  are not affected, and the budget returns within the hour. There is no CAPTCHA.
- **In careful mode a typo is expensive.** While an account is under a distributed attack, its
  owner gets one wrong try per address before the 15-minute wait.

## OAuth 2.1 for MCP

ReloCat is both the protected resource (`<origin>/mcp`) and its authorization server (`<origin>`),
following the MCP authorization specification, revision 2025-11-25
(<https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>), and OpenAI's
guidance for authenticated MCP servers (<https://developers.openai.com/apps-sdk/build/auth>).

| Route | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` (also `…/mcp`) | RFC 9728: `resource`, `authorization_servers`, `scopes_supported` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata; `code_challenge_methods_supported: ["S256"]` |
| `POST /oauth/register` | RFC 7591 dynamic client registration |
| `GET`/`POST /oauth/authorize` | sign-in, then a consent page that names the client, where it returns to and what it may do |
| `POST /oauth/token` | code exchange and refresh |
| `POST /oauth/revoke` | RFC 7009 revocation |

1. A client calls a personal tool without a token. `/mcp` answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="…", scope="person:read person:write"`. (`bank:manage`
   is asked for only when a tool that needs it is refused: a `403` with `error="insufficient_scope"`
   and a `scope` that adds it to what the connection has.) The body is
   the tool error with the same challenge in `_meta["mcp/www_authenticate"]`, the form ChatGPT
   documents; each tool also declares `securitySchemes` (`noauth`, `oauth2`, or both).
2. The client reads the two metadata documents and registers itself. Redirect URIs must be `https`,
   or `http` on `localhost`/`127.0.0.1`/`[::1]`, with no fragment; other schemes only when listed in
   `OAUTH_REDIRECT_SCHEMES`. Public clients (`none`) and clients with a secret
   (`client_secret_post`, `client_secret_basic`) are accepted; a secret is stored hashed.
   Registrations are budgeted per address and in all (see [Throttling](#throttling)). At most 5,000
   clients are kept: when the table is full, a new registration pushes out the oldest client that
   has no grant, so a flood of registrations evicts itself and never a client somebody uses.
3. `/oauth/authorize` requires `response_type=code`, a registered client, a `redirect_uri` that
   matches a registered one exactly, and PKCE with `code_challenge_method=S256` (a missing method
   or `plain` is refused). An unknown client or redirect URI is shown as a page and never redirected
   to. `resource`, when sent, must be this server's MCP endpoint. Every redirect back carries
   `state` and `iss` (RFC 9207).
4. `/oauth/token` checks the client, the one-time code (5 minutes), the redirect URI and the PKCE
   verifier, and issues an opaque access token (1 hour) and a refresh token (30 days). Tokens are
   random, stored only as SHA-256, and bound to the account, the client, the scopes and the
   resource. Refresh tokens rotate; presenting a used code or a used refresh token revokes the
   whole grant, since one of the two holders stole it. A refresh may send `scope` to ask for less
   than was granted (RFC 6749 section 6): the access token it gets is limited to that, while the
   new refresh token keeps the scope of the grant. Asking for more, or for no scope this server
   has, is `invalid_scope`. Malformed client credentials in `Authorization: Basic` are `401
   invalid_client`.
5. `/mcp` accepts the token only in the `Authorization` header and only when it was issued for this
   resource. A token that is not valid gets `401`, also on a public tool: it is never treated as
   anonymous.

Scopes: `person:read` (household, finances, bank summaries, habits), `person:write` (save
answers) and `bank:manage` (start connecting a bank, disconnect one, fetch movements, import a
statement after its summary, delete an imported statement). A request without `scope` gets
`person:read` only. The consent page states each scope in plain words, and for `bank:manage` adds
what it does not allow: a bank is connected only after the person approves on the bank's own page,
an assistant receives totals and states and never individual movements, and nothing moves money.
On `/api` a token reads only with `person:read`, saves answers and habits only with `person:write`
and changes bank data only with `bank:manage`.

Housekeeping runs from the server every ten minutes, whether or not anybody signs in: expired
sessions, expired codes and tokens, grants nothing can use any more (revoked, or with every code
and token expired) and clients that have no grant and were not used for 30 days.

### What could not be confirmed without a real ChatGPT connection

- Whether ChatGPT acts on the HTTP `401` + `WWW-Authenticate`, on the tool-result
  `_meta["mcp/www_authenticate"]`, or on both. The server sends both in one response.
- Where ChatGPT reads `securitySchemes`: OpenAI's pages show it both inside `_meta` and at the top
  level of the tool. The MCP SDK only lets a server set `_meta`, so that is where it is.
- The body of ChatGPT's registration request, and its exact redirect URI. The documentation names
  `https://chatgpt.com/connector_platform_oauth_redirect` for servers that return `iss`, which this
  one does; the connector's management page shows the real value.
- Client ID Metadata Documents (the method both documents prefer) are **not implemented**: they
  need the server to fetch a URL chosen by the client. Dynamic registration is offered instead.

## Deliberately missing

- **Email verification and password reset.** There is no mail service, so no email is sent
  anywhere. A person who forgets the password cannot recover the account; the sign-up page says so.
- **Multi-factor authentication** and passkeys.
- **Rate limits shared between instances.** Sign-in throttles are in the database, but the request
  limiter is in memory: correct for the single process ReloCat runs as.
- **A CAPTCHA, a breached-password check and sign-in notifications.** See what
  [Throttling](#throttling) leaves open.
- **A consent flow tested against a real bank.** A person connects a bank themselves, and the
  consent, its expiry and the sealed credential are implemented and tested against the fictional
  Banc Demo only (`apps/profile-api/BANK_API.md`). No real bank is integrated.
- **Re-authentication for sensitive changes other than the password and deletion.** Connecting or
  disconnecting a bank, importing a statement and downloading the export need the session and its
  CSRF token, not the password again.

A new account's three profile documents are written with `synthetic: false`: a person who signs up
is real. The trigger `accounts_own_real_people` (migration 3) stays behind that as a backstop and
corrects the flag for any account row, whatever wrote the documents.
