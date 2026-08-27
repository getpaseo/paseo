import { QueryClientProvider } from "@tanstack/react-query";
import type { PluginNotificationSourceContribution } from "@getpaseo/plugin";
import { resolvePluginNotificationInterval } from "@getpaseo/plugin/host";
import { useMemo } from "react";
import { isNative } from "@/constants/platform";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { pluginNotificationReceiptStore } from "./notification-receipts";
import { createPluginNotifier, pollPluginNotificationSource } from "./notifications";
import { useInstalledPlugins } from "./registry";
import { createPluginSurfaceRuntime } from "./surface-runtime";
import type { InstalledPlugin } from "./types";

function PluginNotificationSourcePoller({
  plugin,
  source,
}: {
  plugin: InstalledPlugin;
  source: PluginNotificationSourceContribution;
}) {
  const client = useHostRuntimeClient(plugin.serverId);
  const runtime = useMemo(() => createPluginSurfaceRuntime(client, plugin.id), [client, plugin.id]);
  const notifier = useMemo(
    () =>
      createPluginNotifier({
        serverId: plugin.serverId,
        pluginId: plugin.id,
        surfaceIds: plugin.surfaces.map((surface) => surface.id),
      }),
    [plugin],
  );

  const intervalMs = resolvePluginNotificationInterval(source.intervalMs);
  useFetchQuery({
    queryKey: ["plugin-notification-source", plugin.serverId, plugin.id, source.id],
    dataShape: "value",
    enabled: runtime !== null,
    refetchInterval: intervalMs,
    refetchIntervalInBackground: true,
    retry: false,
    staleTimeMs: intervalMs,
    queryFn: async () => {
      if (!runtime) return null;
      try {
        return await pollPluginNotificationSource({
          source,
          scope: {
            serverId: plugin.serverId,
            pluginId: plugin.id,
            sourceId: source.id,
          },
          invoke: runtime.invoke,
          notifier,
          receipts: pluginNotificationReceiptStore,
          reportError(error) {
            console.warn(
              `[Plugins] Notification delivery failed for ${plugin.serverId}/${plugin.id}/${source.id}`,
              error,
            );
          },
        });
      } catch (error) {
        console.warn(
          `[Plugins] Notification poll failed for ${plugin.serverId}/${plugin.id}/${source.id}`,
          error,
        );
        return null;
      }
    },
  });
  return null;
}

function PluginInstallationNotificationSources({ plugin }: { plugin: InstalledPlugin }) {
  if (plugin.notificationSources.length === 0) return null;
  return (
    <QueryClientProvider client={plugin.queryClient}>
      {plugin.notificationSources.map((source) => (
        <PluginNotificationSourcePoller
          key={`${plugin.serverId}/${plugin.id}/${source.id}`}
          plugin={plugin}
          source={source}
        />
      ))}
    </QueryClientProvider>
  );
}

export function PluginNotificationSources() {
  const plugins = useInstalledPlugins();
  if (isNative) return null;
  return plugins.map((plugin) => (
    <PluginInstallationNotificationSources
      key={`${plugin.serverId}/${plugin.id}`}
      plugin={plugin}
    />
  ));
}
