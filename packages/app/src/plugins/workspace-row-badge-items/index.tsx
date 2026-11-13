import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useAppSettings } from "@/hooks/use-settings";
import { useInstalledPlugins } from "../registry";
import { pluginThemeMapping, renderNothing, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import type { InstalledPlugin, PluginWorkspaceRowBadgeItemContribution } from "../types";
import { WorkspaceRowBadgeItemFrameContext, type WorkspaceRowBadgeItemFrame } from "./frame";
import { withDrawn, withoutDrawn, type DrawnPositions } from "./line";
import { isWorkspaceRowBadgeItemVisible, workspaceRowBadgeItemKey } from "./model";

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
  separated,
}: {
  targets: readonly RowBadgeItemTarget[];
  workspaceId: string;
  /** The row drew items of its own, so the first plugin item leads with a separator. */
  separated: boolean;
}) {
  const [drawn, setDrawn] = useState<DrawnPositions>([]);
  const markDrawn = useCallback((position: number) => {
    setDrawn((current) => withDrawn(current, position));
    return () => setDrawn((current) => withoutDrawn(current, position));
  }, []);
  return targets.map((target, position) => (
    <ThemedRowBadgeItemHost
      key={workspaceRowBadgeItemKey(target.plugin.id, target.item.id)}
      target={target}
      workspaceId={workspaceId}
      leading={separated}
      position={position}
      drawn={drawn}
      markDrawn={markDrawn}
      uniProps={pluginThemeMapping}
    />
  ));
}

function RowBadgeItemHost({
  target: { plugin, item },
  workspaceId,
  leading,
  position,
  drawn,
  markDrawn,
  theme,
}: {
  target: RowBadgeItemTarget;
  workspaceId: string;
  leading: boolean;
  position: number;
  drawn: DrawnPositions;
  markDrawn: (position: number) => () => void;
  theme: PluginTheme;
}) {
  const { environment, props: hostProps } = usePluginItemHost(plugin, theme);
  const title = plugin.i18n.resolve(item.title, plugin.locale);
  const frame = useMemo<WorkspaceRowBadgeItemFrame>(
    () => ({
      title,
      testID: `plugin-workspace-row-badge-${plugin.id}-${item.id}`,
      leading,
      position,
      drawn,
      markDrawn,
    }),
    [drawn, item.id, leading, markDrawn, plugin.id, position, title],
  );
  const props = useMemo<PluginWorkspaceRowBadgeItemProps>(
    () => ({ ...hostProps, workspaceId }),
    [hostProps, workspaceId],
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
