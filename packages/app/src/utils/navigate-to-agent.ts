import { router, type Href } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import {
  navigateToAgent as navigateToAgentPure,
  type NavigateToAgentInput,
} from "@/utils/navigate-to-agent.pure";
import { navigateToPreparedWorkspaceTab } from "@/utils/workspace-navigation";

export type { NavigateToAgentInput } from "@/utils/navigate-to-agent.pure";

export function navigateToAgent(input: NavigateToAgentInput): string {
  return navigateToAgentPure(input, {
    readAgentNavTarget: ({ serverId, agentId }) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        workspaces: session?.workspaces.values(),
        agentCwd: agent?.cwd,
      };
    },
    navigateToHostAgent: (route) => {
      router.navigate(route as Href);
    },
    navigateToPreparedWorkspaceTab,
  });
}
