import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBankStore } from '../apps/profile-api/bank.ts';
import { createBankRuntime } from '../apps/profile-api/runtime.ts';
import { open } from '../packages/db/database.ts';
import { createStore } from '../packages/profiles/store.ts';

async function fixture() {
  const db = open(':memory:');
  const doc = { schemaVersion: 1, synthetic: true };
  await createStore(db).create('demo', {
    details: { ...doc, id: 'demo' },
    preferences: doc,
    'bank-account': {
      ...doc,
      snapshotDate: '2026-11-21',
      balanceCents: 500000,
      monthlyIncomeCents: 240000,
      monthlyExpensesCents: 170000,
      debtPaymentsCents: 10000,
    },
  });
  return { db, bank: createBankStore(db) };
}
test('bank events persist monotonic cursors and idempotent runtime ticks do not repeat movements', async () => {
  const { db, bank } = await fixture();
  const runtime = createBankRuntime(bank, () => new Date('2026-11-21T12:00:00Z'));
  try {
    const first = await runtime.tick('demo');
    assert.equal(first.inserted, 1);
    const revision = (await bank.read('demo')).revision;
    const repeated = await runtime.tick('demo');
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.revision, revision);
    const events = await createBankStore(db).events('demo', 0, 1);
    assert.equal(events.events.length, 1);
    assert.equal(events.hasMore, true);
    const next = await bank.events('demo', events.nextCursor, 50);
    assert.equal(next.events.length, 1);
    assert.equal(next.latestRevision, 2);
    assert.equal((await bank.events('demo', next.nextCursor, 50)).events.length, 0);
    assert.equal((await bank.events('demo', 9000, 50)).requiresRefresh, true);
    // A reader whose cursor is older than the events still kept must refresh instead of replaying.
    db.run('DELETE FROM bank_events WHERE user_id = ? AND sequence < ?', 'demo', next.latestRevision);
    assert.equal((await bank.events('demo', 0, 50)).requiresRefresh, true);
  } finally {
    await runtime.close();
    db.close();
  }
});

test('enabled bank feed writes between requests and stops when disabled', async () => {
  const { db, bank } = await fixture();
  let time = new Date('2026-11-21T12:00:00Z').getTime();
  const runtime = createBankRuntime(bank, () => new Date((time += 5000)));
  try {
    await runtime.configure('demo', { enabled: true, intervalMs: 1000 });
    for (let attempt = 0; attempt < 50 && (await runtime.status('demo')).tickCount === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok((await runtime.status('demo')).tickCount >= 1);
    assert.ok((await bank.read('demo')).transactions.some(tx => tx.id.startsWith('runtime-')));
    await runtime.configure('demo', { enabled: false });
    const revision = (await bank.read('demo')).revision;
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal((await bank.read('demo')).revision, revision);
    assert.equal((await runtime.status('demo')).enabled, false);
  } finally {
    await runtime.close();
    db.close();
  }
});
