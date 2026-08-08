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
    if (!supported) {
      pluginRegistry.removeHost(serverId);
      return;
    }
    if (!connected) return;
    void client
      .getPluginCatalog()
      .then((catalog) => {
        if (!cancelled) pluginRegistry.installCatalog(serverId, catalog);
        return undefined;
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
        }
        return undefined;
      });
    return () => {
      cancelled = true;
    };
  }, [client, connected, serverId, supported]);

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
