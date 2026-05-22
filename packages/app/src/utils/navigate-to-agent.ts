import { router, type Href } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { resolveWorkspaceIdByExecutionDirectory } from "@/utils/workspace-execution";
import { navigateToPreparedWorkspaceTab } from "@/utils/workspace-navigation";
import type { Agent, SessionState, WorkspaceDescriptor } from "@/stores/session-store";

interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  currentPathname?: string | null;
  pin?: boolean;
}

function resolveAgentFromSession(
  session: SessionState | undefined,
  agentId: string | null | undefined,
): Agent | null {
  if (!agentId) {
    return null;
  }
  return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
}

function resolveAgentWorkspaceId(input: {
  agent: Agent | null;
  session: SessionState | undefined;
  workspaces: Iterable<WorkspaceDescriptor> | undefined;
}): string | null {
  const directWorkspaceId = resolveWorkspaceIdByExecutionDirectory({
    workspaces: input.workspaces,
    workspaceDirectory: input.agent?.cwd,
  });
  if (directWorkspaceId || !input.agent?.parentAgentId) {
    return directWorkspaceId;
  }

  const parentAgent = resolveAgentFromSession(input.session, input.agent.parentAgentId);
  return resolveWorkspaceIdByExecutionDirectory({
    workspaces: input.workspaces,
    workspaceDirectory: parentAgent?.cwd,
  });
}

export function navigateToAgent(input: NavigateToAgentInput): string {
  const session = useSessionStore.getState().sessions[input.serverId];
  const agent = resolveAgentFromSession(session, input.agentId);
  const workspaces = session ? Array.from(session.workspaces.values()) : undefined;
  const workspaceId = resolveAgentWorkspaceId({
    agent,
    session,
    workspaces,
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
