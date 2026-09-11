import type { LucideIcon } from "lucide-react-native";
import type { PluginFileMenuContext } from "@getpaseo/plugin/client";
import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import { createPluginWorkspaceActionContext, type PluginNavigation } from "../actions";
import { resolvePluginIcon } from "../icons";
import type { PluginSurfaceRuntime } from "../surface-runtime";
import type { InstalledPlugin } from "../types";

export interface PluginFileMenuAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect(): void;
  run(): Promise<void>;
}

export interface PluginFileMenuSource {
  serverId: string;
  workspaceId: string;
  file: { path: string };
  plugins: readonly InstalledPlugin[];
  runtime(plugin: InstalledPlugin): PluginSurfaceRuntime | null;
  state: PluginClientStateSource;
  navigation: PluginNavigation;
  reportError(error: unknown): void;
}

function isWorkspaceRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

type FileMenuItem = InstalledPlugin["fileMenuItems"][number];

/** The item may run only while its installation is loaded and its registration is still present. */
function unavailableReason(plugin: InstalledPlugin, item: FileMenuItem): Error | null {
  if (plugin.lifetime.signal.aborted) return new Error(`Plugin ${plugin.id} is no longer loaded`);
  if (!plugin.fileMenuItems.includes(item)) {
    return new Error(`File menu item ${plugin.id}/${item.id} is no longer available`);
  }
  return null;
}

/** Navigation that refuses to act once the item's installation or registration is gone. */
function guardNavigation(
  plugin: InstalledPlugin,
  item: FileMenuItem,
  navigation: PluginNavigation,
): PluginNavigation {
  const alive = () => {
    const reason = unavailableReason(plugin, item);
    if (reason) throw reason;
  };
  return {
    openSettings(pluginId, screenId) {
      alive();
      navigation.openSettings(pluginId, screenId);
    },
    openSurface(pluginId, surfaceId) {
      alive();
      navigation.openSurface(pluginId, surfaceId);
    },
    openWorkspacePanel(pluginId, panelId, location) {
      alive();
      navigation.openWorkspacePanel(pluginId, panelId, location);
    },
    openAgentPanel(pluginId, panelId, agentId, location) {
      alive();
      navigation.openAgentPanel(pluginId, panelId, agentId, location);
    },
  };
}

/**
 * Items for one file row on one host. Each selection creates its own API runtime and disposes it
 * when the callback settles; nothing is created while the menu is only displayed.
 */
export function buildPluginFileMenuActions(source: PluginFileMenuSource): PluginFileMenuAction[] {
  const path = source.file.path;
  if (!isWorkspaceRelativePath(path)) return [];
  const actions: PluginFileMenuAction[] = [];
  for (const plugin of source.plugins) {
    if (plugin.serverId !== source.serverId || plugin.lifetime.signal.aborted) continue;
    for (const item of plugin.fileMenuItems) {
      const run = async () => {
        const unavailable = unavailableReason(plugin, item);
        if (unavailable) {
          source.reportError(unavailable);
          return;
        }
        let runtime: PluginSurfaceRuntime | null;
        try {
          runtime = source.runtime(plugin);
        } catch (error) {
          source.reportError(error);
          return;
        }
        if (!runtime) {
          source.reportError(new Error("Plugin host is offline"));
          return;
        }
        try {
          const workspace = createPluginWorkspaceActionContext({
            plugin,
            runtime,
            navigation: guardNavigation(plugin, item, source.navigation),
            state: source.state,
            workspaceId: source.workspaceId,
          });
          if (!workspace) throw new Error("Workspace is unavailable");
          const context: PluginFileMenuContext = { ...workspace, file: Object.freeze({ path }) };
          await item.onSelect(context);
        } catch (error) {
          source.reportError(error);
        } finally {
          await runtime.paseo.dispose().catch(source.reportError);
        }
      };
      actions.push({
        key: `${plugin.id}-${item.id}`,
        label: item.title,
        icon: resolvePluginIcon(item.icon),
        run,
        onSelect: () => {
          void run();
        },
      });
    }
  }
  return actions;
}
