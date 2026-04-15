// useCliAgents — detects installed CLI coding agents via daemon RPC
// Adapted from emdash's useCliAgentDetection hook

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export type CliAgentStatusCode = "connected" | "missing" | "error";

export interface CliAgentStatus {
  id: string;
  name: string;
  status: CliAgentStatusCode;
  version?: string | null;
  path?: string | null;
  docUrl?: string | null;
  installCommand?: string | null;
  cli?: string | null;
  error?: string | null;
}

export function cliAgentsQueryKey(serverId: string | null) {
  return ["cliAgents", serverId] as const;
}

interface UseCliAgentsResult {
  /** All known CLI agents with their status */
  agents: CliAgentStatus[];
  /** Only agents detected as installed */
  installedAgents: CliAgentStatus[];
  /** Whether a detection scan is in progress */
  isLoading: boolean;
  isFetching: boolean;
  /** Error message if detection failed */
  error: string | null;
  /** Trigger a fresh scan (ignores cache) */
  refresh: () => void;
}

export function useCliAgents(serverId: string | null): UseCliAgentsResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const queryKey = useMemo(() => cliAgentsQueryKey(serverId), [serverId]);

  const query = useQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: 5 * 60 * 1000, // 5 min — mirrors daemon cache TTL
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const result = await client.listCliAgents({ refresh: false });
      if (result.error) {
        throw new Error(result.error);
      }
      return result.agents as CliAgentStatus[];
    },
  });

  const refresh = useCallback(() => {
    if (!client) return;
    // Invalidate and refetch with refresh=true
    void queryClient.fetchQuery({
      queryKey,
      queryFn: async () => {
        const result = await client.listCliAgents({ refresh: true });
        if (result.error) {
          throw new Error(result.error);
        }
        return result.agents as CliAgentStatus[];
      },
    });
  }, [client, queryClient, queryKey]);

  const agents = query.data ?? [];
  const installedAgents = useMemo(() => agents.filter((a) => a.status === "connected"), [agents]);

  return {
    agents,
    installedAgents,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refresh,
  };
}
