import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Buffer } from "buffer";
import { ChevronRight } from "lucide-react-native";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { OpenLocationSection } from "@/screens/settings/open-location/open-location-section";
import { SendingSection } from "@/screens/settings/general/sending-section";
import {
  useAppSettings,
  useSettings,
  type AppSettings,
  type Settings as EffectiveSettings,
} from "@/hooks/use-settings";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { resolveActiveHostServerId, type HostProfile } from "@/types/host-connection";
import { confirmDialog } from "@/utils/confirm-dialog";
import { BackHeader } from "@/components/headers/back-header";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CommunityLinks } from "@/components/community-links";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { isElectronRuntime } from "@/desktop/host";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { openChangelog } from "@/changelog";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { settingsStyles } from "@/styles/settings";
import { THINKING_TONE_NATIVE_PCM_BASE64 } from "@/utils/thinking-tone.native-pcm";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import {
  LANGUAGE_OPTIONS,
  formatLanguageOptionLabel,
  parseAppLanguage,
  type AppLanguage,
  type SupportedLocale,
} from "@/i18n/locales";
import {
  HostConnectionsPage,
  HostPairDevicePage,
  HostAgentsPage,
  HostSettingsPage,
  HostProvidersPage,
  HostUsagePage,
  HostWorkspacesPage,
  HostTerminalsPage,
} from "@/screens/settings/host-page";
import { PluginSettingsContent } from "@/plugins/settings";
import { useInstalledPlugins } from "@/plugins/registry";
import { HostPluginsPage } from "@/screens/settings/plugins-page";
import { MetadataGenerationPage } from "@/screens/settings/metadata-generation-page";
import ProjectsScreen from "@/screens/projects-screen";
import ProjectSettingsScreen from "@/screens/project-settings-screen";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  buildSettingsHostSectionRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { returnFromSettings, type SettingsView } from "@/navigation/settings-navigation";
import { useSettingsAddHostFlowStore } from "@/stores/settings-add-host-flow-store";
import {
  HOST_SECTION_ITEMS,
  SIDEBAR_SECTION_ITEMS,
  isSectionAvailable,
} from "@/screens/settings/sections";
import { SettingsSidebar, useSortedHosts } from "@/screens/settings/settings-sidebar";
import { isNative } from "@/constants/platform";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

function renderHostSettingsContent(
  view: Extract<SettingsView, { kind: "host" }>,
  onHostRemoved: () => void,
): ReactNode {
  switch (view.section) {
    case "projects":
      return <ProjectsScreen serverId={view.serverId} />;
    case "connections":
      return <HostConnectionsPage serverId={view.serverId} />;
    case "pair-device":
      return <HostPairDevicePage serverId={view.serverId} />;
    case "agents":
      return <HostAgentsPage serverId={view.serverId} />;
    case "metadata":
      return <MetadataGenerationPage serverId={view.serverId} />;
    case "workspaces":
      return <HostWorkspacesPage serverId={view.serverId} />;
    case "providers":
      return <HostProvidersPage serverId={view.serverId} />;
    case "usage":
      return <HostUsagePage serverId={view.serverId} />;
    case "terminals":
      return <HostTerminalsPage serverId={view.serverId} />;
    case "plugins":
      return <HostPluginsPage serverId={view.serverId} />;
    case "host":
      return <HostSettingsPage serverId={view.serverId} onHostRemoved={onHostRemoved} />;
  }
}

// ---------------------------------------------------------------------------
// Trigger + sidebar style helpers
// ---------------------------------------------------------------------------

function getActiveLocale(language: string | undefined): SupportedLocale {
  const parsed = parseAppLanguage(language);
  return parsed && parsed !== "system" ? parsed : "en";
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

interface GeneralSectionProps {
  settings: AppSettings;
  handleLanguageChange: (language: AppLanguage) => void;
}

interface LanguageMenuItemProps {
  value: AppLanguage;
  activeLocale: SupportedLocale;
  selected: boolean;
  onChange: (value: AppLanguage) => void;
}

function LanguageMenuItem({ value, activeLocale, selected, onChange }: LanguageMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onChange(value);
  }, [onChange, value]);
  const option = LANGUAGE_OPTIONS.find((entry) => entry.value === value);
  const label = option
    ? formatLanguageOptionLabel(option, activeLocale, t(option.labelKey))
    : value;

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

