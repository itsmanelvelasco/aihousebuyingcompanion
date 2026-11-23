/**
 * Bring a part of the workspace to the person: open it when it is a collapsed `<details>`, scroll
 * to it and move the keyboard focus there, so a button that says "Add a habit" ends on the form.
 * The first id that exists is used; the rest are fallbacks for a state where that part is not on
 * screen (no person selected, for instance). Returns the id it went to, or null.
 */
export function reveal(...ids: string[]): string | null {
  if (typeof document === 'undefined') return null;
  for (const id of ids) {
    const element = document.getElementById(id);
    if (!element) continue;
    if (element instanceof HTMLDetailsElement) element.open = true;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    element.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    const target =
      element instanceof HTMLDetailsElement ? (element.querySelector<HTMLElement>('summary') ?? element) : element;
    // A heading takes focus only when asked to; it stays out of the tab order.
    if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    return id;
  }
  return null;
}
