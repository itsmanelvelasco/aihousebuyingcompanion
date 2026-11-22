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

/** Two variables that only make sense together, such as a service URL and its token. */
export function envPair(first: string, second: string, purpose: string, env: Env = process.env) {
  const a = env[first];
  const b = env[second];
  if (!a && !b) return null;
  if (!a || !b) throw new Error(`Set both ${first} and ${second} ${purpose}`);
  return [a, b] as const;
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

export const defaultPorts = { app: 8787, profileApi: 3001, habits: 3002, interviewer: 3000, demoBank: 3003 } as const;

/**
 * Settings of the fictional bank service in `apps/demo-bank` (its own process). Its API key and
 * signing secret fall back to the values ReloCat's `demo-bank` provider reads, so one `.env` can
 * configure both ends of a local demo.
 */
export function demoBankConfig(env: Env = process.env) {
  return {
    port: envPort('DEMO_BANK_PORT', defaultPorts.demoBank, env),
    /** Milliseconds between simulated movements. */
    intervalMs: z.coerce
      .number()
      .int()
      .min(100)
      .max(3_600_000)
      .parse(env.DEMO_BANK_INTERVAL_MS || 5000),
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
