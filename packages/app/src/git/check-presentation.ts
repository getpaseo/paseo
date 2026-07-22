export interface PresentableCheck {
  status: string;
  rawStatus?: string;
  traits?: readonly string[];
}

export const COUNTED_CHECK_PRESENTATIONS = [
  "success",
  "failure",
  "warning",
  "actionRequired",
  "manual",
  "pending",
] as const;

export type CountedCheckPresentation = (typeof COUNTED_CHECK_PRESENTATIONS)[number];
export type CheckPresentation = CountedCheckPresentation | "ignored";

export const ATTENTION_CHECK_PRESENTATIONS = [
  "failure",
  "warning",
  "actionRequired",
] as const satisfies readonly CountedCheckPresentation[];

export type CheckPresentationCounts = Record<CountedCheckPresentation, number>;

export function classifyCheck(check: PresentableCheck): CheckPresentation {
  const traits = check.traits ?? [];
  if (traits.includes("action_required")) return "actionRequired";
  if (traits.includes("warning")) return "warning";
  if (traits.includes("manual")) return "manual";
  if (check.status === "success") return "success";
  if (check.status === "failure") return "failure";
  if (check.status === "skipped" || check.status === "cancelled") return "ignored";
  return "pending";
}

export function countCheckPresentations(
  checks: readonly PresentableCheck[],
): CheckPresentationCounts {
  const counts: CheckPresentationCounts = {
    success: 0,
    failure: 0,
    warning: 0,
    actionRequired: 0,
    manual: 0,
    pending: 0,
  };
  for (const check of checks) {
    const presentation = classifyCheck(check);
    if (presentation !== "ignored") counts[presentation] += 1;
  }
  return counts;
}
