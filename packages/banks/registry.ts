import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { envString } from '../config/env.ts';
import type { BankProvider } from './provider.ts';
import { defineBankProvider, supportsWebhooks } from './provider.ts';

/** Where provider files live. Every `*.ts` here is loaded, except names starting with `_`. */
export const providersDirectory = join(import.meta.dirname, 'providers');

type Env = Record<string, string | undefined>;

/** A loaded provider with the state of its environment variables. */
export type RegisteredProvider = {
  provider: BankProvider;
  /** `unconfigured` means a required variable is missing; the provider is listed but cannot sync. */
  status: 'configured' | 'unconfigured';
  missingEnv: string[];
  /** Values of the declared variables that are set. Passed to provider functions, never listed. */
  env: Readonly<Record<string, string>>;
};

/** A provider file that could not be loaded. Reported in the listing instead of stopping the server. */
export type ProviderLoadError = { file: string; message: string };

export type BankRegistry = {
  get(providerId: string): RegisteredProvider | undefined;
  /** Public description of every provider: names and whether variables are set, never their values. */
  list(): ReturnType<typeof describeProvider>[];
  loadErrors: ProviderLoadError[];
};

/** Resolve the declared variables of a provider from the environment. */
function register(provider: BankProvider, env: Env): RegisteredProvider {
  const values: Record<string, string> = {};
  const missingEnv: string[] = [];
  for (const variable of provider.env) {
    const value = envString(variable.name, env);
    if (value) values[variable.name] = value;
    else if (variable.required !== false) missingEnv.push(variable.name);
  }
  return { provider, status: missingEnv.length ? 'unconfigured' : 'configured', missingEnv, env: values };
}

function describeProvider({ provider, status, env }: RegisteredProvider) {
  return {
    id: provider.id,
    displayName: provider.displayName,
    synthetic: provider.synthetic,
    status,
    webhooks: supportsWebhooks(provider),
    pollIntervalMs: provider.pollIntervalMs ?? null,
    env: provider.env.map(variable => ({
      name: variable.name,
      description: variable.description,
      required: variable.required !== false,
      set: variable.name in env,
    })),
  };
}

/** Build a registry from provider objects. Tests use this to plug in a fake bank. */
export function createBankRegistry(
  providers: readonly BankProvider[],
  env: Env = process.env,
  loadErrors: ProviderLoadError[] = [],
): BankRegistry {
  const entries = new Map<string, RegisteredProvider>();
  for (const provider of providers) {
    defineBankProvider(provider);
    if (entries.has(provider.id)) throw new Error(`Duplicate bank provider ID: ${provider.id}`);
    entries.set(provider.id, register(provider, env));
  }
  return {
    get: providerId => entries.get(providerId),
    list: () => [...entries.values()].map(describeProvider),
    loadErrors,
  };
}

/** True for files the registry loads: TypeScript sources that are not templates, helpers or tests. */
function isProviderFile(name: string) {
  return name.endsWith('.ts') && !name.startsWith('_') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');
}

/**
 * Discover providers: import every provider file of a directory and register its default export.
 * A file that fails to load or exports something else is reported in `loadErrors`, and a second
 * file declaring an ID that is already taken is skipped the same way.
 */
export async function loadBankRegistry(options: { directory?: string; env?: Env } = {}): Promise<BankRegistry> {
  const directory = options.directory ?? providersDirectory;
  const files = (await readdir(directory)).filter(isProviderFile).sort();
  const providers: BankProvider[] = [];
  const loadErrors: ProviderLoadError[] = [];
  for (const file of files) {
    try {
      const module = (await import(pathToFileURL(join(directory, file)).href)) as { default?: BankProvider };
      const provider = module.default;
      if (!provider || typeof provider.listAccounts !== 'function' || typeof provider.fetchTransactions !== 'function')
        throw new Error('The default export must be a defineBankProvider({ ... }) result');
      defineBankProvider(provider);
      if (providers.some(other => other.id === provider.id)) throw new Error(`Duplicate provider ID: ${provider.id}`);
      providers.push(provider);
    } catch (error) {
      loadErrors.push({ file, message: error instanceof Error ? error.message : 'Unknown load failure' });
    }
  }
  return createBankRegistry(providers, options.env, loadErrors);
}
