import type { CheckStatus } from "./check-status";
import type { PrPaneCheck } from "./data";

/**
 * The order the checks section reads in: what the user can act on, then what they are
 * waiting on, then what needs no attention. Skipped trails everything because it is the
 * only status that says nothing about whether the run is going well.
 */
const STATUS_ORDER = [
  "failure",
  "pending",
  "success",
  "skipped",
] as const satisfies readonly CheckStatus[];

/** How each status reads inside a count phrase: "2 failing", "4 in progress". */
const STATUS_NOUN: Record<CheckStatus, string> = {
  failure: "failing",
  pending: "in progress",
  success: "successful",
  skipped: "skipped",
};

/** The worst thing happening in the run, which is what the headline and the ring report. */
export type ChecksOutcome = "failure" | "pending" | "success" | "none";

const OUTCOME_HEADLINE: Record<ChecksOutcome, string> = {
  failure: "Some checks were not successful",
  pending: "Some checks haven't completed yet",
  success: "All checks have passed",
  none: "No checks",
};

export interface ChecksCountPart {
  status: CheckStatus;
  count: number;
  /** e.g. "2 failing" */
  text: string;
}

export interface ChecksGroup {
  status: CheckStatus;
  /** e.g. "2 failing checks" */
  label: string;
  checks: readonly PrPaneCheck[];
}

export interface ChecksSummary {
  outcome: ChecksOutcome;
  /** e.g. "Some checks were not successful" */
  headline: string;
  /** The count phrases behind `detail`, kept apart so the header can label each one. */
  parts: readonly ChecksCountPart[];
  /** The noun closing the detail line — "checks", or "check" for a run of one. */
  countNoun: string;
  /** The whole line: "2 failing, 4 in progress, 1 successful checks". Empty with no checks. */
  detail: string;
  total: number;
  /** Non-empty groups only, in `STATUS_ORDER`. */
  groups: readonly ChecksGroup[];
}

/**
 * Reduces a change request's checks to everything the checks section renders, so the
 * header, the ring, and the grouped list all read from one derivation instead of each
 * filtering the array again with its own idea of what counts.
 */
export function summarizeChecks(checks: readonly PrPaneCheck[]): ChecksSummary {
  const groups: ChecksGroup[] = [];
  const parts: ChecksCountPart[] = [];

  for (const status of STATUS_ORDER) {
    const matching = checks.filter((check) => check.status === status);
    if (matching.length === 0) {
      continue;
    }
    groups.push({
      status,
      label: `${matching.length} ${STATUS_NOUN[status]} ${countNoun(matching.length)}`,
      checks: matching,
    });
    parts.push({
      status,
      count: matching.length,
      text: `${matching.length} ${STATUS_NOUN[status]}`,
    });
  }

  const outcome = selectOutcome(checks);
  const noun = countNoun(checks.length);
  return {
    outcome,
    headline: OUTCOME_HEADLINE[outcome],
    parts,
    countNoun: noun,
    detail: parts.length === 0 ? "" : `${parts.map((part) => part.text).join(", ")} ${noun}`,
    total: checks.length,
    groups,
  };
}

/**
 * A failure outranks anything still running: a run that is half done with one failure
 * already needs the user, and reporting it as in progress buries that.
 */
function selectOutcome(checks: readonly PrPaneCheck[]): ChecksOutcome {
  if (checks.length === 0) {
    return "none";
  }
  if (checks.some((check) => check.status === "failure")) {
    return "failure";
  }
  if (checks.some((check) => check.status === "pending")) {
    return "pending";
  }
  return "success";
}

function countNoun(count: number): string {
  return count === 1 ? "check" : "checks";
}
