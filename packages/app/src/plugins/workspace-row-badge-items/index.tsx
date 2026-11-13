import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useAppSettings } from "@/hooks/use-settings";
import { useInstalledPlugins } from "../registry";
import { pluginThemeMapping, renderNothing, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import type { InstalledPlugin, PluginWorkspaceRowBadgeItemContribution } from "../types";
import { isWorkspaceRowBadgeItemVisible, workspaceRowBadgeItemKey } from "./model";

import { WorkspaceRowBadgeTitleContext } from "./kit";

export { WorkspaceRowBadge } from "./kit";
export {
  groupPluginWorkspaceRowBadgeItems,
  isWorkspaceRowBadgeItemVisible,
  type PluginWorkspaceRowBadgeItemGroup,
} from "./model";

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
}: {
  targets: readonly RowBadgeItemTarget[];
  workspaceId: string;
}) {
  return targets.map((target) => (
    <ThemedRowBadgeItemHost
      key={workspaceRowBadgeItemKey(target.plugin.id, target.item.id)}
      target={target}
      workspaceId={workspaceId}
      uniProps={pluginThemeMapping}
    />
  ));
}

function RowBadgeItemHost({
  target: { plugin, item },
  workspaceId,
  theme,
}: {
  target: RowBadgeItemTarget;
  workspaceId: string;
  theme: PluginTheme;
}) {
  const { environment, props: hostProps } = usePluginItemHost(plugin, theme);
  const props = useMemo<PluginWorkspaceRowBadgeItemProps>(
    () => ({ ...hostProps, workspaceId }),
    [hostProps, workspaceId],
  );
  const title = plugin.i18n.resolve(item.title, plugin.locale);
  const Item = item.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Item} renderError={renderNothing}>
      <PluginEnvironmentProvider environment={environment}>
        <WorkspaceRowBadgeTitleContext.Provider value={title}>
          <Item {...props} />
        </WorkspaceRowBadgeTitleContext.Provider>
      </PluginEnvironmentProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedRowBadgeItemHost = withUnistyles(RowBadgeItemHost);
