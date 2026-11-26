import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeatureAvailability } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { pluginListQueryKey } from "./plugin-list";
import { pluginRegistry } from "./registry";
import { syncPluginCatalog } from "./catalog-sync-model";

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const audio = useVoiceAudioEngineOptional();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeatureAvailability(serverId, "plugins");
  const queryClient = useQueryClient();

  useEffect(
    () =>
      syncPluginCatalog({
        serverId,
        client,
        audio,
        connected,
        supported,
        registry: pluginRegistry,
        onCatalogChanged: () => {
          void queryClient.invalidateQueries({ queryKey: pluginListQueryKey(serverId) });
        },
      }),
    [audio, client, connected, queryClient, serverId, supported],
  );

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
