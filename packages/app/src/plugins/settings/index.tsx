import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { router } from "expo-router";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { PluginIconView } from "../icons";
import { useInstalledPlugin } from "../registry";
import type { InstalledPlugin } from "../types";
import { PluginInstallationProvider } from "../installation-provider";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { usePluginLayout } from "../layout";

interface SettingsIdentity {
  serverId: string;
  pluginId: string;
  screenId: string;
}

function renderNoIcon() {
  return null;
}

/** A plugin-supplied icon component may throw; its tab then shows the label alone. */
function SettingsTabIcon({
  plugin,
  icon,
  size,
  color,
}: {
  plugin: InstalledPlugin;
  icon: InstalledPlugin["settingsScreens"][number]["icon"];
  size: number;
  color: string;
}) {
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={icon} renderError={renderNoIcon}>
      <PluginIconView icon={icon} size={size} color={color} />
    </SurfaceErrorBoundary>
  );
}

/**
 * One tab per registered settings screen. A plugin with a single screen shows no tabs.
 * Render inside the installation's provider: tab icons may be plugin components.
 */
function SettingsTabs({ plugin, screenId }: { plugin: InstalledPlugin; screenId: string }) {
  const options = useMemo<SegmentedControlOption<string>[]>(
    () =>
      plugin.settingsScreens.map((screen) => ({
        value: screen.id,
        label: plugin.i18n.resolve(screen.title, plugin.locale),
        icon: ({ color, size }) => (
          <SettingsTabIcon plugin={plugin} icon={screen.icon} size={size} color={color} />
        ),
        testID: `plugin-settings-tab-${screen.id}`,
      })),
    [plugin],
  );
  // Tabs swap the screen in place, so Back still returns to the Plugins page.
  const select = useCallback((id: string) => router.setParams({ screenId: id }), []);
  if (options.length < 2) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tabs}
      testID="plugin-settings-tabs"
    >
      <SegmentedControl options={options} value={screenId} onValueChange={select} />
    </ScrollView>
  );
}

function SettingsContent({
  serverId,
  pluginId,
  screenId,
  theme,
}: SettingsIdentity & { theme: PluginHostProps["theme"] }) {
  const { t } = useTranslation();
  const plugin = useInstalledPlugin(serverId, pluginId);
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "pluginSettings");
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const [attempt, setAttempt] = useState(0);
  const screen = plugin?.settingsScreens.find((item) => item.id === screenId);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const renderError = useCallback(
    (error: string) => (
      <View>
        <Text style={styles.message}>{error}</Text>
        <Button variant="outline" onPress={retry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    ),
    [retry, t],
  );
  const host = useMemo(
    () => ({
      id: serverId,
      label: hosts.find((candidate) => candidate.serverId === serverId)?.label ?? serverId,
    }),
    [hosts, serverId],
  );
  const layout = usePluginLayout(compact);
  if (!connected)
    return <Text style={styles.message}>{t("settings.plugins.screens.offline")}</Text>;
  // COMPAT(pluginSettings): added in v0.8, remove after 2027-03-05.
  if (!supported) return <Text style={styles.message}>{t("settings.plugins.screens.update")}</Text>;
  if (!plugin || !screen || !client)
    return <Text style={styles.message}>{t("settings.plugins.screens.unavailable")}</Text>;
  const Component = screen.Component;
  return (
    <PluginInstallationProvider plugin={plugin}>
      <View>
        <SettingsTabs plugin={plugin} screenId={screen.id} />
        <SurfaceErrorBoundary
          installation={plugin}
          Surface={Component}
          resetKey={attempt}
          renderError={renderError}
        >
          <Component theme={theme} layout={layout} host={host} />
        </SurfaceErrorBoundary>
      </View>
    </PluginInstallationProvider>
  );
}
const ThemedSettingsContent = withUnistyles(SettingsContent);
// Settings routes carry no screen params.
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

/** One of the plugin's settings screens, with tabs to the others. Renders inside its plugin page. */
export function PluginSettingsContent(identity: SettingsIdentity) {
  return <ThemedSettingsContent {...identity} uniProps={themeMapping} />;
}
const styles = StyleSheet.create((theme) => ({
  message: { color: theme.colors.foregroundMuted },
  tabs: { flexGrow: 0, marginBottom: theme.spacing[4] },
}));
