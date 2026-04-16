import { useState, useEffect, useRef, useCallback } from "react";
import type { MutableRefObject, ComponentType } from "react";
import { View, Text, ScrollView, Alert, Pressable } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Buffer } from "buffer";
import {
  Sun,
  Moon,
  Monitor,
  ChevronDown,
  Globe,
  Settings,
  RotateCw,
  Trash2,
  Server,
  Keyboard,
  Stethoscope,
  Info,
  Shield,
  Puzzle,
  Blocks,
  Smartphone,
} from "lucide-react-native";
import { useAppSettings, type AppSettings, type SendBehavior } from "@/hooks/use-settings";
import { THEME_SWATCHES, type ThemeName } from "@/styles/theme";
import type { HostProfile, HostConnection } from "@/types/host-connection";
import { useHosts, useHostMutations } from "@/runtime/host-runtime";
import { formatConnectionStatus, getConnectionStatusTone } from "@/utils/daemons";
import { confirmDialog } from "@/utils/confirm-dialog";
import { MenuHeader } from "@/components/headers/menu-header";
import { useSessionStore } from "@/stores/session-store";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
} from "@/runtime/host-runtime";
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
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { DesktopPermissionsSection } from "@/desktop/components/desktop-permissions-section";
import { IntegrationsSection } from "@/desktop/components/integrations-section";
import { LocalDaemonSection } from "@/desktop/components/desktop-updates-section";
import { PairDeviceSection } from "@/desktop/components/pair-device-section";
import { isElectronRuntime } from "@/desktop/host";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { settingsStyles } from "@/styles/settings";
import { THINKING_TONE_NATIVE_PCM_BASE64 } from "@/utils/thinking-tone.native-pcm";
import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getProviderIcon } from "@/components/provider-icons";
import { ProviderDiagnosticSheet } from "@/components/provider-diagnostic-sheet";
import { SpinningRefreshIcon } from "@/components/spinning-refresh-icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import { isWeb } from "@/constants/platform";

// ---------------------------------------------------------------------------
// Section definitions
// ---------------------------------------------------------------------------

type SettingsSectionId =
  | "hosts"
  | "general"
  | "shortcuts"
  | "integrations"
  | "providers"
  | "diagnostics"
  | "about"
  | "permissions"
  | "daemon"
  | "pair-device";

interface SettingsSectionDef {
  id: SettingsSectionId;
  label: string;
  icon: ComponentType<{ size: number; color: string }>;
}

function getSettingsSections(context: { isDesktopApp: boolean }): SettingsSectionDef[] {
  const sections: SettingsSectionDef[] = [
    { id: "hosts", label: "Hosts", icon: Server },
    { id: "general", label: "General", icon: Settings },
    { id: "permissions", label: "Permissions", icon: Shield },
  ];

  if (context.isDesktopApp) {
    sections.push(
      { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
      { id: "integrations", label: "Integrations", icon: Puzzle },
      { id: "pair-device", label: "Pair device", icon: Smartphone },
      { id: "daemon", label: "Daemon", icon: Settings },
      { id: "providers", label: "Providers", icon: Blocks },
    );
  }

  sections.push(
    { id: "diagnostics", label: "Diagnostics", icon: Stethoscope },
    { id: "about", label: "About", icon: Info },
  );

  return sections;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      clearTimeout(timeout);
      resolve();
    }, ms);
  });

function formatHostConnectionLabel(connection: HostConnection): string {
  if (connection.type === "relay") {
    return `Relay (${connection.relayEndpoint})`;
  }
  if (connection.type === "directSocket") {
    return `Local (${connection.path})`;
  }
  if (connection.type === "directPipe") {
    return `Local (${connection.path})`;
  }
  return `TCP (${connection.endpoint})`;
}

function formatActiveConnectionBadge(input: {
  activeConnection: { type: HostConnection["type"]; display: string } | null;
  theme: ReturnType<typeof useUnistyles>["theme"];
}) {
  const { activeConnection, theme } = input;
  if (!activeConnection) {
    return null;
  }
  if (activeConnection.type === "relay") {
    return {
      icon: <Globe size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      text: "Relay",
    };
  }
  if (activeConnection.type === "directSocket") {
    return {
      icon: <Monitor size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      text: "Local",
    };
  }
  if (activeConnection.type === "directPipe") {
    return {
      icon: <Monitor size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      text: "Local",
    };
  }
  return {
    icon: <Monitor size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    text: activeConnection.display,
  };
}

function formatDaemonVersionBadge(version: string | null): string | null {
  const daemonVersion = version?.trim();
  if (!daemonVersion) {
    return null;
  }
  if (daemonVersion.startsWith("v")) {
    return daemonVersion;
  }
  return `v${daemonVersion}`;
}

// ---------------------------------------------------------------------------
// Section content components
// ---------------------------------------------------------------------------

