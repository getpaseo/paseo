import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

type WorkspaceAgent = Pick<Agent, "parentAgentId" | "workspaceId">;

export function isWorkspaceRootAgent(
  agent: WorkspaceAgent,
  parentAgent: Pick<Agent, "workspaceId"> | undefined,
): boolean {
  if (!agent.parentAgentId) {
    return true;
  }

  const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
  const parentWorkspaceId = normalizeWorkspaceOpaqueId(parentAgent?.workspaceId);
  return Boolean(workspaceId && parentWorkspaceId && workspaceId !== parentWorkspaceId);
}
