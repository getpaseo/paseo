export interface PresentableCheck {
  status: string;
  rawStatus?: string;
  isManual?: boolean;
  requiresAction?: boolean;
}

export type CheckPresentation =
  | "actionRequired"
  | "warning"
  | "manual"
  | "success"
  | "failure"
  | "pending"
  | "ignored";

export interface CheckPresentationCounts {
  passed: number;
  failed: number;
  warnings: number;
  actionRequired: number;
  manual: number;
  pending: number;
}

export interface CheckPresentationCountLabels {
  heading: string;
  passed: string;
  failed: string;
  warnings: string;
  actionRequired: string;
  manual: string;
  pending: string;
}

export function classifyCheck(check: PresentableCheck): CheckPresentation {
  if (check.requiresAction) return "actionRequired";
  if (check.rawStatus?.toLowerCase() === "warning") return "warning";
  if (check.isManual) return "manual";
  if (check.status === "success") return "success";
  if (check.status === "failure") return "failure";
  if (check.status === "skipped" || check.status === "cancelled") return "ignored";
  return "pending";
}

export function countCheckPresentations(
  checks: readonly PresentableCheck[],
): CheckPresentationCounts {
  const counts: CheckPresentationCounts = {
    passed: 0,
    failed: 0,
    warnings: 0,
    actionRequired: 0,
    manual: 0,
    pending: 0,
  };
  for (const check of checks) {
    switch (classifyCheck(check)) {
      case "actionRequired":
        counts.actionRequired += 1;
        break;
      case "warning":
        counts.warnings += 1;
        break;
      case "manual":
        counts.manual += 1;
        break;
      case "success":
        counts.passed += 1;
        break;
      case "failure":
        counts.failed += 1;
        break;
      case "pending":
        counts.pending += 1;
        break;
      case "ignored":
        break;
    }
  }
  return counts;
}

export function formatCheckPresentationCountsLabel(
  counts: CheckPresentationCounts,
  labels: CheckPresentationCountLabels,
): string {
  return [
    labels.heading,
    counts.passed > 0 ? labels.passed : null,
    counts.failed > 0 ? labels.failed : null,
    counts.warnings > 0 ? labels.warnings : null,
    counts.actionRequired > 0 ? labels.actionRequired : null,
    counts.manual > 0 ? labels.manual : null,
    counts.pending > 0 ? labels.pending : null,
  ]
    .filter(Boolean)
    .join(", ");
}
