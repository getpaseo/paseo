const ACTIVATES_ON_ENTER =
  'button, a[href], [role="button"], [role="link"], [role="tab"], [role="combobox"], [role="menuitem"]';

/**
 * Whether the focused element handles Enter itself (Back, Provider settings, Edit profiles,
 * Close, Retry, or a model row's sibling profile action button). Navigable rows carry
 * `data-model-browser-row="true"` and sync `activeKey` on focus, so Enter runs the active row
 * action even after arrowing away from a Tab-focused row.
 */
export function focusedModelBrowserControlOwnsEnter(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.closest('[data-model-browser-row="true"]')) return false;
  return active.matches(ACTIVATES_ON_ENTER);
}
