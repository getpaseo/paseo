import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SubagentRow } from "./select";
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
  // Provider subagents carry the task in `description` and the subagent type in `title`. The
  // task is what tells two siblings apart in a fan-out, so it names the row and the type drops
  // to the secondary line. Providers that report no task (OpenCode, Codex) keep the previous
  // behavior: type as the label, empty subtitle.
  const description = resolveRowLabel(row.description);
  const title = resolveRowLabel(row.title);
  const label = description ?? title;
  // Absent means "not observed" and renders as nothing rather than the parent's setting.
  const details = [
    description && title ? title : null,
    row.kind === "provider" ? resolveRowLabel(row.model) : null,
    row.kind === "provider" ? resolveRowLabel(row.effort) : null,
  ].filter((part): part is string => Boolean(part));
  const status = presentationStatus(row);
  return {
    key: `${row.kind}_subagent_${row.id}`,
    kind: "agent",
    label: label ?? "",
    subtitle: details.join(" · "),
    titleState: label ? "ready" : "loading",
    statusBucket: deriveSidebarStateBucket({
      status,
      requiresAttention: false,
    }),
  };
}

export type SubagentRuntimeFacts = Pick<
  ProviderSubagentDescriptorPayload,
  "model" | "effort" | "usage"
>;

export interface SubagentUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** Tokens read best abbreviated; duration only once the child has finished. */
export function formatSubagentUsage(usage: SubagentUsage | null): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    parts.push(
      usage.totalTokens >= 1000
        ? `${Math.round(usage.totalTokens / 100) / 10}k tokens`
        : `${usage.totalTokens} tokens`,
    );
  }
  if (typeof usage.toolUses === "number" && usage.toolUses > 0) {
    parts.push(`${usage.toolUses} ${usage.toolUses === 1 ? "tool" : "tools"}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The subagent pane has the room the dense track row does not, so its header carries the whole
 * observed runtime on one line. Absent fields render as nothing — never the parent's model or
 * thinking setting.
 */
export function buildSubagentPaneDetails(descriptor: SubagentRuntimeFacts | null): string {
  if (!descriptor) return "";
  const parts = [
    descriptor.model?.trim(),
    descriptor.effort?.trim(),
    formatSubagentUsageDetail(descriptor.usage ?? null),
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

/**
 * The pane has room the dense row does not, so a finished child's wall time joins its cost.
 * Providers report `durationMs` only once the child is done.
 */
function formatSubagentUsageDetail(usage: SubagentUsage | null): string | null {
  const cost = formatSubagentUsage(usage);
  const duration =
    typeof usage?.durationMs === "number" && usage.durationMs > 0
      ? formatDuration(usage.durationMs)
      : null;
  const parts = [cost, duration].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) {
    return `${Math.round(totalSeconds * 10) / 10}s`;
  }
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}m ${rounded % 60}s`;
}

export function formatHeaderLabel(rows: readonly SubagentRow[]): string {
  let runningCount = 0;
  for (const row of rows) {
    if (row.status === "running") {
      runningCount += 1;
    }
  }

  const parts = [`${rows.length} ${rows.length === 1 ? "subagent" : "subagents"}`];
  if (runningCount > 0) {
    parts.push(`${runningCount} running`);
  }
  return parts.join(" · ");
}

export function countFinishedSubagents(rows: readonly SubagentRow[]): number {
  return rows.filter((row) => row.kind === "provider" && row.status !== "running").length;
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
