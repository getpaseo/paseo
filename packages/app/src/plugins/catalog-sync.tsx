import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { pluginSettingsKey } from "./settings/use-settings";
import { useEffect, useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";
import { useSessionStore } from "@/stores/session-store";
import { createHostPluginClientBundleStore } from "./client-bundle-storage";
import { createCatalogRefresh } from "./catalog-refresh";

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const audio = useVoiceAudioEngineOptional();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "plugins");
  const timelineSync = useSessionStore((state) => state.sessions[serverId]?.viewedTimelineSync);
  const bundles = useMemo(() => createHostPluginClientBundleStore(serverId), [serverId]);

  useEffect(() => {
    let cancelled = false;
    let refreshQueue = Promise.resolve();
    if (!supported || !audio) {
      pluginRegistry.removeHost(serverId);
      return;
    }
    if (!connected) {
      pluginRegistry.removeHost(serverId);
      return;
    }
    // SessionProvider creates the owner in an effect; observe only after it is published.
    if (!timelineSync) return;
    const refresh = (replacePluginId?: string) => {
      refreshQueue = refreshQueue.then(() =>
        client
          .getPluginCatalog(bundles)
          .then((catalog) => {
            if (!cancelled) {
              pluginRegistry.installCatalog(serverId, catalog, {
                replacePluginId,
                client,
                audio,
              });
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
    const catalogRefresh = createCatalogRefresh({
      catchUp: timelineSync,
      refresh: (pluginId) => {
        void refresh(pluginId);
      },
      schedule: (task, delay) => {
        const timer = setTimeout(task, delay);
        return () => clearTimeout(timer);
      },
    });
    const observation = client.observeEvents([
      "status.plugin_catalog_changed",
      "status.plugin_settings_changed",
    ]);
    observation.subscribe({
      snapshot: () => {
        catalogRefresh.snapshot();
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
          if (typeof pluginId === "string") catalogRefresh.changed(pluginId);
        }
      },
    });
    return () => {
      cancelled = true;
      catalogRefresh.dispose();
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
    };
  }, [audio, bundles, client, connected, serverId, supported, timelineSync]);

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
