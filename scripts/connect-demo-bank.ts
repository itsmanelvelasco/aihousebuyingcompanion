import { parseArgs } from 'node:util';
import { connectDemoBank } from '../apps/demo-bank/connect.ts';
import { defaultPorts, demoBankConfig, envPort, envString } from '../packages/config/env.ts';

/**
 * `npm run demo-bank:connect [-- --user user-001 --customer cust-001]`
 *
 * Connects a running Banc Demo (`npm run start:demo-bank`) to a running ReloCat (`npm run dev`):
 * registers ReloCat's webhook at the bank, links the user to the bank customer and pulls once.
 * Safe to run again. It reads the same `.env` as both services and prints no secret.
 */
const { values } = parseArgs({
  options: {
    user: { type: 'string', default: 'user-001' },
    customer: { type: 'string', default: 'cust-001' },
  },
});

const bank = demoBankConfig();
const relocatToken = envString('PROFILE_API_TOKEN');
const missing = [
  !bank.apiKey && 'BANK_DEMO_BANK_API_KEY',
  !relocatToken && 'PROFILE_API_TOKEN (ReloCat invents a random one per start when it is unset)',
].filter(Boolean);
if (missing.length) {
  console.error(`Set ${missing.join(' and ')} in .env, restart the services and run this again.`);
  process.exit(1);
}

try {
  const result = await connectDemoBank({
    bankUrl: envString('BANK_DEMO_BANK_BASE_URL') ?? `http://127.0.0.1:${bank.port}`,
    bankApiKey: bank.apiKey!,
    relocatApiUrl: envString('PROFILE_API_URL') ?? `http://127.0.0.1:${envPort('PORT', defaultPorts.app)}/api`,
    relocatToken: relocatToken!,
    userId: values.user,
    customerId: values.customer,
    expectedSecret: envString('BANK_DEMO_BANK_WEBHOOK_SECRET'),
  });
  console.log(
    'Webhook %s at the bank: %s',
    result.webhook.created ? 'registered' : 'already registered',
    result.webhookUrl,
  );
  console.log(
    'Connection %s: %s is bank customer %s (%s)',
    result.connection.created ? 'created' : 'already there',
    result.userId,
    result.customerId,
    result.connection.id,
  );
  if (result.sync?.status === 'synced')
    console.log('First pull: %d new movements, %d updated', result.sync.inserted ?? 0, result.sync.updated ?? 0);
  for (const warning of result.warnings) console.warn('Warning: %s', warning);
  if (result.warnings.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Connecting the demo bank failed');
  process.exit(1);
}
