import { getWorkspacePanelAttributes } from "@/panels/panel-instance-attributes";
import { panelCompactSheetPolicy, type CompactSheetPolicy } from "@/panels/panel-manifest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

function workspaceAgentLookup(workspaceKey: string): (agentId: string) => Agent | null {
  const sessions = useSessionStore.getState().sessions;
  const serverId = Object.keys(sessions)
    .filter((candidate) => workspaceKey.startsWith(`${candidate}:`))
    .sort((left, right) => right.length - left.length)[0];
  const session = serverId ? sessions[serverId] : undefined;
  return (agentId) => session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
}

/**
 * The single target-aware boundary deciding whether a compact reveal lands in the workspace
 * sheet. An agent the client has not loaded yet counts as a root agent and stays a tab.
 */
export function resolveCompactSheetPolicy(
  workspaceKey: string,
  target: WorkspaceTabTarget,
): CompactSheetPolicy | null {
  return panelCompactSheetPolicy(target, {
    isWorkspaceRootAgent: (agentId) => {
      const getAgent = workspaceAgentLookup(workspaceKey);
      const agent = getAgent(agentId);
      if (!agent) return true;
      const parent = agent.parentAgentId ? (getAgent(agent.parentAgentId) ?? undefined) : undefined;
      return isWorkspaceRootAgent(agent, parent);
    },
  });
}

/** Whether the sheet's tab holds unsaved work, which must never be discarded with the sheet. */
export function isSheetTabModified(workspaceKey: string, tabId: string): boolean {
  return getWorkspacePanelAttributes(workspaceKey, tabId).modified;
}
