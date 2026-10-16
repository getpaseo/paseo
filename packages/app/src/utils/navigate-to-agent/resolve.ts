import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import type { SessionState } from "@/stores/session-store";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  // Cached ownership cannot override a newer notification or host lookup.
  // A refreshed directory takes precedence over an older notification.
  workspaceId?: string | null;
  pin?: boolean;
}

export interface AgentNavTarget {
  agentWorkspaceId: string | null | undefined;
  isCurrent: boolean;
}

export function selectAgentNavTarget(input: {
  session: Pick<SessionState, "agents" | "agentDetails" | "hasCurrentAgentDirectory"> | undefined;
  agentId: string;
}): AgentNavTarget {
  const directoryAgent = input.session?.agents.get(input.agentId);
  const agent = directoryAgent ?? input.session?.agentDetails.get(input.agentId);
  const isCurrent = Boolean(input.session?.hasCurrentAgentDirectory && directoryAgent);
  return { agentWorkspaceId: agent?.workspaceId, isCurrent };
}

export interface NavigateToAgentDeps {
  readAgentNavTarget: (input: { serverId: string; agentId: string }) => AgentNavTarget;
  navigateToHostAgent: (route: string) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  const target = deps.readAgentNavTarget({ serverId: input.serverId, agentId: input.agentId });
  const storedWorkspaceId = normalizeWorkspaceOpaqueId(target.agentWorkspaceId);
  const suppliedWorkspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  const workspaceId = target.isCurrent
    ? (storedWorkspaceId ?? suppliedWorkspaceId)
    : (suppliedWorkspaceId ?? storedWorkspaceId);

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
