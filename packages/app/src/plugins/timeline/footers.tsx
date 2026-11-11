import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { PluginTimelineFooterContribution } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { createPluginClientStateSource } from "../client-state/source";
import { useInstalledPlugins } from "../registry";
import { PluginInstallationProvider } from "../installation-provider";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { resolvePluginPlatform } from "../platform";
import type { InstalledPlugin } from "../types";

interface FooterProps {
  plugin: InstalledPlugin;
  footer: PluginTimelineFooterContribution;
  agentId: string;
  theme: PluginTheme;
}

function Footer({ plugin, footer, agentId, theme }: FooterProps) {
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel =
    hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId;
  const host = useMemo(
    () => ({ id: plugin.serverId, label: hostLabel }),
    [hostLabel, plugin.serverId],
  );
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const source = useMemo(() => createPluginClientStateSource(plugin.serverId), [plugin.serverId]);
  const Component = footer.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} resetKey={agentId} Surface={Component}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={source}>
          <Component agentId={agentId} theme={theme} host={host} layout={layout} />
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}

interface TimelineFootersProps {
  agentId: string;
  serverId: string;
  theme: PluginTheme;
  bottomOverlayClearance?: number;
}

function TimelineFooters({
  agentId,
  serverId,
  theme,
  bottomOverlayClearance = 0,
}: TimelineFootersProps) {
  const [contentHeight, setContentHeight] = useState(0);
  const handleContentLayout = useCallback((event: LayoutChangeEvent) => {
    setContentHeight(event.nativeEvent.layout.height);
  }, []);
  const plugins = useInstalledPlugins();
  const footers = plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) => plugin.timelineFooters.map((footer) => ({ plugin, footer })));
  if (footers.length === 0) return null;
  return (
    <ScrollView
      style={[styles.footer, { marginBottom: contentHeight > 0 ? bottomOverlayClearance : 0 }]}
      keyboardShouldPersistTaps="handled"
      testID="plugin-timeline-footer"
    >
      <View style={styles.content} onLayout={handleContentLayout}>
        {footers.map(({ plugin, footer }) => (
          <Footer
            key={`${plugin.id}/${footer.id}`}
            plugin={plugin}
            footer={footer}
            agentId={agentId}
            theme={theme}
          />
        ))}
      </View>
    </ScrollView>
  );
}

export const PluginTimelineFooters = withUnistyles(TimelineFooters, (theme) => ({
  theme: toPluginTheme(theme),
}));
const styles = StyleSheet.create((theme) => ({
  footer: {
    flexGrow: 0,
    maxHeight: "45%",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[4] },
  },
  content: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[2],
  },
}));
