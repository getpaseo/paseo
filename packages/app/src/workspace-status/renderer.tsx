import { useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { PluginWorkspaceStatusRendererProps } from "@getpaseo/plugin/client";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";
import { PluginInstallationProvider } from "@/plugins/installation-provider";
import { useInstalledPlugins } from "@/plugins/registry";
import { resolvePluginPlatform } from "@/plugins/platform";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import { toPluginTheme } from "@/plugins/theme";
import { useHosts } from "@/runtime/host-runtime";
import { densityIconBox, densityIconSize } from "@/styles/density";
import type { Theme } from "@/styles/theme";
import {
  projectWorkspaceStatusActivities,
  projectWorkspaceStatusDetails,
  selectWorkspaceStatusRenderer,
} from "./renderer-model";

type Target = NonNullable<ReturnType<typeof selectWorkspaceStatusRenderer>>;

function RendererContent({
  target,
  ...props
}: PluginWorkspaceStatusRendererProps & { target: Target }) {
  const Content = target.contribution.Component;
  return (
    <PluginInstallationProvider plugin={target.plugin}>
      <Content {...props} />
    </PluginInstallationProvider>
  );
}

const ThemedRendererContent = withUnistyles(RendererContent);
const rendererTheme = (theme: Theme, rt: { breakpoint?: string }) => ({
  theme: toPluginTheme(theme),
  size: densityIconSize(rt, "md"),
});

/** The host owns navigation, hit testing and accessibility; plugins only paint the status mark. */
export function WorkspaceStatusRenderer({
  workspace,
  loading,
  children,
}: {
  workspace: SidebarWorkspaceEntry;
  loading: boolean;
  children: ReactNode;
}) {
  const installed = useInstalledPlugins();
  const target = useMemo(
    () => selectWorkspaceStatusRenderer(installed, workspace.serverId),
    [installed, workspace.serverId],
  );
  const hosts = useHosts();
  const compact = useIsCompactFormFactor();
  const { t } = useTranslation();
  const host = useMemo(
    () =>
      Object.freeze({
        id: workspace.serverId,
        label:
          hosts.find((entry) => entry.serverId === workspace.serverId)?.label ?? workspace.serverId,
      }),
    [hosts, workspace.serverId],
  );
  const workspaceProps = useMemo(
    () =>
      Object.freeze({
        id: workspace.workspaceId,
        name: workspace.name,
        status: workspace.statusBucket,
      }),
    [workspace.workspaceId, workspace.name, workspace.statusBucket],
  );
  const layout = useMemo(
    () => Object.freeze({ compact, platform: resolvePluginPlatform() }),
    [compact],
  );
  const renderError = useCallback(() => children, [children]);
  if (!target) return children;
  return (
    <SurfaceErrorBoundary
      installation={target.plugin.lifetime}
      Surface={target.contribution.Component}
      renderError={renderError}
    >
      <View
        pointerEvents="none"
        accessible
        role="img"
        accessibilityLabel={getStatusBucketLabel(workspace.statusBucket, t)}
        style={styles.slot}
        testID="workspace-status-indicator-renderer"
      >
        <ThemedRendererContent
          target={target}
          workspace={workspaceProps}
          host={host}
          layout={layout}
          statusDetails={projectWorkspaceStatusDetails(workspace.statusDetails)}
          activities={projectWorkspaceStatusActivities(workspace.activities)}
          primaryActivityId={workspace.primaryActivityId ?? null}
          loading={loading}
          uniProps={rendererTheme}
        />
      </View>
    </SurfaceErrorBoundary>
  );
}

const styles = StyleSheet.create({
  slot: {
    width: densityIconBox("md"),
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
