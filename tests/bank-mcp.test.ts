import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBankTools } from '../apps/mcp-server/bank-tools.ts';
import type { Caller, OwnBank, PersonReader, PersonWriter } from '../apps/mcp-server/identity.ts';
import { personalTools } from '../apps/mcp-server/identity.ts';
import { analyzeTransactions } from '../packages/finance/cashflow.ts';
import { ApiError } from '../packages/http/server.ts';

/** The tools that act on the caller's own bank data, and whether each changes something. */
const ownBankTools = {
  list_connectable_banks: false,
  list_my_bank_connections: false,
  get_my_bank_accounts: false,
  list_my_statement_imports: false,
  connect_my_bank: true,
  disconnect_my_bank: true,
  sync_my_bank: true,
  preview_statement_import: true,
  confirm_statement_import: true,
  delete_statement_import: true,
};
const readingTools = ['get_bank_runtime', 'get_bank_summary', 'get_bank_updates'];

/** A person handle whose store answers carry fields the tools must never pass on. */
function person(
  userId: string,
  /** `records`: whether the bank records are fabricated; the person's own flag when omitted. */
  options: { synthetic: boolean; records?: boolean; feedOff?: boolean; broken?: 'throws' | 'invalid' },
): PersonWriter {
  const calls: string[] = [];
  const records = options.records ?? options.synthetic;
  const guard = () => {
    if (options.broken === 'throws') throw new Error('secret-token upstream stack at https://internal.example');
  };
  const reader: PersonReader & { calls: string[] } = {
    userId,
    synthetic: options.synthetic,
    calls,
    context: async () => null,
    inputs: async () => ({ inputs: [] }),
    habits: async () => ({}),
    bankBalanceCents: async () => null,
    async bankUpdates(after, limit) {
      calls.push(`updates:${after}:${limit}`);
      guard();
      if (options.broken === 'invalid') return { synthetic: false };
      return {
        synthetic: records,
        events: [
          {
            sequence: 3,
            occurredAt: '2026-11-21T12:00:00Z',
            type: 'bank.updated',
            accountCount: 1,
            transactionCount: 8,
            token: 'secret-token',
          },
        ],
        latestRevision: 3,
        nextCursor: 3,
        requiresRefresh: false,
        hasMore: false,
        token: 'secret-token',
      };
    },
    async bankRuntime() {
      guard();
      return {
        synthetic: true,
        userId,
        enabled: !options.feedOff,
        intervalMs: 5000,
        lastTickAt: null,
        lastError: options.feedOff ? null : 'secret-token upstream stack',
        tickCount: options.feedOff ? 0 : 2,
      };
    },
    async bankSummary({ from, to }) {
      guard();
      return {
        ...analyzeTransactions([], from, to),
        synthetic: records,
        recurringExpenses: [
          {
            category: 'subscriptions',
            observedMonths: ['2026-09', '2026-10'],
            occurrenceCount: 2,
            averagePaymentCents: 1000,
            status: 'candidate_needs_confirmation',
            description: 'private-merchant',
            accountId: 'private-account',
          },
        ],
        transactions: [{ secret: true }],
        token: 'secret-token',
      };
    },
  };
  return Object.assign(reader, { saveInputs: async () => ({ inserted: 0, duplicates: 0 }) });
}

