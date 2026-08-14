import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";

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
    const refresh = (replacePluginId?: string) => {
      refreshQueue = refreshQueue.then(() =>
        client
          .getPluginCatalog()
          .then((catalog) => {
            if (!cancelled) {
              pluginRegistry.installCatalog(serverId, catalog, { replacePluginId });
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
    };
    void refresh();
    const unsubscribe = client.on("status", (message) => {
      if (message.payload.status === "plugin_catalog_changed") {
        const pluginId = message.payload.pluginId;
        if (typeof pluginId === "string") void refresh(pluginId);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, connected, serverId, supported]);

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
