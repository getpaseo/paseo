import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { AgentNavTarget } from "@/utils/navigate-to-agent/resolve";
import { buildHostWorkspaceOpenRoute } from "@/utils/host-routes";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";

export interface WorkspaceAgentOpenInput {
  serverId: string;
  workspaceId: string;
  openValue: string;
  agentTarget: AgentNavTarget;
  isConnected: boolean;
  hasCurrentAgentDirectory: boolean;
  hasHydratedWorkspaces: boolean;
  workspaces: Map<string, WorkspaceDescriptor> | undefined;
}

export type WorkspaceAgentOpenResolution =
  | { kind: "waiting" }
  | { kind: "redirect"; route: string }
  | { kind: "openCached" }
  | { kind: "openCurrent" };

export function resolveWorkspaceAgentOpen(
  input: WorkspaceAgentOpenInput,
): WorkspaceAgentOpenResolution {
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces: input.workspaces,
    workspaceId: input.workspaceId,
  });
  const canResolveLiveOwnership =
    input.isConnected && input.hasCurrentAgentDirectory && input.hasHydratedWorkspaces;
  if (canResolveLiveOwnership && input.agentTarget.isCurrent) {
    const liveWorkspaceId = normalizeWorkspaceOpaqueId(input.agentTarget.agentWorkspaceId);
    const liveWorkspaceKey = resolveWorkspaceMapKeyByIdentity({
      workspaces: input.workspaces,
      workspaceId: liveWorkspaceId,
    });
    if (liveWorkspaceId && !liveWorkspaceKey) return { kind: "waiting" };
    if (liveWorkspaceKey && liveWorkspaceKey !== workspaceKey) {
      return {
        kind: "redirect",
        route: buildHostWorkspaceOpenRoute(input.serverId, liveWorkspaceKey, input.openValue),
      };
    }
  }
  if (!workspaceKey) {
    return { kind: "waiting" };
  }
  if (!input.isConnected) {
    return { kind: "openCached" };
  }
  if (!input.hasCurrentAgentDirectory || !input.hasHydratedWorkspaces) {
    return { kind: "waiting" };
  }
  return { kind: "openCurrent" };
}
