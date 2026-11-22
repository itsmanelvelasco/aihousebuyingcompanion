import { z } from 'zod';
import { secretFingerprint } from './bank.ts';

/**
 * Wire a running Banc Demo to a running ReloCat, over HTTP only, the way an operator would with a
 * real bank: register ReloCat's webhook URL at the bank, link a ReloCat user to a bank customer and
 * pull once. Every step first looks at what already exists, so running it again changes nothing.
 */

export type ConnectDemoBankOptions = {
  /** Origin of the demo bank, for example `http://127.0.0.1:3003`. */
  bankUrl: string;
  bankApiKey: string;
  /** Base URL of ReloCat's API, for example `http://127.0.0.1:8787/api`. */
  relocatApiUrl: string;
  /** ReloCat's `PROFILE_API_TOKEN`. */
  relocatToken: string;
  /** Where the bank must call. Default: `<relocatApiUrl>/webhooks/bank/demo-bank`. */
  webhookUrl?: string;
  /** ReloCat user to link. Default `user-001`. */
  userId?: string;
  /** Bank customer behind the link. Default `cust-001`. */
  customerId?: string;
  /**
   * The secret ReloCat verifies with, when the caller knows it. A webhook at the bank that signs
   * with another secret (ReloCat was restarted with a new one) gets this one set, so deliveries
   * are accepted again.
   */
  expectedSecret?: string;
};

const webhooksSchema = z.object({
  webhooks: z.array(z.object({ id: z.string(), url: z.string(), secret_fingerprint: z.string().optional() })),
});
const createdWebhookSchema = z.object({ id: z.string(), signing_secret: z.string() });
const providersSchema = z.object({
  providers: z.array(
    z.object({ id: z.string(), status: z.string(), env: z.array(z.object({ name: z.string(), set: z.boolean() })) }),
  ),
});
const connectionsSchema = z.object({ connections: z.array(z.object({ id: z.string(), providerId: z.string() })) });
const connectionSchema = z.object({ id: z.string() });
const syncSchema = z.object({
  results: z.array(
    z.object({
      status: z.string(),
      inserted: z.number().optional(),
      updated: z.number().optional(),
      error: z.string().optional(),
    }),
  ),
});

/** One JSON request. A non-2xx answer becomes an error that names the service and the status only. */
async function call<T>(
  service: string,
  url: string,
  key: string,
  schema: z.ZodType<T>,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`${service} is not reachable at ${new URL(url).origin}`);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = z.object({ error: z.string() }).safeParse(data);
    throw new Error(`${service} answered ${response.status}${reason.success ? `: ${reason.data.error}` : ''}`);
  }
  return schema.parse(data);
}

export async function connectDemoBank(options: ConnectDemoBankOptions) {
  const bankUrl = options.bankUrl.replace(/\/+$/, '');
  const apiUrl = options.relocatApiUrl.replace(/\/+$/, '');
  const webhookUrl = new URL(options.webhookUrl ?? `${apiUrl}/webhooks/bank/demo-bank`).href;
  const userId = options.userId ?? 'user-001';
  const customerId = options.customerId ?? 'cust-001';
  const warnings: string[] = [];
  const bank = <T>(path: string, schema: z.ZodType<T>, method?: string, body?: unknown) =>
    call('Banc Demo', `${bankUrl}${path}`, options.bankApiKey, schema, method, body);
  const relocat = <T>(path: string, schema: z.ZodType<T>, method?: string, body?: unknown) =>
    call('ReloCat', `${apiUrl}${path}`, options.relocatToken, schema, method, body);

  // 1. ReloCat must have the provider configured, or it would refuse both the link and the webhooks.
  const provider = (await relocat('/bank/providers', providersSchema)).providers.find(item => item.id === 'demo-bank');
  if (!provider) throw new Error('ReloCat does not list the demo-bank provider');
  if (provider.status !== 'configured') {
    const missing = provider.env.filter(variable => !variable.set).map(variable => variable.name);
    throw new Error(`ReloCat's demo-bank provider is not configured; set ${missing.join(', ')} and restart it`);
  }

  // 2. The webhook subscription at the bank, signing with the secret ReloCat verifies with.
  const existing = (await bank('/webhooks', webhooksSchema)).webhooks.find(webhook => webhook.url === webhookUrl);
  const webhook = { id: existing?.id ?? '', created: false, secretReplaced: false };
  let secretMatches =
    !options.expectedSecret || existing?.secret_fingerprint === secretFingerprint(options.expectedSecret);
  if (!existing) {
    const created = await bank('/webhooks', createdWebhookSchema, 'POST', { url: webhookUrl });
    webhook.id = created.id;
    webhook.created = true;
    secretMatches = !options.expectedSecret || created.signing_secret === options.expectedSecret;
  }
  if (!secretMatches) {
    try {
      await bank(`/webhooks/${webhook.id}/secret`, createdWebhookSchema, 'PUT', {
        signing_secret: options.expectedSecret,
      });
      webhook.secretReplaced = true;
    } catch (error) {
      warnings.push(
        `The bank signs with a secret that differs from BANK_DEMO_BANK_WEBHOOK_SECRET and it could not be replaced (${
          error instanceof Error ? error.message : 'unknown error'
        }): webhooks will be rejected and only pulls will work.`,
      );
    }
  }

  // 3. The user's link to the bank customer.
  const linked = (await relocat(`/users/${userId}/bank/connections`, connectionsSchema)).connections.find(
    item => item.providerId === 'demo-bank',
  );
  let connection = { id: linked?.id ?? '', created: false };
  if (!linked) {
    const created = await relocat(`/users/${userId}/bank/connections`, connectionSchema, 'POST', {
      providerId: 'demo-bank',
      ref: customerId,
    });
    connection = { id: created.id, created: true };
  }

  // 4. A first pull, so the history is there before the first webhook arrives.
  const sync = (await relocat(`/users/${userId}/bank/sync`, syncSchema, 'POST', { connectionId: connection.id }))
    .results[0];
  if (sync?.status !== 'synced') warnings.push(`The first pull failed: ${sync?.error ?? 'no result'}`);

  return { webhookUrl, userId, customerId, webhook, connection, sync, warnings };
}
