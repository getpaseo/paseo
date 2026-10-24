import type { AudioEngine } from "@/audio";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useEffect, useRef } from "react";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { readCachedPluginCatalog, writeCachedPluginCatalog } from "./catalog-cache";
import { pluginRegistry } from "./registry";
import { pluginSettingsKey } from "./settings/use-settings";
import {
  beginPluginCatalogLoad,
  beginPluginTimelineExpectationHydration,
  markPluginCatalogReady,
  rememberPluginTimelineExpectation,
  resetPluginCatalog,
  usePluginsFeature,
} from "./timeline-paint";

function hostHasTimelineTransformers(serverId: string): boolean {
  return pluginRegistry
    .getSnapshot()
    .some((plugin) => plugin.serverId === serverId && plugin.timelineTransformers.length > 0);
}

async function restoreCachedCatalog(
  serverId: string,
  client: DaemonClient,
  audio: Pick<AudioEngine, "play">,
): Promise<void> {
  const cached = await readCachedPluginCatalog(serverId);
  if (!cached) return;
  // installCatalog rechecks compatibility, so an app upgrade does not skip a bundle
  // that the new host can no longer evaluate. An identical network catalog then
  // preserves this installation instead of evaluating it again.
  pluginRegistry.installCatalog(serverId, cached, { client, audio });
}

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient | null;
}) {
  const audio = useVoiceAudioEngineOptional();
  const connected = useHostRuntimeIsConnected(serverId);
  const pluginsFeature = usePluginsFeature(serverId);
  const retention = useRef<{ serverId: string; client: DaemonClient | null }>({
    serverId: "",
    client: null,
  });
  const featureMemory = useRef<{ serverId: string; feature: boolean | null }>({
    serverId: "",
    feature: null,
  });

  useEffect(() => {
    beginPluginTimelineExpectationHydration();
    let cancelled = false;
    let refreshQueue = Promise.resolve();
    const previousRetention = retention.current;
    const sameServer = previousRetention.serverId === serverId;
    const clientChanged =
      sameServer &&
      previousRetention.client !== null &&
      client !== null &&
      previousRetention.client !== client;
    retention.current = {
      serverId,
      client: client ?? (sameServer ? previousRetention.client : null),
    };
    const featureBecameEnabled =
      featureMemory.current.serverId === serverId &&
      featureMemory.current.feature === false &&
      pluginsFeature === true;
    featureMemory.current = { serverId, feature: pluginsFeature };

    // The socket object is what the installation closes over. A missing client is a
    // blip; a different client is a new connection and has to evaluate again.
    if (clientChanged || featureBecameEnabled) {
      pluginRegistry.removeHost(serverId);
      resetPluginCatalog(serverId);
    }

    if (pluginsFeature === false) {
      pluginRegistry.removeHost(serverId);
      rememberPluginTimelineExpectation(serverId, false);
      markPluginCatalogReady(serverId);
      return;
    }

    if (!audio || pluginsFeature !== true || !connected || !client) {
      return;
    }

    const refresh = (replacePluginId?: string) => {
      refreshQueue = refreshQueue.then(() =>
        client
          .getPluginCatalog()
          .then((catalog) => {
            if (cancelled) return undefined;
            pluginRegistry.installCatalog(serverId, catalog, {
              replacePluginId,
              client,
              audio,
            });
            rememberPluginTimelineExpectation(serverId, hostHasTimelineTransformers(serverId));
            markPluginCatalogReady(serverId);
            void writeCachedPluginCatalog(serverId, catalog);
            return undefined;
          })
          .catch((error) => {
            if (!cancelled) {
              console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
              markPluginCatalogReady(serverId);
            }
            return undefined;
          }),
      );
      return refreshQueue;
    };

    let observation: ReturnType<DaemonClient["observeEvents"]> | null = null;
    const start = async () => {
      await restoreCachedCatalog(serverId, client, audio);
      if (cancelled) return;
      beginPluginCatalogLoad(serverId, {
        hasTransformers: hostHasTimelineTransformers(serverId),
        forceWait: clientChanged || featureBecameEnabled,
      });
      // The subscription snapshot used to be the only fetch, so the bundle waited
      // out an extra round trip before the chat could leave its native rows.
      void refresh();
      observation = client.observeEvents([
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
              void plugin?.queryClient.invalidateQueries({
                queryKey: pluginSettingsKey(settingsId),
              });
            }
          }
          if (message.payload.status === "plugin_catalog_changed") {
            const pluginId = message.payload.pluginId;
            if (typeof pluginId === "string") void refresh(pluginId);
          }
        },
      });
    };
    void start();
    return () => {
      cancelled = true;
      if (!observation) return;
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
    };
  }, [audio, client, connected, pluginsFeature, serverId]);

  useEffect(
    () => () => {
      pluginRegistry.removeHost(serverId);
      resetPluginCatalog(serverId);
    },
    [serverId],
  );
  return null;
}
