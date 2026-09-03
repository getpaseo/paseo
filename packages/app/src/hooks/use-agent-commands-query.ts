import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { agentCommandsQueryKey, type AgentCommandsDraftConfig } from "@/hooks/agent-commands-query";

const DRAFT_COMMANDS_STALE_TIME = Number.POSITIVE_INFINITY;
const SESSION_COMMANDS_STALE_TIME = 60_000;
const EMPTY_AGENT_SLASH_COMMANDS: AgentSlashCommand[] = [];

export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: string;
}

export type DraftCommandConfig = AgentCommandsDraftConfig;

interface ListAgentCommandsOptions {
  agentId: string;
  draftConfig?: DraftCommandConfig;
}

export interface AgentCommandsClient {
  listCommands(options: ListAgentCommandsOptions): ReturnType<DaemonClient["listCommands"]>;
}

export async function fetchAgentCommands(input: {
  client: AgentCommandsClient;
  agentId: string;
  draftConfig?: DraftCommandConfig;
}): Promise<AgentSlashCommand[]> {
  const response = await input.client.listCommands({
    agentId: input.agentId,
    draftConfig: input.draftConfig,
  });
  // Draft listings spin up a provider session on demand, so a failure here is a
  // real failure the user needs to see: without this the daemon's error is
  // dropped and a broken provider is indistinguishable from "no skills". Only
  // draft listings throw — a draft surface with no config yet answers "agent not
  // found", which is an ordinary state rather than something worth reporting.
  if (response.error && input.draftConfig) {
    throw new Error(response.error);
  }
  return response.commands as AgentSlashCommand[];
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
  const { t } = useTranslation();
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabled = enabled && retainedPanelActive;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: agentCommandsQueryKey({ serverId, agentId, draftConfig }),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return fetchAgentCommands({ client, agentId, draftConfig });
    },
    enabled: queryEnabled && !!client && isConnected && (!!agentId || !!draftConfig),
    staleTime: draftConfig ? DRAFT_COMMANDS_STALE_TIME : SESSION_COMMANDS_STALE_TIME,
    // Each draft attempt spawns and tears down a provider session, so a broken
    // provider should report once rather than four times.
    retry: draftConfig ? 0 : 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });

  // isPending is true when the query has never run yet (no cached data and not fetching)
  // isLoading is true when fetching and no data yet
  const isLoading = query.isPending || query.isLoading;

  return {
    commands: query.data ?? EMPTY_AGENT_SLASH_COMMANDS,
    isLoading,
    isError: query.isError,
    error: query.error,
  };
}
