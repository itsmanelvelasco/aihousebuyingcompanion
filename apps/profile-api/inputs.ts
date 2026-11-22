import { z } from 'zod';
import type { AppInput } from '../../packages/contracts/inputs.ts';
import { buildRecommendationInput, inputSchema, resolveInputs } from '../../packages/contracts/inputs.ts';
import type { Database } from '../../packages/db/database.ts';
import { countInputs, deleteInput, getInput, insertInput, listInputs, updateInput } from '../../packages/db/inputs.ts';
import { ApiError } from '../../packages/http/server.ts';
import { createStore, requireUser } from '../../packages/profiles/store.ts';

/**
 * Most input records kept per user. Reaching it never locks the profile: see `supersededInputs`
 * and the retention rule in `INPUTS.md`.
 */
export const maxInputs = 500;
const submittedInput = inputSchema.refine(
  input => input.source !== 'profile' && input.id !== 'profile-snapshot',
  'profile source and profile-snapshot ID are reserved',
);
const batchSchema = z.object({ inputs: z.array(submittedInput).min(1).max(50) }).strict();
const inputFile = z
  .object({ schemaVersion: z.literal(1), synthetic: z.literal(true), inputs: z.array(submittedInput).max(maxInputs) })
  .strict();

/**
 * The records that no longer take part in resolution, oldest first: every field they carry has a
 * strictly newer observation from the same source, so `resolveInputs` gives the same answer with or
 * without them. A record that holds the newest observation of its source for even one field is
 * never listed, whether it is confirmed or not, so the winning value of a field is never dropped.
 */
