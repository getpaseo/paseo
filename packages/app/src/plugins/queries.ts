import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { InstalledPlugin, PluginRegistryEntry } from "@getpaseo/protocol/plugin/types";
import { useReplicaQuery, useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { pluginEntryQueryKey, pluginRegistryQueryKey, pluginsQueryKey } from "./query-keys";

export { pluginEntryQueryKey, pluginRegistryQueryKey, pluginsQueryKey };

function usePluginClient(serverId: string | null) {
  return useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
}

export interface UsePluginsResult {
  plugins: InstalledPlugin[];
  /** False when the daemon is too old to have plugins at all. */
  supported: boolean;
  isLoading: boolean;
  error: Error | null;
}

export function usePlugins(serverId: string | null): UsePluginsResult {
  const client = usePluginClient(serverId);
  // COMPAT(plugins): added in v0.2.6, remove gate after 2027-02-05.
  const supported = useHostFeature(serverId, "plugins");
  const { t } = useTranslation();

  const query = useReplicaQuery({
    queryKey: pluginsQueryKey(serverId),
    enabled: Boolean(serverId && client && supported),
    pushEvent: "plugins.changed",
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.pluginsList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.plugins;
    },
  });

  return {
    plugins: query.data ?? EMPTY_PLUGINS,
    supported,
    isLoading: query.isLoading,
    error: query.error ?? null,
  };
}

const EMPTY_PLUGINS: InstalledPlugin[] = [];

/** The entry HTML for one contribution. Only changes when the plugin set does. */
export function usePluginEntry(input: {
  serverId: string | null;
  pluginId: string | null;
  entry: string | null;
}) {
  const client = usePluginClient(input.serverId);
  const supported = useHostFeature(input.serverId, "plugins");
  const { t } = useTranslation();
  const { pluginId, entry } = input;

  return useReplicaQuery({
    queryKey: pluginEntryQueryKey(input.serverId, pluginId ?? "", entry ?? ""),
    enabled: Boolean(input.serverId && client && supported && pluginId && entry),
    pushEvent: "plugins.changed",
    queryFn: async () => {
      if (!client || !pluginId || !entry) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.pluginsGetEntry({ pluginId, entry });
      if (payload.error || payload.html === null) {
        throw new Error(payload.error ?? t("plugins.errors.entryMissing"));
      }
      return payload.html;
    },
  });
}

export interface UsePluginRegistryResult {
  entries: PluginRegistryEntry[];
  registryUrl: string | null;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refresh: () => void;
}

export function usePluginRegistry(serverId: string | null): UsePluginRegistryResult {
  const client = usePluginClient(serverId);
  const supported = useHostFeature(serverId, "plugins");
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const query = useFetchQuery({
    queryKey: pluginRegistryQueryKey(serverId),
    enabled: Boolean(serverId && client && supported),
    dataShape: "list",
    staleTimeMs: 5 * 60_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.pluginsBrowse();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { registryUrl: payload.registryUrl, plugins: payload.plugins };
    },
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: pluginRegistryQueryKey(serverId) });
  }, [queryClient, serverId]);

  return {
    entries: query.data?.plugins ?? EMPTY_REGISTRY_ENTRIES,
    registryUrl: query.data?.registryUrl ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error ?? null,
    refresh,
  };
}

const EMPTY_REGISTRY_ENTRIES: PluginRegistryEntry[] = [];
