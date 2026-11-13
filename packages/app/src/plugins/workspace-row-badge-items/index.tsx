import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useAppSettings } from "@/hooks/use-settings";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { resolvePluginPlatform } from "../platform";
import { PluginEnvironmentProvider, type PluginEnvironment } from "../popover";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import type { InstalledPlugin, PluginWorkspaceRowBadgeItemContribution } from "../types";
import { WorkspaceRowBadgeItemFrameContext, type WorkspaceRowBadgeItemFrame } from "./frame";
import { isWorkspaceRowBadgeItemVisible, workspaceRowBadgeItemKey } from "./model";

export { WorkspaceRowBadge } from "./kit";
export {
  groupPluginWorkspaceRowBadgeItems,
  isWorkspaceRowBadgeItemVisible,
  type PluginWorkspaceRowBadgeItemGroup,
} from "./model";

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function renderNothing() {
  return null;
}

interface RowBadgeItemTarget {
  plugin: InstalledPlugin;
  item: PluginWorkspaceRowBadgeItemContribution;
}

/** The visible plugin row items installed on this workspace's host. */
export function usePluginWorkspaceRowBadgeItems(serverId: string | null): RowBadgeItemTarget[] {
  const installed = useInstalledPlugins();
  const {
    settings: { sidebarPluginRowBadgeItems },
  } = useAppSettings();
  return useMemo(
    () =>
      installed
        .filter((plugin) => plugin.serverId === serverId)
        .flatMap((plugin) => plugin.workspaceRowBadgeItems.map((item) => ({ plugin, item })))
        .filter(({ plugin, item }) =>
          isWorkspaceRowBadgeItemVisible(
            sidebarPluginRowBadgeItems,
            workspaceRowBadgeItemKey(plugin.id, item.id),
          ),
        ),
    [installed, serverId, sidebarPluginRowBadgeItems],
  );
}

/**
 * Plugin items on a workspace's meta line, after the row's own. No wrapper views: an item that
 * renders nothing must leave no gap behind it on the line.
 */
export function PluginWorkspaceRowBadgeItems({
  targets,
  workspaceId,
  separated,
}: {
  targets: readonly RowBadgeItemTarget[];
  workspaceId: string;
  /** The row drew items of its own, so the first plugin item leads with a separator. */
  separated: boolean;
}) {
  return targets.map((target, index) => (
    <ThemedRowBadgeItemHost
      key={workspaceRowBadgeItemKey(target.plugin.id, target.item.id)}
      target={target}
      workspaceId={workspaceId}
      separated={separated || index > 0}
      uniProps={pluginThemeMapping}
    />
  ));
}

function RowBadgeItemHost({
  target: { plugin, item },
  workspaceId,
  separated,
  theme,
}: {
  target: RowBadgeItemTarget;
  workspaceId: string;
  separated: boolean;
  theme: PluginTheme;
}) {
  const toast = useToast();
  const hosts = useHosts();
  const compact = useIsCompactFormFactor();
  const hostLabel =
    hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId;
  const environment = useMemo<PluginEnvironment>(
    () => ({
      installation: plugin,
      toast,
      state: createPluginClientStateSource(plugin.serverId),
    }),
    [plugin, toast],
  );
  const title = plugin.i18n.resolve(item.title, plugin.locale);
  const frame = useMemo<WorkspaceRowBadgeItemFrame>(
    () => ({ title, testID: `plugin-workspace-row-badge-${plugin.id}-${item.id}`, separated }),
    [item.id, plugin.id, separated, title],
  );
  const props = useMemo<PluginWorkspaceRowBadgeItemProps>(
    () => ({
      theme,
      host: { id: plugin.serverId, label: hostLabel },
      layout: { compact, platform: resolvePluginPlatform() },
      workspaceId,
    }),
    [compact, hostLabel, plugin.serverId, theme, workspaceId],
  );
  const Item = item.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Item} renderError={renderNothing}>
      <PluginEnvironmentProvider environment={environment}>
        <WorkspaceRowBadgeItemFrameContext.Provider value={frame}>
          <Item {...props} />
        </WorkspaceRowBadgeItemFrameContext.Provider>
      </PluginEnvironmentProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedRowBadgeItemHost = withUnistyles(RowBadgeItemHost);
