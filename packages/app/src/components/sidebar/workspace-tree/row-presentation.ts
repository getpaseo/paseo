import { Terminal } from "lucide-react-native";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import { deriveTerminalActivityStatusBucket } from "@getpaseo/protocol/terminal-activity";
import { getProviderIcon } from "@/components/provider-icons";
import type { WorkspaceTabPresentation } from "@/screens/workspace/workspace-tab-presentation";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceAgentNode } from "./agent-tree";

/**
 * Sidebar tree rows reuse the tabs' `WorkspaceTabPresentation` so a row renders
 * through `WorkspaceTabIcon` exactly as the corresponding tab does: provider
 * icon, status dot overlaid on the icon, or the synced spinner while running.
 *
 * These builders mirror the panel descriptors (`useAgentPanelDescriptor`,
 * `useProviderSubagentDescriptor`, `useTerminalPanelDescriptor`) — same icon,
 * same status bucket derivation — so the two surfaces cannot drift apart
 * silently.
 */

/**
 * The tab a row opens. Rows use this for both navigation and for deciding
 * whether they are the active tab, so the row can never highlight one tab while
 * opening another.
 */
export function buildAgentRowTarget(agent: WorkspaceAgentNode): WorkspaceTabTarget {
  if (agent.kind === "provider") {
    return {
      kind: "provider_subagent",
      parentAgentId: agent.parentAgentId ?? "",
      subagentId: agent.id,
    };
  }
  return { kind: "agent", agentId: agent.id };
}

export function buildTerminalRowTarget(terminalId: string): WorkspaceTabTarget {
  return { kind: "terminal", terminalId };
}

/**
 * The workspace a row's tab belongs to.
 *
 * The tree pulls subagents in by parentage regardless of their own workspace, so
 * a row can be displayed under one workspace while belonging to another. The
 * agent's own workspace wins; the containing workspace is only a fallback for
 * agents with no workspace of their own — which matches how the subagent
 * navigation resolver picks a destination. Provider subagents always carry an
 * empty workspace and are scoped to their parent, so they take the fallback.
 */
export function resolveRowWorkspaceId(
  agent: WorkspaceAgentNode,
  containingWorkspaceId: string,
): string {
  return agent.workspaceId.trim() || containingWorkspaceId;
}

/**
 * Agent tab label rule: a missing title, or the placeholder "New agent", reads
 * as still-loading rather than as a name.
 */
export function resolveTreeAgentLabel(
  title: string | null | undefined,
  loadingLabel: string,
): string {
  const normalized = typeof title === "string" ? title.trim() : "";
  if (!normalized || normalized.toLowerCase() === "new agent") {
    return loadingLabel;
  }
  return normalized;
}

export function buildAgentRowPresentation(
  agent: WorkspaceAgentNode,
  label: string,
): WorkspaceTabPresentation {
  return {
    key: agent.id,
    kind: agent.kind === "provider" ? "provider_subagent" : "agent",
    label,
    subtitle: "",
    tooltip: label,
    modified: false,
    titleState: "ready",
    icon: getProviderIcon(agent.provider),
    statusBucket: deriveSidebarStateBucket({
      status: agent.status,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
      pendingPermissionCount: agent.pendingPermissionCount,
    }),
  };
}

export function buildTerminalRowPresentation(input: {
  terminalId: string;
  label: string;
  activity: TerminalActivity | null;
}): WorkspaceTabPresentation {
  return {
    key: input.terminalId,
    kind: "terminal",
    label: input.label,
    subtitle: "",
    tooltip: input.label,
    modified: false,
    titleState: "ready",
    icon: Terminal,
    statusBucket: deriveTerminalActivityStatusBucket(input.activity),
  };
}
