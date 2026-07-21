import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";

export function useDeleteAgent() {
  const queryClient = useQueryClient();

  const deleteAgent = useCallback(
    async (serverId: string, agentId: string): Promise<void> => {
      const client =
        useSessionStore.getState().sessions[serverId]?.client ?? null;
      if (!client) {
        throw new Error("Daemon client unavailable");
      }

      await client.deleteAgent(agentId);

      const setAgents = useSessionStore.getState().setAgents;
      setAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.delete(agentId);
        return next;
      });

      await queryClient.invalidateQueries({
        queryKey: ["sidebarAgentsList", serverId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["allAgents", serverId],
      });
    },
    [queryClient],
  );

  return { deleteAgent };
}
