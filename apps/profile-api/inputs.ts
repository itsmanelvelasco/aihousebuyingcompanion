import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inputSchema, resolveInputs, buildRecommendationInput } from '../../packages/contracts/inputs.ts';
import type { AppInput } from '../../packages/contracts/inputs.ts';
import { ApiError, createStore, userId } from './store.ts';

const submittedInput = inputSchema.refine(input => input.source !== 'profile' && input.id !== 'profile-snapshot', 'profile source and profile-snapshot ID are reserved');
const batchSchema = z.object({ inputs: z.array(submittedInput).min(1).max(50) }).strict();
const inputFile = z.object({ schemaVersion: z.literal(1), synthetic: z.literal(true), inputs: z.array(submittedInput).max(500) }).strict();

export function createInputStore(root: string) {
  const profiles = createStore(root);
  const locks = new Map<string, Promise<unknown>>();
  async function read(id: string) {
    await profiles.read(id, 'details');
    try { return inputFile.parse(JSON.parse(await readFile(join(root, userId.parse(id), 'app-inputs.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { schemaVersion: 1 as const, synthetic: true as const, inputs: [] as AppInput[] };
    }
  }
  async function mutate<T>(id: string, change: (data: z.infer<typeof inputFile>) => T) {
    userId.parse(id);
    const operation = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const data = await read(id);
      const result = change(data);
      inputFile.parse(data);
      const target = join(root, id, 'app-inputs.json');
      const temporary = `${target}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, target); }
      finally { await rm(temporary, { force: true }); }
      return result;
    });
    locks.set(id, operation);
    try { return await operation; } finally { if (locks.get(id) === operation) locks.delete(id); }
  }
  return {
    read,
    async add(id: string, value: unknown) {
      const { inputs } = batchSchema.parse(value);
      return mutate(id, data => {
        let inserted = 0;
        for (const input of inputs) {
          const existing = data.inputs.find(item => item.id === input.id);
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(input)) throw new ApiError(409, `Input ID conflict: ${input.id}`);
          } else { data.inputs.push(input); inserted++; }
        }
        if (data.inputs.length > 500) throw new ApiError(400, 'Maximum 500 input records per user');
        return { inserted, duplicates: inputs.length - inserted };
      });
    },
    async replace(id: string, inputId: string, value: unknown) {
      const input = submittedInput.parse(value);
      if (input.id !== inputId) throw new ApiError(400, 'Input ID must match route');
      return mutate(id, data => {
        const index = data.inputs.findIndex(item => item.id === inputId);
        if (index < 0) throw new ApiError(404, 'Input not found');
        data.inputs[index] = input; return input;
      });
    },
    async delete(id: string, inputId: string) {
      return mutate(id, data => {
        const index = data.inputs.findIndex(item => item.id === inputId);
        if (index < 0) throw new ApiError(404, 'Input not found');
        data.inputs.splice(index, 1); return { deleted: inputId };
      });
    },
    async context(id: string) {
      const file = await read(id);
      const [details, preferences, bank] = await Promise.all(['details', 'preferences', 'bank-account'].map(section => profiles.read(id, section as 'details' | 'preferences' | 'bank-account')));
      const warnings: string[] = ['Saved profile values are unconfirmed; bank snapshot values are not a live ledger summary.'];
      const date = z.iso.date().safeParse(bank.snapshotDate ?? details.snapshotDate);
      const baseline = { id: 'profile-snapshot', source: 'profile' as const, observedAt: date.success ? `${date.data}T00:00:00Z` : '1970-01-01T00:00:00Z', confirmed: false, synthetic: true as const };
      if (!date.success) warnings.push('Profile observation date unknown; 1970-01-01 is an ordering sentinel only.');
      const schoolAliases: Record<string, string> = { ESO: 'eso', primaria: 'primary', primària: 'primary', batxillerat: 'batxillerat', infantil: 'infantil', nursery: 'nursery', FP: 'fp' };
      const proposed: Record<string, Record<string, unknown>> = {
        household: { size: details.householdSize, dependants: details.dependants, employmentStatus: details.employmentStatus },
        housing: { tenure: preferences.goal === 'buy_primary_home' ? 'buy' : undefined, budgetCents: preferences.housingBudgetCents, minimumBedrooms: preferences.minimumBedrooms },
        school: { stages: Array.isArray(preferences.schoolStages) ? preferences.schoolStages.map(stage => schoolAliases[String(stage)] ?? stage) : undefined },
        transport: { maxCommuteMinutes: preferences.maxCommuteMinutes },
        finance: { currentSavingsCents: bank.balanceCents, monthlyIncomeCents: bank.monthlyIncomeCents, monthlyExpensesCents: bank.monthlyExpensesCents, debtPaymentsCents: bank.debtPaymentsCents },
        location: { currentMunicipality: details.currentMunicipality }
      };
      const data: Record<string, Record<string, unknown>> = {};
      for (const [group, fields] of Object.entries(proposed)) for (const [field, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const parsed = inputSchema.safeParse({ ...baseline, data: { [group]: { [field]: value } } });
        if (parsed.success) (data[group] ??= {})[field] = value;
        else warnings.push(`Saved profile field ${group}.${field} could not be normalized; submit a validated input.`);
      }
      const inputs = [...file.inputs];
      if (Object.keys(data).length) inputs.unshift(inputSchema.parse({ ...baseline, data }));
      const resolved = resolveInputs(inputs);
      return { schemaVersion: 1, synthetic: true, userId: id, inputCount: file.inputs.length, resolved, recommendation: buildRecommendationInput(resolved), warnings };
    }
  };
}
