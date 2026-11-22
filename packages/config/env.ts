import { z } from 'zod';

/**
 * Every environment variable ReloCat reads goes through this module, so names, defaults and
 * validation live in one place. See `.env.example` for the full list.
 */
type Env = Record<string, string | undefined>;

const portSchema = z.coerce.number().int().min(0).max(65535);

/** A TCP port. Zero asks the operating system for a free one (used by tests). */
export function envPort(name: string, fallback: number, env: Env = process.env) {
  return portSchema.parse(env[name] || fallback);
}

export function envInteger(name: string, fallback: number, env: Env = process.env) {
  return z.coerce
    .number()
    .int()
    .parse(env[name] || fallback);
}

/** One variable as text. Unset and empty both read as undefined, so callers treat them as "not configured". */
export function envString(name: string, env: Env = process.env) {
  return env[name] || undefined;
}

/** An opt-in switch: only `on`, `true` or `1` enable it, so a typo leaves the feature off. */
export function envFlag(name: string, env: Env = process.env) {
  return ['on', 'true', '1'].includes((env[name] ?? '').trim().toLowerCase());
}

/** A comma-separated list with blanks removed. */
export function envList(name: string, env: Env = process.env) {
  return (env[name] ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

/** Which header, if any, states the address of the client behind a proxy. See `packages/http/rate-limit.ts`. */
export type ClientAddressSource =
  | { kind: 'auto' }
  | { kind: 'none' }
  | { kind: 'x-forwarded-for'; trustedHops: number }
  | { kind: 'header'; name: string };

/**
 * How the rate limiters learn a client's address. `CLIENT_IP_HEADER` is `auto` (default: headers are
 * believed only from a proxy on this machine), `none`, `x-forwarded-for` (with `TRUSTED_PROXY_HOPS`
 * proxies of yours in front, default 1) or the name of a single-value header your proxy overwrites,
 * such as `cf-connecting-ip`. The older `TRUST_PROXY=on` means `x-forwarded-for`.
 */
export function clientAddressConfig(env: Env = process.env): ClientAddressSource {
  const name = (env.CLIENT_IP_HEADER ?? '').trim().toLowerCase();
  const trustedHops = z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .parse(env.TRUSTED_PROXY_HOPS || 1);
  if (name === 'none') return { kind: 'none' };
  if (name === 'x-forwarded-for' || ((name === '' || name === 'auto') && env.TRUST_PROXY === 'on'))
    return { kind: 'x-forwarded-for', trustedHops };
  if (name === '' || name === 'auto') return { kind: 'auto' };
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    throw new Error('CLIENT_IP_HEADER must be auto, none, x-forwarded-for or the name of a header');
  return { kind: 'header', name };
}

/**
 * Why a public deployment must not start with its client-address setting, or null when it may.
 *
 * A public deployment is `NODE_ENV=production` or a set `PUBLIC_ORIGIN`: something terminates TLS
 * in front of the server, so the connecting address is that proxy (or the Docker bridge), not the
 * visitor. With `CLIENT_IP_HEADER` left at `auto` every visitor would then share one rate-limit
 * allowance and one sign-in budget without anybody noticing, so the operator has to say which
 * header carries the address, or say `none` to accept the shared allowance knowingly.
 */
export function clientAddressProblem(env: Env = process.env): string | null {
  const publicService = env.NODE_ENV === 'production' || Boolean(envString('PUBLIC_ORIGIN', env));
  if (!publicService || clientAddressConfig(env).kind !== 'auto') return null;
  return [
    'CLIENT_IP_HEADER is not set, and this is a public deployment (NODE_ENV=production or PUBLIC_ORIGIN).',
    'Behind a proxy or in a container the connecting address is not the visitor, so every visitor would share',
    'one rate-limit allowance. Say how the visitor address reaches this server:',
    '  CLIENT_IP_HEADER=x-forwarded-for   your reverse proxy appends it (set TRUSTED_PROXY_HOPS when there are several)',
    '  CLIENT_IP_HEADER=cf-connecting-ip  Cloudflare (or another proxy that overwrites one header) is the only way in',
    '  CLIENT_IP_HEADER=none              no proxy states it; all visitors behind a proxy are counted as one',
    'See docs/areas/integration-deployment.md.',
  ].join('\n');
}

/** Default OpenAI model IDs. Each can be overridden without touching code. */
export function openaiModels(env: Env = process.env) {
  return {
    habits: env.OPENAI_HABITS_MODEL ?? 'gpt-6.2-sol',
    classification: env.OPENAI_CLASSIFICATION_MODEL ?? 'gpt-6-luna',
    realtime: env.REALTIME_MODEL ?? 'gpt-realtime-2.1',
  };
}

/** Optional live listing search provider. Missing values disable it. */
export function listingSearchConfig(env: Env = process.env) {
  return { token: env.TREG_TOKEN, org: env.TREG_ORG };
}

/**
 * Spending guard of the paid listing search (`packages/listings/budget.ts`): paid searches allowed
 * per UTC day and per minute, and how long an identical search is answered from the cache.
 */
export function listingBudgetConfig(env: Env = process.env) {
  const count = (name: string, fallback: number) =>
    z.coerce
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .parse(env[name] || fallback);
  return {
    dailyLimit: count('LISTINGS_DAILY_LIMIT', 200),
    perMinuteLimit: count('LISTINGS_PER_MINUTE_LIMIT', 12),
    cacheTtlMs: count('LISTINGS_CACHE_SECONDS', 600) * 1000,
  };
}

/**
 * Where runtime state lives. `DATABASE_FILE` is the SQLite database; the two directories are read
 * only once, to import the JSON files that earlier versions wrote there (they are never modified).
 */
export function storageConfig(env: Env = process.env) {
  return {
    databaseFile: envString('DATABASE_FILE', env) ?? 'data/relocat.db',
    legacyProfileDir: envString('PROFILE_DATA_DIR', env) ?? 'data/runtime-users',
    legacyHabitsDir: envString('HABITS_DATA_DIR', env) ?? 'data/runtime-habits',
  };
}

export const defaultPorts = { app: 8787, interviewer: 3000, demoBank: 3003 } as const;

/**
 * Requests one client address may make per minute (`RATE_LIMIT_PER_MINUTE`). Unset: 300 on a
 * public deployment (`NODE_ENV=production` or a `PUBLIC_ORIGIN`), 3000 otherwise. On a developer's
 * machine every browser tab, the journey board (one poll a second per tab), the workspace and the
 * test tools all arrive from the one address 127.0.0.1, and 300 a minute is five board tabs.
 */
export function rateLimitConfig(env: Env = process.env) {
  const publicService = env.NODE_ENV === 'production' || Boolean(envString('PUBLIC_ORIGIN', env));
  return {
    perMinute: envInteger('RATE_LIMIT_PER_MINUTE', publicService ? 300 : 3000, env),
    webhooksPerMinute: envInteger('WEBHOOK_RATE_LIMIT_PER_MINUTE', 120, env),
  };
}

/**
 * `DATA_ENCRYPTION_KEY`: the key bank credentials are sealed with at rest, as text. Unset and empty
 * both read as undefined. `packages/banks/vault.ts` parses it (64 hex characters, or base64 of 32
 * bytes) and explains what happens without it.
 */
export function dataEncryptionKey(env: Env = process.env) {
  return envString('DATA_ENCRYPTION_KEY', env);
}

/**
 * Settings of the fictional bank service in `apps/demo-bank` (its own process). Its API key and
 * signing secret fall back to the values ReloCat's `demo-bank` provider reads, so one `.env` can
 * configure both ends of a local demo.
 */
export function demoBankConfig(env: Env = process.env) {
  return {
    port: envPort('DEMO_BANK_PORT', defaultPorts.demoBank, env),
    /**
     * Milliseconds between simulated movements. `DEMO_BANK_TICK_MS` is the bank's own variable;
     * `DEMO_BANK_INTERVAL_MS`, which also paces ReloCat's in-process synthetic feed, is read when
     * it is unset so that older `.env` files keep working.
     */
    intervalMs: z.coerce
      .number()
      .int()
      .min(100)
      .max(3_600_000)
      .parse(env.DEMO_BANK_TICK_MS || env.DEMO_BANK_INTERVAL_MS || 5000),
    seed: envString('DEMO_BANK_SEED', env),
    /** First simulated day, `YYYY-MM-DD`. Unset: three months before today. */
    startDate: envString('DEMO_BANK_START_DATE', env),
    customers: envInteger('DEMO_BANK_CUSTOMERS', 4, env),
    apiKey: envString('DEMO_BANK_API_KEY', env) ?? envString('BANK_DEMO_BANK_API_KEY', env),
    /** Key of the bank's `/simulate` routes. Unset: the API key. */
    adminKey: envString('DEMO_BANK_ADMIN_KEY', env),
    /** Fixed webhook signing secret. Unset: the bank invents one per subscription. */
    webhookSecret: envString('DEMO_BANK_WEBHOOK_SECRET', env) ?? envString('BANK_DEMO_BANK_WEBHOOK_SECRET', env),
    snapshotFile: envString('DEMO_BANK_SNAPSHOT_FILE', env),
    allowRemoteWebhooks: envFlag('DEMO_BANK_ALLOW_REMOTE_WEBHOOKS', env),
  };
}

/** Text with a default. Unset and empty both take the default, so `HOST=` does not bind every interface. */
export function envText(name: string, fallback: string, env: Env = process.env) {
  return env[name]?.trim() || fallback;
}

/** `PUBLIC_ORIGIN` as an origin without a trailing slash, or null when unset or empty. A bad URL throws. */
export function publicOriginConfig(env: Env = process.env) {
  const value = envString('PUBLIC_ORIGIN', env);
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('PUBLIC_ORIGIN must be an http(s) URL');
  return url.origin;
}

const demoPersonaIds = ['user-001', 'user-002', 'user-003', 'user-004'];

/**
 * Accounts, the public demo and the surfaces a deployment exposes.
 *
 * - `PUBLIC_DEMO`: the four fictional personas are readable without an account. On by default
 *   outside production; in production only when set to `on`.
 * - `DEMO_USER_IDS`: the only ids the demo may ever read. Default: the four personas.
 * - `SHARED_BOARD`: one journey board everybody follows. A local convenience: on by default only
 *   outside production and without a `PUBLIC_ORIGIN`.
 * - `ALLOWED_HOSTS`: extra `Host` values accepted besides the public origin and localhost.
 * - `OAUTH_REDIRECT_SCHEMES`: private-use redirect schemes accepted from OAuth clients (for example `cursor`).
 */
export function accessConfig(env: Env = process.env) {
  const production = env.NODE_ENV === 'production';
  const explicit = (name: string) => {
    const value = (env[name] ?? '').trim().toLowerCase();
    return value === '' ? undefined : ['on', 'true', '1'].includes(value);
  };
  return {
    production,
    publicDemo: explicit('PUBLIC_DEMO') ?? !production,
    demoUserIds: envList('DEMO_USER_IDS', env).length ? envList('DEMO_USER_IDS', env) : demoPersonaIds,
    sharedBoard: explicit('SHARED_BOARD') ?? (!production && !envString('PUBLIC_ORIGIN', env)),
    allowedHosts: envList('ALLOWED_HOSTS', env).map(host => host.toLowerCase()),
    signUps: explicit('SIGNUPS') ?? true,
    oauthRedirectSchemes: envList('OAUTH_REDIRECT_SCHEMES', env),
  };
}
