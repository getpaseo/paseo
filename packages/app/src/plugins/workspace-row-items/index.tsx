import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginWorkspaceRowItemProps } from "@getpaseo/plugin/client";
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
import type { InstalledPlugin, PluginWorkspaceRowItemContribution } from "../types";
import { WorkspaceRowItemFrameContext, type WorkspaceRowItemFrame } from "./frame";
import { isWorkspaceRowItemVisible, workspaceRowItemKey } from "./model";

export { WorkspaceRowBadge } from "./kit";
export {
  groupPluginWorkspaceRowItems,
  isWorkspaceRowItemVisible,
  type PluginWorkspaceRowItemGroup,
} from "./model";

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function renderNothing() {
  return null;
}

interface RowItemTarget {
  plugin: InstalledPlugin;
  item: PluginWorkspaceRowItemContribution;
}

/** The visible plugin row items installed on this workspace's host. */
export function usePluginWorkspaceRowItems(serverId: string | null): RowItemTarget[] {
  const installed = useInstalledPlugins();
  const {
    settings: { sidebarPluginRowItems },
  } = useAppSettings();
  return useMemo(
    () =>
      installed
        .filter((plugin) => plugin.serverId === serverId)
        .flatMap((plugin) => plugin.workspaceRowItems.map((item) => ({ plugin, item })))
        .filter(({ plugin, item }) =>
          isWorkspaceRowItemVisible(sidebarPluginRowItems, workspaceRowItemKey(plugin.id, item.id)),
        ),
    [installed, serverId, sidebarPluginRowItems],
  );
}

/**
 * Plugin items on a workspace's meta line, after the row's own. No wrapper views: an item that
 * renders nothing must leave no gap behind it on the line.
 */
export function PluginWorkspaceRowItems({
  targets,
  workspaceId,
  separated,
}: {
  targets: readonly RowItemTarget[];
  workspaceId: string;
  /** The row drew items of its own, so the first plugin item leads with a separator. */
  separated: boolean;
}) {
  return targets.map((target, index) => (
    <ThemedRowItemHost
      key={workspaceRowItemKey(target.plugin.id, target.item.id)}
      target={target}
      workspaceId={workspaceId}
      separated={separated || index > 0}
      uniProps={pluginThemeMapping}
    />
  ));
}

function RowItemHost({
  target: { plugin, item },
  workspaceId,
  separated,
  theme,
}: {
  target: RowItemTarget;
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
  const frame = useMemo<WorkspaceRowItemFrame>(
    () => ({ title, testID: `plugin-workspace-row-${plugin.id}-${item.id}`, separated }),
    [item.id, plugin.id, separated, title],
  );
  const props = useMemo<PluginWorkspaceRowItemProps>(
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
        <WorkspaceRowItemFrameContext.Provider value={frame}>
          <Item {...props} />
        </WorkspaceRowItemFrameContext.Provider>
      </PluginEnvironmentProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedRowItemHost = withUnistyles(RowItemHost);
