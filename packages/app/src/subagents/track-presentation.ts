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

/**
 * The one state the collapsed pill can show. The pill has room for a dot and a count, so the
 * children collapse into the most urgent bucket among them — the same rule a collapsed project
 * row in the sidebar uses, and for the same reason.
 *
 * `null` when every child is done: a finished fan-out is not worth a colour above the composer.
 */
export function aggregateSubagentStatusBucket(
  rows: readonly SubagentRow[],
): SidebarStateBucket | null {
  if (rows.length === 0) {
    return null;
  }
  const buckets = rows.flatMap((row) => {
    const bucket = buildSubagentRowPresentationData(row).statusBucket;
    return bucket ? [bucket] : [];
  });
  const aggregate = aggregateSidebarStateBuckets(buckets);
  return aggregate === "done" ? null : aggregate;
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