export function supersededInputs(inputs: AppInput[]) {
  const newest = new Map<string, number>();
  const fieldsOf = (input: AppInput) =>
    Object.entries(input.data).flatMap(([group, values]) =>
      Object.entries(values ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([field]) => `${input.source}|${group}.${field}`),
    );
  for (const input of inputs)
    for (const key of fieldsOf(input))
      newest.set(key, Math.max(newest.get(key) ?? -Infinity, Date.parse(input.observedAt)));
  return inputs
    .filter(input => fieldsOf(input).every(key => Date.parse(input.observedAt) < newest.get(key)!))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

/** A user's submitted inputs: one row per record, in the order they were first added. */
export function createInputStore(db: Database) {
  const profiles = createStore(db);
  function stored(id: string) {
    return listInputs(db, id) as AppInput[];
  }
  async function read(id: string) {
    requireUser(db, id);
    return inputFile.parse({ schemaVersion: 1, synthetic: true, inputs: stored(id) });
  }
  /** Run one change for an existing user in a transaction: all of it is stored, or none of it. */
  function mutate<T>(id: string, change: () => T) {
    return db.transaction(() => {
      requireUser(db, id);
      return change();
    });
  }
  /**
   * Bring a user back to the cap after a write by deleting superseded records: first those of the
   * sources just written, then the others, oldest first. Records of this request are kept. When
   * every stored record still decides a field there is nothing safe to delete and the write is
   * refused; that takes 500 records which each hold the newest value of some field.
   */
  function prune(id: string, written: AppInput[]) {
    const excess = countInputs(db, id) - maxInputs;
    if (excess <= 0) return 0;
    const writtenIds = new Set(written.map(input => input.id));
    const writtenSources = new Set(written.map(input => input.source));
    const candidates = supersededInputs(stored(id)).filter(input => !writtenIds.has(input.id));
    const ordered = [
      ...candidates.filter(input => writtenSources.has(input.source)),
      ...candidates.filter(input => !writtenSources.has(input.source)),
    ].slice(0, excess);
    if (ordered.length < excess)
      throw new ApiError(
        409,
        `Maximum ${maxInputs} input records per user, and none is superseded: delete records that are no longer needed`,
      );
    for (const input of ordered) deleteInput(db, id, input.id);
    return ordered.length;
  }
  return {
    read,
    async add(id: string, value: unknown) {
      const { inputs } = batchSchema.parse(value);
      return mutate(id, () => {
        let inserted = 0;
        let replaced = 0;
        for (const input of inputs) {
          const existing = getInput(db, id, input.id);
          if (!existing) {
            insertInput(db, id, input);
            inserted++;
          } else if (JSON.stringify(existing) !== JSON.stringify(input)) {
            // The same ID with different content is the client updating its own record.
            updateInput(db, id, input);
            replaced++;
          }
        }
        const pruned = prune(id, inputs);
        return { inserted, replaced, duplicates: inputs.length - inserted - replaced, pruned };
      });
    },
    async replace(id: string, inputId: string, value: unknown) {
      const input = submittedInput.parse(value);
      if (input.id !== inputId) throw new ApiError(400, 'Input ID must match route');
      return mutate(id, () => {
        if (!updateInput(db, id, input)) throw new ApiError(404, 'Input not found');
        return input;
      });
    },
    async delete(id: string, inputId: string) {
      return mutate(id, () => {
        if (!deleteInput(db, id, inputId)) throw new ApiError(404, 'Input not found');
        return { deleted: inputId };
      });
    },
    async context(id: string) {
      const file = await read(id);
      const [details, preferences, bank] = await Promise.all(
        ['details', 'preferences', 'bank-account'].map(section =>
          profiles.read(id, section as 'details' | 'preferences' | 'bank-account'),
        ),
      );
      const warnings: string[] = [
        'Saved profile values are unconfirmed; bank snapshot values are not a live ledger summary.',
      ];
      const date = z.iso.date().safeParse(bank.snapshotDate ?? details.snapshotDate);
      const baseline = {
        id: 'profile-snapshot',
        source: 'profile' as const,
        observedAt: date.success ? `${date.data}T00:00:00Z` : '1970-01-01T00:00:00Z',
        confirmed: false,
        synthetic: true as const,
      };
      if (!date.success) warnings.push('Profile observation date unknown; 1970-01-01 is an ordering sentinel only.');
      const schoolAliases: Record<string, string> = {
        ESO: 'eso',
        primaria: 'primary',
        primària: 'primary',
        batxillerat: 'batxillerat',
        infantil: 'infantil',
        nursery: 'nursery',
        FP: 'fp',
      };
      const proposed: Record<string, Record<string, unknown>> = {
        household: {
          size: details.householdSize,
          dependants: details.dependants,
          employmentStatus: details.employmentStatus,
        },
        housing: {
          tenure: preferences.goal === 'buy_primary_home' ? 'buy' : undefined,
          budgetCents: preferences.housingBudgetCents,
          minimumBedrooms: preferences.minimumBedrooms,
        },
        school: {
          stages: Array.isArray(preferences.schoolStages)
            ? preferences.schoolStages.map(stage => schoolAliases[String(stage)] ?? stage)
            : undefined,
        },
        transport: { maxCommuteMinutes: preferences.maxCommuteMinutes },
        finance: {
          currentSavingsCents: bank.balanceCents,
          monthlyIncomeCents: bank.monthlyIncomeCents,
          monthlyExpensesCents: bank.monthlyExpensesCents,
          debtPaymentsCents: bank.debtPaymentsCents,
        },
        location: { currentMunicipality: details.currentMunicipality },
      };
      const data: Record<string, Record<string, unknown>> = {};
      for (const [group, fields] of Object.entries(proposed))
        for (const [field, value] of Object.entries(fields)) {
          if (value === undefined) continue;
          const parsed = inputSchema.safeParse({ ...baseline, data: { [group]: { [field]: value } } });
          if (parsed.success) (data[group] ??= {})[field] = value;
          else
            warnings.push(`Saved profile field ${group}.${field} could not be normalized; submit a validated input.`);
        }
      const inputs = [...file.inputs];
      if (Object.keys(data).length) inputs.unshift(inputSchema.parse({ ...baseline, data }));
      const resolved = resolveInputs(inputs);
      return {
        schemaVersion: 1,
        synthetic: true,
        userId: id,
        inputCount: file.inputs.length,
        resolved,
        recommendation: buildRecommendationInput(resolved),
        warnings,
      };
    },
  };
}
