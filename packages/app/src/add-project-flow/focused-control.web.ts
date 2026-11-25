import { RESULTS_TEST_ID } from "./result-list-id";

const ACTIVATES_ON_ENTER =
  'button, a[href], [role="button"], [role="link"], [role="tab"], [role="combobox"], [role="menuitem"]';

/**
 * Whether the focused element handles Enter itself, such as the Close button, a tab, or the
 * Location field. Result rows are buttons too, but Enter on a row runs the primary action, the
 * same as Enter in the search field.
 */
export function focusedControlOwnsEnter(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.closest(`[data-testid="${RESULTS_TEST_ID}"]`)) return false;
  return active.matches(ACTIVATES_ON_ENTER);
}
