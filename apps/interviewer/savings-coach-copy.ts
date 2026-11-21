import type { BilingualText } from "../../packages/site/language.ts";

export const savingsCoachCopy = {
  title: ["Simulador d’estalvi", "Savings Coach"],
  intro: ["Prova un hàbit i mira com canviaria el temps que necessites per estalviar per a un habitatge. Les dades són fictícies.", "Try one habit and see how it could change your home savings timeline. This demo uses fictional data."],
  target: ["Objectiu d’estalvi per a la compra", "Purchase cash target"],
  saved: ["Estalvis acumulats", "Already set aside"],
  remaining: ["Pendent d’estalviar", "Left to save"],
  monthly: ["Aportació mensual", "Monthly contribution"],
  pace: ["Al ritme actual", "At the current pace"],
  habit: ["Tria un hàbit per provar", "Choose a habit to try"],
  extra: ["Estalvi mensual addicional", "Extra monthly savings"],
  compare: ["Compara els terminis", "Compare timelines"],
  assumption: ["Indica una quantitat que creguis que pots estalviar cada mes.", "Use an amount you think you could set aside each month."],
  loading: ["Carregant el pla fictici…", "Loading the fictional plan…"],
} satisfies BilingualText;

export const catalanHabits: Record<string, readonly [title: string, action: string]> = {
  "Weekly money check-in": ["Revisa les finances un cop per setmana", "Dedica uns minuts cada setmana a revisar el pla i valorar si l’hàbit encara et va bé."],
  "Review optional subscriptions": ["Revisa les subscripcions prescindibles", "Fes una llista de les subscripcions i mira quines encara et fan servei. Mantén les essencials."],
  "Plan one affordable meal": ["Planifica un àpat econòmic", "Tria un àpat que s’ajusti a les teves necessitats i comprova si planificar-lo t’ajuda a estalviar."],
  "Review one regular journey": ["Revisa un trajecte habitual", "Compara una alternativa segura i pràctica que s’ajusti al temps i a l’accessibilitat que necessites."],
  "Review flexible spending": ["Revisa una despesa que puguis ajustar", "Tria un petit canvi en una despesa que puguis ajustar, si encaixa amb les teves prioritats."],
  "Review the cash-flow gap": ["Revisa la diferència entre ingressos i despeses", "Comprova que hi constin tots els ingressos i les despeses essencials abans de comprometre’t a estalviar més."],
};
