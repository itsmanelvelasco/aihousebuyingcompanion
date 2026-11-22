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

export const defaultPorts = { app: 8787, profileApi: 3001, habits: 3002, interviewer: 3000 } as const;
