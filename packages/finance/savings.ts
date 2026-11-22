/**
 * The longest savings timeline any ReloCat surface reports: 600 months (50 years). A target further
 * away is not a plan, and holding income, expenses and prices constant for longer is not credible.
 */
export const maxPlanningMonths = 600;

/**
 * The one savings-timeline rule shared by every ReloCat surface.
 *
 * Months are rounded up. A target already reached takes zero months. Zero, negative or unknown
 * monthly savings produce no finite timeline (`null`) rather than a misleading number, and so does a
 * target more than `maxPlanningMonths` away.
 * The amounts only need to share a unit (cents or euros).
 */
export function monthsToTarget(remaining: number, monthlySavings: number | null): number | null {
  if (remaining <= 0) return 0;
  if (monthlySavings === null || !(monthlySavings > 0)) return null;
  const months = Math.ceil(remaining / monthlySavings);
  return Number.isSafeInteger(months) && months <= maxPlanningMonths ? months : null;
}
