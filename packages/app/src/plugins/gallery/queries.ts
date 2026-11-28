import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePluginList } from "@/plugins/plugin-list";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { pluginUpdatesQueryKey } from "./operations";

// The directory changes when a maintainer publishes, not while someone browses. These queries
// refetch on mount only once stale, so opening a plugin's page does not fetch them again.
const DIRECTORY_STALE_MS = 10 * 60_000;

function useHostReady(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return { client, ready: Boolean(client && connected) };
}

/** The host's plugin directory. `supported` is false until the host proxies the registry. */
export function usePluginDirectory(serverId: string) {
  const { client, ready } = useHostReady(serverId);
  // COMPAT(pluginRegistry): added in v0.16.0, remove gate after 2027-05-15.
  const supported = useHostFeature(serverId, "pluginRegistry");
  const query = useFetchQuery({
    queryKey: ["plugin-directory", serverId] as const,
    queryFn: () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.listPluginRegistry();
    },
    enabled: ready && supported,
    dataShape: "value",
    staleTimeMs: DIRECTORY_STALE_MS,
    refetchOnMount: true,
  });
  return { supported, query };
}

/** One listing with its overview. */
export function usePluginListing(serverId: string, listingId: string | undefined) {
  const { client, ready } = useHostReady(serverId);
  // COMPAT(pluginRegistry): added in v0.16.0, remove gate after 2027-05-15.
  const supported = useHostFeature(serverId, "pluginRegistry");
  return useFetchQuery({
    queryKey: ["plugin-listing", serverId, listingId] as const,
    queryFn: () => {
      if (!client || !listingId) throw new Error("Plugin host is offline");
      return client.getRegistryPlugin(listingId);
    },
    enabled: ready && supported && listingId !== undefined,
    dataShape: "value",
    staleTimeMs: DIRECTORY_STALE_MS,
    refetchOnMount: true,
  });
}

/** Installed plugins with a newer reviewed version, by plugin ID. */
export function usePluginUpdates(serverId: string) {
  const { client, ready } = useHostReady(serverId);
  // COMPAT(pluginSourceUpdates): added in v0.8.0, remove gate after 2027-03-16.
  const supported = useHostFeature(serverId, "pluginSourceUpdates");
  return useFetchQuery({
    queryKey: pluginUpdatesQueryKey(serverId),
    queryFn: () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.previewPluginUpdates();
    },
    enabled: ready && supported,
    dataShape: "list",
    staleTimeMs: DIRECTORY_STALE_MS,
    refetchOnMount: true,
    select: (previews) => previews.filter((preview) => preview.outcome === "update"),
  });
}

/** Refetches the plugin list when another client or the CLI changes it. */
function usePluginCatalogFeed(serverId: string, refetch: () => unknown) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "pluginManagement");
  useEffect(() => {
    if (!client || !connected || !supported) return;
    const observation = client.observeEvents(["status.plugin_catalog_changed"]);
    observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "status" && message.payload.status === "plugin_catalog_changed")
          void refetch();
      },
    });
    return () => {
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release settings feed", error));
    };
  }, [client, connected, supported, refetch]);
}

/**
 * The host's plugins, refetched whenever another client or the CLI changes them. A change also
 * re-checks updates, whose proposals name the revision each plugin had when checked.
 */
export function useLivePluginList(serverId: string) {
  const plugins = usePluginList(serverId);
  const queryClient = useQueryClient();
  const { refetch } = plugins;
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: pluginUpdatesQueryKey(serverId) });
    return refetch();
  }, [queryClient, refetch, serverId]);
  usePluginCatalogFeed(serverId, refresh);
  return plugins;
}
