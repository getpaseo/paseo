import { classifyCheck, type CheckPresentation } from "@/git/check-presentation";
import type { TFunction } from "i18next";
import type { PrPaneCheck } from "./data";

/**
 * The order the checks section reads in: what the user can act on, then what they are
 * waiting on, then what needs no attention. Skipped trails everything because it is the
 * only status that says nothing about whether the run is going well.
 */
const PRESENTATION_ORDER = [
  "actionRequired",
  "warning",
  "failure",
  "pending",
  "manual",
  "success",
  "ignored",
] as const satisfies readonly CheckPresentation[];

/** The worst thing happening in the run, which is what the headline and the ring report. */
export type ChecksOutcome = "actionRequired" | "failure" | "pending" | "success" | "none";

const COPY = "workspace.git.pr.checksOverview";

export interface ChecksCountPart {
  status: CheckPresentation;
  count: number;
  /** e.g. "2 failing" */
  text: string;
}

export interface ChecksGroup {
  status: CheckPresentation;
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
  /**
   * The words around the count phrases in `detail`: "" and " checks" in English, where the noun
   * closes the line, while other languages lead with it.
   */
  detailLead: string;
  detailTrail: string;
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
export function summarizeChecks(checks: readonly PrPaneCheck[], t: TFunction): ChecksSummary {
  const groups: ChecksGroup[] = [];
  const parts: ChecksCountPart[] = [];

  for (const status of PRESENTATION_ORDER) {
    const matching = checks.filter((check) => classifyCheck(check) === status);
    if (matching.length === 0) {
      continue;
    }
    groups.push({
      status,
      label: t(`${COPY}.${matching.length === 1 ? "groupOne" : "groupMany"}.${status}`, {
        count: matching.length,
      }),
      checks: matching,
    });
    parts.push({
      status,
      count: matching.length,
      text: t(`${COPY}.count.${status}`, { count: matching.length }),
    });
  }

  const outcome = selectOutcome(checks);
  const { lead, trail } = detailFrame(checks.length, t);
  return {
    outcome,
    headline: t(`${COPY}.headline.${outcome}`),
    parts,
    detailLead: lead,
    detailTrail: trail,
    detail: parts.length === 0 ? "" : `${lead}${parts.map((part) => part.text).join(", ")}${trail}`,
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
  if (checks.some((check) => classifyCheck(check) === "actionRequired")) {
    return "actionRequired";
  }
  if (
    checks.some((check) => {
      const presentation = classifyCheck(check);
      return presentation === "failure" || presentation === "warning";
    })
  ) {
    return "failure";
  }
  if (checks.some((check) => check.status === "pending")) {
    return "pending";
  }
  return "success";
}

/**
 * The header renders each count phrase on its own, so the translated line is split around
 * where the phrases go.
 */
function detailFrame(total: number, t: TFunction): { lead: string; trail: string } {
  const marker = "\u0000";
  const line = t(`${COPY}.${total === 1 ? "detailOne" : "detailMany"}`, { parts: marker });
  const [lead = "", trail = ""] = line.split(marker);
  return { lead, trail };
}
