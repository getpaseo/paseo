import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { ComponentType, ReactNode } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Buffer } from "buffer";
import {
  ArrowLeft,
  Sun,
  Moon,
  Monitor,
  Blocks,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Settings,
  Server,
  Keyboard,
  Stethoscope,
  Info,
  Shield,
  Puzzle,
  Plus,
} from "lucide-react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { ScreenTitle } from "@/components/headers/screen-title";
import { HeaderIconBadge } from "@/components/headers/header-icon-badge";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useAppSettings, type AppSettings, type SendBehavior } from "@/hooks/use-settings";
import { THEME_SWATCHES } from "@/styles/theme";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import { confirmDialog } from "@/utils/confirm-dialog";
import { BackHeader } from "@/components/headers/back-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { AddHostMethodModal } from "@/components/add-host-method-modal";
import { AddHostModal } from "@/components/add-host-modal";
import { PairLinkModal } from "@/components/pair-link-modal";
import { KeyboardShortcutsSection } from "@/screens/settings/keyboard-shortcuts-section";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DesktopPermissionsSection } from "@/desktop/components/desktop-permissions-section";
import { IntegrationsSection } from "@/desktop/components/integrations-section";
import { isElectronRuntime } from "@/desktop/host";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { settingsStyles } from "@/styles/settings";
import { THINKING_TONE_NATIVE_PCM_BASE64 } from "@/utils/thinking-tone.native-pcm";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { HostPage, HostRenameButton } from "@/screens/settings/host-page";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  buildHostOpenProjectRoute,
  buildHostWorkspaceRoute,
  buildSettingsHostRoute,
  buildSettingsSectionRoute,
  type SettingsSectionSlug,
} from "@/utils/host-routes";
import { getLastNavigationWorkspaceRouteSelection } from "@/stores/navigation-active-workspace-store";
import { getProviderIcon } from "@/components/provider-icons";
import { ProviderDiagnosticSheet } from "@/components/provider-diagnostic-sheet";
import { SpinningRefreshIcon } from "@/components/spinning-refresh-icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import {
  resolveHelperProviderPreferences,
  type HelperProviderPreference,
} from "@/utils/helper-provider-preferences";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type SettingsView =
  | { kind: "root" }
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "host"; serverId: string };

interface SidebarSectionItem {
  id: SettingsSectionSlug;
  label: string;
  icon: ComponentType<{ size: number; color: string }>;
  desktopOnly?: boolean;
}

const SIDEBAR_SECTION_ITEMS: SidebarSectionItem[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard, desktopOnly: true },
  { id: "integrations", label: "Integrations", icon: Puzzle, desktopOnly: true },
  { id: "providers", label: "Providers", icon: Blocks, desktopOnly: true },
  { id: "permissions", label: "Permissions", icon: Shield, desktopOnly: true },
  { id: "diagnostics", label: "Diagnostics", icon: Stethoscope },
  { id: "about", label: "About", icon: Info },
];

// ---------------------------------------------------------------------------
// Theme helpers (General section)
// ---------------------------------------------------------------------------

function ThemeIcon({
  theme,
  size,
  color,
}: {
  theme: AppSettings["theme"];
  size: number;
  color: string;
}) {
  switch (theme) {
    case "light":
      return <Sun size={size} color={color} />;
    case "dark":
      return <Moon size={size} color={color} />;
    case "auto":
      return <Monitor size={size} color={color} />;
    default:
      return <ThemeSwatch color={THEME_SWATCHES[theme]} size={size} />;
  }
}

function ThemeSwatch({ color, size }: { color: string; size: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.15)",
      }}
    />
  );
}

const THEME_LABELS: Record<AppSettings["theme"], string> = {
  light: "Light",
  dark: "Dark",
  zinc: "Zinc",
  midnight: "Midnight",
  claude: "Claude",
  ghostty: "Ghostty",
  auto: "System",
};

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

interface GeneralSectionProps {
  settings: AppSettings;
  handleThemeChange: (theme: AppSettings["theme"]) => void;
  handleSendBehaviorChange: (behavior: SendBehavior) => void;
}

