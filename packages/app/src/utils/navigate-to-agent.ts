import { router, type Href } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { resolveWorkspaceIdByExecutionDirectory } from "@/utils/workspace-execution";
import { navigateToPreparedWorkspaceTab } from "@/utils/workspace-navigation";

interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  currentPathname?: string | null;
  pin?: boolean;
}

export function navigateToAgent(input: NavigateToAgentInput): string {
  const session = useSessionStore.getState().sessions[input.serverId];
  const agent = session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId);
  const workspaceId = resolveWorkspaceIdByExecutionDirectory({
    workspaces: session?.workspaces.values(),
    workspaceDirectory: agent?.cwd,
  });

  if (!workspaceId) {
    const route = buildHostAgentDetailRoute(input.serverId, input.agentId);
    router.navigate(route as Href);
    return route;
  }

  return navigateToPreparedWorkspaceTab({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    currentPathname: input.currentPathname,
    pin: input.pin,
  });
}
