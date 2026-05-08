import { useCallback, useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatus,
  useHostRuntimeIsDirectoryLoading,
} from "@/runtime/host-runtime";
import type { AggregatedAgentsResult } from "@/hooks/use-aggregated-agents";
import type { AggregatedAgent } from "@/types/aggregated-agent";
import { buildAllAgentsList, toAggregatedAgent } from "@/utils/aggregated-agent";

export function useAllAgentsList(options?: {
  serverId?: string | null;
  includeArchived?: boolean;
}): AggregatedAgentsResult {
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();

  const serverId = useMemo(() => {
    const value = options?.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options?.serverId]);
  const includeArchived = options?.includeArchived ?? false;

  const liveAgents = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.agents ?? null) : null,
  );
  const connectionStatus = useHostRuntimeConnectionStatus(serverId ?? "");

  const refreshAll = useCallback(() => {
    if (!serverId || connectionStatus !== "online") {
      return;
    }
    void runtime.refreshAgentDirectory({ serverId }).catch(() => undefined);
  }, [runtime, serverId, connectionStatus]);

  const agents = useMemo(() => {
    if (!serverId || !liveAgents) {
      return [];
    }
    const serverLabel = daemons.find((daemon) => daemon.serverId === serverId)?.label ?? serverId;
    return buildAllAgentsList({
      agents: liveAgents.values(),
      serverId,
      serverLabel,
      includeArchived,
    });
  }, [daemons, includeArchived, liveAgents, serverId]);

  const isDirectoryLoading = useHostRuntimeIsDirectoryLoading(serverId ?? "");
  const isInitialLoad = isDirectoryLoading && agents.length === 0;
  const isRevalidating = isDirectoryLoading && agents.length > 0;

  return {
    agents,
    isLoading: isDirectoryLoading,
    isInitialLoad,
    isRevalidating,
    refreshAll,
  };
}

export const __private__ = {
  buildAllAgentsList,
  toAggregatedAgent,
};
