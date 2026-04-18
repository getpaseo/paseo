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
  ChevronDown,
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
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
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
import {
  buildHostOpenProjectRoute,
  buildSettingsHostRoute,
  buildSettingsSectionRoute,
  type SettingsSectionSlug,
} from "@/utils/host-routes";

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

  const handleInstallUpdate = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }

    void confirmDialog({
      title: "Install desktop update",
      message: "This updates Paseo on this computer.",
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
  const hostServerIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const anyOnlineServerId = useAnyOnlineHostServerId(hostServerIds);

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
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (anyOnlineServerId) {
      router.replace(buildHostOpenProjectRoute(anyOnlineServerId));
      return;
    }
    router.replace("/");
  }, [anyOnlineServerId, router]);

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
          {detailHeader ? (
            <ScreenHeader
              left={
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
              }
              leftStyle={desktopStyles.detailLeft}
            />
          ) : null}
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