function GeneralSection({
  settings,
  handleThemeChange,
  handleSendBehaviorChange,
}: GeneralSectionProps) {
  const { theme } = useUnistyles();
  const iconSize = theme.iconSize.md;
  const iconColor = theme.colors.foregroundMuted;

  return (
    <SettingsSection title="General">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Theme</Text>
          </View>
          <DropdownMenu>
            <DropdownMenuTrigger
              style={({ pressed }) => [styles.themeTrigger, pressed && { opacity: 0.85 }]}
            >
              <ThemeIcon theme={settings.theme} size={iconSize} color={iconColor} />
              <Text style={styles.themeTriggerText}>{THEME_LABELS[settings.theme]}</Text>
              <ChevronDown size={theme.iconSize.sm} color={iconColor} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" width={200}>
              {(["light", "dark", "auto"] as const).map((t) => (
                <DropdownMenuItem
                  key={t}
                  selected={settings.theme === t}
                  onSelect={() => handleThemeChange(t)}
                  leading={<ThemeIcon theme={t} size={iconSize} color={iconColor} />}
                >
                  {THEME_LABELS[t]}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {(["zinc", "midnight", "claude", "ghostty"] as const).map((t) => (
                <DropdownMenuItem
                  key={t}
                  selected={settings.theme === t}
                  onSelect={() => handleThemeChange(t)}
                  leading={<ThemeIcon theme={t} size={iconSize} color={iconColor} />}
                >
                  {THEME_LABELS[t]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Default send</Text>
            <Text style={settingsStyles.rowHint}>
              What happens when you press Enter while the agent is running
            </Text>
          </View>
          <SegmentedControl
            size="sm"
            value={settings.sendBehavior}
            onValueChange={handleSendBehaviorChange}
            options={[
              { value: "interrupt", label: "Interrupt" },
              { value: "queue", label: "Queue" },
            ]}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

interface ProvidersSectionProps {
  routeServerId: string;
}

function ProvidersSection({ routeServerId }: ProvidersSectionProps) {
  const { theme } = useUnistyles();
  const isConnected = useHostRuntimeIsConnected(routeServerId);
  const { settings, updateSettings } = useAppSettings();
  const { entries, isLoading, isRefreshing, refresh } = useProvidersSnapshot(routeServerId);
  const [diagnosticProvider, setDiagnosticProvider] = useState<string | null>(null);
  const providerDefinitions = buildProviderDefinitions(entries);
  const readyEntries = useMemo(
    () => (entries ?? []).filter((entry) => entry.status === "ready"),
    [entries],
  );
  const helperProviders = useMemo(
    () =>
      resolveHelperProviderPreferences({
        entries,
        savedPreferences: settings.helperProviders,
      }),
    [entries, settings.helperProviders],
  );
  const providerRefreshInFlight =
    isRefreshing || (entries?.some((entry) => entry.status === "loading") ?? false);
  const hasServer = routeServerId.trim().length > 0;

  const updateHelperProviders = useCallback(
    async (next: typeof helperProviders) => {
      await updateSettings({ helperProviders: next });
    },
    [helperProviders, updateSettings],
  );

  const moveHelperProvider = useCallback(
    (index: number, direction: -1 | 1) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= helperProviders.length) {
        return;
      }

      const next = [...helperProviders];
      const [moved] = next.splice(index, 1);
      if (!moved) {
        return;
      }
      next.splice(targetIndex, 0, moved);
      void updateHelperProviders(next);
    },
    [helperProviders, updateHelperProviders],
  );

  const setHelperProviderModel = useCallback(
    (provider: string, model: string | null) => {
      const next = helperProviders.map((entry) =>
        entry.provider === provider ? { ...entry, model } : entry,
      );
      void updateHelperProviders(next);
    },
    [helperProviders, updateHelperProviders],
  );

  const renderHelperProvider = useCallback(
    ({
      item: helper,
      index,
      drag,
      dragHandleProps,
    }: DraggableRenderItemInfo<HelperProviderPreference>) => {
      const entry = readyEntries.find((candidate) => candidate.provider === helper.provider);
      const ProviderIcon = getProviderIcon(helper.provider);
      const selectedModel =
        entry?.models?.find((candidate) => candidate.id === helper.model) ?? null;
      const helperModelLabel = selectedModel?.label ?? "Default helper model";

      return (
        <View style={[styles.audioRow, index > 0 ? styles.audioRowBorder : null]}>
          <View style={styles.audioRowContent}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing[2] }}>
              <Pressable
                {...(dragHandleProps?.attributes as object)}
                {...(dragHandleProps?.listeners as object)}
                ref={dragHandleProps?.setActivatorNodeRef as never}
                onLongPress={drag}
                delayLongPress={150}
                style={({ pressed }) => [
                  styles.helperDragHandle,
                  pressed ? styles.helperMoveButtonPressed : null,
                ]}
              >
                <Text style={styles.helperDragHandleText}>⋮⋮</Text>
              </Pressable>
              <ProviderIcon size={theme.iconSize.sm} color={theme.colors.foreground} />
              <Text style={styles.audioRowTitle}>{entry?.label ?? helper.provider}</Text>
            </View>
            <Text style={styles.audioRowSubtitle}>Model: {helperModelLabel}</Text>
          </View>

          <View style={styles.helperControls}>
            <DropdownMenu>
              <DropdownMenuTrigger
                style={({ pressed }) => [
                  styles.helperModelTrigger,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={styles.helperModelTriggerText}>{helperModelLabel}</Text>
                <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end" width={260}>
                <DropdownMenuItem
                  selected={!helper.model}
                  onSelect={() => setHelperProviderModel(helper.provider, null)}
                >
                  Default helper model
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {(entry?.models ?? []).map((model) => (
                  <DropdownMenuItem
                    key={model.id}
                    selected={helper.model === model.id}
                    onSelect={() => setHelperProviderModel(helper.provider, model.id)}
                  >
                    {model.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <View style={styles.helperMoveButtons}>
              <Pressable
                disabled={index === 0}
                onPress={() => moveHelperProvider(index, -1)}
                style={({ pressed }) => [
                  styles.helperMoveButton,
                  index === 0 ? styles.helperMoveButtonDisabled : null,
                  pressed && index !== 0 ? styles.helperMoveButtonPressed : null,
                ]}
              >
                <ArrowUp size={theme.iconSize.sm} color={theme.colors.foreground} />
              </Pressable>
              <Pressable
                disabled={index === helperProviders.length - 1}
                onPress={() => moveHelperProvider(index, 1)}
                style={({ pressed }) => [
                  styles.helperMoveButton,
                  index === helperProviders.length - 1 ? styles.helperMoveButtonDisabled : null,
                  pressed && index !== helperProviders.length - 1
                    ? styles.helperMoveButtonPressed
                    : null,
                ]}
              >
                <ArrowDown size={theme.iconSize.sm} color={theme.colors.foreground} />
              </Pressable>
            </View>
          </View>
        </View>
      );
    },
    [helperProviders.length, moveHelperProvider, readyEntries, setHelperProviderModel, theme],
  );

  return (
    <>
      <SettingsSection title="Providers">
        {!hasServer || !isConnected ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>Connect to a host to see providers</Text>
          </View>
        ) : isLoading ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>Loading providers...</Text>
          </View>
        ) : (
          <>
            <View style={[settingsStyles.card, styles.audioCard]}>
              <View style={styles.providerCardHeader}>
                <View style={styles.audioRowContent}>
                  <Text style={styles.audioRowTitle}>Available providers</Text>
                  <Text style={styles.audioRowSubtitle}>
                    Inspect installed providers and the models they currently expose.
                  </Text>
                </View>
                <Pressable
                  onPress={() => {
                    void refresh();
                  }}
                  disabled={providerRefreshInFlight}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Refresh providers"
                  style={({ hovered, pressed }) => [
                    styles.providerRefreshButton,
                    (hovered || pressed) && styles.providerRefreshButtonHovered,
                    providerRefreshInFlight ? styles.providerRefreshButtonDisabled : null,
                  ]}
                >
                  <SpinningRefreshIcon
                    spinning={providerRefreshInFlight}
                    size={theme.iconSize.sm}
                    color={theme.colors.foregroundMuted}
                  />
                </Pressable>
              </View>
              {providerDefinitions.map((def, index) => {
                const entry = entries?.find((candidate) => candidate.provider === def.id);
                const status = entry?.status ?? "unavailable";
                const ProviderIcon = getProviderIcon(def.id);
                const providerError =
                  status === "error" &&
                  typeof entry?.error === "string" &&
                  entry.error.trim().length > 0
                    ? entry.error.trim()
                    : null;
                const modelCount = entry?.models?.length ?? 0;

                return (
                  <Pressable
                    key={def.id}
                    style={[styles.audioRow, index > 0 ? styles.audioRowBorder : null]}
                    onPress={() => setDiagnosticProvider(def.id)}
                    accessibilityRole="button"
                  >
                    <View style={styles.audioRowContent}>
                      <View
                        style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing[2] }}
                      >
                        <ProviderIcon size={theme.iconSize.sm} color={theme.colors.foreground} />
                        <Text style={styles.audioRowTitle}>{def.label}</Text>
                      </View>
                      {providerError ? (
                        <Text style={styles.aboutErrorText} numberOfLines={3}>
                          {providerError}
                        </Text>
                      ) : status === "ready" && modelCount > 0 ? (
                        <Text style={styles.audioRowSubtitle}>
                          {modelCount === 1 ? "1 model" : `${modelCount} models`}
                        </Text>
                      ) : null}
                    </View>
                    <StatusBadge
                      label={
                        status === "ready"
                          ? "Available"
                          : status === "error"
                            ? "Error"
                            : status === "loading"
                              ? "Loading..."
                              : "Not installed"
                      }
                      variant={
                        status === "ready" ? "success" : status === "error" ? "error" : "muted"
                      }
                    />
                  </Pressable>
                );
              })}
            </View>

            <View style={[settingsStyles.card, styles.audioCard, styles.helperCard]}>
              <View style={styles.helperSectionHeader}>
                <Text style={styles.audioRowTitle}>Helper provider order</Text>
                <Text style={styles.audioRowSubtitle}>
                  Structured helper providers for commit messages and PR text. Only ready
                  providers appear here.
                </Text>
              </View>

              {helperProviders.length === 0 ? (
                <View style={[styles.audioRow, styles.audioRowBorder]}>
                  <View style={styles.audioRowContent}>
                    <Text style={styles.audioRowTitle}>No helper providers available</Text>
                    <Text style={styles.audioRowSubtitle}>
                      Install or enable a provider above to configure helper order and models.
                    </Text>
                  </View>
                </View>
              ) : (
                <DraggableList
                  data={helperProviders}
                  keyExtractor={(item) => item.provider}
                  renderItem={renderHelperProvider}
                  onDragEnd={(next) => {
                    void updateHelperProviders(next);
                  }}
                  scrollEnabled={false}
                  useDragHandle
                  containerStyle={styles.helperListContainer}
                />
              )}
            </View>
          </>
        )}
      </SettingsSection>

      {diagnosticProvider ? (
        <ProviderDiagnosticSheet
          provider={diagnosticProvider}
          visible
          onClose={() => setDiagnosticProvider(null)}
          serverId={routeServerId}
        />
      ) : null}
    </>
  );
}

interface DiagnosticsSectionProps {
  voiceAudioEngine: ReturnType<typeof useVoiceAudioEngineOptional>;
  isPlaybackTestRunning: boolean;
  playbackTestResult: string | null;
  handlePlaybackTest: () => Promise<void>;
}

function DiagnosticsSection({
  voiceAudioEngine,
  isPlaybackTestRunning,
  playbackTestResult,
  handlePlaybackTest,
}: DiagnosticsSectionProps) {
  return (
    <SettingsSection title="Diagnostics">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Test audio</Text>
            {playbackTestResult ? (
              <Text style={settingsStyles.rowHint}>{playbackTestResult}</Text>
            ) : null}
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => void handlePlaybackTest()}
            disabled={!voiceAudioEngine || isPlaybackTestRunning}
          >
            {isPlaybackTestRunning ? "Playing..." : "Play test"}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

interface AboutSectionProps {
  appVersionText: string;
  isDesktopApp: boolean;
}

function AboutSection({ appVersionText, isDesktopApp }: AboutSectionProps) {
  return (
    <SettingsSection title="About">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Version</Text>
          </View>
          <Text style={styles.aboutValue}>{appVersionText}</Text>
        </View>
        {isDesktopApp ? <DesktopAppUpdateRow /> : null}
      </View>
    </SettingsSection>
  );
}

function DesktopAppUpdateRow() {
  const { settings, updateSettings } = useAppSettings();
  const {
    isDesktopApp,
    statusText,
    availableUpdate,
    errorMessage,
    isChecking,
    isInstalling,
    checkForUpdates,
    installUpdate,
  } = useDesktopAppUpdater();

  useFocusEffect(
    useCallback(() => {
      if (!isDesktopApp) {
        return undefined;
      }
      void checkForUpdates({ silent: true });
      return undefined;
    }, [checkForUpdates, isDesktopApp]),
  );

  const handleCheckForUpdates = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }
    void checkForUpdates();
  }, [checkForUpdates, isDesktopApp]);

  const handleReleaseChannelChange = useCallback(
    (releaseChannel: AppSettings["releaseChannel"]) => {
      void updateSettings({ releaseChannel });
    },
    [updateSettings],
  );

  const handleInstallUpdate = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }

    void confirmDialog({
      title: "Install desktop update",
      message: "This updates Paseo on this computer",
      confirmLabel: "Install update",
      cancelLabel: "Cancel",
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        void installUpdate();
      })
      .catch((error) => {
        console.error("[Settings] Failed to open app update confirmation", error);
        Alert.alert("Error", "Unable to open the update confirmation dialog.");
      });
  }, [installUpdate, isDesktopApp]);

  if (!isDesktopApp) {
    return null;
  }

  return (
    <>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Release channel</Text>
          <Text style={settingsStyles.rowHint}>
            Switch to Beta to get updates sooner and help shape them
          </Text>
        </View>
        <SegmentedControl
          size="sm"
          value={settings.releaseChannel}
          onValueChange={handleReleaseChannelChange}
          options={[
            { value: "stable", label: "Stable" },
            { value: "beta", label: "Beta" },
          ]}
        />
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>App updates</Text>
          <Text style={settingsStyles.rowHint}>{statusText}</Text>
          {availableUpdate?.latestVersion ? (
            <Text style={settingsStyles.rowHint}>
              Ready to install: {formatVersionWithPrefix(availableUpdate.latestVersion)}
            </Text>
          ) : null}
          {errorMessage ? <Text style={styles.aboutErrorText}>{errorMessage}</Text> : null}
        </View>
        <View style={styles.aboutUpdateActions}>
          <Button
            variant="outline"
            size="sm"
            onPress={handleCheckForUpdates}
            disabled={isChecking || isInstalling}
          >
            {isChecking ? "Checking..." : "Check"}
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={handleInstallUpdate}
            disabled={isChecking || isInstalling || !availableUpdate}
          >
            {isInstalling
              ? "Installing..."
              : availableUpdate?.latestVersion
                ? `Update to ${formatVersionWithPrefix(availableUpdate.latestVersion)}`
                : "Update"}
          </Button>
        </View>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function useAnyOnlineHostServerId(serverIds: string[]): string | null {
  const runtime = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
    () => null,
  );
}

interface SettingsSidebarProps {
  view: SettingsView;
  onSelectSection: (section: SettingsSectionSlug) => void;
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  onBackToWorkspace: () => void;
  layout: "desktop" | "mobile";
}

function SettingsSidebar({
  view,
  onSelectSection,
  onSelectHost,
  onAddHost,
  onBackToWorkspace,
  layout,
}: SettingsSidebarProps) {
  const { theme } = useUnistyles();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useMemo(() => {
    if (!localServerId) {
      return hosts;
    }
    const localIndex = hosts.findIndex((host) => host.serverId === localServerId);
    if (localIndex <= 0) {
      return hosts;
    }
    const next = hosts.slice();
    const [local] = next.splice(localIndex, 1);
    next.unshift(local);
    return next;
  }, [hosts, localServerId]);
  const isDesktopApp = isElectronRuntime();
  const items = SIDEBAR_SECTION_ITEMS.filter((item) => !item.desktopOnly || isDesktopApp);
  const padding = useWindowControlsPadding("sidebar");
  const isDesktop = layout === "desktop";
  const containerStyle = isDesktop ? sidebarStyles.desktopContainer : sidebarStyles.mobileContainer;
  const selectedSectionId = view.kind === "section" ? view.section : null;
  const selectedServerId = view.kind === "host" ? view.serverId : null;

  return (
    <View style={containerStyle} testID="settings-sidebar">
      {isDesktop ? (
        <>
          <TitlebarDragRegion />
          {padding.top > 0 ? <View style={{ height: padding.top }} /> : null}
        </>
      ) : null}
      {isDesktop ? (
        <SidebarHeaderRow
          icon={ArrowLeft}
          label="Back"
          onPress={onBackToWorkspace}
          testID="settings-back-to-workspace"
        />
      ) : null}
      <View style={sidebarStyles.list}>
        {items.map((item) => {
          const isSelected = selectedSectionId === item.id;
          const IconComponent = item.icon;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              onPress={() => onSelectSection(item.id)}
              style={({ hovered = false }) => [
                sidebarStyles.item,
                hovered && sidebarStyles.itemHovered,
                isSelected && sidebarStyles.itemSelected,
              ]}
            >
              <IconComponent
                size={theme.iconSize.md}
                color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
              <Text
                style={[sidebarStyles.label, isSelected && { color: theme.colors.foreground }]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <SidebarSeparator />
      <View style={sidebarStyles.list}>
        {sortedHosts.map((host) => {
          const isSelected = selectedServerId === host.serverId;
          const isLocal = localServerId !== null && host.serverId === localServerId;
          return (
            <Pressable
              key={host.serverId}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              onPress={() => onSelectHost(host.serverId)}
              testID={`settings-host-entry-${host.serverId}`}
              style={({ hovered = false }) => [
                sidebarStyles.item,
                hovered && sidebarStyles.itemHovered,
                isSelected && sidebarStyles.itemSelected,
              ]}
            >
              <Server
                size={theme.iconSize.md}
                color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
              <Text
                style={[sidebarStyles.label, isSelected && { color: theme.colors.foreground }]}
                numberOfLines={1}
              >
                {host.label}
              </Text>
              {isLocal ? (
                <Text style={sidebarStyles.localMarker} testID="settings-host-local-marker">
                  Local
                </Text>
              ) : null}
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add host"
          onPress={onAddHost}
          testID="settings-add-host"
          style={({ hovered = false }) => [
            sidebarStyles.item,
            hovered && sidebarStyles.itemHovered,
          ]}
        >
          <Plus size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={sidebarStyles.label} numberOfLines={1}>
            Add host
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export interface SettingsScreenProps {
  view: SettingsView;
}

export default function SettingsScreen({ view }: SettingsScreenProps) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const { settings, isLoading: settingsLoading, updateSettings } = useAppSettings();
  const [isAddHostMethodVisible, setIsAddHostMethodVisible] = useState(false);
  const [isDirectHostVisible, setIsDirectHostVisible] = useState(false);
  const [isPasteLinkVisible, setIsPasteLinkVisible] = useState(false);
  const [isPlaybackTestRunning, setIsPlaybackTestRunning] = useState(false);
  const [playbackTestResult, setPlaybackTestResult] = useState<string | null>(null);
  const isDesktopApp = isElectronRuntime();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const isCompactLayout = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const hosts = useHosts();
  const localDaemonServerId = useLocalDaemonServerId();
  const hostServerIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const anyOnlineServerId = useAnyOnlineHostServerId(hostServerIds);
  const providerServerId = useMemo(
    () => localDaemonServerId ?? anyOnlineServerId ?? "",
    [anyOnlineServerId, localDaemonServerId],
  );

  const handleThemeChange = useCallback(
    (nextTheme: AppSettings["theme"]) => {
      void updateSettings({ theme: nextTheme });
    },
    [updateSettings],
  );

  const handleSendBehaviorChange = useCallback(
    (behavior: SendBehavior) => {
      void updateSettings({ sendBehavior: behavior });
    },
    [updateSettings],
  );

  const handlePlaybackTest = useCallback(async () => {
    if (!voiceAudioEngine || isPlaybackTestRunning) {
      return;
    }

    setIsPlaybackTestRunning(true);
    setPlaybackTestResult(null);

    try {
      const bytes = Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64");
      await voiceAudioEngine.initialize();
      voiceAudioEngine.stop();
      await voiceAudioEngine.play({
        type: "audio/pcm;rate=16000;bits=16",
        size: bytes.byteLength,
        async arrayBuffer() {
          return Uint8Array.from(bytes).buffer;
        },
      });
      setPlaybackTestResult(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Settings] Playback test failed", error);
      setPlaybackTestResult(`Playback failed: ${message}`);
    } finally {
      setIsPlaybackTestRunning(false);
    }
  }, [isPlaybackTestRunning, voiceAudioEngine]);

  const closeAddConnectionFlow = useCallback(() => {
    setIsAddHostMethodVisible(false);
    setIsDirectHostVisible(false);
    setIsPasteLinkVisible(false);
  }, []);

  const goBackToAddConnectionMethods = useCallback(() => {
    setIsDirectHostVisible(false);
    setIsPasteLinkVisible(false);
    setIsAddHostMethodVisible(true);
  }, []);

  const handleAddHost = useCallback(() => {
    setIsAddHostMethodVisible(true);
  }, []);

  const handleHostAdded = useCallback(
    ({ serverId }: { serverId: string }) => {
      const target = buildSettingsHostRoute(serverId);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const handleSelectSection = useCallback(
    (section: SettingsSectionSlug) => {
      const target = buildSettingsSectionRoute(section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const handleSelectHost = useCallback(
    (serverId: string) => {
      const target = buildSettingsHostRoute(serverId);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  const handleScanQr = useCallback(() => {
    closeAddConnectionFlow();
    router.push({
      pathname: "/pair-scan",
      params: { source: "settings" },
    });
  }, [closeAddConnectionFlow, router]);

  const handleHostRemoved = useCallback(() => {
    const fallback = buildSettingsSectionRoute("general");
    if (isCompactLayout) {
      router.replace("/settings");
    } else {
      router.replace(fallback);
    }
  }, [isCompactLayout, router]);

  const handleBackToRoot = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/settings");
    }
  }, [router]);

  const handleBackToWorkspace = useCallback(() => {
    if (!isCompactLayout) {
      const lastWorkspaceRoute = getLastNavigationWorkspaceRouteSelection();
      if (lastWorkspaceRoute) {
        router.replace(
          buildHostWorkspaceRoute(lastWorkspaceRoute.serverId, lastWorkspaceRoute.workspaceId),
        );
        return;
      }
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (anyOnlineServerId) {
      router.replace(buildHostOpenProjectRoute(anyOnlineServerId));
      return;
    }
    router.replace("/");
  }, [anyOnlineServerId, isCompactLayout, router]);

  const detailHeader = ((): {
    title: string;
    Icon: ComponentType<{ size: number; color: string }>;
    titleAccessory?: ReactNode;
  } | null => {
    if (view.kind === "host") {
      const host = hosts.find((h) => h.serverId === view.serverId);
      if (!host) return null;
      return {
        title: host.label,
        Icon: Server,
        titleAccessory: <HostRenameButton host={host} />,
      };
    }
    if (view.kind === "section") {
      const item = SIDEBAR_SECTION_ITEMS.find((s) => s.id === view.section);
      if (!item) return null;
      return { title: item.label, Icon: item.icon };
    }
    return null;
  })();

  const content = (() => {
    if (view.kind === "host") {
      return <HostPage serverId={view.serverId} onHostRemoved={handleHostRemoved} />;
    }
    if (view.kind === "section") {
      switch (view.section) {
        case "general":
          return (
            <GeneralSection
              settings={settings}
              handleThemeChange={handleThemeChange}
              handleSendBehaviorChange={handleSendBehaviorChange}
            />
          );
        case "shortcuts":
          return isDesktopApp ? <KeyboardShortcutsSection /> : null;
        case "integrations":
          return isDesktopApp ? <IntegrationsSection /> : null;
        case "providers":
          return isDesktopApp ? <ProvidersSection routeServerId={providerServerId} /> : null;
        case "permissions":
          return isDesktopApp ? <DesktopPermissionsSection /> : null;
        case "diagnostics":
          return (
            <DiagnosticsSection
              voiceAudioEngine={voiceAudioEngine}
              isPlaybackTestRunning={isPlaybackTestRunning}
              playbackTestResult={playbackTestResult}
              handlePlaybackTest={handlePlaybackTest}
            />
          );
        case "about":
          return <AboutSection appVersionText={appVersionText} isDesktopApp={isDesktopApp} />;
      }
    }
    return null;
  })();

  if (settingsLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading settings...</Text>
      </View>
    );
  }

  const addHostModals = (
    <>
      <AddHostMethodModal
        visible={isAddHostMethodVisible}
        onClose={closeAddConnectionFlow}
        onDirectConnection={() => {
          setIsAddHostMethodVisible(false);
          setIsDirectHostVisible(true);
        }}
        onPasteLink={() => {
          setIsAddHostMethodVisible(false);
          setIsPasteLinkVisible(true);
        }}
        onScanQr={handleScanQr}
      />
      <AddHostModal
        visible={isDirectHostVisible}
        onClose={closeAddConnectionFlow}
        onCancel={goBackToAddConnectionMethods}
        onSaved={handleHostAdded}
      />
      <PairLinkModal
        visible={isPasteLinkVisible}
        onClose={closeAddConnectionFlow}
        onCancel={goBackToAddConnectionMethods}
        onSaved={handleHostAdded}
      />
    </>
  );

  // Mobile root: full-screen sidebar-as-list.
  if (isCompactLayout && view.kind === "root") {
    return (
      <View style={styles.container}>
        <BackHeader title="Settings" onBack={handleBackToWorkspace} />
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={{ paddingBottom: insets.bottom }}
        >
          <SettingsSidebar
            view={view}
            onSelectSection={handleSelectSection}
            onSelectHost={handleSelectHost}
            onAddHost={handleAddHost}
            onBackToWorkspace={handleBackToWorkspace}
            layout="mobile"
          />
        </ScrollView>
        {addHostModals}
      </View>
    );
  }

  // Mobile detail: full-screen content with a back header that returns to the list.
  if (isCompactLayout) {
    return (
      <View style={styles.container}>
        <BackHeader
          title={detailHeader?.title}
          titleAccessory={detailHeader?.titleAccessory}
          onBack={handleBackToRoot}
        />
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={{ paddingBottom: insets.bottom }}
        >
          <View style={styles.content}>{content}</View>
        </ScrollView>
        {addHostModals}
      </View>
    );
  }

  // Desktop split view — mirrors AppContainer: sidebar owns the titlebar drag
  // region + traffic-light padding; detail pane renders whatever header the
  // selected section provides.
  return (
    <View style={styles.container}>
      <View style={desktopStyles.row}>
        <SettingsSidebar
          view={view}
          onSelectSection={handleSelectSection}
          onSelectHost={handleSelectHost}
          onAddHost={handleAddHost}
          onBackToWorkspace={handleBackToWorkspace}
          layout="desktop"
        />
        <View style={desktopStyles.contentPane}>
          <ScreenHeader
            borderless={!detailHeader}
            windowControlsPaddingRole="detailHeader"
            left={
              detailHeader ? (
                <>
                  <HeaderIconBadge>
                    <detailHeader.Icon
                      size={theme.iconSize.md}
                      color={theme.colors.foregroundMuted}
                    />
                  </HeaderIconBadge>
                  <ScreenTitle testID="settings-detail-header-title">
                    {detailHeader.title}
                  </ScreenTitle>
                  {detailHeader.titleAccessory}
                </>
              ) : null
            }
            leftStyle={desktopStyles.detailLeft}
          />
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={{ paddingBottom: insets.bottom }}
          >
            <View style={styles.content}>{content}</View>
          </ScrollView>
        </View>
      </View>
      {addHostModals}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  aboutValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  aboutErrorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  aboutUpdateActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  themeTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  themeTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  providerCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  providerRefreshButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.full,
    justifyContent: "center",
    alignItems: "center",
  },
  providerRefreshButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  providerRefreshButtonDisabled: {
    opacity: 0.5,
  },
  helperCard: {
    marginTop: theme.spacing[3],
  },
  helperSectionHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1],
  },
  helperControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  helperListContainer: {
    width: "100%",
  },
  helperDragHandle: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  helperDragHandleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 14,
    letterSpacing: -1,
  },
  helperModelTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxWidth: 220,
  },
  helperModelTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  helperMoveButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  helperMoveButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  helperMoveButtonDisabled: {
    opacity: 0.4,
  },
  helperMoveButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  audioCard: {
    overflow: "hidden",
  },
  audioRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  audioRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  audioRowContent: {
    flex: 1,
    marginRight: theme.spacing[3],
  },
  audioRowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  audioRowSubtitle: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  emptyCard: {
    padding: theme.spacing[4],
    marginBottom: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

const desktopStyles = StyleSheet.create((theme) => ({
  row: {
    flex: 1,
    flexDirection: "row",
  },
  contentPane: {
    flex: 1,
  },
  detailLeft: {
    gap: theme.spacing[2],
  },
}));

const sidebarStyles = StyleSheet.create((theme) => ({
  desktopContainer: {
    width: 320,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  mobileContainer: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  list: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[1],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  itemHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  itemSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  label: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
  localMarker: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
}));
