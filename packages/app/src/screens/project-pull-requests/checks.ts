import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import { mapCheckStatus } from "@/git/pull-request-panel/check-status";

export type SearchCheck = NonNullable<ForgeSearchItem["checks"]>[number];
export interface CheckIndicators {
  failures: SearchCheck[];
  cancelled: SearchCheck[];
  summary: "passed" | "pending" | "skipped" | null;
}

export function getCheckIndicators(checks: ForgeSearchItem["checks"]): CheckIndicators {
  const failures: SearchCheck[] = [];
  const cancelled: SearchCheck[] = [];
  let pending = false;
  let passed = false;
  for (const check of checks ?? []) {
    switch (mapCheckStatus(check.status)) {
      case "failure":
        failures.push(check);
        break;
      case "cancelled":
        cancelled.push(check);
        break;
      case "pending":
        pending = true;
        break;
      case "success":
        passed = true;
        break;
      case "skipped":
        break;
    }
  }
  if (pending) return { failures, cancelled, summary: "pending" };
  if (failures.length || cancelled.length || !checks?.length)
    return { failures, cancelled, summary: null };
  return { failures, cancelled, summary: passed ? "passed" : "skipped" };
}

export function checkLabel(check: SearchCheck): string {
  return check.workflow && check.workflow !== check.name
    ? `${check.workflow} / ${check.name}`
    : check.name;
}
