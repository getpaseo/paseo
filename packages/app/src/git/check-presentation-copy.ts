import type { TFunction } from "i18next";
import {
  COUNTED_CHECK_PRESENTATIONS,
  classifyCheck,
  type CheckPresentationCounts,
  type CountedCheckPresentation,
  type PresentableCheck,
} from "./check-presentation";

const CHECK_PRESENTATION_COUNT_KEYS = {
  success: "sidebar.workspace.checks.passed",
  failure: "sidebar.workspace.checks.failed",
  warning: "sidebar.workspace.checks.warning",
  actionRequired: "sidebar.workspace.checks.actionRequired",
  manual: "sidebar.workspace.checks.manual",
  pending: "sidebar.workspace.checks.pending",
} as const satisfies Record<CountedCheckPresentation, string>;

const CHECK_PRESENTATION_STATUS_KEYS = {
  success: "workspace.git.pr.accessibility.checkStatus.passed",
  failure: "workspace.git.pr.accessibility.checkStatus.failed",
  warning: "workspace.git.pr.accessibility.checkStatus.warning",
  actionRequired: "workspace.git.pr.accessibility.checkStatus.actionRequired",
  manual: "workspace.git.pr.accessibility.checkStatus.manual",
  pending: "workspace.git.pr.accessibility.checkStatus.pending",
} as const satisfies Record<CountedCheckPresentation, string>;

export function getCheckPresentationCountLabel(
  presentation: CountedCheckPresentation,
  count: number,
  t: TFunction,
): string {
  return t(CHECK_PRESENTATION_COUNT_KEYS[presentation], { count });
}

export function formatCheckPresentationCountsLabel(
  counts: CheckPresentationCounts,
  heading: string,
  t: TFunction,
): string {
  const labels = COUNTED_CHECK_PRESENTATIONS.flatMap((presentation) => {
    const count = counts[presentation];
    return count > 0 ? [getCheckPresentationCountLabel(presentation, count, t)] : [];
  });
  return [heading, ...labels].join(", ");
}

export function getCheckPresentationStatusLabel(check: PresentableCheck, t: TFunction): string {
  const presentation = classifyCheck(check);
  if (presentation !== "ignored") return t(CHECK_PRESENTATION_STATUS_KEYS[presentation]);
  if (check.rawStatus?.toLowerCase() === "cancelled") {
    return t("workspace.git.pr.accessibility.checkStatus.cancelled");
  }
  return t("workspace.git.pr.accessibility.checkStatus.skipped");
}
