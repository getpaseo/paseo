import { pluginSettingsKey } from "./settings/use-settings";
import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";

const catalogRefreshes = new WeakMap<DaemonClient, () => Promise<void>>();

export async function waitForPluginCatalog(client: DaemonClient): Promise<void> {
  await catalogRefreshes.get(client)?.();
}

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "plugins");

  useEffect(() => {
    let cancelled = false;
    let refreshQueue = Promise.resolve();
    if (!supported) {
      pluginRegistry.removeHost(serverId);
      return;
    }
    if (!connected) {
      pluginRegistry.removeHost(serverId);
      return;
    }
    let latestRefresh = refreshQueue;
    const pendingRefresh = () => latestRefresh;
    catalogRefreshes.set(client, pendingRefresh);
    const refresh = (replacePluginId?: string) => {
      latestRefresh = refreshQueue.then(() =>
        client.getPluginCatalog().then((catalog) => {
          if (!cancelled) {
            pluginRegistry.installCatalog(serverId, catalog, {
              replacePluginId,
              client,
            });
          }
          return undefined;
        }),
      );
      refreshQueue = latestRefresh.catch((error) => {
        if (!cancelled) {
          console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
        }
      });
      return refreshQueue;
    };
    const observation = client.observeEvents([
      "status.plugin_catalog_changed",
      "status.plugin_settings_changed",
    ]);
    observation.subscribe({
      snapshot: () => {
        void refresh();
      },
      update: (message) => {
        if (message.type !== "status") return;
        if (message.payload.status === "plugin_settings_changed") {
          const { pluginId, settingsId } = message.payload;
          if (typeof settingsId === "string") {
            const plugin = pluginRegistry
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
      if (catalogRefreshes.get(client) === pendingRefresh) catalogRefreshes.delete(client);
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
    };
  }, [client, connected, serverId, supported]);

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
