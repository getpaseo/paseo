import type { AgentSubsessionPayload } from "@getpaseo/protocol/messages";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SubagentRow } from "./select";

export interface SubagentRowPresentationData {
  key: string;
  kind: "agent";
  label: string;
  subtitle: string;
  titleState: "ready" | "loading";
  statusBucket: SidebarStateBucket | null;
}

export function buildSubagentRowPresentationData(row: SubagentRow): SubagentRowPresentationData {
  const label = resolveRowLabel(row.title);
  return {
    key: `subagent_${row.id}`,
    kind: "agent",
    label: label ?? "",
    subtitle: "",
    titleState: label ? "ready" : "loading",
    statusBucket: deriveSidebarStateBucket({
      status: row.status,
      requiresAttention: false,
    }),
  };
}

const NO_SUBSESSIONS: readonly Pick<AgentSubsessionPayload, "status">[] = [];

export function formatHeaderLabel(
  rows: readonly SubagentRow[],
  subsessions: readonly Pick<AgentSubsessionPayload, "status">[] = NO_SUBSESSIONS,
): string {
  let runningCount = 0;
  for (const row of rows) {
    if (row.status === "running") {
      runningCount += 1;
    }
  }
  for (const sub of subsessions) {
    if (sub.status === "running") {
      runningCount += 1;
    }
  }

  const total = rows.length + subsessions.length;
  const parts = [`${total} ${total === 1 ? "subagent" : "subagents"}`];
  if (runningCount > 0) {
    parts.push(`${runningCount} running`);
  }
  return parts.join(" · ");
}

export function resolveRowLabel(title: SubagentRow["title"]): string | null {
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