interface HostsSectionProps {
  daemons: HostProfile[];
  settings: AppSettings;
  routeServerId: string;
  theme: ReturnType<typeof useUnistyles>["theme"];
  handleEditDaemon: (profile: HostProfile) => void;
  setIsAddHostMethodVisible: (visible: boolean) => void;
  isAddHostMethodVisible: boolean;
  isDirectHostVisible: boolean;
  isPasteLinkVisible: boolean;
  closeAddConnectionFlow: () => void;
  goBackToAddConnectionMethods: () => void;
  setIsDirectHostVisible: (visible: boolean) => void;
  setIsPasteLinkVisible: (visible: boolean) => void;
  pendingRemoveHost: HostProfile | null;
  setPendingRemoveHost: (host: HostProfile | null) => void;
  isRemovingHost: boolean;
  setIsRemovingHost: (removing: boolean) => void;
  removeHost: (serverId: string) => Promise<void>;
  editingDaemonLive: HostProfile | null;
  isSavingEdit: boolean;
  handleCloseEditDaemon: () => void;
  handleSaveEditDaemon: (label: string) => Promise<void>;
  handleRemoveConnection: (serverId: string, connectionId: string) => Promise<void>;
  handleRemoveDaemon: (profile: HostProfile) => void;
  restartConfirmationMessage: string;
  waitForCondition: (
    predicate: () => boolean,
    timeoutMs: number,
    intervalMs?: number,
  ) => Promise<boolean>;
  isMountedRef: MutableRefObject<boolean>;
}

function HostsSection(props: HostsSectionProps) {
  const { theme } = useUnistyles();

  return (
    <>
      <View style={settingsStyles.section}>
        <Text style={settingsStyles.sectionTitle}>Hosts</Text>

        {props.daemons.length === 0 ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>No hosts configured</Text>
          </View>
        ) : (
          props.daemons.map((daemon) => {
            return (
              <DaemonCard
                key={daemon.serverId}
                daemon={daemon}
                onOpenSettings={props.handleEditDaemon}
              />
            );
          })
        )}

        <Button
          variant="outline"
          size="md"
          style={styles.addButton}
          textStyle={styles.addButtonText}
          onPress={() => {
            props.setIsAddHostMethodVisible(true);
          }}
        >
          + Add connection
        </Button>
      </View>

      <AddHostMethodModal
        visible={props.isAddHostMethodVisible}
        onClose={props.closeAddConnectionFlow}
        onDirectConnection={() => {
          props.setIsAddHostMethodVisible(false);
          props.setIsDirectHostVisible(true);
        }}
        onPasteLink={() => {
          props.setIsAddHostMethodVisible(false);
          props.setIsPasteLinkVisible(true);
        }}
        onScanQr={() => {
          const sourceServerId = props.routeServerId || undefined;
          props.closeAddConnectionFlow();
          router.push({
            pathname: "/pair-scan",
            params: { source: "settings", sourceServerId },
          });
        }}
      />

      <AddHostModal
        visible={props.isDirectHostVisible}
        onClose={props.closeAddConnectionFlow}
        onCancel={props.goBackToAddConnectionMethods}
      />

      <PairLinkModal
        visible={props.isPasteLinkVisible}
        onClose={props.closeAddConnectionFlow}
        onCancel={props.goBackToAddConnectionMethods}
      />

      {props.pendingRemoveHost ? (
        <AdaptiveModalSheet
          title="Remove host"
          visible
          onClose={() => {
            if (props.isRemovingHost) return;
            props.setPendingRemoveHost(null);
          }}
          testID="remove-host-confirm-modal"
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
            Remove {props.pendingRemoveHost.label}? This will delete its saved connections.
          </Text>
          <View style={[styles.formActionsRow, { marginTop: theme.spacing[4] }]}>
            <Button
              variant="secondary"
              size="sm"
              style={{ flex: 1 }}
              onPress={() => props.setPendingRemoveHost(null)}
              disabled={props.isRemovingHost}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              style={{ flex: 1 }}
              onPress={() => {
                const serverId = props.pendingRemoveHost!.serverId;
                props.setIsRemovingHost(true);
                void props
                  .removeHost(serverId)
                  .then(() => props.setPendingRemoveHost(null))
                  .catch((error) => {
                    console.error("[Settings] Failed to remove host", error);
                    Alert.alert("Error", "Unable to remove host");
                  })
                  .finally(() => props.setIsRemovingHost(false));
              }}
              disabled={props.isRemovingHost}
              testID="remove-host-confirm"
            >
              Remove
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}

      <HostDetailModal
        visible={Boolean(props.editingDaemonLive)}
        host={props.editingDaemonLive}
        isSaving={props.isSavingEdit}
        onClose={props.handleCloseEditDaemon}
        onSave={(label) => void props.handleSaveEditDaemon(label)}
        onRemoveConnection={props.handleRemoveConnection}
        onRemoveHost={props.handleRemoveDaemon}
        restartConfirmationMessage={props.restartConfirmationMessage}
        waitForCondition={props.waitForCondition}
        isScreenMountedRef={props.isMountedRef}
      />
    </>
  );
}

interface GeneralSectionProps {
  routeServerId: string;
  settings: AppSettings;
  handleThemeChange: (theme: AppSettings["theme"]) => void;
  handleSendBehaviorChange: (behavior: SendBehavior) => void;
}

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

