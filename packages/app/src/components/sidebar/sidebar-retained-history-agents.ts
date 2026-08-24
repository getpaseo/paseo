import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { deriveWorkspaceAgentVisibility } from "@/workspace-tabs/agent-visibility";

export function selectRetainedHistoryRootAgents(
  agents: ReadonlyMap<string, Agent>,
  workspaceId: string,
): Agent[] {
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(workspaceId);
  if (!normalizedWorkspaceId) return [];

  const visibility = deriveWorkspaceAgentVisibility({
    sessionAgents: agents instanceof Map ? agents : new Map(agents),
    workspaceId: normalizedWorkspaceId,
  });
  const result = [...visibility.autoOpenAgentIds].flatMap((agentId) => {
    const agent = agents.get(agentId);
    return agent ? [agent] : [];
  });

  return result.sort((left, right) => {
    const leftRunning = left.status === "running";
    const rightRunning = right.status === "running";
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
    return (
      right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
      left.id.localeCompare(right.id)
    );
  });
}
