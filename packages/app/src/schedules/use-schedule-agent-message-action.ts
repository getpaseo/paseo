import { useCallback } from "react";
import { useRouter } from "expo-router";
import { buildSchedulesRoute } from "@/utils/host-routes";

/**
 * Opens the Schedules create form aimed at one running agent. The intent nonce
 * makes a second trigger for the same agent a fresh navigation, so the form
 * reopens after it was dismissed.
 */
export function useScheduleAgentMessageAction(
  serverId: string | undefined,
): ((agentId: string) => void) | undefined {
  const router = useRouter();
  const scheduleMessage = useCallback(
    (agentId: string) => {
      if (!serverId) {
        return;
      }
      router.push(
        buildSchedulesRoute({ serverId, agentId, intentId: `${Date.now().toString(36)}` }),
      );
    },
    [router, serverId],
  );
  return serverId ? scheduleMessage : undefined;
}
