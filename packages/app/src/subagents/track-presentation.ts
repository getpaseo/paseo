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
  const status = presentationStatus(row);
  return {
    key: `${row.kind}_subagent_${row.id}`,
    kind: "agent",
    label: label ?? "",
    subtitle: description && title ? title : "",
    titleState: label ? "ready" : "loading",
    statusBucket: deriveSidebarStateBucket({
      status,
      requiresAttention: false,
    }),
  };
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
