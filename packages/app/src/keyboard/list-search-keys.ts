/**
 * Keys owned by a search field that drives a result list (the model picker's
 * search is the one today): Emacs-style Ctrl+N / Ctrl+P and the arrow keys move
 * the highlight, Enter commits it.
 *
 * Global shortcuts must stand down for these keys while such a field holds
 * focus — on non-mac Ctrl+N is "new workspace" and Ctrl+P is "switch project",
 * and the global keydown listener runs at window capture, i.e. before the field
 * ever sees the event. `use-keyboard-shortcuts` bails out on these keys when the
 * focus scope is `list-search` (see keyboard/focus-scope.ts).
 */
export type ListSearchKeyAction = "next" | "previous" | "submit";

export interface ListSearchKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Marker for the search row. Web-only (react-native-web renders `dataSet` as
 * `data-*` attributes); on native it renders nothing and is harmless.
 */
export const LIST_SEARCH_DATASET = { keyboardScope: "list-search" } as const;

export const LIST_SEARCH_SELECTOR = "[data-keyboard-scope='list-search']";

/** The marker for a surface that only owns these keys while it is open. */
export function listNavigationDataSet(active: boolean): typeof LIST_SEARCH_DATASET | undefined {
  return active ? LIST_SEARCH_DATASET : undefined;
}

export function resolveListSearchKeyAction(event: ListSearchKeyEvent): ListSearchKeyAction | null {
  if (event.altKey || event.metaKey || event.shiftKey) return null;
  if (event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === "n") return "next";
    if (key === "p") return "previous";
    return null;
  }
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "previous";
  if (event.key === "Enter") return "submit";
  return null;
}
