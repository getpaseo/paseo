import { useCallback, useSyncExternalStore } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  beginAgentUnarchive,
  finishAgentUnarchive,
  isAgentUnarchiving,
  subscribeUnarchiveAgentPending,
  type UnarchiveAgentTarget,
} from "@/stores/unarchive-agent-store";

export type { UnarchiveAgentTarget };

function useIsAgentUnarchiving({ serverId, agentId }: UnarchiveAgentTarget): boolean {
  const read = useCallback(() => isAgentUnarchiving({ serverId, agentId }), [agentId, serverId]);
  return useSyncExternalStore(subscribeUnarchiveAgentPending, read, read);
}

export async function runAgentUnarchive(input: {
  serverId: string;
  agentId: string;
  client: { refreshAgent: (agentId: string) => Promise<{ historyDiverged?: boolean } | unknown> } | null;
  isConnected: boolean;
  onRefreshed?: (result: { historyDiverged?: boolean }) => void;
}): Promise<boolean> {
  const { serverId, agentId, client, isConnected, onRefreshed } = input;
  if (!client || !isConnected || isAgentUnarchiving({ serverId, agentId })) {
    return false;
  }
  const token = beginAgentUnarchive({ serverId, agentId });
  try {
    const refreshed = await client.refreshAgent(agentId);
    if (refreshed && typeof refreshed === "object" && "historyDiverged" in refreshed) {
      onRefreshed?.(refreshed as { historyDiverged?: boolean });
    }
    return true;
  } finally {
    finishAgentUnarchive({ serverId, agentId }, token);
  }
}

export function useUnarchiveAgent({ serverId, agentId }: UnarchiveAgentTarget) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isUnarchiving = useIsAgentUnarchiving({ serverId, agentId });

  const unarchive = useCallback(
    async (options?: { onRefreshed?: (result: { historyDiverged?: boolean }) => void }): Promise<void> => {
      await runAgentUnarchive({
        serverId,
        agentId,
        client,
        isConnected,
        onRefreshed: options?.onRefreshed,
      });
    },
    [agentId, client, isConnected, serverId],
  );

  return {
    unarchive,
    isUnarchiving,
    isConnected,
    canUnarchive: Boolean(client && isConnected && !isUnarchiving),
  };
}
