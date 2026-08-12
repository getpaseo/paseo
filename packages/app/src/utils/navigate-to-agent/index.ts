import { router, type Href } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { getOrCreateClientId } from "@/utils/client-id";
import { openAgentTab } from "@/utils/open-agent-tab";
import { resolveNavigateToAgent, type NavigateToAgentInput } from "./resolve";

export type { NavigateToAgentInput } from "./resolve";

export async function navigateToAgent(input: NavigateToAgentInput): Promise<string | null> {
  const getAgent = (agentId: string) => {
    const session = useSessionStore.getState().sessions[input.serverId];
    return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  };
  try {
    return await openAgentTab(input.agentId, {
      getAgent,
      getClientId: getOrCreateClientId,
      markOpen: async (agentId, label) => {
        const client = useSessionStore.getState().sessions[input.serverId]?.client;
        if (!client) {
          throw new Error("Daemon client unavailable");
        }
        await client.updateAgent(agentId, { labels: { [label]: "true" } });
      },
      open: () =>
        resolveNavigateToAgent(input, {
          readAgentNavTarget: ({ agentId }) => ({
            agentWorkspaceId: getAgent(agentId)?.workspaceId,
          }),
          navigateToHostAgent: (route) => {
            router.navigate(route as Href);
          },
          navigateToWorkspace,
        }),
    });
  } catch (error) {
    console.error("[AgentNavigation] Failed to open agent tab", { error, agentId: input.agentId });
    input.onError?.();
    return null;
  }
}
