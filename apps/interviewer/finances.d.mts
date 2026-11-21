export interface CashFlowSummary {
  observedMonths: string[];
  transactionCount: number;
  excludedTransfers: number;
  estimatedMonthlySalary: number | null;
  monthlyOtherIncome: number;
  salaryMonths: number;
  monthlyInflows: number;
  monthlyCostOfLiving: number;
  monthlyNetCashFlow: number;
  monthlyExpenses: Record<string, number>;
}

export interface SavingsPlanInput {
  target: number;
  saved: number;
  monthly: number;
  habit: number;
}

export interface SavingsComparison {
  remaining: number;
  baselineMonths: number | null;
  withHabitMonths: number | null;
}

export function summarizeCsv(csv: string): CashFlowSummary;
export function compareSavings(plan: SavingsPlanInput): SavingsComparison;
