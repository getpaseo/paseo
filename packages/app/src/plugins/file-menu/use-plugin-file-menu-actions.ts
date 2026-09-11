import { useMemo, useSyncExternalStore } from "react";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { pluginRegistry } from "../registry";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import type { InstalledPlugin } from "../types";
import { buildPluginFileMenuActions, type PluginFileMenuAction } from "./actions";

const NO_PLUGINS: InstalledPlugin[] = [];
const NO_ACTIONS: PluginFileMenuAction[] = [];
const subscribeNothing = () => () => {};
const readNothing = () => NO_PLUGINS;

/**
 * Plugin actions for one Files row. Rows subscribe to the plugin catalog only once `enabled`, and
 * the host client is read when an item is selected, so closed rows hold no plugin subscriptions.
 */
export function usePluginFileMenuActions(input: {
  enabled: boolean;
  serverId: string;
  workspaceId: string | null | undefined;
  path: string;
}): PluginFileMenuAction[] {
  const { enabled, serverId, workspaceId, path } = input;
  const plugins = useSyncExternalStore(
    enabled ? pluginRegistry.subscribe : subscribeNothing,
    enabled ? pluginRegistry.getSnapshot : readNothing,
    enabled ? pluginRegistry.getSnapshot : readNothing,
  );
  const toast = useToast();
  return useMemo(() => {
    if (!enabled || !workspaceId) return NO_ACTIONS;
    return buildPluginFileMenuActions({
      serverId,
      workspaceId,
      file: { path },
      plugins,
      runtime: (plugin) =>
        createPluginSurfaceRuntime(
          getHostRuntimeStore().getSnapshot(serverId)?.client ?? null,
          plugin,
        ),
      state: createPluginClientStateSource(serverId),
      navigation: createPluginNavigation({ serverId, workspaceId }),
      reportError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
    });
  }, [enabled, path, plugins, serverId, toast, workspaceId]);
}
