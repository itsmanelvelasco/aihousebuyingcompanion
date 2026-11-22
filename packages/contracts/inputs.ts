import { z } from 'zod';
import { household, isoDate, municipalityCode, recommendationInput, schoolStage } from './places.ts';

const optional = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const cents = z.number().int().safe().nonnegative().max(100_000_000_000);
const dataSchema = z
  .object({
    housing: z
      .object({
        tenure: optional(z.enum(['buy', 'rent'])),
        budgetCents: optional(z.number().int().positive().max(5_000_000_000)),
        homeSizeM2: optional(z.number().positive().max(2000)),
        minimumBedrooms: optional(z.number().int().min(1).max(20)),
        allowComarcaEstimate: optional(z.boolean()),
      })
      .strict()
      .optional(),
    household: z
      .object({
        size: optional(z.number().int().min(1).max(30)),
        dependants: optional(z.number().int().min(0).max(20)),
        employmentStatus: optional(z.string().trim().min(1).max(100)),
      })
      .strict()
      .optional(),
    school: z
      .object({
        stages: optional(
          z
            .array(schoolStage)
            .max(6)
            .transform(values => [...new Set(values)].sort()),
        ),
        mode: optional(z.enum(['car_free', 'rail'])),
        maxJourneyMinutes: optional(z.number().int().min(1).max(240)),
      })
      .strict()
      .optional(),
    transport: z
      .object({
        destinationCode: optional(municipalityCode),
        maxCommuteMinutes: optional(z.number().int().min(1).max(360)),
        travelDate: optional(isoDate),
      })
      .strict()
      .optional(),
    finance: z
      .object({
        currentSavingsCents: optional(cents),
        monthlyIncomeCents: optional(cents),
        monthlyExpensesCents: optional(cents),
        debtPaymentsCents: optional(cents),
        targetCashCents: optional(cents),
        emergencyReserveCents: optional(cents),
      })
      .strict()
      .optional(),
    location: z
      .object({
        currentMunicipality: optional(z.string().trim().min(1).max(100)),
        selectedMunicipalityCode: optional(municipalityCode),
      })
      .strict()
      .optional(),
    rural: z
      .object({ required: optional(z.boolean()) })
      .strict()
      .optional(),
    /**
     * The household facts that decide whether a tax measure or an aid applies: the buyer's age, the
     * children and their ages, habitual residence, family status, the type of tax return and the tax
     * bases. The fields are those of the incentive screening (`household` in `places.ts`), without the
     * purchase price, which the planner takes from the plan. A tax base is the figure on the tax
     * return, never a salary. The planner reads a fact only from a confirmed input.
     */
    eligibility: household.omit({ purchasePriceEur: true }).optional(),
  })
  .strict()
  .refine(
    data => Object.values(data).some(group => group && Object.values(group).some(value => value !== undefined)),
    'Supply at least one input field',
  );

export const inputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    source: z.enum(['profile', 'interview', 'manual', 'bank', 'listing']),
    observedAt: z.iso.datetime(),
    confirmed: z.boolean(),
    synthetic: z.literal(true),
    data: dataSchema,
  })
  .strict();
export type AppInput = z.infer<typeof inputSchema>;
type Value = string | number | boolean | string[] | null;
type Provenance = Pick<AppInput, 'source' | 'observedAt' | 'confirmed'> & { inputId: string };
type Candidate = Provenance & { value: Value };