async function connect(caller: Caller) {
  const server = new McpServer({ name: 'bank-test', version: '1' });
  registerBankTools(server, caller);
  const client = new Client({ name: 'test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test('bank tools read the caller’s own ledger, take no user id and never pass on store internals', async () => {
  const me = person('p-me', { synthetic: false });
  const demoPersona = person('user-001', { synthetic: true });
  const { client, close } = await connect({
    me,
    scopes: ['person:read'],
    demo: { ids: ['user-001'], open: id => (id === 'user-001' ? demoPersona : null) },
  });
  try {
    const list = await client.listTools();
    assert.deepEqual(
      list.tools.map(tool => tool.name).sort(),
      [
        ...readingTools,
        'get_demo_bank_runtime',
        'get_demo_bank_summary',
        'get_demo_bank_updates',
        ...Object.keys(ownBankTools),
      ].sort(),
    );
    // Only the tools that manage the caller's own bank data change anything; every demo tool reads.
    for (const tool of list.tools)
      assert.equal(
        tool.annotations?.readOnlyHint,
        !(ownBankTools as Record<string, boolean>)[tool.name],
        `${tool.name} readOnlyHint`,
      );
    assert(list.tools.filter(tool => tool.name.includes('demo')).every(tool => tool.annotations?.readOnlyHint));
    for (const tool of list.tools)
      assert(!('userId' in (tool.inputSchema.properties ?? {})), `${tool.name} takes a userId`);

    const updates = await client.callTool({ name: 'get_bank_updates', arguments: { after: 2 } });
    assert(!updates.isError);
    assert.equal((updates.structuredContent as Record<string, unknown>)?.nextCursor, 3);
    assert(!JSON.stringify(updates).includes('secret-token'));
    assert.deepEqual((me as unknown as { calls: string[] }).calls, ['updates:2:50']);
    assert.equal(
      (updates.structuredContent as Record<string, unknown>)?.synthetic,
      false,
      'the flag is passed through',
    );
    assert.match(JSON.stringify(updates.content), /real bank data/);
    assert.doesNotMatch(JSON.stringify(updates.content), /synthetic demo data/);

    // A user id from the model is not an argument: the call is refused and reads nothing.
    const named = await client.callTool({ name: 'get_bank_updates', arguments: { userId: 'user-001' } });
    assert(named.isError);
    assert.equal((me as unknown as { calls: string[] }).calls.length, 1);

    const demoUpdates = await client.callTool({ name: 'get_demo_bank_updates', arguments: { demoId: 'user-001' } });
    assert(!demoUpdates.isError);
    assert.equal((demoUpdates.structuredContent as Record<string, unknown>)?.synthetic, true);
    assert.match(JSON.stringify(demoUpdates.content), /synthetic demo data/);
    const outside = await client.callTool({ name: 'get_demo_bank_updates', arguments: { demoId: 'p-me' } });
    assert(outside.isError, 'only the allowlisted demo ids can be named');

    const runtime = await client.callTool({ name: 'get_bank_runtime', arguments: {} });
    assert(!runtime.isError);
    assert.equal(
      (runtime.structuredContent as Record<string, unknown>)?.lastError,
      'Background bank feed needs attention.',
    );
    const summary = await client.callTool({
      name: 'get_bank_summary',
      arguments: { from: '2026-10-01', to: '2026-10-31' },
    });
    assert(!summary.isError);
    assert.equal((summary.structuredContent as Record<string, unknown>)?.dataStatus, 'unknown');
    for (const leaked of ['secret-token', 'private-merchant', 'private-account'])
      assert(!JSON.stringify(summary).includes(leaked), leaked);
    assert(!('transactions' in (summary.structuredContent as Record<string, unknown>)));
    const badRange = await client.callTool({
      name: 'get_bank_summary',
      arguments: { from: '2026-10-02', to: '2026-10-31' },
    });
    assert(badRange.isError);
  } finally {
    await close();
  }
});

test('a real person with a fictional bank is told exactly that: a real profile, synthetic movements', async () => {
  const text = (result: unknown) => JSON.stringify((result as { content: unknown }).content);
  const period = { from: '2026-10-01', to: '2026-10-31' };
  // A person who belongs to an account, connected to the fictional demo bank.
  const connected = await connect({
    me: person('p-me', { synthetic: false, records: true }),
    scopes: ['person:read'],
    demo: { ids: ['user-001'], open: () => person('user-001', { synthetic: true }) },
  });
  try {
    for (const request of [
      { name: 'get_bank_summary', arguments: period },
      { name: 'get_bank_updates', arguments: {} },
    ]) {
      const result = await connected.client.callTool(request);
      assert(!result.isError);
      assert.equal((result.structuredContent as Record<string, unknown>).synthetic, true, 'the records are fabricated');
      assert.match(text(result), /come from a fictional bank feed \(synthetic: true\), not from a real bank/);
      assert.match(text(result), /profile they are attached to is the person’s own and is not fictional/);
      assert.doesNotMatch(text(result), /Fictional demo persona|all underlying records are synthetic demo data/i);
    }
    // The feed status describes the feed, never the person.
    const runtime = await connected.client.callTool({ name: 'get_bank_runtime', arguments: {} });
    assert.match(text(runtime), /synthetic: true describes the feed only/);
    assert.doesNotMatch(text(runtime), /all underlying records are synthetic|Fictional demo persona/i);
    // The same data read for a demo persona is fictional through and through.
    const demo = await connected.client.callTool({
      name: 'get_demo_bank_summary',
      arguments: { demoId: 'user-001', ...period },
    });
    assert.match(text(demo), /Fictional demo persona: all underlying records are synthetic demo data/);
    const demoRuntime = await connected.client.callTool({
      name: 'get_demo_bank_runtime',
      arguments: { demoId: 'user-001' },
    });
    assert.match(text(demoRuntime), /Fictional demo persona: the feed and everything it adds are synthetic/);
  } finally {
    await connected.close();
  }
  // A real person who never used the demo feed is not told anything about synthetic records of theirs.
  const untouched = await connect({
    me: person('p-me', { synthetic: false, feedOff: true }),
    scopes: ['person:read'],
    demo: null,
  });
  try {
    const runtime = await untouched.client.callTool({ name: 'get_bank_runtime', arguments: {} });
    assert.match(text(runtime), /The demo feed is off and has added nothing/);
    assert.doesNotMatch(text(runtime), /records are synthetic/i);
    const summary = await untouched.client.callTool({ name: 'get_bank_summary', arguments: period });
    assert.equal((summary.structuredContent as Record<string, unknown>).synthetic, false);
    assert.match(text(summary), /include real bank data \(synthetic: false\)/);
  } finally {
    await untouched.close();
  }
});

test('bank tools turn store failures and unexpected shapes into one plain error', async () => {
  for (const broken of ['throws', 'invalid'] as const) {
    const { client, close } = await connect({
      me: person('p-me', { synthetic: false, broken }),
      scopes: ['person:read'],
      demo: null,
    });
    try {
      const result = await client.callTool({ name: 'get_bank_updates', arguments: {} });
      assert(result.isError);
      assert(!/secret-token|internal\.example|stack/.test(JSON.stringify(result)));
    } finally {
      await close();
    }
  }
});

test('without a signed-in person the personal bank tools ask for sign-in and the demo tools are absent', async () => {
  const { client, close } = await connect({
    me: null,
    scopes: [],
    demo: null,
    challenge: () => 'Bearer resource_metadata="https://relo.example/.well-known/oauth-protected-resource"',
  });
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [...readingTools, ...Object.keys(ownBankTools)].sort());
    // Each of them is registered as personal, so the HTTP layer refuses it before it runs.
    for (const name of names) assert(name in personalTools, `${name} is not in personalTools`);
    for (const [name, changes] of Object.entries(ownBankTools))
      assert.deepEqual(personalTools[name], [changes ? 'bank:manage' : 'person:read'], name);
    const result = await client.callTool({ name: 'get_bank_runtime', arguments: {} });
    assert(result.isError);
    assert.match(JSON.stringify(result.content), /Sign in to ReloCat/);
    assert.match(String((result._meta?.['mcp/www_authenticate'] as string[] | undefined)?.[0]), /resource_metadata=/);
  } finally {
    await close();
  }
  // A credential without the read scope is told which permission is missing.
  const limited = await connect({
    me: person('p-me', { synthetic: false }),
    scopes: [],
    demo: null,
    challenge: () => 'Bearer x',
  });
  try {
    const result = await limited.client.callTool({ name: 'get_bank_runtime', arguments: {} });
    assert(result.isError);
    assert.match(JSON.stringify(result.content), /person:read/);
  } finally {
    await limited.close();
  }
});

