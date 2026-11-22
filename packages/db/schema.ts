/**
 * The schema as forward-only migrations. Never edit a migration that has shipped: add the next one.
 *
 * Conventions: integer cents stay integers, booleans are 0/1, dates are `YYYY-MM-DD` text and
 * timestamps are ISO 8601 text (the same strings the API returns). The `synthetic` flag is kept
 * per record, exactly as it arrived. Tables are `STRICT`, so a value of the wrong type is refused.
 */
export type Migration = { version: number; name: string; sql: string };

const initial = `
  -- One-off markers, such as "the legacy JSON files were imported".
  CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE users (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    created_at TEXT NOT NULL
  ) STRICT;

  -- The three profile documents are schemaless on purpose (teams add fields), so each is one JSON value.
  CREATE TABLE profile_sections (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    section TEXT NOT NULL CHECK (section IN ('details', 'preferences', 'bank-account')),
    synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
    document TEXT NOT NULL CHECK (json_valid(document)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, section)
  ) STRICT, WITHOUT ROWID;

  -- Versioned multi-source inputs. Provenance is in columns; the partial answers are one JSON object.
  CREATE TABLE input_records (
    row_id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
    synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
    data TEXT NOT NULL CHECK (json_valid(data)),
    UNIQUE (user_id, id)
  ) STRICT;

  -- Head of a user's ledger: the revision counter and when it last changed.
  CREATE TABLE bank_ledgers (
    user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE bank_accounts (
    row_id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    opening_balance_cents INTEGER NOT NULL,
    opening_date TEXT NOT NULL,
    synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
    UNIQUE (user_id, id)
  ) STRICT;
  CREATE INDEX bank_accounts_real ON bank_accounts (user_id) WHERE synthetic = 0;

  CREATE TABLE bank_transactions (
    row_id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
    currency TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('booked', 'pending')),
    synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, account_id) REFERENCES bank_accounts (user_id, id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX bank_transactions_by_date ON bank_transactions (user_id, date, id);
  CREATE INDEX bank_transactions_by_account ON bank_transactions (user_id, account_id, date);
  CREATE INDEX bank_transactions_real ON bank_transactions (user_id) WHERE synthetic = 0;

  -- One row per ledger revision; sequence equals the revision it produced. The newest 500 are kept.
  CREATE TABLE bank_events (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    occurred_at TEXT NOT NULL,
    type TEXT NOT NULL,
    account_count INTEGER NOT NULL,
    transaction_count INTEGER NOT NULL,
    synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
    PRIMARY KEY (user_id, sequence)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE bank_connections (
    row_id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    created_at TEXT NOT NULL,
    cursor TEXT,
    poll_interval_ms INTEGER,
    last_sync_at TEXT,
    last_error TEXT,
    last_attempt_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    UNIQUE (user_id, id),
    -- A bank reference belongs to one connection, whoever asks and from whichever process.
    UNIQUE (provider_id, ref)
  ) STRICT;

  -- Verified webhooks waiting for their sync: at most one per connection reference.
  -- AUTOINCREMENT keeps seq strictly increasing even after rows are deleted.
  CREATE TABLE bank_webhook_queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    received_at TEXT NOT NULL,
    UNIQUE (provider_id, ref)
  ) STRICT;

  -- Notification IDs already accepted, oldest first. The newest 2000 are kept.
  CREATE TABLE bank_webhook_seen (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    UNIQUE (provider_id, event_id)
  ) STRICT;

  CREATE TABLE habit_goals (
    row_id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    action TEXT NOT NULL,
    category TEXT NOT NULL,
    target_days_per_week INTEGER NOT NULL CHECK (target_days_per_week BETWEEN 1 AND 7),
    planned_monthly_saving_cents INTEGER,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    UNIQUE (user_id, id)
  ) STRICT;

  CREATE TABLE habit_checkins (
    row_id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    date TEXT NOT NULL,
    completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
    note TEXT,
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, goal_id) REFERENCES habit_goals (user_id, id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX habit_checkins_by_goal ON habit_checkins (user_id, goal_id, date);

  -- Attempts of paid AI calls per scope and day (today: scope 'openai-habits').
  CREATE TABLE ai_usage (
    scope TEXT NOT NULL,
    day TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    PRIMARY KEY (scope, day)
  ) STRICT, WITHOUT ROWID;

  -- Scripted board runs. The scene state is a small schemaless JSON object owned by apps/board.
  CREATE TABLE board_runs (
    id TEXT PRIMARY KEY,
    pair_code TEXT NOT NULL UNIQUE,
    persona TEXT NOT NULL,
    state TEXT NOT NULL CHECK (json_valid(state)),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    shared INTEGER NOT NULL CHECK (shared IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  -- There is one shared board at most.
  CREATE UNIQUE INDEX board_runs_shared ON board_runs (shared) WHERE shared = 1;
  CREATE INDEX board_runs_expiry ON board_runs (expires_at);
`;

/**
 * Accounts, browser sessions and OAuth. A person record (`users` row) may belong to one account;
 * a `users` row without an account is a fixture of the public demo. Secrets are never stored:
 * passwords are scrypt hashes, session ids, authorization codes and tokens are SHA-256 hashes.
 */
const accounts = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    -- Lower-cased and trimmed by packages/auth before it is stored or compared.
    email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
    password_hash TEXT NOT NULL,
    -- The one person this account owns. Deleting the account deletes that users row in the same transaction.
    user_id TEXT NOT NULL UNIQUE REFERENCES users (id),
    created_at TEXT NOT NULL,
    last_login_at TEXT
  ) STRICT;

  CREATE TABLE auth_sessions (
    id_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    -- Absolute end of the session; the idle limit is applied to last_seen_at.
    expires_at TEXT NOT NULL
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX auth_sessions_by_account ON auth_sessions (account_id);

  -- Failed sign-ins per key ('account:<email>' or 'address:<ip>') in a fixed window.
  CREATE TABLE auth_throttle (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL CHECK (failures >= 0),
    window_start TEXT NOT NULL,
    locked_until TEXT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    -- NULL for a public client (PKCE only).
    secret_hash TEXT,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris)),
    auth_method TEXT NOT NULL CHECK (auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
    created_at TEXT NOT NULL,
    last_used_at TEXT
  ) STRICT;

  -- One row per consent: an account letting a client act for it. Revoking it ends every token below it.
  CREATE TABLE oauth_grants (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    scopes TEXT NOT NULL,
    resource TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;
  CREATE INDEX oauth_grants_by_account ON oauth_grants (account_id);

  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    -- Set at the exchange. A second exchange revokes the grant.
    used_at TEXT
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    -- A refresh token is used once; presenting it again revokes the grant.
    used_at TEXT
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX oauth_tokens_by_grant ON oauth_tokens (grant_id);
  CREATE INDEX oauth_tokens_expiry ON oauth_tokens (expires_at);
`;

export const migrations: readonly Migration[] = [
  { version: 1, name: 'initial runtime schema', sql: initial },
  { version: 2, name: 'accounts, sessions and oauth', sql: accounts },
];
