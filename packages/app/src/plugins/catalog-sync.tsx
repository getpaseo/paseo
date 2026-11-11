import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useEffect, useRef } from "react";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { syncPluginCatalog } from "./catalog-sync-model";
import { pluginRegistry } from "./registry";
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

    if (!audio || pluginsFeature !== true || !connected || !client) return;

    const hasTransformers = hostHasTimelineTransformers(serverId);
    beginPluginCatalogLoad(serverId, {
      hasTransformers,
      forceWait: clientChanged || featureBecameEnabled,
    });
    return syncPluginCatalog({
      serverId,
      client,
      audio,
      connected,
      supported: true,
      registry: pluginRegistry,
      onCatalogInstalled: () => {
        rememberPluginTimelineExpectation(serverId, hostHasTimelineTransformers(serverId));
        markPluginCatalogReady(serverId);
      },
      onCatalogFailed: () => {
        markPluginCatalogReady(serverId);
      },
    });
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
