import type { ResultListNotice, ResultRow } from "./result-list";

/** What the sheet needs from the current tab to drive its keys and its primary button. */
export interface AddProjectTabView {
  /** The rows Up and Down walk; empty for a tab without a list. */
  rows: ResultRow[];
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

/** Where the picked row sits in `rows`; the first row when nothing listed is picked. */
export function resolveActiveIndex(
  rows: readonly { id: string }[],
  selectedId: string | null,
): number {
  const index = selectedId === null ? -1 : rows.findIndex((row) => row.id === selectedId);
  return Math.max(index, 0);
}
