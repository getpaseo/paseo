import type { ResultListNotice, ResultRow } from "./result-list";

/** What the sheet needs from the current tab to drive its keys and its primary button. */
export interface AddProjectTabView {
  /** The rows Up and Down walk; empty for a tab without a list. */
  rows: ResultRow[];
  /** The active row, or -1 when none is: an older search's rows, or a pick the new answer dropped. */
  activeIndex: number;
  notice: ResultListNotice | null;
  /** Why this host cannot do what the tab offers; the tab's fields are read-only while set. */
  unavailable: string | null;
  primary: {
    label: string;
    /** Absent when there is nothing to commit yet. */
    submit: (() => void) | null;
  };
}

/**
 * Where the user's pick sits in `rows`. Without a pick, the first row is the default. A pick that
 * a new answer dropped is not swapped for another row: nothing is active until the user picks again.
 */
export function resolveActiveIndex(
  rows: readonly { id: string }[],
  selectedId: string | null,
): number {
  if (selectedId === null) return rows.length > 0 ? 0 : -1;
  return rows.findIndex((row) => row.id === selectedId);
}