function GeneralSection({ settings, handleLanguageChange }: GeneralSectionProps) {
  const { t, i18n } = useTranslation();
  const activeLocale = getActiveLocale(i18n.language);
  const selectedLanguageOption = LANGUAGE_OPTIONS.find(
    (option) => option.value === settings.language,
  );
  const selectedLanguageLabel = selectedLanguageOption
    ? formatLanguageOptionLabel(
        selectedLanguageOption,
        activeLocale,
        t(selectedLanguageOption.labelKey),
      )
    : settings.language;
  return (
    <SettingsSection title={t("settings.general.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.general.language.label")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.general.language.description")}</Text>
          </View>
          <DropdownMenu>
            <DropdownTrigger accessibilityRole="button" accessibilityLabel={selectedLanguageLabel}>
              {selectedLanguageLabel}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={300}>
              {LANGUAGE_OPTIONS.map((option) => (
                <LanguageMenuItem
                  key={option.value}
                  value={option.value}
                  activeLocale={activeLocale}
                  selected={settings.language === option.value}
                  onChange={handleLanguageChange}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
    </SettingsSection>
  );
}

interface DiagnosticsSectionProps {
  useLegacyTerminalRenderer: boolean;
  onUseLegacyTerminalRendererChange: (value: boolean) => void;
  voiceAudioEngine: ReturnType<typeof useVoiceAudioEngineOptional>;
  isPlaybackTestRunning: boolean;
  playbackTestResult: string | null;
  handlePlaybackTest: () => Promise<void>;
}

function DiagnosticsSection({
  useLegacyTerminalRenderer,
  onUseLegacyTerminalRendererChange,
  voiceAudioEngine,
  isPlaybackTestRunning,
  playbackTestResult,
  handlePlaybackTest,
}: DiagnosticsSectionProps) {
  const { t } = useTranslation();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const handlePlayPress = useCallback(() => {
    void handlePlaybackTest();
  }, [handlePlaybackTest]);
  return (
    <SettingsSection title={t("settings.diagnostics.title")}>
      <View style={settingsStyles.card}>
        {isNative ? (
          <View style={settingsStyles.row} testID="legacy-terminal-renderer-row">
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.diagnostics.legacyTerminalRenderer.label")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.diagnostics.legacyTerminalRenderer.description")}
              </Text>
            </View>
            <Switch
              value={useLegacyTerminalRenderer}
              onValueChange={onUseLegacyTerminalRendererChange}
              accessibilityLabel={t(
                "settings.diagnostics.legacyTerminalRenderer.accessibilityLabel",
              )}
              testID="legacy-terminal-renderer-switch"
            />
          </View>
        ) : null}
        <View style={settingsStyles.row} testID="app-diagnostic-row">
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.app.rowTitle")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.diagnostics.app.rowHint")}</Text>
          </View>
          <Button variant="secondary" size="sm" onPress={openAppDiagnostic}>
            {t("settings.diagnostics.app.run")}
          </Button>
        </View>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.diagnostics.testAudio")}</Text>
            {playbackTestResult ? (
              <Text style={settingsStyles.rowHint}>{playbackTestResult}</Text>
            ) : null}
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={handlePlayPress}
            disabled={!voiceAudioEngine || isPlaybackTestRunning}
          >
            {isPlaybackTestRunning
              ? t("settings.diagnostics.playing")
              : t("settings.diagnostics.playTest")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

interface AboutSectionProps {
  appVersion: string | null;
  appVersionText: string;
  isDesktopApp: boolean;
}

function AboutSection({ appVersion, appVersionText, isDesktopApp }: AboutSectionProps) {
  const { t } = useTranslation();
  return (
    <>
      <SettingsSection title={t("settings.about.title")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.about.appVersion")}</Text>
              <Text style={settingsStyles.rowHint}>{t("settings.about.thisDevice")}</Text>
            </View>
            <Text style={styles.aboutValue}>{appVersionText}</Text>
          </View>
          <WhatsNewRow />
          {isDesktopApp ? <DesktopAppUpdateRow /> : null}
        </View>
      </SettingsSection>
      <ConnectedHostsSection clientVersion={appVersion} />
      <View style={styles.aboutCommunity}>
        <CommunityLinks />
      </View>
    </>
  );
}

function WhatsNewRow() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();

  return (
    <Pressable
      style={[settingsStyles.row, settingsStyles.rowBorder]}
      onPress={openChangelog}
      accessibilityRole="button"
      testID="settings-whats-new"
    >
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("changelog.title")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.about.whatsNewHint")}</Text>
          </View>
          <ChevronRight
            size={theme.iconSize.sm}
            color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
          />
        </>
      )}
    </Pressable>
  );
}

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function ConnectedHostsSection({ clientVersion }: { clientVersion: string | null }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  if (hosts.length === 0) {
    return null;
  }
  return (
    <SettingsSection title={t("settings.about.connectedHosts")}>
      <View style={settingsStyles.card}>
        {hosts.map((host, index) => (
          <HostVersionRow
            key={host.serverId}
            host={host}
            showBorder={index > 0}
            clientVersion={clientVersion}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function HostVersionRow({
  host,
  showBorder,
  clientVersion,
}: {
  host: HostProfile;
  showBorder: boolean;
  clientVersion: string | null;
}) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );

  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );

  const normalizedHost = normalizeVersion(daemonVersion);
  const normalizedClient = normalizeVersion(clientVersion);
  const isMismatch =
    normalizedHost !== null && normalizedClient !== null && normalizedHost !== normalizedClient;

  let valueText: string;
  if (!isConnected) {
    valueText = t("settings.about.offline");
  } else if (normalizedHost) {
    valueText = formatVersionWithPrefix(normalizedHost);
  } else {
    valueText = "—";
  }

  const valueStyle = useMemo(
    () => [styles.aboutValue, isMismatch && styles.aboutVersionMismatch],
    [isMismatch],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {host.label}
        </Text>
        {isMismatch ? (
          <Text style={settingsStyles.rowHint}>{t("settings.about.versionDiffers")}</Text>
        ) : null}
      </View>
      <Text style={valueStyle}>{valueText}</Text>
    </View>
  );
}

function getUpdateButtonLabel(
  t: TFunction,
  isInstalling: boolean,
  latestVersion: string | null | undefined,
): string {
  if (isInstalling) return t("settings.about.updates.installing");
  if (latestVersion) {
    return t("settings.about.updates.updateTo", {
      version: formatVersionWithPrefix(latestVersion),
    });
  }
  return t("settings.about.updates.update");
}

function DesktopAppUpdateRow() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettings();
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
      void checkForUpdates({ intent: "automatic", silent: true });
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
    (releaseChannel: EffectiveSettings["releaseChannel"]) => {
      void updateSettings({ releaseChannel });
    },
    [updateSettings],
  );
  const releaseChannelOptions = useMemo(
    () => [
      { value: "stable" as const, label: t("settings.about.releaseChannel.stable") },
      { value: "beta" as const, label: t("settings.about.releaseChannel.beta") },
    ],
    [t],
  );

  const handleInstallUpdate = useCallback(() => {
    if (!isDesktopApp) {
      return;
    }

    void confirmDialog({
      title: t("settings.about.updates.installTitle"),
      message: t("settings.about.updates.installMessage"),
      confirmLabel: t("settings.about.updates.installConfirm"),
      cancelLabel: t("common.actions.cancel"),
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        void installUpdate();
        return;
      })
      .catch((error) => {
        console.error("[Settings] Failed to open app update confirmation", error);
        Alert.alert(
          t("settings.about.updates.alertTitle"),
          t("settings.about.updates.alertMessage"),
        );
      });
  }, [installUpdate, isDesktopApp, t]);

  const isUpdateReady = availableUpdate?.readyToInstall === true;
  const readyUpdateVersion = isUpdateReady ? availableUpdate?.latestVersion : null;

  if (!isDesktopApp) {
    return null;
  }

  return (
    <>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.about.releaseChannel.label")}</Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.about.releaseChannel.description")}
          </Text>
        </View>
        <SegmentedControl
          size="sm"
          value={settings.releaseChannel}
          onValueChange={handleReleaseChannelChange}
          options={releaseChannelOptions}
        />
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.about.updates.label")}</Text>
          <Text style={settingsStyles.rowHint}>{statusText}</Text>
          {readyUpdateVersion ? (
            <Text style={settingsStyles.rowHint}>
              {t("settings.about.updates.readyToInstall", {
                version: formatVersionWithPrefix(readyUpdateVersion),
              })}
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
            {isChecking ? t("settings.about.updates.checking") : t("settings.about.updates.check")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={handleInstallUpdate}
            disabled={isChecking || isInstalling || !isUpdateReady}
          >
            {getUpdateButtonLabel(t, isInstalling, readyUpdateVersion)}
          </Button>
        </View>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export interface SettingsScreenProps {
  view: SettingsView;
  openAddHostIntent?: string | null;
}

export default function SettingsScreen({ view, openAddHostIntent = null }: SettingsScreenProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const { settings, isLoading: settingsLoading, updateSettings } = useAppSettings();
  const [isPlaybackTestRunning, setIsPlaybackTestRunning] = useState(false);
  const [playbackTestResult, setPlaybackTestResult] = useState<string | null>(null);
  const lastOpenedAddHostIntentRef = useRef<string | null>(null);
  const isDesktopApp = isElectronRuntime();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const isCompactLayout = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const insetBottomStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useSortedHosts(hosts, localServerId);
  const lastWorkspaceSelection = useLastWorkspaceSelection();
  const routedSettingsHostServerId =
    view.kind === "host" || view.kind === "project" || view.kind === "plugin"
      ? view.serverId
      : null;
  const [selectedSettingsHostServerId, setSelectedSettingsHostServerId] = useState<string | null>(
    routedSettingsHostServerId ?? lastWorkspaceSelection?.serverId ?? null,
  );
  useFocusEffect(
    useCallback(() => {
      setSelectedSettingsHostServerId(
        routedSettingsHostServerId ?? lastWorkspaceSelection?.serverId ?? null,
      );
    }, [lastWorkspaceSelection?.serverId, routedSettingsHostServerId]),
  );

  // The host the four sections scope to: the host on the active view, otherwise
  // the picker choice, otherwise the connected local daemon, otherwise the first host.
  const activeHostServerId = useMemo(() => {
    if (view.kind === "host" || view.kind === "project" || view.kind === "plugin")
      return view.serverId;
    return resolveActiveHostServerId({
      selectedServerId: selectedSettingsHostServerId,
      localServerId,
      hosts,
      orderedHosts: sortedHosts,
    });
  }, [view, selectedSettingsHostServerId, localServerId, hosts, sortedHosts]);

  const handleLanguageChange = useCallback(
    (language: AppLanguage) => {
      void updateSettings({ language });
    },
    [updateSettings],
  );

  const handleUseLegacyTerminalRendererChange = useCallback(
    (useLegacyTerminalRenderer: boolean) => {
      void updateSettings({ useLegacyTerminalRenderer });
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
      setPlaybackTestResult(t("settings.diagnostics.playbackFailed", { message }));
    } finally {
      setIsPlaybackTestRunning(false);
    }
  }, [isPlaybackTestRunning, t, voiceAudioEngine]);

  const handleAddHost = useSettingsAddHostFlowStore((state) => state.open);

  useEffect(() => {
    if (!openAddHostIntent || lastOpenedAddHostIntentRef.current === openAddHostIntent) {
      return;
    }
    lastOpenedAddHostIntentRef.current = openAddHostIntent;
    handleAddHost();
  }, [handleAddHost, openAddHostIntent]);

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

  // Picker: choose the host for host-section rows. If the user is already on a
  // host detail route, keep that detail section and swap only the host segment.
  const handleSelectHost = useCallback(
    (serverId: string) => {
      setSelectedSettingsHostServerId(serverId);
      if (view.kind === "project") {
        const target = buildSettingsHostSectionRoute(serverId, "projects");
        if (isCompactLayout) {
          router.push(target);
        } else {
          router.replace(target);
        }
        return;
      }
      if (view.kind !== "host") {
        return;
      }
      const target = buildSettingsHostSectionRoute(serverId, view.section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router, view],
  );

  const handleSelectHostSection = useCallback(
    (section: HostSectionSlug) => {
      if (!activeHostServerId) {
        handleAddHost();
        return;
      }
      const target = buildSettingsHostSectionRoute(activeHostServerId, section);
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [activeHostServerId, handleAddHost, isCompactLayout, router],
  );

  const handleHostRemoved = useCallback(() => {
    const fallback = buildSettingsSectionRoute("general");
    if (isCompactLayout) {
      router.replace("/settings");
    } else {
      router.replace(fallback);
    }
  }, [isCompactLayout, router]);

  const handleBackFromDetail = useCallback(() => {
    returnFromSettings(view);
  }, [view]);

  const handleBackToWorkspace = useCallback(() => {
    returnFromSettings({ kind: "root" });
  }, []);

  const installedPlugins = useInstalledPlugins();
  const detailTitle = ((): string | undefined => {
    if (view.kind === "plugin") {
      const screen = installedPlugins
        .find((plugin) => plugin.serverId === view.serverId && plugin.id === view.pluginId)
        ?.settingsScreens.find((candidate) => candidate.id === view.screenId);
      return `${view.pluginId} · ${screen?.title ?? t("settings.title")}`;
    }
    if (view.kind === "host") {
      const item = HOST_SECTION_ITEMS.find((s) => s.id === view.section);
      return item ? t(item.labelKey) : undefined;
    }
    if (view.kind === "section") {
      const item = SIDEBAR_SECTION_ITEMS.find((s) => s.id === view.section);
      return item ? t(item.labelKey) : undefined;
    }
    if (view.kind === "project") {
      return t("settings.projects");
    }
    return undefined;
  })();

  const content: ReactNode = (() => {
    if (view.kind === "plugin")
      return (
        <PluginSettingsContent
          serverId={view.serverId}
          pluginId={view.pluginId}
          screenId={view.screenId}
          onBackToPlugins={handleBackFromDetail}
          showBackToPlugins={!isCompactLayout}
        />
      );
    if (view.kind === "host") {
      return renderHostSettingsContent(view, handleHostRemoved);
    }
    if (view.kind === "project") {
      return (
        <ProjectSettingsScreen
          serverId={view.serverId}
          projectId={view.projectId}
          onBackToProjects={handleBackFromDetail}
          showBackToProjects={!isCompactLayout}
        />
      );
    }
    if (view.kind === "section") {
      const item = SIDEBAR_SECTION_ITEMS.find((candidate) => candidate.id === view.section);
      if (!item || !isSectionAvailable(item, isDesktopApp)) return null;
      switch (view.section) {
        case "general":
          return (
            <>
              <GeneralSection settings={settings} handleLanguageChange={handleLanguageChange} />
              <SendingSection />
              {isDesktopApp ? <OpenLocationSection /> : null}
            </>
          );
        case "diagnostics":
          return (
            <DiagnosticsSection
              useLegacyTerminalRenderer={settings.useLegacyTerminalRenderer}
              onUseLegacyTerminalRendererChange={handleUseLegacyTerminalRendererChange}
              voiceAudioEngine={voiceAudioEngine}
              isPlaybackTestRunning={isPlaybackTestRunning}
              playbackTestResult={playbackTestResult}
              handlePlaybackTest={handlePlaybackTest}
            />
          );
        case "about":
          return (
            <AboutSection
              appVersion={appVersion}
              appVersionText={appVersionText}
              isDesktopApp={isDesktopApp}
            />
          );
        default:
          return item.Content ? <item.Content /> : null;
      }
    }
    return null;
  })();

  if (settingsLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>{t("settings.loading")}</Text>
      </View>
    );
  }

  // Mobile root: full-screen sidebar-as-list.
  if (isCompactLayout && view.kind === "root") {
    return (
      <View style={styles.container}>
        <BackHeader title={t("settings.title")} onBack={handleBackToWorkspace} />
        <ScrollView style={styles.scrollView} contentContainerStyle={insetBottomStyle}>
          <SettingsSidebar
            view={view}
            onSelectSection={handleSelectSection}
            onSelectHostSection={handleSelectHostSection}
            onSelectHost={handleSelectHost}
            onAddHost={handleAddHost}
            onBackToWorkspace={handleBackToWorkspace}
            activeHostServerId={activeHostServerId}
            layout="mobile"
          />
        </ScrollView>
      </View>
    );
  }

  if (isCompactLayout) {
    return (
      <View style={styles.container}>
        <PageLayout title={detailTitle} onBack={handleBackFromDetail}>
          {content}
        </PageLayout>
      </View>
    );
  }

  // Desktop split view — SettingsChrome owns the sidebar and the detail pane.
  return (
    <PageLayout title={detailTitle} titleTestID="settings-detail-header-title">
      {content}
    </PageLayout>
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
    fontSize: theme.fontSize.base,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  aboutValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  aboutVersionMismatch: {
    color: theme.colors.palette.amber[500],
  },
  aboutErrorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  aboutCommunity: {
    marginTop: theme.spacing[4],
  },
  aboutUpdateActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
