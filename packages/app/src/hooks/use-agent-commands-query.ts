import { useQuery } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";

const COMMANDS_STALE_TIME = 60_000; // Commands rarely change, cache for 1 minute

export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: string;
}

export interface DraftCommandConfig {
  provider: AgentProvider;
  cwd: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export type AgentCommandsClient = Pick<DaemonClient, "listCommands">;

export async function fetchAgentCommands(input: {
  client: AgentCommandsClient;
  agentId: string;
  draftConfig?: DraftCommandConfig;
}): Promise<AgentSlashCommand[]> {
  const response = await input.client.listCommands(input.agentId, {
    draftConfig: input.draftConfig,
  });
  return response.commands as AgentSlashCommand[];
}

function agentCommandsQueryKey(
  serverId: string,
  agentId: string,
  draftConfig?: DraftCommandConfig,
) {
  return [
    "agentCommands",
    serverId,
    agentId,
    draftConfig?.provider ?? null,
    draftConfig?.cwd ?? null,
    draftConfig?.modeId ?? null,
    draftConfig?.model ?? null,
    draftConfig?.thinkingOptionId ?? null,
    draftConfig?.featureValues ?? null,
  ] as const;
}

interface UseAgentCommandsQueryOptions {
  serverId: string;
  agentId: string;
  enabled?: boolean;
  draftConfig?: DraftCommandConfig;
}

export function useAgentCommandsQuery({
  serverId,
  agentId,
  enabled = true,
  draftConfig,
}: UseAgentCommandsQueryOptions) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: agentCommandsQueryKey(serverId, agentId, draftConfig),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return fetchAgentCommands({ client, agentId, draftConfig });
    },
    enabled: enabled && !!client && isConnected && (!!agentId || !!draftConfig),
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
