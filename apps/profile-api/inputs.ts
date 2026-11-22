import { z } from 'zod';
import type { AppInput } from '../../packages/contracts/inputs.ts';
import { buildRecommendationInput, inputSchema, maxInputs, resolveInputs } from '../../packages/contracts/inputs.ts';
import type { Database } from '../../packages/db/database.ts';
import { countInputs, deleteInput, getInput, insertInput, listInputs, updateInput } from '../../packages/db/inputs.ts';
import { personIsSynthetic } from '../../packages/db/profiles.ts';
import { ApiError } from '../../packages/http/server.ts';
import { createStore, requireUser } from '../../packages/profiles/store.ts';

/**
 * Most input records kept per user (`maxInputs`, 500). Reaching it never locks the profile: see
 * `supersededInputs` and the retention rule in `INPUTS.md`.
 */
export { maxInputs } from '../../packages/contracts/inputs.ts';
export const submittedInput = inputSchema.refine(
  input => input.source !== 'profile' && input.id !== 'profile-snapshot',
  'profile source and profile-snapshot ID are reserved',
);
const batchSchema = z.object({ inputs: z.array(submittedInput).min(1).max(50) }).strict();
const inputFile = z
  .object({ schemaVersion: z.literal(1), synthetic: z.boolean(), inputs: z.array(submittedInput).max(maxInputs) })
  .strict();
/** Sources whose records can be fabricated even for a real person: a bank can be a fictional one. */
const sourcesThatCanBeSynthetic = new Set<AppInput['source']>(['bank']);

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
  /**
   * The file-level flag is an aggregate: true only for a fictional person whose every record is
   * fabricated. A real person with no records yet is not labelled synthetic.
   */
  function fileOf(id: string) {
    const inputs = stored(id);
    const synthetic = personIsSynthetic(db, id) && inputs.every(input => input.synthetic);
    return inputFile.parse({ schemaVersion: 1, synthetic, inputs });
  }
  async function read(id: string) {
    requireUser(db, id);
    return db.read(() => fileOf(id));
  }
  /**
   * The record as it is stored. What is stated by or for a real person is real, whatever flag the
   * client sent (older clients always sent `true`); only a source that can itself be fabricated
   * keeps the flag it arrived with. A fictional person's records are stored as they arrive.
   */
  function truthful(id: string, input: AppInput): AppInput {
    if (!input.synthetic || sourcesThatCanBeSynthetic.has(input.source) || personIsSynthetic(db, id)) return input;
    return { ...input, synthetic: false };
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
        const records = inputs.map(input => truthful(id, input));
        for (const input of records) {
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
        const pruned = prune(id, records);
        return { inserted, replaced, duplicates: inputs.length - inserted - replaced, pruned };
      });
    },
    async replace(id: string, inputId: string, value: unknown) {
      const submitted = submittedInput.parse(value);
      if (submitted.id !== inputId) throw new ApiError(400, 'Input ID must match route');
      return mutate(id, () => {
        const input = truthful(id, submitted);
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
      // The snapshot is as fictional as the documents it is read from: all of them, or it is not.
      const snapshotSynthetic = details.synthetic && preferences.synthetic && bank.synthetic;
      const baseline = {
        id: 'profile-snapshot',
        source: 'profile' as const,
        observedAt: date.success ? `${date.data}T00:00:00Z` : '1970-01-01T00:00:00Z',
        confirmed: false,
        synthetic: snapshotSynthetic,
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
          // Savings for the purchase are what the profile declares, never the balance of an account.
          currentSavingsCents: preferences.purchaseSavingsCents,
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
      // The balance of the bank snapshot is a fact of its own. It is not proposed as savings for the
      // purchase: an account balance also holds rent, bills and the emergency reserve.
      const balance = z.number().int().safe().nonnegative().safeParse(bank.balanceCents);
      const bankSnapshot = balance.success
        ? {
            balanceCents: balance.data,
            observedAt: date.success ? date.data : null,
            confirmed: false,
            synthetic: bank.synthetic,
          }
        : null;
      if (bankSnapshot && resolved.data.finance?.currentSavingsCents == null)
        warnings.push(
          'The bank snapshot balance is not counted as savings for the purchase; declare or confirm finance.currentSavingsCents.',
        );
      return {
        schemaVersion: 1,
        // An aggregate: true only for a fictional person whose every contributing record is fabricated.
        synthetic: file.synthetic && (!Object.keys(data).length || snapshotSynthetic),
        userId: id,
        inputCount: file.inputs.length,
        bankSnapshot,
        resolved,
        recommendation: buildRecommendationInput(resolved),
        warnings,
      };
    },
  };
}
