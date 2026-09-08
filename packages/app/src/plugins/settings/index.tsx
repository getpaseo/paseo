import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { router } from "expo-router";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { SettingsAction } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { useInstalledPlugin } from "../registry";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import { toPluginTheme } from "../theme";
import { buildPluginSettingsRoute } from "./routes";

interface SettingsIdentity {
  serverId: string;
  pluginId: string;
  screenId: string;
}

function SettingsLink({
  serverId,
  pluginId,
  screenId,
  title,
}: SettingsIdentity & { title: string }) {
  const { t } = useTranslation();
  const open = useCallback(
    () => router.push(buildPluginSettingsRoute(serverId, pluginId, screenId)),
    [serverId, pluginId, screenId],
  );
  return (
    <SettingsAction label={title} actionLabel={t("settings.plugins.screens.open")} onPress={open} />
  );
}

export function PluginSettingsLinks({ serverId, pluginId }: Omit<SettingsIdentity, "screenId">) {
  const plugin = useInstalledPlugin(serverId, pluginId);
  const supported = useHostFeature(serverId, "pluginSettings");
  if (!supported || !plugin) return null;
  return (
    <>
      {plugin.settingsScreens.map((screen) => (
        <SettingsLink
          key={screen.id}
          serverId={serverId}
          pluginId={pluginId}
          screenId={screen.id}
          title={screen.title}
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
  const platform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";
  const layout = useMemo<PluginHostProps["layout"]>(
    () => ({ compact, platform }),
    [compact, platform],
  );
  if (!connected)
    return <Text style={styles.message}>{t("settings.plugins.screens.offline")}</Text>;
  // COMPAT(pluginSettings): added in v0.8, remove after 2027-03-05.
  if (!supported) return <Text style={styles.message}>{t("settings.plugins.screens.update")}</Text>;
  const runtime = createPluginSurfaceRuntime(client, pluginId);
  if (!plugin || !screen || !runtime)
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
        <PluginRuntimeBoundary plugin={plugin} runtime={runtime}>
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
