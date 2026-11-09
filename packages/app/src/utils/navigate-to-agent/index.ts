import { router, type Href } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { resolveNavigateToAgent, type NavigateToAgentInput } from "./resolve";

export type { NavigateToAgentInput } from "./resolve";

function readAgentNavTarget({ serverId, agentId }: { serverId: string; agentId: string }) {
  const session = useSessionStore.getState().sessions[serverId];
  const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  return {
    agentWorkspaceId: agent?.workspaceId,
  };
}

export function navigateToAgent(input: NavigateToAgentInput): string {
  return resolveNavigateToAgent(input, {
    readAgentNavTarget,
    navigateToHostAgent: (route) => {
      router.navigate(route as Href);
    },
    navigateToWorkspace,
  });
}

/**
 * Navigates to the agent where its composer is. A compact sheet is for looking and has no composer,
 * so a subagent that lands in one becomes a tab, as Open as tab does.
 */
export function navigateToAgentComposer(input: NavigateToAgentInput): void {
  navigateToAgent(input);
  const workspaceId = normalizeWorkspaceOpaqueId(
    readAgentNavTarget(input).agentWorkspaceId ?? input.workspaceId,
  );
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId: input.serverId, workspaceId })
    : null;
  if (!workspaceKey) return;
  const layout = useWorkspaceLayoutStore.getState();
  const sheet = layout.sheetsByWorkspace[workspaceKey]?.find(
    ({ tab }) => tab.target.kind === "agent" && tab.target.agentId === input.agentId,
  );
  if (sheet) layout.openTabInFront(workspaceKey, sheet);
}
