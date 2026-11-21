import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { PluginTimelineFooterProps } from "@getpaseo/plugin/client";
import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import React, { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { PluginInstallationProvider } from "../installation-provider";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { resolvePluginPlatform } from "../platform";

const mapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function TimelineFootersBody({
  agentId,
  serverId,
  activeCalls,
  theme,
}: {
  agentId: string;
  serverId: string;
  activeCalls: readonly ToolCallTimelineItem[];
  theme: PluginTimelineFooterProps["theme"];
}) {
  const plugins = useInstalledPlugins();
  const hosts = useHosts();
  const label = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label }), [serverId, label]);
  const compact = useIsCompactFormFactor();
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const source = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  return (
    <View style={styles.container}>
      {plugins
        .filter((plugin) => plugin.serverId === serverId)
        .flatMap((plugin) =>
          plugin.timelineFooters.map(({ id, Component }) => (
            <SurfaceErrorBoundary
              key={`${plugin.id}/${id}`}
              installation={plugin}
              resetKey={activeCalls}
              Surface={Component}
            >
              <PluginInstallationProvider plugin={plugin}>
                <PluginClientStateProvider source={source}>
                  <Component
                    agentId={agentId}
                    activeCalls={activeCalls}
                    theme={theme}
                    host={host}
                    layout={layout}
                  />
                </PluginClientStateProvider>
              </PluginInstallationProvider>
            </SurfaceErrorBoundary>
          )),
        )}
    </View>
  );
}

const ThemedTimelineFooters = withUnistyles(TimelineFootersBody);
export function PluginTimelineFooters(props: {
  agentId: string;
  serverId: string;
  activeCalls: readonly ToolCallTimelineItem[];
}) {
  return <ThemedTimelineFooters {...props} uniProps={mapping} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
}));
