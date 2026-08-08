import { router, useLocalSearchParams } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react-native";
import {
  Component,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
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
import { resolvePluginIcon } from "./icons";
import { useInstalledPlugin, usePluginInstallations } from "./registry";
import { buildPluginSurfaceRoute } from "./routes";
import { rememberPluginContributionHost } from "./sidebar-groups";
import { PluginRpcProvider } from "./sdk";
import type { PluginSurfaceProps } from "./types";

const EMPTY_SHORTCUT_KEYS: ShortcutKey[] = [];
const EMPTY_THEME_DTO: Record<string, unknown> = {};
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const pluginThemeMapping = (theme: Theme) => ({
  themeDto: JSON.parse(JSON.stringify(theme)) as Record<string, unknown>,
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
  invoke,
  plugin,
  layout,
  host,
  themeDto = EMPTY_THEME_DTO,
}: {
  Surface: ComponentType<PluginSurfaceProps>;
  invoke(method: string, input: unknown): Promise<unknown>;
  plugin: NonNullable<ReturnType<typeof useInstalledPlugin>>;
  layout: PluginSurfaceProps["layout"];
  host: PluginSurfaceProps["host"];
  themeDto?: Record<string, unknown>;
}) {
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <PluginRpcProvider invoke={invoke}>
        <Surface theme={themeDto} host={host} layout={layout} />
      </PluginRpcProvider>
    </QueryClientProvider>
  );
}

const ThemedSurfaceRenderer = withUnistyles(SurfaceRenderer);

interface SurfaceErrorBoundaryState {
  error: string | null;
}

class SurfaceErrorBoundary extends Component<{ children: ReactNode }, SurfaceErrorBoundaryState> {
  state: SurfaceErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): SurfaceErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[Plugins] Surface render failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <Text style={styles.errorText}>Plugin failed: {this.state.error}</Text>;
    }
    return this.props.children;
  }
}

function resolvePlatform(): PluginSurfaceProps["layout"]["platform"] {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

function PluginHostSwitcher({
  serverId,
  pluginId,
  contributionId,
  serverIds,
}: {
  serverId: string;
  pluginId: string;
  contributionId: string;
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
      rememberPluginContributionHost(`${pluginId}/${contributionId}`, nextServerId);
      router.replace(buildPluginSurfaceRoute(nextServerId, pluginId, contributionId));
    },
    [contributionId, pluginId],
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
    surfaceId?: string | string[];
  }>();
  const serverId = routeParam(params.serverId);
  const pluginId = routeParam(params.pluginId);
  const contributionId = routeParam(params.surfaceId);
  const plugin = useInstalledPlugin(serverId, pluginId);
  const installations = usePluginInstallations(pluginId);
  const hosts = useHosts();
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const sidebarItem = plugin?.sidebarItems.find((entry) => entry.id === contributionId) ?? null;
  const surface = plugin?.surfaces.find((entry) => entry.id === sidebarItem?.surface) ?? null;
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const contributionServerIds = useMemo(
    () =>
      installations
        .filter((entry) => entry.sidebarItems.some((item) => item.id === contributionId))
        .map((entry) => entry.serverId),
    [contributionId, installations],
  );
  const title = sidebarItem?.title ?? (pluginId || "Plugin");
  const Icon = sidebarItem ? resolvePluginIcon(sidebarItem.icon) : null;
  const invoke = useCallback(
    async (method: string, input: unknown) => {
      if (!client) throw new Error("Plugin host is offline");
      return client.invokePluginRpc(pluginId, method, input);
    },
    [client, pluginId],
  );
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
        <PluginHostSwitcher
          serverId={serverId}
          pluginId={pluginId}
          contributionId={contributionId}
          serverIds={contributionServerIds}
        />
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
    [close, contributionId, contributionServerIds, pluginId, serverId],
  );

  return (
    <View style={styles.screen}>
      <ScreenHeader left={headerLeft} right={headerRight} />
      <View style={styles.body}>
        {plugin && surface ? (
          <SurfaceErrorBoundary key={`${serverId}/${pluginId}/${contributionId}`}>
            <ThemedSurfaceRenderer
              Surface={surface.Component}
              invoke={invoke}
              plugin={plugin}
              host={host}
              layout={layout}
              uniProps={pluginThemeMapping}
            />
          </SurfaceErrorBoundary>
        ) : (
          <Text style={styles.errorText}>This plugin surface is unavailable.</Text>
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
    fontSize: theme.fontSize.sm,
  },
}));
