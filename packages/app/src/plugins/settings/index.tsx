import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { router } from "expo-router";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { useInstalledPlugin } from "../registry";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { buildPluginSettingsRoute } from "./routes";
import { usePluginLayout } from "../layout";

interface SettingsIdentity {
  serverId: string;
  pluginId: string;
  screenId: string;
}

function PluginSettingsMenuItem({
  serverId,
  pluginId,
  screenId,
  title,
  disabled,
}: SettingsIdentity & { title: string; disabled?: boolean }) {
  const open = useCallback(
    () => router.push(buildPluginSettingsRoute(serverId, pluginId, screenId)),
    [serverId, pluginId, screenId],
  );
  return (
    <DropdownMenuItem onSelect={open} disabled={disabled}>
      {title}
    </DropdownMenuItem>
  );
}

export function PluginSettingsMenuItems({
  serverId,
  pluginId,
  disabled,
}: Omit<SettingsIdentity, "screenId"> & { disabled?: boolean }) {
  const plugin = useInstalledPlugin(serverId, pluginId);
  const supported = useHostFeature(serverId, "pluginSettings");
  if (!supported || !plugin) return null;
  return (
    <>
      {plugin.settingsScreens.map((screen) => (
        <PluginSettingsMenuItem
          key={screen.id}
          serverId={serverId}
          pluginId={pluginId}
          screenId={screen.id}
          title={screen.title}
          disabled={disabled}
        />
      ))}
    </>
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
        <Button variant="outline" size="sm" onPress={retry}>
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
    <View>
      <SurfaceErrorBoundary
        installation={plugin}
        Surface={Component}
        resetKey={attempt}
        renderError={renderError}
      >
        <PluginRuntimeBoundary plugin={plugin} client={client}>
          <Component theme={theme} layout={layout} host={host} />
        </PluginRuntimeBoundary>
      </SurfaceErrorBoundary>
    </View>
  );
}
const ThemedSettingsContent = withUnistyles(SettingsContent);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
export function PluginSettingsContent(props: SettingsIdentity) {
  return <ThemedSettingsContent {...props} uniProps={themeMapping} />;
}
const styles = StyleSheet.create((theme) => ({ message: { color: theme.colors.foregroundMuted } }));
