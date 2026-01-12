import { useQuery } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";

const COMMANDS_STALE_TIME = 60_000; // Commands rarely change, cache for 1 minute

interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

function commandsQueryKey(serverId: string, agentId: string) {
  return ["agentCommands", serverId, agentId] as const;
}

interface UseAgentCommandsQueryOptions {
  serverId: string;
  agentId: string;
  enabled?: boolean;
}

export function useAgentCommandsQuery({
  serverId,
  agentId,
  enabled = true,
}: UseAgentCommandsQueryOptions) {
  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );
  const isConnected = useSessionStore(
    (state) => state.sessions[serverId]?.connection.isConnected ?? false
  );

  const query = useQuery({
    queryKey: commandsQueryKey(serverId, agentId),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const response = await client.listCommands(agentId);
      return response.commands as AgentSlashCommand[];
    },
    enabled: enabled && !!client && isConnected && !!agentId,
    staleTime: COMMANDS_STALE_TIME,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });

  // isPending is true when the query has never run yet (no cached data and not fetching)
  // isLoading is true when fetching and no data yet
  const isLoading = query.isPending || query.isLoading;

  return {
    commands: query.data ?? [],
    isLoading,
    isError: query.isError,
    error: query.error,
  };
}
