// useIntegrationStatus — queries daemon for integration connection status
// Integrations are configured on the desktop daemon, app just reads status
import { useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import type { IntegrationId } from "@/types/kanban";

export interface IntegrationStatusEntry {
  id: IntegrationId;
  connected: boolean;
  account?: string;
  error?: string;
}

export type IntegrationStatusMap = Record<IntegrationId, IntegrationStatusEntry>;

const ALL_IDS: IntegrationId[] = [
  "github",
  "linear",
  "jira",
  "gitlab",
  "plain",
  "forgejo",
  "sentry",
];

const EMPTY_MAP: IntegrationStatusMap = Object.fromEntries(
  ALL_IDS.map((id) => [id, { id, connected: false }]),
) as IntegrationStatusMap;

export function useIntegrationStatus(serverId: string | undefined) {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const query = useQuery({
    queryKey: ["integration-status", serverId],
    queryFn: async () => {
      if (!client) throw new Error("No client");
      console.log(`[IntegrationStatus] calling listIntegrationStatus (serverId=${serverId})...`);
      const result = await client.listIntegrationStatus();
      console.log(`[IntegrationStatus] listIntegrationStatus response:`, {
        integrations: result.integrations?.map((e: Record<string, unknown>) => ({
          id: e.id,
          connected: e.connected,
          account: e.account,
          error: e.error,
        })),
      });
      return result.integrations as IntegrationStatusEntry[];
    },
    enabled: !!client && !!isConnected,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const statusMap = useMemo<IntegrationStatusMap>(() => {
    if (!query.data) return EMPTY_MAP;
    const map = { ...EMPTY_MAP };
    for (const entry of query.data) {
      map[entry.id as IntegrationId] = entry as IntegrationStatusEntry;
    }
    return map;
  }, [query.data]);

  return {
    statusMap,
    isLoading: query.isLoading,
    refetch: query.refetch,
    isConnected: (id: IntegrationId) => statusMap[id]?.connected ?? false,
    getAccount: (id: IntegrationId) => statusMap[id]?.account,
  };
}

/** Hook to connect a specific integration via daemon */
export function useIntegrationConnect(serverId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      integrationId: IntegrationId;
      credentials: Record<string, string>;
    }) => {
      const client = getHostRuntimeStore().getClient(serverId ?? "");
      if (!client) throw new Error("No client");
      return client.connectIntegration(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integration-status", serverId] });
    },
  });
}

/** Hook to disconnect a specific integration via daemon */
export function useIntegrationDisconnect(serverId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (integrationId: IntegrationId) => {
      const client = getHostRuntimeStore().getClient(serverId ?? "");
      if (!client) throw new Error("No client");
      return client.disconnectIntegration({ integrationId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integration-status", serverId] });
    },
  });
}

/** Hook to search issues from a specific integration via daemon */
export function useIntegrationSearch(serverId: string | undefined) {
  return useMutation({
    mutationFn: async (input: {
      integrationId: IntegrationId;
      query: string;
      cwd?: string;
      limit?: number;
    }) => {
      const client = getHostRuntimeStore().getClient(serverId ?? "");
      if (!client) throw new Error("No client");
      return client.searchIntegration(input);
    },
  });
}

/** Hook to fetch recent items from an integration via daemon.
 *  Pass `options.enabled = false` to defer fetching until the caller is ready
 *  (e.g. wait until the dropdown is open so all 7 integrations don't fire at mount).
 */
export function useIntegrationFetchItems(
  serverId: string | undefined,
  integrationId: IntegrationId,
  cwd?: string,
  options?: { enabled?: boolean },
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  return useQuery({
    queryKey: ["integration-items", serverId, integrationId, cwd],
    queryFn: async () => {
      if (!client) throw new Error("No client");
      const result = await client.fetchIntegrationItems({ integrationId, cwd });
      return result.items;
    },
    enabled: !!client && !!isConnected && options?.enabled !== false,
    staleTime: 60_000,
  });
}