export function resolveInputs(inputs: AppInput[]) {
  const fields = new Map<string, Candidate[]>();
  for (const input of inputs.map(value => inputSchema.parse(value))) {
    for (const [group, values] of Object.entries(input.data)) {
      for (const [field, value] of Object.entries(values)) {
        if (value === undefined) continue;
        const path = `${group}.${field}`;
        const candidate = {
          value: value as Value,
          inputId: input.id,
          source: input.source,
          observedAt: input.observedAt,
          confirmed: input.confirmed,
        };
        fields.set(path, [...(fields.get(path) ?? []), candidate]);
      }
    }
  }
  const data: Record<string, Record<string, Value>> = {};
  const provenance: Record<string, Provenance[]> = {};
  const conflicts: { field: string; candidates: Candidate[] }[] = [];
  for (const [path, candidates] of [...fields.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const latestBySource = new Map<AppInput['source'], number>();
    for (const candidate of candidates)
      latestBySource.set(
        candidate.source,
        Math.max(latestBySource.get(candidate.source) ?? -Infinity, Date.parse(candidate.observedAt)),
      );
    const latest = candidates.filter(
      candidate => Date.parse(candidate.observedAt) === latestBySource.get(candidate.source),
    );
    const eligible = latest.some(candidate => candidate.confirmed)
      ? latest.filter(candidate => candidate.confirmed)
      : latest;
    const distinct = new Set(eligible.map(candidate => JSON.stringify(candidate.value)));
    const [group, key] = path.split('.');
    (data[group] ??= {})[key] = distinct.size > 1 ? null : eligible[0].value;
    provenance[path] = eligible.map(({ value: _, ...info }) => info);
    if (distinct.size > 1) conflicts.push({ field: path, candidates: eligible });
  }
  return { data: data as z.infer<typeof dataSchema>, provenance, conflicts };
}

export function buildRecommendationInput(resolved: ReturnType<typeof resolveInputs>) {
  const { data } = resolved;
  const missingFields: string[] = [];
  const unsupportedFields: string[] = [];
  const result: z.input<typeof recommendationInput> = {};
  const housing = data.housing;
  if (!housing?.tenure) missingFields.push('housing.tenure');
  if (housing?.budgetCents == null) missingFields.push('housing.budgetCents');
  if (housing?.tenure === 'buy' && housing.homeSizeM2 == null) missingFields.push('housing.homeSizeM2');
  if (housing?.tenure && housing.budgetCents != null) {
    result.housing = { tenure: housing.tenure, maxBudgetEur: housing.budgetCents / 100 };
    if (housing.homeSizeM2 != null) result.housing.homeSizeM2 = housing.homeSizeM2;
    if (housing.allowComarcaEstimate === false) result.housing.allowComarcaEstimate = false;
    if (housing.allowComarcaEstimate === true) {
      if (resolved.provenance['housing.allowComarcaEstimate']?.some(item => item.confirmed))
        result.housing.allowComarcaEstimate = true;
      else unsupportedFields.push('housing.allowComarcaEstimate:requires_confirmation');
    }
  }
  if (housing?.minimumBedrooms != null) unsupportedFields.push('housing.minimumBedrooms');
  if (data.school) {
    if (data.school.stages == null) missingFields.push('school.stages');
    else {
      result.schoolStages = data.school.stages;
      if (data.school.stages.length && data.school.mode == null) missingFields.push('school.mode');
    }
    if (data.school.mode != null) result.schoolMode = data.school.mode;
    if (data.school.maxJourneyMinutes != null) result.maxSchoolJourneyMinutes = data.school.maxJourneyMinutes;
    if (data.school.stages?.length === 0 && (data.school.mode != null || data.school.maxJourneyMinutes != null))
      missingFields.push('school.stages:required_for_constraints');
  }
  if (data.transport) {
    if (data.transport.destinationCode == null) missingFields.push('transport.destinationCode');
    if (data.transport.maxCommuteMinutes == null) missingFields.push('transport.maxCommuteMinutes');
    if (data.transport.destinationCode != null && data.transport.maxCommuteMinutes != null)
      result.commute = {
        destinationCode: data.transport.destinationCode,
        maxMinutes: data.transport.maxCommuteMinutes,
      };
    if (data.transport.travelDate != null) result.travelDate = data.transport.travelDate;
  }
  if (data.rural?.required != null) result.ruralOnly = data.rural.required;
  for (const group of ['household', 'finance', 'location'] as const) {
    for (const [key, value] of Object.entries(data[group] ?? {}))
      if (value !== null && value !== undefined) unsupportedFields.push(`${group}.${key}`);
  }
  // Unsupported bedroom requirements cannot be claimed to have passed a town filter.
  const ready = missingFields.length === 0 && resolved.conflicts.length === 0 && housing?.minimumBedrooms == null;
  return { ready, input: ready ? recommendationInput.parse(result) : null, missingFields, unsupportedFields };
}
