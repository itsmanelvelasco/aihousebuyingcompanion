# packages/auth: accounts, sessions and OAuth for MCP

Every stored person belongs to an account, and nothing reads or writes a person without that
account's authority. This package holds the logic; `apps/server` holds the HTTP routes and pages.

| File | What it holds |
| --- | --- |
| `passwords.ts` | scrypt hashing (`node:crypto`), a random salt per password, constant-time verification |
| `secrets.ts` | random secrets, their SHA-256 hashes, the CSRF token of a session, the PKCE check |
| `accounts.ts` | sign-up, sign-in, throttling, browser sessions, account deletion |
| `oauth.ts` | the OAuth 2.1 authorization server for MCP clients |

SQL lives in `packages/db/auth.ts`; the tables are migration 2 in `packages/db/schema.ts`. Nothing
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
- **Throttling**: failed sign-ins are counted per account (5) and per address (20) in a 15-minute
  window; reaching the limit locks that key for 15 minutes. Sign-ups are limited per address. The
  counters are rows of `auth_throttle`.
- **Deletion**: `/account` deletes the account after the password is confirmed. One transaction
  removes the account, its sessions, grants, codes and tokens, and every row of its person: profile
  documents, inputs, ledger, accounts, movements, events, bank connections, queued bank
  notifications, habit goals and check-ins.

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
   `WWW-Authenticate: Bearer resource_metadata="…", scope="person:read person:write"`. The body is
   the tool error with the same challenge in `_meta["mcp/www_authenticate"]`, the form ChatGPT
   documents; each tool also declares `securitySchemes` (`noauth`, `oauth2`, or both).
2. The client reads the two metadata documents and registers itself. Redirect URIs must be `https`,
   or `http` on `localhost`/`127.0.0.1`/`[::1]`, with no fragment; other schemes only when listed in
   `OAUTH_REDIRECT_SCHEMES`. Public clients (`none`) and clients with a secret
   (`client_secret_post`, `client_secret_basic`) are accepted; a secret is stored hashed.
3. `/oauth/authorize` requires `response_type=code`, a registered client, a `redirect_uri` that
   matches a registered one exactly, and PKCE with `code_challenge_method=S256` (a missing method
   or `plain` is refused). An unknown client or redirect URI is shown as a page and never redirected
   to. `resource`, when sent, must be this server's MCP endpoint. Every redirect back carries
   `state` and `iss` (RFC 9207).
4. `/oauth/token` checks the client, the one-time code (5 minutes), the redirect URI and the PKCE
   verifier, and issues an opaque access token (1 hour) and a refresh token (30 days). Tokens are
   random, stored only as SHA-256, and bound to the account, the client, the scopes and the
   resource. Refresh tokens rotate; presenting a used code or a used refresh token revokes the
   whole grant, since one of the two holders stole it.
5. `/mcp` accepts the token only in the `Authorization` header and only when it was issued for this
   resource. A token that is not valid gets `401`, also on a public tool: it is never treated as
   anonymous.

Scopes: `person:read` (household, finances, bank summaries, habits) and `person:write` (save
answers). A request without `scope` gets `person:read` only.

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
- **A person-facing export** of stored data; `/account` shows it and can delete it.
- **Consent for real bank connections.** A person's own credential cannot create bank connections
  or start a feed through `/api`; that stays with the operator's token.
- **An honest storage flag.** The input and profile contracts (`packages/contracts/inputs.ts`,
  `packages/profiles/store.ts`) still require `synthetic: true` on every stored record. Records of
  an account's person are therefore stored with that literal, and the truth is stated at the
  boundary instead: a person owned by an account is reported with `synthetic: false` by the tools
  and by `/api/users/<id>/context`. The contracts should accept `false` and the stores should
  write it.
