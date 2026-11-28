import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import type { WorkspaceRowBadgesProps } from "@getpaseo/plugin/client/ui";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useAppSettings } from "@/hooks/use-settings";
import { useInstalledPlugins } from "../registry";
import { pluginThemeMapping, renderNothing, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import type { InstalledPlugin, PluginWorkspaceRowBadgeItemContribution } from "../types";
import {
  isWorkspaceRowBadgeItemVisible,
  listWorkspaceRowBadgeItems,
  pickWorkspaceRowBadgeItems,
  workspaceRowBadgeItemKey,
} from "./model";

import {
  WorkspaceRowBadgesContext,
  WorkspaceRowBadgeTitleContext,
  type WorkspaceRowBadgesSource,
} from "./kit";

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

function visibleTargets(
  plugins: readonly InstalledPlugin[],
  visibility: Readonly<Record<string, boolean>>,
): RowBadgeItemTarget[] {
  return plugins
    .flatMap((plugin) => plugin.workspaceRowBadgeItems.map((item) => ({ plugin, item })))
    .filter(({ plugin, item }) =>
      isWorkspaceRowBadgeItemVisible(visibility, workspaceRowBadgeItemKey(plugin.id, item.id)),
    );
}

/** The visible plugin row items installed on this workspace's host. */
export function usePluginWorkspaceRowBadgeItems(serverId: string | null): RowBadgeItemTarget[] {
  const installed = useInstalledPlugins();
  const {
    settings: { sidebarPluginRowBadgeItems },
  } = useAppSettings();
  return useMemo(
    () =>
      visibleTargets(
        installed.filter((plugin) => plugin.serverId === serverId),
        sidebarPluginRowBadgeItems,
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

const targetKey = (target: RowBadgeItemTarget) =>
  workspaceRowBadgeItemKey(target.plugin.id, target.item.id);

const RowBadgeTargetsContext = createContext<readonly RowBadgeItemTarget[]>([]);

/** The badges Paseo's sidebar draws for a workspace, for sidebar views that draw their own rows. */
function PluginWorkspaceRowBadgesForWorkspace({ workspace, items }: WorkspaceRowBadgesProps) {
  const targets = useContext(RowBadgeTargetsContext);
  const onHost = targets.filter((target) => target.plugin.serverId === workspace.hostId);
  const chosen = pickWorkspaceRowBadgeItems(onHost, targetKey, items);
  return <PluginWorkspaceRowBadgeItems targets={chosen} workspaceId={workspace.id} />;
}

/**
 * Plugins' badge items and their renderer, for a sidebar view. Render it outside the view's installation provider:
 * the view's own query client does not see app settings change, so the Show toggles are read here.
 */
export function SidebarViewRowBadgesProvider({ children }: { children: ReactNode }) {
  const installed = useInstalledPlugins();
  const {
    settings: { sidebarPluginRowBadgeItems },
  } = useAppSettings();
  const targets = useMemo(
    () => visibleTargets(installed, sidebarPluginRowBadgeItems),
    [installed, sidebarPluginRowBadgeItems],
  );
  const source = useMemo<WorkspaceRowBadgesSource>(
    () => ({
      items: listWorkspaceRowBadgeItems(installed, sidebarPluginRowBadgeItems),
      Badges: PluginWorkspaceRowBadgesForWorkspace,
    }),
    [installed, sidebarPluginRowBadgeItems],
  );
  return (
    <RowBadgeTargetsContext.Provider value={targets}>
      <WorkspaceRowBadgesContext.Provider value={source}>
        {children}
      </WorkspaceRowBadgesContext.Provider>
    </RowBadgeTargetsContext.Provider>
  );
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
