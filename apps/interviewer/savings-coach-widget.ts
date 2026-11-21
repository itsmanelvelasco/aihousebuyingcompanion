import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { compareSavings } from "./finances.mjs";
import { savingsCoachOutput, savingsComparisonInput, savingsComparisonOutput } from "./savings-contract.ts";
import type { SavingsCoach } from "./savings-contract.ts";

const element = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const content = element("savings-coach-content");
const status = element("coach-status");
const form = element<HTMLFormElement>("coach-form");
const controls = element<HTMLFieldSetElement>("coach-controls");
const habit = element<HTMLSelectElement>("coach-habit");
const amount = element<HTMLInputElement>("coach-extra");
const result = element("coach-result");
const timeout = 15_000;
const catalan = document.documentElement.lang === "ca";
const t = (ca: string, en: string) => catalan ? ca : en;

function duration(months: number | null) {
  if (months === null) return t("Termini sense estimar", "No projected timeline");
  if (months === 0) return t("Objectiu assolit", "Target reached");
  return `${months} ${months === 1 ? t("mes", "month") : t("mesos", "months")}`;
}

function render(plan: SavingsCoach, app?: App) {
  const money = new Intl.NumberFormat(catalan ? "ca-ES" : undefined,
    { style: "currency", currency: plan.currency, minimumFractionDigits: 0, maximumFractionDigits: 2 });
  element("coach-target").textContent = money.format(plan.target);
  element("coach-saved").textContent = money.format(plan.saved);
  element("coach-remaining").textContent = money.format(plan.remaining);
  element("coach-monthly").textContent = money.format(plan.monthly);
  element("coach-baseline").textContent = duration(plan.baselineMonths);
  element("coach-extra-label").textContent = `${t("Estalvi mensual addicional", "Extra monthly savings")} (${plan.currency})`;
  element("coach-habits").hidden = !plan.suggestions.length;
  habit.replaceChildren(...plan.suggestions.map((item, index) => new Option(item.title, String(index))));
  function showHabit() {
    element("coach-action").textContent = plan.suggestions[Number(habit.value)]?.action ?? "";
    result.hidden = true;
  }
  showHabit();
  habit.onchange = showHabit;
  amount.oninput = () => { result.hidden = true; };
  form.onsubmit = async event => {
    event.preventDefault();
    const input = savingsComparisonInput.safeParse({ target: plan.target, saved: plan.saved, monthly: plan.monthly, habit: amount.valueAsNumber });
    if (!input.success) {
      status.textContent = t("Introdueix una quantitat igual o superior a zero.", "Enter an extra monthly savings amount of zero or more.");
      return;
    }
    result.hidden = true;
    controls.disabled = true;
    status.textContent = t("Comparant terminis…", "Comparing timelines…");
    try {
      const response = app && await app.callServerTool({ name: "compare_home_savings", arguments: input.data }, { timeout });
      if (response?.isError) throw new Error("Savings comparison failed");
      const comparison = savingsComparisonOutput.parse(response ? response.structuredContent : compareSavings(input.data));
      const { baselineMonths, withHabitMonths } = comparison;
      const difference = baselineMonths === null || withHabitMonths === null ? null : baselineMonths - withHabitMonths;
      element("coach-projection").textContent = duration(withHabitMonths);
      const extra = money.format(input.data.habit);
      element("coach-difference").textContent = difference !== null && difference > 0
        ? t(`Hi arribaries ${duration(difference)} abans si estalvies ${extra} més cada mes.`, `${duration(difference)} sooner if you set aside ${extra} more each month.`)
        : difference === 0 ? t("El termini estimat es manté.", "This amount keeps the same estimated timeline.")
        : withHabitMonths === null ? t("Cal una aportació mensual positiva per estimar el termini.", "The estimate needs a positive monthly contribution.")
        : t("Amb l’aportació addicional ja podem estimar un termini.", "The extra contribution gives this plan a projected timeline.");
      result.hidden = false;
      status.textContent = "";
    } catch {
      status.textContent = t("No s’ha pogut carregar la comparació. Torna-ho a provar.", "The comparison could not load. Try again.");
    } finally {
      controls.disabled = false;
    }
  };
  content.hidden = false;
  status.textContent = "";
}

async function initialize() {
  const demo = document.querySelector("#savings-coach-data")?.textContent;
  if (demo) {
    render(savingsCoachOutput.parse(JSON.parse(demo)));
    return;
  }
  const app = new App({ name: "Relocat Savings Coach", version: "1.0.0" });
  const timer = window.setTimeout(() => { status.textContent = "No savings plan arrived. Open the Savings Coach again to retry."; }, timeout);
  app.ontoolresult = message => {
    window.clearTimeout(timer);
    const plan = savingsCoachOutput.safeParse(message.structuredContent);
    if (plan.success) render(plan.data, app);
    else status.textContent = "The fictional plan could not load. Open the Savings Coach again to retry.";
  };
  app.onhostcontextchanged = context => { if (context.theme) applyDocumentTheme(context.theme); };
  try {
    await app.connect(undefined, { timeout });
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
  } catch (error) {
    window.clearTimeout(timer);
    throw error;
  }
}

void initialize().catch(() => {
  status.textContent = t("No s’ha pogut carregar el simulador d’estalvi. Recarrega la pàgina per tornar-ho a provar.",
    "The Savings Coach could not load. Open it again to retry.");
});
