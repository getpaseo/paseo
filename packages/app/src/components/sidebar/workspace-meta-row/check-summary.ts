import { mapCheckStatus } from "@/git/pull-request-panel/check-status";
import type { PrHint } from "@/git/pr-hint";

/**
 * What the sidebar reports about a change request's CI, reduced to the three things a row
 * can show. "running" carries a fraction so the indicator can fill as checks land.
 */
export type CheckSummaryState = "passed" | "failed" | "running";

export interface CheckSummary {
  state: CheckSummaryState;
  /** Checks that have reached a terminal status. Equals `total` when state is not "running". */
  completed: number;
  total: number;
}

/**
 * Failure wins over progress. A run that is half done with one failure already needs the
 * user to open the hover card, and a ring still filling says "wait" — so the moment any
 * check fails the summary is "failed" and the fraction stops mattering.
 *
 * `checks` is the richer source and the only one that can produce a fraction. Forges that
 * report a summary without the individual checks fall back to `checksStatus`, which
 * degrades the ring to empty-or-full rather than dropping the indicator.
 */
export function selectCheckSummary(hint: PrHint | null): CheckSummary | null {
  if (!hint) return null;
  return summarizeChecks(hint.checks) ?? summarizeChecksStatus(hint.checksStatus);
}

/** The pie has four pieces, so a run reports progress in quarters. */
const PIE_PIECES = 4;

/**
 * How much of the pie is filled, as a fraction, snapped down to a quarter. Rounding down
 * rather than to nearest means the indicator never claims a check finished that hasn't —
 * nine of ten reads as three quarters, and only the tenth closes the circle.
 */
export function toFilledQuarters(summary: CheckSummary): number {
  if (summary.total === 0) return 0;
  return Math.floor((summary.completed / summary.total) * PIE_PIECES) / PIE_PIECES;
}

function summarizeChecks(checks: PrHint["checks"]): CheckSummary | null {
  if (!checks || checks.length === 0) return null;

  let completed = 0;
  let failed = false;
  for (const check of checks) {
    const status = mapCheckStatus(check.status);
    if (status === "failure") failed = true;
    if (status !== "pending") completed += 1;
  }

  const total = checks.length;
  if (failed) return { state: "failed", completed: total, total };
  if (completed === total) return { state: "passed", completed: total, total };
  return { state: "running", completed, total };
}

function summarizeChecksStatus(checksStatus: PrHint["checksStatus"]): CheckSummary | null {
  switch (checksStatus) {
    case "success":
      return { state: "passed", completed: 1, total: 1 };
    case "failure":
      return { state: "failed", completed: 1, total: 1 };
    case "pending":
      return { state: "running", completed: 0, total: 1 };
    default:
      return null;
  }
}
