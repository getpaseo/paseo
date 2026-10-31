import type { AudioEngine } from "@/audio";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginRegistry } from "./registry";
import { pluginSettingsKey, pluginSettingsPrefix } from "./settings/query";

type PluginCatalog = Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>;

interface CatalogSyncInput {
  serverId: string;
  client: DaemonClient;
  audio: Pick<AudioEngine, "play"> | null;
  connected: boolean;
  supported: boolean;
  registry: Pick<PluginRegistry, "installCatalog" | "getSnapshot" | "removeHost">;
  // Runs once before the first catalog request. Timeline paint restores a cached
  // catalog here so the chat does not wait on the network.
  prepare?: () => Promise<void>;
  onCatalogInstalled?: (catalog: PluginCatalog) => void;
  onCatalogFailed?: () => void;
}

export function syncPluginCatalog({
  serverId,
  client,
  audio,
  connected,
  supported,
  registry,
  prepare,
  onCatalogInstalled,
  onCatalogFailed,
}: CatalogSyncInput): () => void {
  if (!supported || !audio) {
    registry.removeHost(serverId);
    return () => {};
  }
  // A dropped socket reconnects on the same client, so installations keep rendering offline.
  if (!connected) return () => {};
  const installationOptions = { client, audio };
  let cancelled = false;
  let prepared = false;
  let fullRefreshPending = false;
  let refreshQueue = Promise.resolve();
  function refresh(replacePluginId?: string) {
    // The subscription snapshot and the eager first fetch are the same catalog read.
    // Coalesce them so a sync snapshot does not download the bundle twice.
    if (replacePluginId === undefined && fullRefreshPending) return refreshQueue;
    const fullRefresh = replacePluginId === undefined;
    if (fullRefresh) fullRefreshPending = true;
    refreshQueue = refreshQueue.then(async () => {
      try {
        if (!prepared) {
          prepared = true;
          await prepare?.();
        }
        if (cancelled) return undefined;
        try {
          const catalog = await client.getPluginCatalog();
          if (cancelled) return undefined;
          registry.installCatalog(serverId, catalog, { ...installationOptions, replacePluginId });
          onCatalogInstalled?.(catalog);
        } catch (error) {
          if (!cancelled) {
            console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
            onCatalogFailed?.();
          }
        }
        return undefined;
      } finally {
        if (fullRefresh) fullRefreshPending = false;
      }
    });
    return refreshQueue;
  }
  const observation = client.observeEvents([
    "status.plugin_catalog_changed",
    "status.plugin_settings_changed",
  ]);
  observation.subscribe({
    snapshot: () => {
      void refresh().then(() => {
        if (cancelled) return undefined;
        // Retained replicas miss offline writes and do not refetch when a screen mounts.
        for (const plugin of registry.getSnapshot()) {
          if (plugin.serverId !== serverId) continue;
          void plugin.queryClient.invalidateQueries({
            queryKey: pluginSettingsPrefix,
            refetchType: "all",
          });
        }
        return undefined;
      });
    },
    update: (message) => {
      if (message.type !== "status") return;
      if (message.payload.status === "plugin_settings_changed") {
        const { pluginId, settingsId } = message.payload;
        if (typeof settingsId === "string") {
          const plugin = registry
            .getSnapshot()
            .find((item) => item.serverId === serverId && item.id === pluginId);
          void plugin?.queryClient.invalidateQueries({ queryKey: pluginSettingsKey(settingsId) });
        }
      }
      if (message.payload.status === "plugin_catalog_changed") {
        const pluginId = message.payload.pluginId;
        if (typeof pluginId === "string") void refresh(pluginId);
      }
    },
  });
  // The subscription snapshot used to be the only fetch, so the bundle waited out
  // an extra round trip before the chat could leave its native rows.
  void refresh();
  return () => {
    cancelled = true;
    void observation
      .release()
      .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
  };
}
