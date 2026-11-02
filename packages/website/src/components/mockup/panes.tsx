import { DiffRows, REVIEW_DIFF_ROWS, ScopeRow } from "./diff";
import { useTranslation } from "react-i18next";

// --- review -----------------------------------------------------------------

/** The selected Changes-tree file, open in its own workspace tab. */
export function DiffReviewPane() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-mock-surface0">
      <ScopeRow label={t("landing.mockup.app.uncommitted")} />
      <DiffRows rows={REVIEW_DIFF_ROWS} />
    </div>
  );
}
