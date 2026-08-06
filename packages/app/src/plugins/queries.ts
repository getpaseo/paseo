import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { InstalledPlugin, PluginRegistryEntry } from "@getpaseo/protocol/plugin/types";
import { useReplicaQuery, useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { pluginEntryQueryKey, pluginRegistryQueryKey, pluginsQueryKey } from "./query-keys";
import { resolvePluginsSupport, type PluginsSupport } from "./model";

export { pluginEntryQueryKey, pluginRegistryQueryKey, pluginsQueryKey };

function usePluginClient(serverId: string | null) {
  return useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
}

/** Whether this host has plugins, has no plugins, or has not said yet. */
export function usePluginsSupport(serverId: string | null): PluginsSupport {
  // COMPAT(plugins): added in v0.2.6, remove gate after 2027-02-05.
  const hasPluginsFeature = useHostFeature(serverId, "plugins");
  const hasServerInfo = useSessionStore(
    (state) => (state.sessions[serverId ?? ""]?.serverInfo ?? null) !== null,
  );
  return resolvePluginsSupport({ serverId, hasServerInfo, hasPluginsFeature });
}

export interface UsePluginsResult {
  plugins: InstalledPlugin[];
  support: PluginsSupport;
  isLoading: boolean;
  error: Error | null;
}

export function usePlugins(serverId: string | null): UsePluginsResult {
  const client = usePluginClient(serverId);
  const support = usePluginsSupport(serverId);
  const { t } = useTranslation();

  const query = useReplicaQuery({
    queryKey: pluginsQueryKey(serverId),
    enabled: Boolean(serverId && client && support === "supported"),
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
    support,
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
  const support = usePluginsSupport(input.serverId);
  const { t } = useTranslation();
  const { pluginId, entry } = input;

  return useReplicaQuery({
    queryKey: pluginEntryQueryKey(input.serverId, pluginId ?? "", entry ?? ""),
    enabled: Boolean(input.serverId && client && support === "supported" && pluginId && entry),
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
  const support = usePluginsSupport(serverId);
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const wantsFreshIndex = useRef(false);
  const query = useFetchQuery({
    queryKey: pluginRegistryQueryKey(serverId),
    enabled: Boolean(serverId && client && support === "supported"),
    dataShape: "list",
    staleTimeMs: 5 * 60_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      // The daemon caches the index for five minutes, so invalidating the query
      // alone re-asks and gets the same stale answer back. Refresh has to say so.
      //
      // Cleared after the request, not before: react-query retries a failed
      // `queryFn` three times by default, and forcing the upstream fetch is
      // exactly the slow path that times out. Clearing first meant the retries
      // went back to the cache and "succeeded" with the stale index the user was
      // trying to get past. A stray `refresh` on a later refetch is harmless.
      const payload = await client.pluginsBrowse(
        wantsFreshIndex.current ? { refresh: true } : undefined,
      );
      wantsFreshIndex.current = false;
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { registryUrl: payload.registryUrl, plugins: payload.plugins };
    },
  });

  const refresh = useCallback(() => {
    wantsFreshIndex.current = true;
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
