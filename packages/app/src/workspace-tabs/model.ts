import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { WorkspaceFileTabTarget } from "@/workspace/file-open";

export interface WorkspaceDraftTabSetup {
  provider: AgentProvider;
  cwd: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
}

export interface WorkspaceWorkingDiffTabTarget {
  kind: "working_diff";
  focusPath?: string;
  focusRequestId?: number;
}

export type PluginWorkspaceTabTarget =
  | {
      kind: "plugin";
      pluginId: string;
      panelId: string;
      context: "workspace";
    }
  | {
      kind: "plugin";
      pluginId: string;
      panelId: string;
      context: "agent";
      agentId: string;
    };

export type WorkspaceTabTarget =
  | { kind: "new_tab" }
  | { kind: "draft"; draftId: string; setup?: WorkspaceDraftTabSetup }
  | { kind: "agent"; agentId: string }
  | { kind: "provider_subagent"; parentAgentId: string; subagentId: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "browser"; browserId: string }
  | { kind: "files" }
  | { kind: "pull_request" }
  | WorkspaceFileTabTarget
  | WorkspaceWorkingDiffTabTarget
  | PluginWorkspaceTabTarget
  | { kind: "setup"; workspaceId: string }
  | { kind: "commit_diff"; sha: string };

export interface WorkspaceTab {
  tabId: string;
  target: WorkspaceTabTarget;
  createdAt: number;
  state?: JsonValue;
}

export function buildWorkspaceTabPersistenceKey(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const serverId = input.serverId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!serverId || !workspaceId) {
    return null;
  }
  return `${serverId}:${workspaceId}`;
}

/**
 * The agent a tab is showing, if any. An agent-context plugin panel counts, and
 * a provider subagent counts as its parent: both are views onto that agent, so
 * focusing one must not drop agent context.
 */
export function getWorkspaceTabAgentId(target: WorkspaceTabTarget): string | null {
  if (target.kind === "agent") return target.agentId;
  if (target.kind === "provider_subagent") return target.parentAgentId;
  return target.kind === "plugin" && target.context === "agent" ? target.agentId : null;
}
