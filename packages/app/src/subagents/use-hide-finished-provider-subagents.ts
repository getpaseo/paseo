import { useCallback } from "react";
import { useProviderSubagentStore } from "./provider-store";

export interface UseHideFinishedProviderSubagentsInput {
  serverId: string;
  parentAgentId: string;
}

export function useHideFinishedProviderSubagents({
  serverId,
  parentAgentId,
}: UseHideFinishedProviderSubagentsInput): () => void {
  return useCallback(() => {
    useProviderSubagentStore.getState().hideFinishedForParent(serverId, parentAgentId);
  }, [parentAgentId, serverId]);
}
