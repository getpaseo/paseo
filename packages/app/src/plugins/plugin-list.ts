import { useMemo } from "react";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import { useFetchQueries, useFetchQuery } from "@/data/query";
import { useHostFeature, useHostFeatureMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";

export function pluginListQueryKey(serverId: string) {
  return ["plugins", serverId] as const;
}

/** A host's configured plugins, as listed on Settings → Plugins. One cache entry per host. */
export function usePluginList(serverId: string, options: { enabled?: boolean } = {}) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "pluginManagement");
  return useFetchQuery({
    queryKey: pluginListQueryKey(serverId),
    queryFn: async () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.listPlugins();
    },
    enabled: (options.enabled ?? true) && Boolean(client && connected && supported),
    dataShape: "list",
    staleTimeMs: 1_000,
  });
}

/** The manifest's display name, or the plugin id when it has none. */
export function pluginDisplayName(plugin: Pick<PluginListItem, "id" | "name">): string {
  return plugin.name ?? plugin.id;
}

/** The display name of one configured plugin; its id until the list loads. */
export function usePluginDisplayName(
  target: { serverId: string; pluginId: string } | null,
): string | undefined {
  const plugins = usePluginList(target?.serverId ?? "", { enabled: target !== null });
  if (!target) return undefined;
  const plugin = plugins.data?.find((candidate) => candidate.id === target.pluginId);
  return plugin ? pluginDisplayName(plugin) : target.pluginId;
}

/** Configured plugins across all connected hosts advertising `pluginManagement`, including server-only plugins. */
export function useConfiguredPluginsAcrossHosts(): readonly Pick<PluginListItem, "id" | "name">[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const featureMap = useHostFeatureMap(serverIds, "pluginManagement");
  const queries = useFetchQueries(
    hosts.map((host) => {
      const serverId = host.serverId;
      const client = getHostRuntimeStore().getClient(serverId);
      const supported = featureMap.get(serverId) === true;
      return {
        queryKey: pluginListQueryKey(serverId),
        queryFn: async () => {
          const currentClient = getHostRuntimeStore().getClient(serverId);
          if (!currentClient) throw new Error("Plugin host is offline");
          return currentClient.listPlugins();
        },
        enabled: Boolean(client?.isConnected && supported),
        dataShape: "list" as const,
        staleTimeMs: 1_000,
      };
    }),
  );
  return useMemo(
    () =>
      queries.flatMap((query) =>
        (query.data ?? []).map((plugin) => ({
          id: plugin.id,
          name: pluginDisplayName(plugin),
        })),
      ),
    [queries],
  );
}
