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
  client: { refreshAgent: (agentId: string) => Promise<unknown> } | null;
  isConnected: boolean;
}): Promise<boolean> {
  const { serverId, agentId, client, isConnected } = input;
  if (!client || !isConnected || isAgentUnarchiving({ serverId, agentId })) {
    return false;
  }
  const token = beginAgentUnarchive({ serverId, agentId });
  try {
    await client.refreshAgent(agentId);
    return true;
  } finally {
    finishAgentUnarchive({ serverId, agentId }, token);
  }
}

export function useUnarchiveAgent({ serverId, agentId }: UnarchiveAgentTarget) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isUnarchiving = useIsAgentUnarchiving({ serverId, agentId });

  const unarchive = useCallback(async (): Promise<void> => {
    await runAgentUnarchive({ serverId, agentId, client, isConnected });
  }, [agentId, client, isConnected, serverId]);

  return {
    unarchive,
    isUnarchiving,
    isConnected,
    canUnarchive: Boolean(client && isConnected && !isUnarchiving),
  };
}
