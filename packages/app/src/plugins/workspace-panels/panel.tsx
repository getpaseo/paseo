import type {
  PluginAgentPanelProps,
  PluginHostProps,
  PluginWorkspacePanelProps,
} from "@paseo/plugin";
import { PluginClientStateProvider } from "@paseo/plugin/host";
import { CircleAlert } from "lucide-react-native";
import { useMemo } from "react";
import { Platform, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceExists } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { createPluginClientStateSource } from "../client-state/source";
import { resolvePluginIcon } from "../icons";
import { useInstalledPlugin } from "../registry";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { resolvePluginWorkspacePanel } from "./resolution";

const EMPTY_THEME_DTO: Record<string, unknown> = {};
const pluginThemeMapping = (theme: Theme) => ({
  themeDto: JSON.parse(JSON.stringify(theme)) as Record<string, unknown>,
});

function resolvePlatform(): PluginHostProps["layout"]["platform"] {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

function PluginPanelBody({ themeDto = EMPTY_THEME_DTO }: { themeDto?: Record<string, unknown> }) {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "plugin", "PluginPanel requires plugin target");
  const plugin = useInstalledPlugin(serverId, target.pluginId);
  const contribution = resolvePluginWorkspacePanel(plugin, target);
  const workspaceExists = useWorkspaceExists(serverId, workspaceId);
  const agentExists = useSessionStore((state) => {
    if (target.context !== "agent") return null;
    const session = state.sessions[serverId];
    const agent = session?.agents.get(target.agentId) ?? session?.agentDetails.get(target.agentId);
    return (
      Boolean(agent) &&
      normalizeWorkspaceOpaqueId(agent?.workspaceId) === normalizeWorkspaceOpaqueId(workspaceId)
    );
  });
  const client = useHostRuntimeClient(serverId);
  const runtime = useMemo(
    () => createPluginSurfaceRuntime(client, target.pluginId),
    [client, target.pluginId],
  );
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePlatform() }), [compact]);
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);

  if (!plugin || !contribution || !workspaceExists) {
    return <PluginPanelUnavailable />;
  }
  if (!runtime) {
    return <PluginPanelUnavailable message="Plugin host is offline." />;
  }

  let panel;
  let Surface: unknown;
  if (contribution.context === "workspace") {
    const props: PluginWorkspacePanelProps = {
      context: "workspace",
      theme: themeDto,
      host,
      layout,
      workspaceId,
    };
    const Component = contribution.Component;
    Surface = Component;
    panel = <Component {...props} />;
  } else if (agentExists && target.context === "agent") {
    const props: PluginAgentPanelProps = {
      context: "agent",
      theme: themeDto,
      host,
      layout,
      workspaceId,
      agentId: target.agentId,
    };
    const Component = contribution.Component;
    Surface = Component;
    panel = <Component {...props} />;
  } else {
    return <PluginPanelUnavailable />;
  }

  return (
    <SurfaceErrorBoundary
      installation={plugin}
      Surface={Surface}
      key={`${serverId}/${target.pluginId}/${target.panelId}/${target.context}`}
    >
      <PluginRuntimeBoundary plugin={plugin} runtime={runtime}>
        <PluginClientStateProvider source={stateSource}>{panel}</PluginClientStateProvider>
      </PluginRuntimeBoundary>
    </SurfaceErrorBoundary>
  );
}

const ThemedPluginPanelBody = withUnistyles(PluginPanelBody);

function PluginPanel() {
  return <ThemedPluginPanelBody uniProps={pluginThemeMapping} />;
}

function PluginPanelUnavailable({
  message = "This plugin panel is unavailable.",
}: {
  message?: string;
}) {
  return (
    <View style={styles.unavailable}>
      <Text style={styles.unavailableText}>{message}</Text>
    </View>
  );
}

function usePluginPanelDescriptor(
  target: Extract<import("@/workspace-tabs/model").WorkspaceTabTarget, { kind: "plugin" }>,
  context: { serverId: string },
): PanelDescriptor {
  const plugin = useInstalledPlugin(context.serverId, target.pluginId);
  const panel = plugin?.workspacePanels.find(
    (contribution) => contribution.id === target.panelId && contribution.context === target.context,
  );
  if (!panel) {
    return {
      label: "Plugin unavailable",
      subtitle: target.pluginId,
      tooltip: "This plugin panel is unavailable",
      titleState: "ready",
      icon: CircleAlert,
      statusBucket: null,
    };
  }
  return {
    label: panel.title,
    subtitle: target.pluginId,
    tooltip: panel.title,
    titleState: "ready",
    icon: resolvePluginIcon(panel.icon),
    statusBucket: null,
  };
}

export const pluginPanelRegistration: PanelRegistration<"plugin"> = {
  kind: "plugin",
  component: PluginPanel,
  useDescriptor: usePluginPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  unavailable: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  unavailableText: {
    color: theme.colors.foregroundMuted,
  },
}));
