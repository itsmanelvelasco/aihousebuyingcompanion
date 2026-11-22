import { randomBytes } from 'node:crypto';
import type { BankProvider } from '../../packages/banks/provider.ts';
import { defineBankProvider } from '../../packages/banks/provider.ts';
import { createBankRegistry } from '../../packages/banks/registry.ts';
import { createVault } from '../../packages/banks/vault.ts';
import { ApiError } from '../../packages/http/server.ts';

/** A vault with a random key, as a deployment with `DATA_ENCRYPTION_KEY` has. */
export const testVault = () => createVault(randomBytes(32));

/**
 * A bank that people connect by consenting at the bank, without any HTTP: the test plays the bank.
 *
 *   - `beginConsent` hands out a page address that carries the state, as a bank would.
 *   - The test "approves at the bank" by presenting a code from `logins` on the callback; each code
 *     stands for one bank login and maps to the credential the bank returns for it.
 *   - The provider records every reference the engine hands it, so a test can see that the stored
 *     credential came back out decrypted.
 *
 * It is `synthetic: false`: what it returns is treated as real bank data.
 */
export function consentBank(options: { webhooks?: boolean } = {}) {
  const state = {
    /** code presented on the callback -> credential the bank returns */
    logins: new Map<string, string>([
      ['code-ada', 'CREDENTIAL-ada-7f3c9b1e'],
      ['code-bob', 'CREDENTIAL-bob-52aa0d4c'],
    ]),
    /** What `completeConsent` reports as the end of the consent; undefined leaves it out. */
    expiresAt: undefined as string | null | undefined,
    begun: [] as { returnUrl: string; state: string }[],
    completed: 0,
    /** References the engine passed to the provider when syncing. */
    refsSeen: [] as string[],
    fetches: 0,
    movements: 1,
  };
  const provider = defineBankProvider({
    id: 'consent-bank',
    displayName: 'Consent Bank',
    synthetic: false,
    env: [],
    ...(options.webhooks === false ? { pollIntervalMs: 3_600_000 } : {}),
    consent: {
      async beginConsent(request) {
        state.begun.push(request);
        const page = new URL('https://bank.example/authorize');
        page.searchParams.set('state', request.state);
        page.searchParams.set('redirect_uri', request.returnUrl);
        return { redirectUrl: page.href };
      },
      async completeConsent(params) {
        state.completed++;
        const credential = state.logins.get(params.code ?? '');
        if (!credential) throw new ApiError(502, 'Consent Bank refused the code');
        return state.expiresAt === undefined ? { ref: credential } : { ref: credential, expiresAt: state.expiresAt };
      },
    },
    async listAccounts(connection) {
      state.refsSeen.push(connection.ref);
      return [
        {
          id: 'cb-main',
          name: 'Main account',
          currency: 'EUR' as const,
          openingBalanceCents: 0,
          openingDate: '2026-01-01',
        },
      ];
    },
    async fetchTransactions() {
      state.fetches++;
      return {
        transactions: Array.from({ length: state.movements }, (_, index) => ({
          id: `cb-movement-${index + 1}`,
          accountId: 'cb-main',
          date: '2026-11-02',
          description: `Consent Bank movement ${index + 1}`,
          amountCents: -1250,
          category: 'food' as const,
          status: 'booked' as const,
        })),
      };
    },
    ...(options.webhooks === false
      ? {}
      : {
          verifyWebhook: ({ headers }: { headers: Readonly<Record<string, string | string[] | undefined>> }) =>
            headers['x-consent-bank'] === 'signed',
          parseWebhook(rawBody: string) {
            const body = JSON.parse(rawBody) as { credential?: unknown };
            return typeof body.credential === 'string' ? { connectionRef: body.credential } : null;
          },
        }),
  });
  /** The state the engine gave the bank for the newest consent, as the bank would send it back. */
  const lastState = () => state.begun[state.begun.length - 1]?.state ?? '';
  return {
    provider,
    state,
    lastState,
    registry: (extra: BankProvider[] = []) => createBankRegistry([provider, ...extra], {}),
  };
}
