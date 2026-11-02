import { useMemo } from "react";
import { buildGoalPrefillFromChat, findLastUserMessageText } from "@/goals/goal-chat-prefill";
import { useHostFeature } from "@/runtime/host-features";
import { useGoalLaunchStore } from "@/stores/goal-launch-store";
import { useSessionStore } from "@/stores/session-store";

/** Returns false when the chat's agent is not loaded on this client. */
export type StartGoalFromChat = (agentId: string, args?: string) => boolean;

/**
 * Opens the goal form seeded from one chat on this host, or null while the host cannot run
 * goals. The goal gets its own Lead; the chat only receives the outcome.
 */
export function useStartGoalFromChat(serverId: string | null): StartGoalFromChat | null {
  const supportsGoals = useHostFeature(serverId, "goals");
  const open = useGoalLaunchStore((state) => state.open);

  return useMemo(() => {
    if (!serverId || !supportsGoals) {
      return null;
    }
    return (agentId: string, args?: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId) ?? null;
      if (!agent) {
        return false;
      }
      const lastUserMessage = findLastUserMessageText([
        session?.agentStreamHead.get(agentId) ?? [],
        session?.agentStreamTail.get(agentId) ?? [],
      ]);
      open({
        serverId,
        prefill: buildGoalPrefillFromChat({ agent, args, lastUserMessage }),
      });
      return true;
    };
  }, [open, serverId, supportsGoals]);
}
