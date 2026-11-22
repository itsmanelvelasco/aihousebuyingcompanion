import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { metricKind, serviceKind } from '../packages/contracts/places.ts';
import { loadData, missingMetrics, missingServices } from '../packages/places/data.ts';

// Handles RFC-style quoted fields, doubled quotes and embedded line breaks.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && c === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  assert.equal(quoted, false, 'CSV has balanced quotes');
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
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
    assert.ok(!ids.has(id));
    ids.add(id);
    assert.equal(d.id, id);
    assert.equal(p.userId, id);
    assert.equal(b.userId, id);
    for (const [name, document] of Object.entries({ details: d, preferences: p, 'bank-account': b })) {
      assert.equal((document as Record<string, unknown>).synthetic, true);
      assert.equal((document as Record<string, unknown>).schemaVersion, 1);
      assert.deepEqual(JSON.parse(await readFile(resolve('data/users', id, `${name}.json`), 'utf8')), document);
    }
    assert.equal(b.currency, 'EUR');
    for (const value of [
      b.balanceCents,
      b.monthlyIncomeCents,
      b.monthlyExpensesCents,
      b.debtPaymentsCents,
      p.targetPurchasePriceCents,
    ]) {
      assert.ok(Number.isSafeInteger(value) && value >= 0);
    }
    assert.equal(b.monthlyNetCashflowCents, b.monthlyIncomeCents - b.monthlyExpensesCents - b.debtPaymentsCents);
    assert.ok(b.balanceCents < b.estimatedUpfrontCashCents);
    // Every household declares what it has set aside for the purchase: whole euros, part of the
    // balance (the rest covers rent, bills and a reserve) and so still short of the upfront target.
    assert.ok(Number.isSafeInteger(p.purchaseSavingsCents) && p.purchaseSavingsCents >= 0);
    assert.equal(p.purchaseSavingsCents % 100, 0);
    assert.ok(p.purchaseSavingsCents <= b.balanceCents, `${id}: savings exceed the balance`);
    assert.ok(
      p.purchaseSavingsCents >= Math.floor(b.balanceCents * 0.6) - 100,
      `${id}: savings below 60% of the balance`,
    );
    assert.ok(p.purchaseSavingsCents < b.estimatedUpfrontCashCents);
    assert.ok(d.financialBarriers.includes('insufficient_upfront_savings'));
    assert.equal(d.creditHistory.numericScore, null);
    assert.equal(p.incentiveEligibility, 'needs_verification');
    assert.ok(d.dependantAges.every((age: number) => age >= 0 && age <= 17 && age <= d.age - 18));
    householdTypes.add(d.householdType);
    provinces.add(d.province);
    creditCases.add(d.creditHistory.status);
    needs.add(JSON.stringify([p.schoolStages, p.requiresPublicTransport, p.ruralPreference, p.minimumBedrooms]));
    if (b.monthlyNetCashflowCents < 0) negativeCashflow++;
  }
  assert.equal(ids.size, 500);
  assert.equal(householdTypes.size, 5);
  assert.equal(provinces.size, 4);
  assert.equal(creditCases.size, 5);
  assert.ok(needs.size > 30);
  assert.ok(negativeCashflow > 0 && negativeCashflow < 500);
  const [header, ...rows] = parseCsv(await readFile(resolve('data/synthetic-users.csv'), 'utf8'));
  assert.equal(rows.length, 500);
  assert.ok(header);
  const idIndex = header.indexOf('id');
  assert.ok(idIndex >= 0);
  assert.deepEqual(new Set(rows.map(row => row[idIndex])), ids);
  for (const row of rows) assert.equal(row.length, header.length);
  const savingsIndex = header.indexOf('purchaseSavingsCents');
  const byId = new Map(dataset.users.map((user: { id: string }) => [user.id, user]));
  for (const row of rows)
    assert.equal(
      Number(row[savingsIndex]),
      (byId.get(row[idIndex]) as { preferences: { purchaseSavingsCents: number } }).preferences.purchaseSavingsCents,
    );
});

const official = /^https:\/\/([a-z0-9-]+\.)*(idescat\.cat|gencat\.cat|transparenciacatalunya\.cat|fgc\.cat)\//;

