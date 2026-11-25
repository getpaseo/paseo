import type { ResultListNotice, ResultRow } from "./result-list";

/** What the sheet needs from the current tab to drive its keys and its primary button. */
export interface AddProjectTabView {
  /** The rows Up and Down walk; empty for a tab without a list. */
  rows: ResultRow[];
  activeIndex: number;
  notice: ResultListNotice | null;
  primary: {
    label: string;
    /** Absent when there is nothing to commit yet. */
    submit: (() => void) | null;
  };
}

/** Clamps a stored selection to the rows that arrived for it. */
export function clampActiveIndex(activeIndex: number, rowCount: number): number {
  if (rowCount === 0) return 0;
  return Math.min(Math.max(activeIndex, 0), rowCount - 1);
}
