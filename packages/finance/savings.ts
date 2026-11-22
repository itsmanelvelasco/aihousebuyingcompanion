/**
 * The one savings-timeline rule shared by every ReloCat surface.
 *
 * Months are rounded up. A target already reached takes zero months. Zero, negative or unknown
 * monthly savings produce no finite timeline (`null`) rather than a misleading number.
 * The amounts only need to share a unit (cents or euros).
 */
export function monthsToTarget(remaining: number, monthlySavings: number | null): number | null {
  if (remaining <= 0) return 0;
  if (monthlySavings === null || !(monthlySavings > 0)) return null;
  const months = Math.ceil(remaining / monthlySavings);
  return Number.isSafeInteger(months) ? months : null;
}