function GeneralSection({
  routeServerId,
  settings,
  handleThemeChange,
  handleSendBehaviorChange,
}: GeneralSectionProps) {
  const { theme } = useUnistyles();
  const isConnected = useHostRuntimeIsConnected(routeServerId);
  const { config, patchConfig } = useDaemonConfig(routeServerId);
  const iconSize = theme.iconSize.md;
  const iconColor = theme.colors.foregroundMuted;

  return (
    <View style={settingsStyles.section}>
      <Text style={settingsStyles.sectionTitle}>General</Text>
      <View style={[settingsStyles.card, styles.audioCard]}>
        <View style={styles.audioRow}>
          <View style={styles.audioRowContent}>
            <Text style={styles.audioRowTitle}>Theme</Text>
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
        <View style={styles.audioRow}>
          <View style={styles.audioRowContent}>
            <Text style={styles.audioRowTitle}>Default send</Text>
            <Text style={styles.audioRowSubtitle}>
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
        {routeServerId.length > 0 && isConnected ? (
          <View style={[styles.audioRow, styles.audioRowBorder]}>
            <View style={styles.audioRowContent}>
              <Text style={styles.audioRowTitle}>Inject Paseo tools</Text>
              <Text style={styles.audioRowSubtitle}>
                Automatically inject Paseo MCP tools into new agents
              </Text>
            </View>
            <SegmentedControl
              size="sm"
              value={config?.mcp.injectIntoAgents === false ? "off" : "on"}
              onValueChange={(value) => {
                void patchConfig({
                  mcp: {
                    injectIntoAgents: value === "on",
                  },
                });
              }}
              options={[
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

interface ProvidersSectionProps {
  routeServerId: string;
}

function ProvidersSection({ routeServerId }: ProvidersSectionProps) {
  const { theme } = useUnistyles();
  const isConnected = useHostRuntimeIsConnected(routeServerId);
  const { entries, isLoading, isRefreshing, refresh } = useProvidersSnapshot(routeServerId);
  const [diagnosticProvider, setDiagnosticProvider] = useState<string | null>(null);
  const providerDefinitions = buildProviderDefinitions(entries);
  const providerRefreshInFlight =
    isRefreshing || (entries?.some((entry) => entry.status === "loading") ?? false);

  const hasServer = routeServerId.length > 0;

  return (
    <>
      <View style={settingsStyles.section}>
        <View style={settingsStyles.sectionHeader}>
          <Text style={settingsStyles.sectionHeaderTitle}>Providers</Text>
          {hasServer && isConnected ? (
            <Pressable
              onPress={() => {
                void refresh();
              }}
              disabled={providerRefreshInFlight}
              hitSlop={8}
              style={({ hovered, pressed }) => [
                settingsStyles.sectionHeaderLink,
                styles.providerRefreshButton,
                (hovered || pressed) && styles.providerRefreshButtonHovered,
                providerRefreshInFlight ? styles.providerRefreshButtonDisabled : null,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Refresh providers"
            >
              <SpinningRefreshIcon
                spinning={providerRefreshInFlight}
                size={theme.iconSize.sm}
                color={theme.colors.foregroundMuted}
              />
            </Pressable>
          ) : null}
        </View>
        {!hasServer || !isConnected ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>Connect to a host to see providers</Text>
          </View>
        ) : isLoading ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>Loading...</Text>
          </View>
        ) : (
          <View style={[settingsStyles.card, styles.audioCard]}>
            {providerDefinitions.map((def) => {
              const entry = entries?.find((e) => e.provider === def.id);
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
                  style={styles.audioRow}
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
                    ) : null}
                    {status === "ready" && modelCount > 0 ? (
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
        )}
      </View>

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
    <View style={settingsStyles.section}>
      <Text style={settingsStyles.sectionTitle}>Diagnostics</Text>
      <View style={[settingsStyles.card, styles.audioCard]}>
        <View style={styles.audioRow}>
          <View style={styles.audioRowContent}>
            <Text style={styles.audioRowTitle}>Test audio</Text>
            {playbackTestResult ? (
              <Text style={styles.aboutHintText}>{playbackTestResult}</Text>
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
    </View>
  );
}

interface AboutSectionProps {
  appVersionText: string;
  isDesktopApp: boolean;
}

function AboutSection({ appVersionText, isDesktopApp }: AboutSectionProps) {
  return (
    <View style={settingsStyles.section}>
      <Text style={settingsStyles.sectionTitle}>About</Text>
      <View style={[settingsStyles.card, styles.audioCard]}>
        <View style={styles.audioRow}>
          <View style={styles.audioRowContent}>
            <Text style={styles.audioRowTitle}>Version</Text>
          </View>
          <Text style={styles.aboutValue}>{appVersionText}</Text>
        </View>
        {isDesktopApp ? <DesktopAppUpdateRow /> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Section content switcher
// ---------------------------------------------------------------------------

interface SettingsSectionContentProps {
  sectionId: SettingsSectionId;
  hostsProps: HostsSectionProps;
  generalProps: GeneralSectionProps;
  providersProps: ProvidersSectionProps;
  diagnosticsProps: DiagnosticsSectionProps;
  aboutProps: AboutSectionProps;
  appVersion: string | null;
  isLocalDaemon: boolean;
  isDesktopApp: boolean;
}

function SettingsSectionContent({
  sectionId,
  hostsProps,
  generalProps,
  providersProps,
  diagnosticsProps,
  aboutProps,
  appVersion,
  isLocalDaemon,
  isDesktopApp,
}: SettingsSectionContentProps) {
  switch (sectionId) {
    case "hosts":
      return <HostsSection {...hostsProps} />;
    case "general":
      return <GeneralSection {...generalProps} />;
    case "shortcuts":
      return <KeyboardShortcutsSection />;
    case "providers":
      return <ProvidersSection {...providersProps} />;
    case "diagnostics":
      return <DiagnosticsSection {...diagnosticsProps} />;
    case "about":
      return <AboutSection {...aboutProps} />;
    case "integrations":
      return isDesktopApp ? <IntegrationsSection /> : null;
    case "permissions":
      return isDesktopApp ? <DesktopPermissionsSection /> : null;
    case "pair-device":
      return isDesktopApp ? <PairDeviceSection /> : null;
    case "daemon":
      return isDesktopApp ? (
        <LocalDaemonSection appVersion={appVersion} showLifecycleControls={isLocalDaemon} />
      ) : null;
  }
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

interface SettingsLayoutProps {
  sections: SettingsSectionDef[];
  sectionContentProps: Omit<SettingsSectionContentProps, "sectionId">;
}

function SettingsMobileLayout({ sections, sectionContentProps }: SettingsLayoutProps) {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView style={styles.scrollView} contentContainerStyle={{ paddingBottom: insets.bottom }}>
      <View style={styles.content}>
        {sections.map((section) => (
          <SettingsSectionContent
            key={section.id}
            sectionId={section.id}
            {...sectionContentProps}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function SettingsDesktopLayout({ sections, sectionContentProps }: SettingsLayoutProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [selectedSectionId, setSelectedSectionId] = useState<SettingsSectionId>("hosts");

  return (
    <View style={desktopStyles.row}>
      <View style={desktopStyles.sidebar}>
        {sections.map((section) => {
          const isSelected = section.id === selectedSectionId;
          const IconComponent = section.icon;
          const showSeparator = section.id === "integrations" || section.id === "providers";
          return (
            <View key={section.id}>
              {showSeparator ? <View style={desktopStyles.sidebarSeparator} /> : null}
              <Pressable
                style={[
                  desktopStyles.sidebarItem,
                  isSelected && { backgroundColor: theme.colors.surface2 },
                ]}
                onPress={() => setSelectedSectionId(section.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
              >
                <IconComponent
                  size={theme.iconSize.md}
                  color={isSelected ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
                <Text
                  style={[
                    desktopStyles.sidebarLabel,
                    isSelected && { color: theme.colors.foreground },
                  ]}
                  numberOfLines={1}
                >
                  {section.label}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      <ScrollView
        style={desktopStyles.contentPane}
        contentContainerStyle={{ paddingBottom: insets.bottom }}
      >
        <View style={styles.content}>
          <SettingsSectionContent sectionId={selectedSectionId} {...sectionContentProps} />
        </View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Desktop app update row (unchanged)
// ---------------------------------------------------------------------------

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
    <View style={[styles.audioRow, styles.audioRowBorder]}>
      <View style={styles.audioRowContent}>
        <Text style={styles.audioRowTitle}>App updates</Text>
        <Text style={styles.aboutHintText}>{statusText}</Text>
        {availableUpdate?.latestVersion ? (
          <Text style={styles.aboutHintText}>
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
// Main screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const { theme } = useUnistyles();
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const params = useLocalSearchParams<{ editHost?: string; serverId?: string }>();
  const routeServerId = typeof params.serverId === "string" ? params.serverId.trim() : "";
  const { settings, isLoading: settingsLoading, updateSettings } = useAppSettings();
  const { daemons, renameHost, removeHost, removeConnection } = {
    daemons: useHosts(),
    ...useHostMutations(),
  };
  const [isAddHostMethodVisible, setIsAddHostMethodVisible] = useState(false);
  const [isDirectHostVisible, setIsDirectHostVisible] = useState(false);
  const [isPasteLinkVisible, setIsPasteLinkVisible] = useState(false);
  const [pendingRemoveHost, setPendingRemoveHost] = useState<HostProfile | null>(null);
  const [isRemovingHost, setIsRemovingHost] = useState(false);
  const [editingDaemon, setEditingDaemon] = useState<HostProfile | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isPlaybackTestRunning, setIsPlaybackTestRunning] = useState(false);
  const [playbackTestResult, setPlaybackTestResult] = useState<string | null>(null);
  const isLoading = settingsLoading;
  const isMountedRef = useRef(true);
  const lastHandledEditHostRef = useRef<string | null>(null);
  const isDesktopApp = isElectronRuntime();
  const isLocalDaemon = useIsLocalDaemon(routeServerId);
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const editingServerId = editingDaemon?.serverId ?? null;
  const editingDaemonLive = editingServerId
    ? (daemons.find((daemon) => daemon.serverId === editingServerId) ?? null)
    : null;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Keep the edit modal bound to live registry state.
  useEffect(() => {
    if (!editingServerId) return;
    if (editingDaemonLive) return;
    setEditingDaemon(null);
  }, [editingDaemonLive, editingServerId]);

  const waitForCondition = useCallback(
    async (predicate: () => boolean, timeoutMs: number, intervalMs = 250) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isMountedRef.current) {
          return false;
        }
        if (predicate()) {
          return true;
        }
        await delay(intervalMs);
      }
      return predicate();
    },
    [],
  );

  const handleEditDaemon = useCallback((profile: HostProfile) => {
    setEditingDaemon(profile);
  }, []);

  const handleCloseEditDaemon = useCallback(() => {
    if (isSavingEdit) return;
    setEditingDaemon(null);
  }, [isSavingEdit]);

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

  useEffect(() => {
    const editHost = typeof params.editHost === "string" ? params.editHost.trim() : "";
    if (!editHost) return;
    if (lastHandledEditHostRef.current === editHost) return;
    const profile = daemons.find((daemon) => daemon.serverId === editHost) ?? null;
    if (!profile) return;
    lastHandledEditHostRef.current = editHost;
    handleEditDaemon(profile);
  }, [daemons, handleEditDaemon, params.editHost]);

  const handleSaveEditDaemon = useCallback(
    async (nextLabelRaw: string) => {
      if (!editingServerId) return;
      if (isSavingEdit) return;

      const nextLabel = nextLabelRaw.trim();
      if (!nextLabel) {
        Alert.alert("Label required", "Enter a label for this host.");
        return;
      }

      try {
        setIsSavingEdit(true);
        await renameHost(editingServerId, nextLabel);
        handleCloseEditDaemon();
      } catch (error) {
        console.error("[Settings] Failed to rename host", error);
        Alert.alert("Error", "Unable to save host");
      } finally {
        setIsSavingEdit(false);
      }
    },
    [editingServerId, handleCloseEditDaemon, isSavingEdit, renameHost],
  );

  const handleRemoveConnection = useCallback(
    async (serverId: string, connectionId: string) => {
      await removeConnection(serverId, connectionId);
    },
    [removeConnection],
  );

  const handleRemoveDaemon = useCallback((profile: HostProfile) => {
    setEditingDaemon(null);
    setPendingRemoveHost(profile);
  }, []);

  const handleThemeChange = useCallback(
    (newTheme: AppSettings["theme"]) => {
      void updateSettings({ theme: newTheme });
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

  const isCompactLayout = useIsCompactFormFactor();
  const sections = getSettingsSections({ isDesktopApp });

  const hostsProps: HostsSectionProps = {
    daemons,
    settings,
    routeServerId,
    theme,
    handleEditDaemon,
    setIsAddHostMethodVisible,
    isAddHostMethodVisible,
    isDirectHostVisible,
    isPasteLinkVisible,
    closeAddConnectionFlow,
    goBackToAddConnectionMethods,
    setIsDirectHostVisible,
    setIsPasteLinkVisible,
    pendingRemoveHost,
    setPendingRemoveHost,
    isRemovingHost,
    setIsRemovingHost,
    removeHost,
    editingDaemonLive,
    isSavingEdit,
    handleCloseEditDaemon,
    handleSaveEditDaemon,
    handleRemoveConnection,
    handleRemoveDaemon,
    restartConfirmationMessage:
      "This will restart the daemon. The app will reconnect automatically.",
    waitForCondition,
    isMountedRef,
  };

  const generalProps: GeneralSectionProps = {
    routeServerId,
    settings,
    handleThemeChange,
    handleSendBehaviorChange,
  };

  const diagnosticsProps: DiagnosticsSectionProps = {
    voiceAudioEngine,
    isPlaybackTestRunning,
    playbackTestResult,
    handlePlaybackTest,
  };

  const aboutProps: AboutSectionProps = {
    appVersionText,
    isDesktopApp,
  };

  const providersProps: ProvidersSectionProps = {
    routeServerId,
  };

  const sectionContentProps: Omit<SettingsSectionContentProps, "sectionId"> = {
    hostsProps,
    generalProps,
    providersProps,
    diagnosticsProps,
    aboutProps,
    appVersion,
    isLocalDaemon,
    isDesktopApp,
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading settings...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title="Settings" />
      {isCompactLayout ? (
        <SettingsMobileLayout sections={sections} sectionContentProps={sectionContentProps} />
      ) : (
        <SettingsDesktopLayout sections={sections} sectionContentProps={sectionContentProps} />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// HostDetailModal (unchanged)
// ---------------------------------------------------------------------------

interface HostDetailModalProps {
  visible: boolean;
  host: HostProfile | null;
  isSaving: boolean;
  onClose: () => void;
  onSave: (label: string) => void;
  onRemoveConnection: (serverId: string, connectionId: string) => Promise<void>;
  onRemoveHost: (host: HostProfile) => void;
  restartConfirmationMessage: string;
  waitForCondition: (
    predicate: () => boolean,
    timeoutMs: number,
    intervalMs?: number,
  ) => Promise<boolean>;
  isScreenMountedRef: MutableRefObject<boolean>;
}

function HostDetailModal({
  visible,
  host,
  isSaving,
  onClose,
  onSave,
  onRemoveConnection,
  onRemoveHost,
  restartConfirmationMessage,
  waitForCondition,
  isScreenMountedRef,
}: HostDetailModalProps) {
  const { theme } = useUnistyles();
  const [draftLabel, setDraftLabel] = useState("");
  const [pendingRemoveConnection, setPendingRemoveConnection] = useState<{
    serverId: string;
    connectionId: string;
    title: string;
  } | null>(null);
  const [isRemovingConnection, setIsRemovingConnection] = useState(false);

  // Read per-connection probes from host runtime snapshots.
  const connections = host?.connections ?? [];

  // Restart logic (moved from DaemonCard)
  const runtimeSnapshot = useHostRuntimeSnapshot(host?.serverId ?? "");
  const runtimeClient = useHostRuntimeClient(host?.serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(host?.serverId ?? "");
  const runtime = getHostRuntimeStore();
  const daemonClient = runtimeClient;
  const daemonVersion = useSessionStore((state) =>
    host ? (state.sessions[host.serverId]?.serverInfo?.version ?? null) : null,
  );
  const probeByConnectionId = runtimeSnapshot?.probeByConnectionId ?? new Map();
  const connectionStatus = runtimeSnapshot?.connectionStatus ?? "connecting";
  const activeConnection = runtimeSnapshot?.activeConnection ?? null;
  const lastError = runtimeSnapshot?.lastError ?? null;
  const [isRestarting, setIsRestarting] = useState(false);
  const isHostConnected = useCallback(() => {
    if (!host) {
      return false;
    }
    return isHostRuntimeConnected(runtime.getSnapshot(host.serverId));
  }, [host, runtime]);

  const waitForDaemonRestart = useCallback(async () => {
    const disconnectTimeoutMs = 7000;
    const reconnectTimeoutMs = 30000;

    if (isHostConnected()) {
      await waitForCondition(() => !isHostConnected(), disconnectTimeoutMs);
    }

    const reconnected = await waitForCondition(() => isHostConnected(), reconnectTimeoutMs);

    if (isScreenMountedRef.current) {
      setIsRestarting(false);
      if (!reconnected && host) {
        Alert.alert(
          "Unable to reconnect",
          `${host.label} did not come back online. Please verify it restarted.`,
        );
      }
    }
  }, [host, isHostConnected, isScreenMountedRef, waitForCondition]);

  const beginServerRestart = useCallback(() => {
    if (!daemonClient || !host) return;

    if (!isHostConnected()) {
      Alert.alert(
        "Host offline",
        "This host is offline. Paseo reconnects automatically—wait until it's back online before restarting.",
      );
      return;
    }

    setIsRestarting(true);
    void daemonClient.restartServer(`settings_daemon_restart_${host.serverId}`).catch((error) => {
      console.error(`[Settings] Failed to restart daemon ${host.label}`, error);
      if (!isScreenMountedRef.current) return;
      setIsRestarting(false);
      Alert.alert(
        "Error",
        "Failed to send the restart request. Paseo reconnects automatically—try again once the host shows as online.",
      );
    });

    void waitForDaemonRestart();
  }, [daemonClient, host, isHostConnected, isScreenMountedRef, waitForDaemonRestart]);

  const handleRestartPress = useCallback(() => {
    if (!daemonClient || !host) {
      Alert.alert(
        "Host unavailable",
        "This host is not connected. Wait for it to come online before restarting.",
      );
      return;
    }

    void confirmDialog({
      title: `Restart ${host.label}`,
      message: restartConfirmationMessage,
      confirmLabel: "Restart",
      cancelLabel: "Cancel",
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        beginServerRestart();
      })
      .catch((error) => {
        console.error(`[Settings] Failed to open restart confirmation for ${host.label}`, error);
        Alert.alert("Error", "Unable to open the restart confirmation dialog.");
      });
  }, [beginServerRestart, daemonClient, host, restartConfirmationMessage]);

  // Status display
  const statusLabel = formatConnectionStatus(connectionStatus);
  const statusTone = getConnectionStatusTone(connectionStatus);
  const statusColor =
    statusTone === "success"
      ? theme.colors.palette.green[400]
      : statusTone === "warning"
        ? theme.colors.palette.amber[500]
        : statusTone === "error"
          ? theme.colors.destructive
          : theme.colors.foregroundMuted;
  const statusPillBg =
    statusTone === "success"
      ? "rgba(74, 222, 128, 0.1)"
      : statusTone === "warning"
        ? "rgba(245, 158, 11, 0.1)"
        : statusTone === "error"
          ? "rgba(248, 113, 113, 0.1)"
          : "rgba(161, 161, 170, 0.1)";
  const connectionBadge = (() => {
    return formatActiveConnectionBadge({
      activeConnection,
      theme,
    });
  })();
  const versionBadgeText = formatDaemonVersionBadge(daemonVersion);
  const connectionError =
    typeof lastError === "string" && lastError.trim().length > 0 ? lastError.trim() : null;

  const handleDraftLabelChange = useCallback((nextValue: string) => {
    setDraftLabel(nextValue);
  }, []);

  useEffect(() => {
    if (!visible || !host) return;
    // Initialize once per modal open / host switch; keep user edits fully local while typing.
    setDraftLabel(host.label ?? "");
  }, [visible, host?.serverId]);

  useEffect(() => {
    if (!visible) {
      setIsRestarting(false);
      setDraftLabel("");
    }
  }, [visible]);

  return (
    <>
      <AdaptiveModalSheet
        title={host?.label ?? "Host"}
        visible={visible}
        onClose={onClose}
        testID="host-detail-modal"
      >
        {/* Status row */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing[2] }}>
          <View style={[styles.statusPill, { backgroundColor: statusPillBg }]}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
          {connectionBadge ? (
            <View style={styles.connectionPill}>
              {connectionBadge.icon}
              <Text style={styles.connectionText} numberOfLines={1}>
                {connectionBadge.text}
              </Text>
            </View>
          ) : null}
          {versionBadgeText ? (
            <View style={styles.versionPill}>
              <Text style={styles.connectionText} numberOfLines={1}>
                {versionBadgeText}
              </Text>
            </View>
          ) : null}
        </View>
        {connectionError ? (
          <Text style={{ color: theme.colors.palette.red[300], fontSize: theme.fontSize.xs }}>
            {connectionError}
          </Text>
        ) : null}

        {/* Label */}
        <View style={styles.formField}>
          <Text style={styles.label}>Label</Text>
          <AdaptiveTextInput
            style={styles.input}
            value={draftLabel}
            onChangeText={handleDraftLabelChange}
            placeholder="My Host"
            placeholderTextColor={theme.colors.foregroundMuted}
          />
        </View>

        {/* Connections */}
        {host ? (
          <View style={styles.formField}>
            <Text style={styles.label}>Connections</Text>
            <View style={{ gap: 8 }}>
              {host.connections.map((conn) => {
                const probe = probeByConnectionId.get(conn.id);
                return (
                  <ConnectionRow
                    key={conn.id}
                    connection={conn}
                    latencyMs={probe?.status === "available" ? probe.latencyMs : undefined}
                    latencyLoading={!probe || probe.status === "pending"}
                    latencyError={probe?.status === "unavailable"}
                    onRemove={() => {
                      const title = formatHostConnectionLabel(conn);
                      setPendingRemoveConnection({
                        serverId: host.serverId,
                        connectionId: conn.id,
                        title,
                      });
                    }}
                  />
                );
              })}
            </View>
          </View>
        ) : null}

        {/* Save/Cancel + Advanced */}
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            marginTop: theme.spacing[2],
            paddingTop: theme.spacing[4],
          }}
        >
          <View
            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                style={({ pressed }) => [styles.advancedTrigger, pressed && { opacity: 0.85 }]}
              >
                <Settings size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                <Text style={styles.advancedTriggerText}>Advanced</Text>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" width={220}>
                <DropdownMenuItem
                  onSelect={handleRestartPress}
                  leading={
                    <RotateCw size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
                  }
                  status={isRestarting ? "pending" : "idle"}
                  pendingLabel="Restarting..."
                  disabled={!daemonClient || !isConnected}
                >
                  Restart daemon
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    if (host) onRemoveHost(host);
                  }}
                  leading={<Trash2 size={theme.iconSize.md} color={theme.colors.destructive} />}
                >
                  Remove host
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <View style={styles.formActionsRow}>
              <Button variant="secondary" size="sm" onPress={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onPress={() => onSave(draftLabel)}
                disabled={isSaving}
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </View>
          </View>
        </View>
      </AdaptiveModalSheet>

      {/* Remove connection confirmation */}
      {pendingRemoveConnection ? (
        <AdaptiveModalSheet
          title="Remove connection"
          visible
          onClose={() => {
            if (isRemovingConnection) return;
            setPendingRemoveConnection(null);
          }}
          testID="remove-connection-confirm-modal"
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
            Remove {pendingRemoveConnection.title}? This cannot be undone.
          </Text>
          <View style={[styles.formActionsRow, { marginTop: theme.spacing[4] }]}>
            <Button
              variant="secondary"
              size="sm"
              style={{ flex: 1 }}
              onPress={() => setPendingRemoveConnection(null)}
              disabled={isRemovingConnection}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              style={{ flex: 1 }}
              onPress={() => {
                const { serverId, connectionId } = pendingRemoveConnection;
                setIsRemovingConnection(true);
                void onRemoveConnection(serverId, connectionId)
                  .then(() => setPendingRemoveConnection(null))
                  .catch((error) => {
                    console.error("[Settings] Failed to remove connection", error);
                    Alert.alert("Error", "Unable to remove connection");
                  })
                  .finally(() => setIsRemovingConnection(false));
              }}
              disabled={isRemovingConnection}
              testID="remove-connection-confirm"
            >
              Remove
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// ConnectionRow (unchanged)
// ---------------------------------------------------------------------------

function ConnectionRow({
  connection,
  latencyMs,
  latencyLoading,
  latencyError,
  onRemove,
}: {
  connection: HostConnection;
  latencyMs: number | null | undefined;
  latencyLoading: boolean;
  latencyError: boolean;
  onRemove: () => void;
}) {
  const { theme } = useUnistyles();
  const title = formatHostConnectionLabel(connection);

  const latencyText = (() => {
    if (latencyLoading) return "...";
    if (latencyError) return "Timeout";
    if (latencyMs != null) return `${latencyMs}ms`;
    return "\u2014";
  })();

  const latencyColor = latencyError ? theme.colors.palette.red[300] : theme.colors.foregroundMuted;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }}>{title}</Text>
      <Text style={{ color: latencyColor, fontSize: 11 }}>{latencyText}</Text>
      <Button
        variant="ghost"
        size="sm"
        textStyle={{ color: theme.colors.destructive }}
        onPress={onRemove}
      >
        Remove
      </Button>
    </View>
  );
}

// ---------------------------------------------------------------------------
// DaemonCard (unchanged)
// ---------------------------------------------------------------------------

interface DaemonCardProps {
  daemon: HostProfile;
  onOpenSettings: (daemon: HostProfile) => void;
}

function DaemonCard({ daemon, onOpenSettings }: DaemonCardProps) {
  const { theme } = useUnistyles();
  const snapshot = useHostRuntimeSnapshot(daemon.serverId);
  const connectionStatus = snapshot?.connectionStatus ?? "connecting";
  const activeConnection = snapshot?.activeConnection ?? null;
  const lastError = snapshot?.lastError ?? null;
  const daemonVersion = useSessionStore(
    useCallback(
      (state) => state.sessions[daemon.serverId]?.serverInfo?.version ?? null,
      [daemon.serverId],
    ),
  );
  const statusLabel = formatConnectionStatus(connectionStatus);
  const statusTone = getConnectionStatusTone(connectionStatus);
  const statusColor =
    statusTone === "success"
      ? theme.colors.palette.green[400]
      : statusTone === "warning"
        ? theme.colors.palette.amber[500]
        : statusTone === "error"
          ? theme.colors.destructive
          : theme.colors.foregroundMuted;
  const badgeText = statusLabel;
  const connectionError =
    typeof lastError === "string" && lastError.trim().length > 0 ? lastError.trim() : null;
  const statusPillBg =
    statusTone === "success"
      ? "rgba(74, 222, 128, 0.1)"
      : statusTone === "warning"
        ? "rgba(245, 158, 11, 0.1)"
        : statusTone === "error"
          ? "rgba(248, 113, 113, 0.1)"
          : "rgba(161, 161, 170, 0.1)";
  const connectionBadge = (() => {
    return formatActiveConnectionBadge({
      activeConnection,
      theme,
    });
  })();
  const versionBadgeText = formatDaemonVersionBadge(daemonVersion);

  return (
    <View style={[settingsStyles.card, styles.hostCard]} testID={`daemon-card-${daemon.serverId}`}>
      <View style={styles.hostCardContent}>
        <View style={styles.hostHeaderRow}>
          <Text style={styles.hostLabel} numberOfLines={1}>
            {daemon.label}
          </Text>
          <View style={styles.hostHeaderRight}>
            <View
              style={[
                isWeb ? styles.statusPill : styles.statusPillMobile,
                { backgroundColor: statusPillBg },
              ]}
            >
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              {isWeb ? (
                <Text style={[styles.statusText, { color: statusColor }]}>{badgeText}</Text>
              ) : null}
            </View>

            {connectionBadge ? (
              <View style={isWeb ? styles.connectionPill : styles.connectionPillMobile}>
                {connectionBadge.icon}
                {isWeb ? (
                  <Text style={styles.connectionText} numberOfLines={1}>
                    {connectionBadge.text}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {versionBadgeText ? (
              <View style={styles.versionPill}>
                <Text style={styles.connectionText} numberOfLines={1}>
                  {versionBadgeText}
                </Text>
              </View>
            ) : null}

            <Pressable
              style={styles.hostSettingsButton}
              onPress={() => onOpenSettings(daemon)}
              testID={`daemon-card-settings-${daemon.serverId}`}
              accessibilityLabel={`Open settings for ${daemon.label}`}
              accessibilityRole="button"
            >
              {({ hovered = false, pressed = false }) => (
                <Settings
                  size={theme.iconSize.sm}
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )}
            </Pressable>
          </View>
        </View>
        {connectionError ? <Text style={styles.hostError}>{connectionError}</Text> : null}
      </View>
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
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    marginBottom: theme.spacing[2],
  },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  // Host card styles
  hostCard: {
    marginBottom: theme.spacing[3],
    overflow: "hidden",
  },
  hostCardContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  hostHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  hostHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  hostLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
    flexShrink: 1,
  },
  hostError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  // Status pill
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
  },
  statusPillMobile: {
    alignItems: "center",
    justifyContent: "center",
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  connectionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    maxWidth: 170,
  },
  connectionPillMobile: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.full,
  },
  connectionText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  versionPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    maxWidth: 200,
  },
  hostSettingsButton: {
    width: 28,
    height: 28,
    paddingVertical: 0,
    paddingHorizontal: 0,
    borderRadius: theme.borderRadius.md,
    gap: 0,
    marginLeft: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
  },
  advancedTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "transparent",
  },
  advancedTriggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
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
  disabled: {
    opacity: theme.opacity[50],
  },
  testResultText: {
    fontSize: theme.fontSize.xs,
  },
  // Add host button
  addButton: {
    borderStyle: "dashed",
  },
  addButtonText: {
    color: theme.colors.foregroundMuted,
  },
  // Add/Edit form
  formCard: {
    padding: theme.spacing[4],
    marginBottom: theme.spacing[3],
    gap: theme.spacing[4],
  },
  formTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  formField: {
    gap: theme.spacing[2],
  },
  formActionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  formButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  formButtonPrimary: {
    backgroundColor: theme.colors.palette.blue[500],
    borderColor: theme.colors.palette.blue[500],
  },
  formButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  formButtonPrimaryText: {
    color: theme.colors.palette.white,
  },
  providerRefreshButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.full,
    justifyContent: "center",
  },
  providerRefreshButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  providerRefreshButtonDisabled: {
    opacity: 0.5,
  },
  // Audio settings card
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
  aboutValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  aboutHintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: 2,
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
  // Empty state
  emptyCard: {
    padding: theme.spacing[4],
    marginBottom: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  // Dev section
  devCard: {
    overflow: "hidden",
  },
  devButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  devButtonBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  devButtonContent: {
    flex: 1,
  },
  devButtonTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  devButtonDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
}));

const desktopStyles = StyleSheet.create((theme) => ({
  row: {
    flex: 1,
    flexDirection: "row",
  },
  sidebar: {
    width: 200,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[1],
  },
  sidebarItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  sidebarLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  sidebarSeparator: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    marginVertical: theme.spacing[2],
    marginHorizontal: theme.spacing[3],
  },
  contentPane: {
    flex: 1,
  },
}));
