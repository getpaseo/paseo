import type { TFunction } from "i18next";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  aggregateSidebarStateBuckets,
  deriveSidebarStateBucket,
} from "@/utils/sidebar-agent-state";
import type { SubagentRow } from "./select";
import { isFinishedSubagent } from "./archive-finished";
import { providerSubagentLifecycleStatus } from "./provider-store";

function presentationStatus(row: SubagentRow) {
  if (row.kind === "paseo") return row.status;
  return providerSubagentLifecycleStatus(row.status);
}

export interface SubagentRowPresentationData {
  key: string;
  kind: "agent";
  label: string;
  subtitle: string;
  titleState: "ready" | "loading";
  statusBucket: SidebarStateBucket | null;
}

export function buildSubagentRowPresentationData(row: SubagentRow): SubagentRowPresentationData {
  // The task distinguishes siblings in a fan-out, so it names the row when present. Providers
  // own the compact secondary context because model, effort, and usage semantics differ.
  const description = resolveRowLabel(row.description);
  const title = resolveRowLabel(row.title);
  const label = description ?? title;
  const providerSubtitle = row.kind === "provider" ? resolveRowLabel(row.subtitle) : null;
  const subtitle = providerSubtitle ?? (description ? title : null);
  const status = presentationStatus(row);
  return {
    key: `${row.kind}_subagent_${row.id}`,
    kind: "agent",
    label: label ?? "",
    subtitle: subtitle ?? "",
    titleState: label ? "ready" : "loading",
    statusBucket: deriveSidebarStateBucket({
      status,
      requiresAttention: false,
    }),
  };
}

/** The one state the collapsed pill shows, and how many children are in it. */
interface SubagentStatusSummary {
  bucket: Exclude<SidebarStateBucket, "done">;
  count: number;
}

/** Everything the collapsed pill draws. Built together so the label and the mark cannot disagree. */
export interface SubagentPillPresentation {
  label: string;
  statusBucket: SidebarStateBucket | null;
}

/**
 * What the pill says about a fan-out, and which mark it says it with.
 *
 * The pill has room for one mark and one number, and they have to answer the same question. Left
 * to itself the mark wins and its state is read onto the number: a spinning ring beside
 * "2 subagents" says two of them are running. So while anything is happening the pill names that
 * state and counts the children in it, and only falls back to naming the total once nothing is.
 *
 * Which state that is comes from collapsing the children into the most urgent bucket among them —
 * the same rule a collapsed project row in the sidebar uses, and for the same reason.
 */
export function buildSubagentPillPresentation(
  t: TFunction,
  rows: readonly SubagentRow[],
): SubagentPillPresentation {
  const summary = summarizeSubagentStatus(rows);
  if (!summary) {
    return { label: totalLabel(t, rows.length), statusBucket: null };
  }
  return { label: statusLabel(t, summary), statusBucket: summary.bucket };
}

function statusLabel(t: TFunction, { bucket, count }: SubagentStatusSummary): string {
  switch (bucket) {
    case "running":
      return t("subagents.pillLabelRunning", { count });
    case "failed":
      return t("subagents.pillLabelFailed", { count });
    case "needs_input":
      return count === 1
        ? t("subagents.pillLabelNeedsInputOne")
        : t("subagents.pillLabelNeedsInputMany", { count });
    case "attention":
      return t("subagents.pillLabelReadyToReview", { count });
  }
}

/** Nothing is happening, so the pill is back to naming what it opens. */
function totalLabel(t: TFunction, total: number): string {
  return total === 1 ? t("subagents.pillLabelOne") : t("subagents.pillLabelMany", { count: total });
}

/**
 * `null` when every child is done: a finished fan-out is not worth a colour above the composer.
 */
function summarizeSubagentStatus(rows: readonly SubagentRow[]): SubagentStatusSummary | null {
  const buckets = rows.flatMap((row) => {
    const bucket = buildSubagentRowPresentationData(row).statusBucket;
    return bucket ? [bucket] : [];
  });
  const bucket = aggregateSidebarStateBuckets(buckets);
  if (bucket === "done") {
    return null;
  }
  return { bucket, count: buckets.filter((candidate) => candidate === bucket).length };
}

export function countFinishedSubagents(rows: readonly SubagentRow[]): number {
  return rows.filter(isFinishedSubagent).length;
}

export function resolveRowLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}
