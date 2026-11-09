import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { router } from "expo-router";
import { ArrowLeft, Settings } from "lucide-react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Button } from "@/components/ui/button";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
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
import { buildPluginSettingsRoute } from "./routes";

interface SettingsIdentity {
  serverId: string;
  pluginId: string;
  screenId: string;
}

const ThemedSettingsIcon = withUnistyles(Settings);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Opens the plugin's settings at its first screen. Renders nothing when it has none. */
export function PluginSettingsButton({ serverId, pluginId }: Omit<SettingsIdentity, "screenId">) {
  const { t } = useTranslation();
  const plugin = useInstalledPlugin(serverId, pluginId);
  const supported = useHostFeature(serverId, "pluginSettings");
  const firstScreenId = plugin?.settingsScreens[0]?.id;
  const open = useCallback(() => {
    if (firstScreenId) router.push(buildPluginSettingsRoute(serverId, pluginId, firstScreenId));
  }, [serverId, pluginId, firstScreenId]);
  const compact = useIsCompactFormFactor();
  if (!supported || !firstScreenId) return null;
  return (
    <ToolbarButton
      label={t("settings.plugins.actions.settings")}
      compact={compact}
      onPress={open}
      testID={`plugin-settings-${pluginId}`}
    >
      <ThemedSettingsIcon size={paneContentToolbarIconSize(compact)} uniProps={mutedIconMapping} />
    </ToolbarButton>
  );
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
  const platform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";
  const layout = useMemo<PluginHostProps["layout"]>(
    () => ({ compact, platform }),
    [compact, platform],
  );
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
export function PluginSettingsContent({
  onBackToPlugins,
  showBackToPlugins,
  ...identity
}: SettingsIdentity & { onBackToPlugins: () => void; showBackToPlugins: boolean }) {
  const { t } = useTranslation();
  return (
    <View>
      {showBackToPlugins ? (
        <Button
          onPress={onBackToPlugins}
          variant="ghost"
          leftIcon={ArrowLeft}
          style={styles.backButton}
        >
          {t("settings.plugins.screens.backToPlugins")}
        </Button>
      ) : null}
      <ThemedSettingsContent {...identity} uniProps={themeMapping} />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  message: { color: theme.colors.foregroundMuted },
  tabs: { flexGrow: 0, marginBottom: theme.spacing[4] },
  backButton: { alignSelf: "flex-start", paddingHorizontal: 0, marginBottom: theme.spacing[4] },
}));
