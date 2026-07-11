import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  // Used as the workspace target when the agent is not yet in the session store
  // (cold deep-links). Otherwise the workspace is read from the store.
  workspaceId?: string | null;
  // History can point at an agent whose owning workspace has been archived even
  // when the agent itself was not. Other navigation paths must not refresh an
  // agent just because their workspace descriptor is temporarily unavailable.
  restoreWorkspace?: {
    agentArchived: boolean;
  };
  pin?: boolean;
}

export interface AgentNavTarget {
  agentWorkspaceId: string | null | undefined;
}

export interface HistoryRestoreTarget {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  agentArchived: boolean;
}

export interface NavigateToAgentDeps {
  readAgentNavTarget: (input: { serverId: string; agentId: string }) => AgentNavTarget;
  navigateToHostAgent: (route: string) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
  restoreHistoryEntry: (input: HistoryRestoreTarget) => void;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  const agentWorkspaceId =
    input.workspaceId ??
    deps.readAgentNavTarget({ serverId: input.serverId, agentId: input.agentId }).agentWorkspaceId;
  const workspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  if (input.restoreWorkspace) {
    deps.restoreHistoryEntry({
      serverId: input.serverId,
      agentId: input.agentId,
      workspaceId,
      agentArchived: input.restoreWorkspace.agentArchived,
    });
  }

  if (!workspaceId) {
    const route = buildHostAgentDetailRoute(input.serverId, input.agentId);
    deps.navigateToHostAgent(route);
    return route;
  }

  return deps.navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    pin: input.pin,
  });
}
