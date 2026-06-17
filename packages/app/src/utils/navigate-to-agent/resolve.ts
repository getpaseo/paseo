import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToPreparedWorkspaceTabInput } from "@/utils/prepare-workspace-tab";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  currentPathname?: string | null;
  pin?: boolean;
}

export interface AgentNavTarget {
  agentWorkspaceId: string | null | undefined;
}

export interface NavigateToAgentDeps {
  readAgentNavTarget: (input: { serverId: string; agentId: string }) => AgentNavTarget;
  navigateToHostAgent: (route: string) => void;
  navigateToPreparedWorkspaceTab: (input: NavigateToPreparedWorkspaceTabInput) => string;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  const { agentWorkspaceId } = deps.readAgentNavTarget({
    serverId: input.serverId,
    agentId: input.agentId,
  });
  const workspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  if (!workspaceId) {
    const route = buildHostAgentDetailRoute(input.serverId, input.agentId);
    deps.navigateToHostAgent(route);
    return route;
  }

  return deps.navigateToPreparedWorkspaceTab({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    currentPathname: input.currentPathname,
    pin: input.pin,
  });
}
