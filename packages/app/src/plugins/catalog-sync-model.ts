import type { AudioEngine } from "@/audio";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginRegistry } from "./registry";
import { pluginSettingsKey, pluginSettingsPrefix } from "./settings/query";

interface CatalogSyncInput {
  serverId: string;
  client: DaemonClient;
  audio: Pick<AudioEngine, "play"> | null;
  connected: boolean;
  supported: boolean;
  registry: Pick<PluginRegistry, "installCatalog" | "getSnapshot" | "removeHost">;
}

export function syncPluginCatalog({
  serverId,
  client,
  audio,
  connected,
  supported,
  registry,
}: CatalogSyncInput): () => void {
  if (!supported || !audio) {
    registry.removeHost(serverId);
    return () => {};
  }
  // A dropped socket reconnects on the same client, so installations keep rendering offline.
  if (!connected) return () => {};
  const installationOptions = { client, audio };
  let cancelled = false;
  let refreshQueue = Promise.resolve();
  function refresh(replacePluginId?: string) {
    refreshQueue = refreshQueue.then(() =>
      client
        .getPluginCatalog()
        .then((catalog) => {
          if (!cancelled) {
            registry.installCatalog(serverId, catalog, { ...installationOptions, replacePluginId });
          }
          return undefined;
        })
        .catch((error) => {
          if (!cancelled) {
            console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
          }
          return undefined;
        }),
    );
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
  return () => {
    cancelled = true;
    void observation
      .release()
      .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
  };
}
