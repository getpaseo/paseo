import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

export function importedSessionWorkspaceNavigation(
  serverId: string,
  agent: Pick<AgentSnapshotPayload, "id" | "workspaceId">,
): NavigateToWorkspaceInput | null {
  const workspaceId = agent.workspaceId?.trim();
  if (!workspaceId) {
    return null;
  }
  return {
    serverId,
    workspaceId,
    target: { kind: "agent", agentId: agent.id },
  };
}
