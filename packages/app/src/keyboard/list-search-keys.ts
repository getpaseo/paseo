export type ListSearchKeyAction = "next" | "previous" | "submit";

export interface ListSearchKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

export const LIST_SEARCH_DATASET = { keyboardScope: "list-search" } as const;

export const LIST_SEARCH_SELECTOR = "[data-keyboard-scope='list-search']";

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
