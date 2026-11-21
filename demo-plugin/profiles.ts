import { z } from 'zod';
import { loadData } from '../packages/places/data.ts';
import { recommendTowns } from '../packages/places/recommend.ts';
import { resolveInputs, buildRecommendationInput, inputSchema } from '../packages/contracts/inputs.ts';
import type { DemoView } from './demo.ts';

export const connectedAnswers = z.object({
  town: z.string().trim().min(1).max(80).optional(), bedrooms: z.number().int().min(1).max(20).optional(),
  household: z.number().int().min(1).max(30).optional(), employment: z.string().trim().min(1).max(100).optional(),
  income: z.number().nonnegative().max(1e7).optional(), spending: z.number().nonnegative().max(1e7).optional(),
  savings: z.number().nonnegative().max(1e7).optional(), budget: z.number().positive().max(5e7).optional(),
  floorArea: z.number().positive().max(2000).optional(), upfrontTarget: z.number().positive().max(1e7).optional(), emergencyReserve: z.number().nonnegative().max(1e7).optional(), destinationCode: z.string().regex(/^\d{6}$/).optional(),
  maxCommuteMinutes: z.number().int().min(1).max(360).optional(),
  schoolStages: z.array(z.enum(['nursery', 'infantil', 'primary', 'eso', 'batxillerat', 'fp'])).max(6).optional(),
  schoolMode: z.enum(['car_free', 'rail']).optional(), allowComarcaEstimate: z.boolean().optional()
}).strict();
type Answers = z.infer<typeof connectedAnswers>;
export type Connection = { baseUrl: string; token: string };
export function profileConnection(): Connection | null {
  const baseUrl = process.env.PROFILE_API_URL;
  const token = process.env.PROFILE_API_TOKEN;
  if (!baseUrl && !token) return null;
  if (!baseUrl || !token) throw new Error('Set both PROFILE_API_URL and PROFILE_API_TOKEN for connected mode');
  const url = new URL(baseUrl);
  if (url.username || url.password || !(['https:'].includes(url.protocol) || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Profile API needs HTTPS or loopback HTTP without embedded credentials');
  return { baseUrl: url.origin, token };
}
const ids = { onboarding: 'user-001', progress: 'user-002', shortcuts: 'user-003', payoff: 'user-004' };
const observationClocks = new Map<string, number>();
export class ProfileBridge {
  config: Connection;
  constructor(config: Connection) { this.config = config; }
  async request(userId: string, path: string, method = 'GET', body?: unknown) {
    let response: Response;
    try { response = await fetch(`${this.config.baseUrl}/users/${userId}${path}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) }); }
    catch { throw new Error('Profile service is unavailable; no scripted fallback was used.'); }
    if (!response.ok) throw new Error(`Profile service rejected the request (${response.status}); no scripted fallback was used.`);
    return await response.json();
  }
  user(view: DemoView) { return ids[view.persona]; }
  async save(view: DemoView, answers: Answers) {
    const id = this.user(view);
    const cents = (n: number) => Math.round(n * 100);
    const data: Record<string, Record<string, unknown>> = {};
    const set = (group: string, field: string, value: unknown) => { if (value !== undefined) (data[group] ??= {})[field] = value; };
    set('housing', 'tenure', 'buy');
    set('housing', 'minimumBedrooms', answers.bedrooms);
    set('housing', 'budgetCents', answers.budget === undefined ? undefined : cents(answers.budget));
    set('housing', 'homeSizeM2', answers.floorArea);
    set('housing', 'allowComarcaEstimate', answers.allowComarcaEstimate);
    set('household', 'size', answers.household); set('household', 'employmentStatus', answers.employment);
    set('location', 'currentMunicipality', undefined); // A target town is not the current residence.
    if (answers.town) {
      const { snapshot } = loadData();
      const town = snapshot.municipalities.find(town => town.name.localeCompare(answers.town!, 'ca', { sensitivity: 'base' }) === 0);
      if (town) set('location', 'selectedMunicipalityCode', town.code);
    }
    set('transport', 'destinationCode', answers.destinationCode); set('transport', 'maxCommuteMinutes', answers.maxCommuteMinutes);
    set('school', 'stages', answers.schoolStages); set('school', 'mode', answers.schoolMode);
    set('finance', 'monthlyIncomeCents', answers.income === undefined ? undefined : cents(answers.income));
    set('finance', 'currentSavingsCents', answers.savings === undefined ? undefined : cents(answers.savings));
    set('finance', 'targetCashCents', answers.upfrontTarget === undefined ? undefined : cents(answers.upfrontTarget));
    set('finance', 'emergencyReserveCents', answers.emergencyReserve === undefined ? undefined : cents(answers.emergencyReserve));
    if (answers.spending !== undefined) {
      // Interview spending is explicitly total spending, already including debt.
      set('finance', 'monthlyExpensesCents', cents(answers.spending));
      set('finance', 'debtPaymentsCents', 0);
    }
    const clock = Math.max(Date.now(), (observationClocks.get(view.runId) ?? 0) + 1);
    observationClocks.set(view.runId, clock);
    const input = inputSchema.parse({ id: `interview-${view.runId}-${view.revision}`, source: 'interview', observedAt: new Date(clock).toISOString(), synthetic: true, confirmed: true, data });
    await this.request(id, '/inputs', 'POST', { inputs: [input] });
  }
  async connectBank(view: DemoView) {
    const id = this.user(view);
    const accounts = await this.request(id, '/bank/accounts');
    if (!accounts.accounts.length) await this.request(id, '/bank/demo', 'POST', {});
  }
  async runtime(view: DemoView, enabled: boolean) {
    await this.request(this.user(view), '/bank/runtime', 'POST', { enabled, intervalMs: 5000 });
  }
  async decorate(view: DemoView) {
    const id = this.user(view);
    const [context, accounts, runtime, events] = await Promise.all([
      this.request(id, '/context'), this.request(id, '/bank/accounts'),
      this.request(id, '/bank/runtime'), this.request(id, '/bank/events?after=0&limit=1')
    ]);
    const data = context.resolved.data;
    const answers: Record<string, unknown> = 'answers' in view ? { ...view.answers } : {};
    const fill = (key: string, value: unknown) => { if (value !== undefined && value !== null) answers[key] = value; };
    fill('household', data.household?.size); fill('employment', data.household?.employmentStatus);
    fill('bedrooms', data.housing?.minimumBedrooms); fill('budget', data.housing?.budgetCents == null ? null : data.housing.budgetCents / 100);
    fill('floorArea', data.housing?.homeSizeM2); fill('destinationCode', data.transport?.destinationCode); fill('maxCommuteMinutes', data.transport?.maxCommuteMinutes);
    fill('schoolStages', data.school?.stages); fill('schoolMode', data.school?.mode); fill('allowComarcaEstimate', data.housing?.allowComarcaEstimate);
    fill('income', data.finance?.monthlyIncomeCents == null ? null : data.finance.monthlyIncomeCents / 100);
    fill('spending', data.finance?.monthlyExpensesCents == null ? null : (data.finance.monthlyExpensesCents + (data.finance.debtPaymentsCents ?? 0)) / 100);
    fill('savings', data.finance?.currentSavingsCents == null ? null : data.finance.currentSavingsCents / 100);
    fill('upfrontTarget', data.finance?.targetCashCents == null ? null : data.finance.targetCashCents / 100);
    fill('emergencyReserve', data.finance?.emergencyReserveCents == null ? null : data.finance.emergencyReserveCents / 100);
    const currentBalance = accounts.accounts.length && accounts.accounts.every((a: { balanceCents: unknown }) => typeof a.balanceCents === 'number')
      ? accounts.accounts.reduce((sum: number, a: { balanceCents: number }) => sum + a.balanceCents, 0) : null;
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const summary = await this.request(id, `/bank/summary?from=${from}&to=${to}`);
    const extra: Record<string, unknown> = {
      connection: { mode: 'connected_synthetic', userId: id, ledgerRevision: events.latestRevision, liveBankBalanceCents: currentBalance, runtime, summary, warnings: ['Live account balances are not assumed available for a purchase; savings remain the declared/profile snapshot value.', 'Interview spending already includes debt; debtPaymentsCents is zero when this aggregate is supplied. No mortgage approval is implied.', ...('answers' in view && view.answers.town && !data.location?.selectedMunicipalityCode ? ['Requested town name is outside the pilot or unresolved; it has not been applied as a municipality filter.'] : [])] },
      profileContext: context
    };
    // A town screen cannot verify bedrooms. Retain that requirement for property checks
    // and clearly mark this as a provisional municipality screen, never a home match.
    const relaxed = structuredClone(data);
    const propertyChecks = relaxed.housing?.minimumBedrooms == null ? [] : [{ field: 'minimumBedrooms', required: relaxed.housing.minimumBedrooms, status: 'needs_property_listing' }];
    if (relaxed.housing) relaxed.housing.minimumBedrooms = null;
    const parsed = inputSchema.safeParse({ id: 'town-screen', source: 'manual', confirmed: false, synthetic: true, observedAt: new Date().toISOString(), data: relaxed });
    let towns: unknown = null;
    if (parsed.success) {
      const resolved = resolveInputs([parsed.data]);
      // Preserve explicit confirmation provenance only for comarca consent.
      resolved.provenance['housing.allowComarcaEstimate'] = context.resolved.provenance['housing.allowComarcaEstimate'] ?? [];
      resolved.conflicts = context.resolved.conflicts;
      const prepared = buildRecommendationInput(resolved);
      if (prepared.ready && prepared.input) {
        const { snapshot, policies } = loadData();
        towns = recommendTowns(snapshot, policies, { ...prepared.input, limit: 3 }, new Date().toISOString().slice(0, 10));
      }
      extra.townScreening = { ...prepared, result: towns, propertyChecks, completeHomeMatch: false };
    }
    if ('answers' in view) {
      const required = ['budget', 'floorArea', 'destinationCode', 'maxCommuteMinutes', 'schoolStages', ...(Array.isArray(answers.schoolStages) && answers.schoolStages.length ? ['schoolMode'] : []), 'allowComarcaEstimate', 'upfrontTarget', 'emergencyReserve'];
      const prompts: Record<string, string> = { budget: 'Maximum purchase budget in EUR?', floorArea: 'Required floor area in m²?', destinationCode: 'Six-digit municipality code for the commute destination?', maxCommuteMinutes: 'Maximum one-way commute in minutes?', schoolStages: 'Required stages as a comma-separated list (empty means none)?', schoolMode: 'School travel mode: car_free or rail?', allowComarcaEstimate: 'May we use clearly labelled comarca purchase-price estimates? true or false', upfrontTarget: 'Confirmed upfront cash target in EUR, including your deposit, tax and fee assumptions?', emergencyReserve: 'How much savings in EUR must remain as an emergency reserve?' };
      const examples: Record<string, string> = { budget: '130000', floorArea: '85', destinationCode: '251207', maxCommuteMinutes: '120', schoolStages: 'eso', schoolMode: 'rail', allowComarcaEstimate: 'false', upfrontTarget: '54000' };
      const group = { title: 'Complete the municipality screening', questions: required.filter(key => answers[key] === undefined || answers[key] === null).map(key => ({ id: key, prompt: prompts[key], example: examples[key] ?? '0', kind: ['budget', 'floorArea', 'maxCommuteMinutes', 'upfrontTarget', 'emergencyReserve'].includes(key) ? 'number' : 'text' })) };
      const saved = typeof answers.savings === 'number' ? answers.savings : null;
      const monthly = summary.averageMonthlySavingsCents === null ? null : summary.averageMonthlySavingsCents / 100;
      const target = data.finance?.targetCashCents == null ? null : data.finance.targetCashCents / 100;
      const available = saved === null || data.finance?.emergencyReserveCents == null ? null : Math.max(0, saved - data.finance.emergencyReserveCents / 100);
      const months = available !== null && target !== null && monthly !== null ? (available >= target ? 0 : monthly > 0 ? Math.ceil((target - available) / monthly) : null) : null;
      return { ...view, ...extra, answers, group: group.questions.length ? group : null, totalQuestions: Object.keys(answers).length + group.questions.length,
        bank: accounts.accounts.length ? { currency: 'EUR', savings: saved, income: answers.income, spending: answers.spending, discretionary: 0, insight: 'Runtime ledger balances are loaded. Historical cash-flow estimates retain their stated period and assumptions.' } : null,
        plan: available !== null && target !== null && monthly !== null ? { saved: available, monthly, target, upfrontMonths: months, termMonths: 240, debtFreeMonths: months === null ? null : months + 240 } : null,
        message: group.questions.length ? group.questions.map(q => q.prompt).join(' ') : 'Profile saved. Compare the sourced municipality screen; property-level bedroom requirements remain unverified.' };
    }
    // Legacy scenes remain scripted illustrations, visibly separated from runtime data.
    return { ...view, ...extra, message: `${view.message} This scene is scripted; connected profile and bank facts are shown separately.` };
  }
}
