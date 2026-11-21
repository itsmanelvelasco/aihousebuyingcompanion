import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Handles RFC-style quoted fields, doubled quotes and embedded line breaks.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ',') { row.push(field); field = ''; }
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  assert.equal(quoted, false, 'CSV has balanced quotes');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

test('500 synthetic household profiles agree with their full JSON and CSV exports', async () => {
  const dataset = JSON.parse(await readFile(resolve('data/synthetic-users.json'), 'utf8'));
  assert.equal(dataset.count, 500);
  assert.equal(dataset.synthetic, true);
  assert.equal(dataset.users.length, 500);
  const ids = new Set<string>();
  const householdTypes = new Set<string>();
  const provinces = new Set<string>();
  const creditCases = new Set<string>();
  const needs = new Set<string>();
  let negativeCashflow = 0;
  for (const user of dataset.users) {
    const { id, details: d, preferences: p, bankAccount: b } = user;
    assert.match(id, /^user-\d{3}$/);
    assert.ok(!ids.has(id)); ids.add(id);
    assert.equal(d.id, id);
    assert.equal(p.userId, id); assert.equal(b.userId, id);
    for (const [name, document] of Object.entries({ details: d, preferences: p, 'bank-account': b })) {
      assert.equal((document as Record<string, unknown>).synthetic, true);
      assert.equal((document as Record<string, unknown>).schemaVersion, 1);
      assert.deepEqual(JSON.parse(await readFile(resolve('data/users', id, `${name}.json`), 'utf8')), document);
    }
    assert.equal(b.currency, 'EUR');
    for (const value of [b.balanceCents, b.monthlyIncomeCents, b.monthlyExpensesCents, b.debtPaymentsCents, p.targetPurchasePriceCents]) {
      assert.ok(Number.isSafeInteger(value) && value >= 0);
    }
    assert.equal(b.monthlyNetCashflowCents, b.monthlyIncomeCents - b.monthlyExpensesCents - b.debtPaymentsCents);
    assert.ok(b.balanceCents < b.estimatedUpfrontCashCents);
    assert.ok(d.financialBarriers.includes('insufficient_upfront_savings'));
    assert.equal(d.creditHistory.numericScore, null);
    assert.equal(p.incentiveEligibility, 'needs_verification');
    assert.ok(d.dependantAges.every((age: number) => age >= 0 && age <= 17 && age <= d.age - 18));
    householdTypes.add(d.householdType); provinces.add(d.province); creditCases.add(d.creditHistory.status);
    needs.add(JSON.stringify([p.schoolStages, p.requiresPublicTransport, p.ruralPreference, p.minimumBedrooms]));
    if (b.monthlyNetCashflowCents < 0) negativeCashflow++;
  }
  assert.equal(ids.size, 500);
  assert.equal(householdTypes.size, 5); assert.equal(provinces.size, 4);
  assert.equal(creditCases.size, 5); assert.ok(needs.size > 30);
  assert.ok(negativeCashflow > 0 && negativeCashflow < 500);
  const [header, ...rows] = parseCsv(await readFile(resolve('data/synthetic-users.csv'), 'utf8'));
  assert.equal(rows.length, 500);
  assert.ok(header);
  const idIndex = header.indexOf('id');
  assert.ok(idIndex >= 0);
  assert.deepEqual(new Set(rows.map(row => row[idIndex])), ids);
  for (const row of rows) assert.equal(row.length, header.length);
});