test('the caller’s own bank tools pass on states and totals, word refusals plainly and need the right scope', async () => {
  const calls: string[] = [];
  const bank: OwnBank = {
    connectable: async () => [
      { id: 'demo-bank', displayName: 'Banc Demo', synthetic: true, connect: 'consent_at_bank' },
    ],
    connections: async () => ({
      connections: [
        {
          id: 'demo-bank-1a2b3c4d',
          providerId: 'demo-bank',
          consent: 'expired',
          lastError: 'The consent at the bank has expired.',
        },
      ],
      pendingConsents: [],
    }),
    accounts: async () => ({
      synthetic: false,
      updatedAt: null,
      accounts: [{ id: 'manual-import', balanceCents: 1200 }],
    }),
    async connect(providerId) {
      calls.push(`connect:${providerId}`);
      if (providerId === 'operator-bank') throw new ApiError(403, 'This bank can only be connected by the operator');
      return {
        status: 'consent_required',
        message: 'Open your account page.',
        continueUrl: 'https://relo.example/account',
      };
    },
    async disconnect(connectionId) {
      calls.push(`disconnect:${connectionId}`);
      if (connectionId !== 'demo-bank-1a2b3c4d') throw new ApiError(404, 'Bank connection not found');
      return { deleted: connectionId };
    },
    async sync(connectionId) {
      calls.push(`sync:${connectionId ?? 'all'}`);
      return { results: [{ status: 'failed', error: 'The consent at the bank has expired.' }] };
    },
    async previewStatement(csv) {
      calls.push(`preview:${csv.length}`);
      return {
        previewHash: 'abc',
        rowCount: 2,
        newRows: 2,
        coveredFrom: '2026-10-01',
        coveredTo: '2026-10-02',
        monthlyFigures: false,
      };
    },
    async confirmStatement(previewHash) {
      calls.push(`confirm:${previewHash}`);
      if (previewHash !== 'abc') throw new ApiError(409, 'There is no statement waiting under this preview hash.');
      return { inserted: 2, duplicates: 0 };
    },
    statementImports: async () => [{ id: 'imp-1', rowCount: 2 }],
    async deleteStatementImport(importId) {
      calls.push(`delete:${importId}`);
      throw new Error('secret-token upstream stack at https://internal.example');
    },
  };
  const me: PersonWriter = Object.assign(person('p-me', { synthetic: false }), { bank });
  const challenge: Caller['challenge'] = (error, scopes) =>
    `Bearer scope="${(scopes ?? []).join(' ')}", error="${error?.code}"`;
  const everything = await connect({ me, scopes: ['person:read', 'bank:manage'], demo: null, challenge });
  try {
    const call = (name: string, args: Record<string, unknown> = {}) =>
      everything.client.callTool({ name, arguments: args });
    const text = (result: Awaited<ReturnType<typeof call>>) => JSON.stringify(result.content);

    assert.deepEqual((await call('list_connectable_banks')).structuredContent, { banks: await bank.connectable() });
    assert.deepEqual((await call('list_my_bank_connections')).structuredContent, await bank.connections());
    assert.deepEqual((await call('list_my_statement_imports')).structuredContent, {
      imports: [{ id: 'imp-1', rowCount: 2 }],
    });
    // A consent is never completed by a tool: the answer sends the person to their account page.
    const consent = await call('connect_my_bank', { providerId: 'demo-bank' });
    assert.equal(consent.isError, undefined);
    assert.match(text(consent), /Nothing is connected yet\..*https:\/\/relo\.example\/account/);
    // The summary of a preview tells the model to show it and wait for the person.
    const preview = await call('preview_statement_import', { csv: 'date,description,amount\n2026-10-01,Salary,1.00' });
    assert.match(text(preview), /Nothing was imported yet\..*only after they agree/);
    assert.match(text(await call('confirm_statement_import', { previewHash: 'abc' })), /Imported 2 new movement\(s\)/);

    // A refusal the store words for people is passed on; anything else is one plain sentence.
    const refused = await call('confirm_statement_import', { previewHash: 'other' });
    assert.deepEqual(
      [refused.isError, text(refused)],
      [true, JSON.stringify([{ type: 'text', text: 'There is no statement waiting under this preview hash.' }])],
    );
    assert.match(
      text(await call('connect_my_bank', { providerId: 'operator-bank' })),
      /only be connected by the operator/,
    );
    assert.match(
      text(await call('disconnect_my_bank', { connectionId: 'somebody-elses' })),
      /Bank connection not found/,
    );
    const broken = await call('delete_statement_import', { importId: 'imp-1' });
    assert.deepEqual(
      [broken.isError, text(broken)],
      [true, JSON.stringify([{ type: 'text', text: 'Bank data is unavailable right now.' }])],
    );
    // Arguments that are not the tool's own are refused before the store is asked.
    const before = calls.length;
    for (const [name, args] of [
      ['connect_my_bank', { providerId: 'demo-bank', ref: 'cust-001' }],
      ['connect_my_bank', { providerId: 'demo-bank', userId: 'user-001' }],
      ['sync_my_bank', { userId: 'user-001' }],
      ['disconnect_my_bank', { connectionId: 'Not An Id' }],
      ['preview_statement_import', { csv: '' }],
    ] as const)
      assert((await call(name, args)).isError, `${name} ${JSON.stringify(args)}`);
    assert.equal(calls.length, before);
  } finally {
    await everything.close();
  }

  // Without bank:manage the tools that change something say which permission is missing and ask the store nothing.
  calls.length = 0;
  const reader = await connect({ me, scopes: ['person:read'], demo: null, challenge });
  try {
    for (const [name, changes] of Object.entries(ownBankTools)) {
      const args =
        name === 'connect_my_bank'
          ? { providerId: 'demo-bank' }
          : name === 'disconnect_my_bank'
            ? { connectionId: 'demo-bank-1a2b3c4d' }
            : name === 'preview_statement_import'
              ? { csv: 'date,description,amount\n2026-10-01,Salary,1.00' }
              : name === 'confirm_statement_import'
                ? { previewHash: 'abc' }
                : name === 'delete_statement_import'
                  ? { importId: 'imp-1' }
                  : {};
      const result = await reader.client.callTool({ name, arguments: args });
      assert.equal(Boolean(result.isError), changes, name);
      if (!changes) continue;
      assert.match(JSON.stringify(result.content), /allow \\"bank:manage\\"/, name);
      assert.deepEqual(result._meta?.['mcp/www_authenticate'], [
        'Bearer scope="person:read bank:manage", error="insufficient_scope"',
      ]);
    }
    assert.deepEqual(calls, [], 'no change reached the store');
  } finally {
    await reader.close();
  }

  // A server without a bank engine (the scripted rehearsal) says so instead of failing.
  const bare = await connect({
    me: person('p-me', { synthetic: false }),
    scopes: ['person:read', 'bank:manage'],
    demo: null,
  });
  try {
    const result = await bare.client.callTool({ name: 'list_connectable_banks', arguments: {} });
    assert.match(JSON.stringify(result.content), /not available on this server/);
  } finally {
    await bare.close();
  }
});
