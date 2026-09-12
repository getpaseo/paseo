import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { agentCommandsQueryKey, type AgentCommandsDraftConfig } from "@/hooks/agent-commands-query";

const DRAFT_COMMANDS_STALE_TIME = Number.POSITIVE_INFINITY;
const SESSION_COMMANDS_STALE_TIME = 60_000;
/**
 * A draft config the daemon could not service — no model resolved yet, provider
 * snapshot still loading — comes back as an empty list. Caching that forever
 * leaves the composer with no commands for the rest of the session, so let an
 * empty result go stale and be retried.
 */
const EMPTY_DRAFT_COMMANDS_STALE_TIME = 5_000;

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
  // A draft composer has nothing to show but provider commands, so a failure has
  // to surface. A running agent still has client commands to fall back on, and
  // some providers legitimately report that they cannot list commands at all.
  if (input.draftConfig && response.error) {
    throw new Error(response.error);
  }
  return response.commands as AgentSlashCommand[];
}

export function resolveCommandsStaleTime(input: {
  isDraft: boolean;
  commands: readonly AgentSlashCommand[] | undefined;
}): number {
  if (!input.isDraft) {
    return SESSION_COMMANDS_STALE_TIME;
  }
  return (input.commands?.length ?? 0) > 0
    ? DRAFT_COMMANDS_STALE_TIME
    : EMPTY_DRAFT_COMMANDS_STALE_TIME;
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
    staleTime: (commandsQuery) =>
      resolveCommandsStaleTime({
        isDraft: Boolean(draftConfig),
        commands: commandsQuery.state.data,
      }),
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
