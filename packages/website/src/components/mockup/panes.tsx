import { DiffRows, REVIEW_DIFF_ROWS, ScopeRow } from "./diff";

// --- review -----------------------------------------------------------------

/** The selected Changes-tree file, open in its own workspace tab. */
export function DiffReviewPane() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-mock-surface0">
      <ScopeRow label="Uncommitted" />
      <DiffRows rows={REVIEW_DIFF_ROWS} />
    </div>
  );
}
