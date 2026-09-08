import { router, useLocalSearchParams } from "expo-router";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { ChevronDown, X } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState, type ComponentType } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderIconBadge } from "@/components/headers/header-icon-badge";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { HostPicker } from "@/components/hosts/host-picker";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { usePluginHostNavigation } from "./host-navigation";
import { resolvePluginIcon } from "./icons";
import { toPluginTheme } from "./theme";
import { useInstalledPlugin, usePluginInstallations } from "./registry";
import { buildPluginSurfaceRoute } from "./routes";
import { rememberPluginContributionHost } from "./contribution-host";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { createPluginSurfaceRuntime } from "./surface-runtime";
import { PluginRuntimeBoundary } from "./runtime-boundary";
import {
  getPluginSurfaceContributionServerIds,
  resolvePluginSurfaceContribution,
  type PluginSurfaceContributionIdentity,
} from "./surface-contribution";

const EMPTY_SHORTCUT_KEYS: ShortcutKey[] = [];
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const pluginThemeMapping = (theme: Theme) => ({
  theme: toPluginTheme(theme),
});
const ThemedX = withUnistyles(X);
const ThemedChevronDown = withUnistyles(ChevronDown);

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function PluginHeaderIcon({
  Icon,
  color = "",
}: {
  Icon: ReturnType<typeof resolvePluginIcon>;
  color?: string;
}) {
  return <Icon size={16} color={color} />;
}

const ThemedPluginHeaderIcon = withUnistyles(PluginHeaderIcon);

function SurfaceRenderer({
  Surface,
  runtime,
  plugin,
  layout,
  host,
  theme,
}: {
  Surface: ComponentType<PluginSurfaceProps>;
  runtime: NonNullable<ReturnType<typeof createPluginSurfaceRuntime>>;
  plugin: NonNullable<ReturnType<typeof useInstalledPlugin>>;
  layout: PluginSurfaceProps["layout"];
  host: PluginSurfaceProps["host"];
  theme: PluginTheme;
}) {
  const navigation = usePluginHostNavigation(host.id);
  return (
    <PluginRuntimeBoundary plugin={plugin} runtime={runtime}>
      <Surface theme={theme} host={host} layout={layout} navigation={navigation} />
    </PluginRuntimeBoundary>
  );
}

const ThemedSurfaceRenderer = withUnistyles(SurfaceRenderer);

function resolvePlatform(): PluginSurfaceProps["layout"]["platform"] {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

function PluginHostSwitcher({
  serverId,
  pluginId,
  identity,
  serverIds,
}: {
  serverId: string;
  pluginId: string;
  identity: PluginSurfaceContributionIdentity;
  serverIds: string[];
}) {
  const allHosts = useHosts();
  const hosts = useMemo(
    () => allHosts.filter((host) => serverIds.includes(host.serverId)),
    [allHosts, serverIds],
  );
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View | null>(null);
  const selectedLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const selectHost = useCallback(
    (nextServerId: string) => {
      rememberPluginContributionHost(`${pluginId}/${identity.kind}/${identity.id}`, nextServerId);
      router.replace(buildPluginSurfaceRoute(nextServerId, pluginId, identity));
    },
    [identity, pluginId],
  );
  const openPicker = useCallback(() => setOpen(true), []);
  const show = serverIds.length > 1 && hosts.length > 1;
  if (!show) return null;

  return (
    <HostPicker
      hosts={hosts}
      value={serverId}
      onSelect={selectHost}
      open={open}
      onOpenChange={setOpen}
      anchorRef={anchorRef}
      title="Choose plugin host"
      desktopPlacement="bottom-start"
    >
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Plugin host: ${selectedLabel}`}
          testID="plugin-host-switcher"
          onPress={openPicker}
          style={styles.hostSwitcher}
        >
          <Text numberOfLines={1} style={styles.hostSwitcherText}>
            {selectedLabel}
          </Text>
          <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
        </Pressable>
      </View>
    </HostPicker>
  );
}

export function PluginSurfaceScreen() {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    pluginId?: string | string[];
    contributionKind?: string | string[];
    contributionId?: string | string[];
  }>();
  const serverId = routeParam(params.serverId);
  const pluginId = routeParam(params.pluginId);
  const contributionKind = routeParam(params.contributionKind);
  const contributionId = routeParam(params.contributionId);
  const identity = useMemo<PluginSurfaceContributionIdentity | null>(() => {
    if (contributionKind !== "sidebar" && contributionKind !== "surface") return null;
    return { kind: contributionKind, id: contributionId };
  }, [contributionId, contributionKind]);
  const plugin = useInstalledPlugin(serverId, pluginId);
  const installations = usePluginInstallations(pluginId);
  const hosts = useHosts();
  const client = useHostRuntimeClient(serverId);
  const runtime = useMemo(() => createPluginSurfaceRuntime(client, pluginId), [client, pluginId]);
  const compact = useIsCompactFormFactor();
  const { sidebarItem, surface } = useMemo(
    () => resolvePluginSurfaceContribution(plugin, identity),
    [identity, plugin],
  );
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const contributionServerIds = useMemo(
    () =>
      identity ? getPluginSurfaceContributionServerIds(installations, pluginId, identity) : [],
    [identity, installations, pluginId],
  );
  const title = sidebarItem?.title ?? surface?.id ?? (pluginId || "Plugin");
  const Icon = sidebarItem ? resolvePluginIcon(sidebarItem.icon) : null;
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(`/h/${encodeURIComponent(serverId)}`);
  }, [serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePlatform() }), [compact]);
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const headerLeft = useMemo(
    () => (
      <>
        {Icon ? (
          <HeaderIconBadge>
            <ThemedPluginHeaderIcon Icon={Icon} uniProps={mutedColorMapping} />
          </HeaderIconBadge>
        ) : null}
        <ScreenTitle>{title}</ScreenTitle>
      </>
    ),
    [Icon, title],
  );
  const headerRight = useMemo(
    () => (
      <>
        {identity ? (
          <PluginHostSwitcher
            serverId={serverId}
            pluginId={pluginId}
            identity={identity}
            serverIds={contributionServerIds}
          />
        ) : null}
        <HeaderToggleButton
          accessibilityLabel="Close plugin"
          onPress={close}
          testID="plugin-surface-close"
          tooltipKeys={EMPTY_SHORTCUT_KEYS}
          tooltipLabel="Close"
          tooltipSide="bottom"
        >
          <ThemedX size={18} uniProps={mutedColorMapping} />
        </HeaderToggleButton>
      </>
    ),
    [close, contributionServerIds, identity, pluginId, serverId],
  );

  return (
    <View style={styles.screen}>
      <ScreenHeader left={headerLeft} right={headerRight} />
      <View style={styles.body}>
        {plugin && surface && runtime ? (
          <SurfaceErrorBoundary
            key={`${serverId}/${pluginId}/${identity?.kind}/${contributionId}`}
            installation={plugin}
            Surface={surface.Component}
          >
            <ThemedSurfaceRenderer
              Surface={surface.Component}
              runtime={runtime}
              plugin={plugin}
              host={host}
              layout={layout}
              uniProps={pluginThemeMapping}
            />
          </SurfaceErrorBoundary>
        ) : (
          <Text style={styles.errorText}>
            {plugin && surface ? "Plugin host is offline." : "This plugin surface is unavailable."}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
  },
  errorText: {
    color: theme.colors.statusDanger,
    padding: theme.spacing[4],
  },
  hostSwitcher: {
    maxWidth: 180,
    minHeight: 32,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  hostSwitcherText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
