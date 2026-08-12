import { router, type Href } from "expo-router";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { getOrCreateClientId } from "@/utils/client-id";
import { openAgentTab } from "@/utils/open-agent-tab";
import { resolveNavigateToAgent, type NavigateToAgentInput } from "./resolve";

export type { NavigateToAgentInput } from "./resolve";

export async function navigateToAgent(input: NavigateToAgentInput): Promise<string | null> {
  const getCachedAgent = (agentId: string) => {
    const session = useSessionStore.getState().sessions[input.serverId];
    return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  };
  const getAgent = async (agentId: string) => {
    const cached = getCachedAgent(agentId);
    if (cached) {
      return cached;
    }
    const client = useSessionStore.getState().sessions[input.serverId]?.client;
    if (!client) {
      throw new Error("Daemon client unavailable");
    }
    const result = await client.fetchAgent({ agentId });
    if (!result) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return {
      id: result.agent.id,
      workspaceId: result.agent.workspaceId,
      parentAgentId: getParentAgentIdFromLabels(result.agent.labels),
    };
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
            agentWorkspaceId: getCachedAgent(agentId)?.workspaceId,
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