test('every municipality carries density, surface and foreign-nationality share, or lists them as missing', () => {
  const { snapshot } = loadData();
  const added = ['area_km2', 'population_density_per_km2', 'foreign_population_percent'] as const;
  for (const kind of added) assert.ok(metricKind.options.includes(kind));
  for (const town of snapshot.municipalities) {
    const metrics = snapshot.townMetrics[town.code];
    const missing: string[] = missingMetrics(snapshot, town.code);
    const value = (kind: string) => metrics.find(metric => metric.kind === kind)?.value;
    for (const kind of added) {
      const metric = metrics.find(metric => metric.kind === kind);
      // Unknown is acceptable only when it is declared: a town never silently lacks an indicator.
      assert.equal(missing.includes(kind), !metric, `${town.code} ${kind}`);
      if (!metric) continue;
      assert.match(metric.observedAt, /^20\d{2}/, `${town.code} ${kind} observation date`);
      assert.match(metric.sourceUrl, /^https:\/\/(www|api)\.idescat\.cat\//);
      assert.equal(metric.geographyName, town.name);
    }
    const area = value('area_km2');
    const density = value('population_density_per_km2');
    const foreign = value('foreign_population_percent');
    const population = value('population');
    if (area !== undefined) assert.ok(area > 0 && area < 1000, `${town.code} area`);
    if (density !== undefined) assert.ok(density > 0 && density < 30_000, `${town.code} density`);
    if (foreign !== undefined) assert.ok(foreign >= 0 && foreign <= 100, `${town.code} foreign share`);
    if (area !== undefined && density !== undefined && population !== undefined) {
      // Idescat publishes all three; they must agree within rounding and a year of population change.
      const expected = population / area;
      assert.ok(Math.abs(density - expected) <= Math.max(1, density * 0.05), `${town.code} density check`);
    }
  }
  // Idescat publishes all three for every pilot town today; a regression to "missing" should be noticed.
  const complete = snapshot.municipalities.filter(town =>
    added.every(kind => !(missingMetrics(snapshot, town.code) as string[]).includes(kind)),
  );
  assert.equal(complete.length, snapshot.municipalities.length);
});

test('service counts are sourced, dated and never state a zero the directories do not publish', () => {
  const { snapshot } = loadData();
  const towns = new Set(snapshot.municipalities.map(town => town.code));
  assert.deepEqual(new Set(Object.keys(snapshot.services ?? {})), towns);
  const covered = new Set<string>();
  for (const town of snapshot.municipalities) {
    const services = snapshot.services?.[town.code] ?? [];
    const missing: string[] = missingServices(snapshot, town.code);
    assert.equal(services.length + missing.length, serviceKind.options.length);
    for (const service of services) {
      covered.add(service.kind);
      assert.ok(!missing.includes(service.kind));
      assert.ok(Number.isInteger(service.count) && service.count >= 0);
      assert.ok(service.observedAt, `${town.code} ${service.kind} observation date`);
      assert.match(service.sourceUrl, official);
      // Only the retail census states explicit zeroes; a directory without a listing means unknown.
      if (service.kind !== 'retail') assert.ok(service.count > 0, `${town.code} ${service.kind}`);
    }
    const count = (kind: string) => services.find(service => service.kind === kind)?.count;
    const schools = snapshot.schools.filter(school => school.municipalityCode === town.code).length;
    const stops = snapshot.rail.stops.filter(stop => stop.municipalityCode === town.code).length;
    const retail = snapshot.townMetrics[town.code].find(metric => metric.kind === 'retail_establishments');
    assert.equal(count('school'), schools || undefined);
    assert.equal(count('rail_station'), stops || undefined);
    assert.equal(count('retail'), retail?.value);
  }
  // No official open dataset covers pharmacies yet. Social services come from a register without
  // municipality codes: a town it could not be matched to by name and comarca stays unknown.
  assert.deepEqual([...covered].sort(), [
    'hospital',
    'library',
    'primary_care',
    'rail_station',
    'retail',
    'school',
    'social_services',
    'sports',
  ]);
  const social = snapshot.municipalities.flatMap(town =>
    (snapshot.services?.[town.code] ?? []).filter(service => service.kind === 'social_services'),
  );
  assert.ok(social.length > 0 && social.length < snapshot.municipalities.length);
  assert.ok(
    social.every(
      service => service.sourceUrl.endsWith('/d/ivft-vegh') && /^\d{4}-\d{2}-\d{2}$/.test(service.observedAt),
    ),
  );
  const lleida = snapshot.services?.['251207'] ?? [];
  assert.ok((lleida.find(service => service.kind === 'hospital')?.count ?? 0) >= 1);
});
