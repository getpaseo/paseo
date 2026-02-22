import { useState, useEffect, useRef, useCallback } from "react";
import type { MutableRefObject } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Alert,
  Platform,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import Constants from "expo-constants";
import appPackage from "../../package.json";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { Sun, Moon, Monitor, Globe, Settings, RotateCw, Trash2 } from "lucide-react-native";
import { useAppSettings, type AppSettings } from "@/hooks/use-settings";
import { useDaemonRegistry, type HostProfile, type HostConnection } from "@/contexts/daemon-registry-context";
import { formatConnectionStatus, getConnectionStatusTone } from "@/utils/daemons";
import { confirmDialog } from "@/utils/confirm-dialog";
import { MenuHeader } from "@/components/headers/menu-header";
import { useSessionStore } from "@/stores/session-store";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeSession,
} from "@/runtime/host-runtime";
import { AddHostMethodModal } from "@/components/add-host-method-modal";
import { AddHostModal } from "@/components/add-host-modal";
import { PairLinkModal } from "@/components/pair-link-modal";
import { NameHostModal } from "@/components/name-host-modal";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { DesktopPermissionsSection } from "@/desktop/components/desktop-permissions-section";
import { LocalDaemonSection } from "@/desktop/components/desktop-updates-section";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      clearTimeout(timeout);
      resolve();
    }, ms);
  });

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
  section: {
    marginBottom: theme.spacing[6],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
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
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
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
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
    backgroundColor: "transparent",
    marginLeft: theme.spacing[2],
  },
  hostSettingsButtonActive: {
    backgroundColor: theme.colors.surface3,
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
  disabled: {
    opacity: theme.opacity[50],
  },
  testResultText: {
    fontSize: theme.fontSize.xs,
  },
  // Add host button
  addButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderStyle: "dashed",
  },
  addButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  // Add/Edit form
  formCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
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
  // Audio settings card
  audioCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
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
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
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
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
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

function resolveAppVersion(): string | null {
  const packageVersion = appPackage?.version;
  if (typeof packageVersion === "string" && packageVersion.trim().length > 0) {
    return packageVersion.trim();
  }

  const expoVersion = Constants.expoConfig?.version;
  if (typeof expoVersion === "string" && expoVersion.trim().length > 0) {
    return expoVersion.trim();
  }

  const manifestVersion = (Constants as any).manifest?.version;
  if (typeof manifestVersion === "string" && manifestVersion.trim().length > 0) {
    return manifestVersion.trim();
  }

  return null;
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

function formatVersionForDisplay(version: string | null | undefined): string {
  const value = version?.trim();
  if (!value) {
    return "\u2014";
  }

  if (value.startsWith("v")) {
    return value;
  }

  return `v${value}`;
}

function DesktopAppUpdateRow() {
  const {
    isDesktop,
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
      if (!isDesktop) {
        return undefined;
      }
      void checkForUpdates({ silent: true });
      return undefined;
    }, [checkForUpdates, isDesktop])
  );

  const handleCheckForUpdates = useCallback(() => {
    if (!isDesktop) {
      return;
    }
    void checkForUpdates();
  }, [checkForUpdates, isDesktop]);

  const handleInstallUpdate = useCallback(() => {
    if (!isDesktop) {
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
  }, [installUpdate, isDesktop]);

  if (!isDesktop) {
    return null;
  }

  return (
    <View style={[styles.audioRow, styles.audioRowBorder]}>
      <View style={styles.audioRowContent}>
        <Text style={styles.audioRowTitle}>App updates</Text>
        <Text style={styles.aboutHintText}>{statusText}</Text>
        {availableUpdate?.latestVersion ? (
          <Text style={styles.aboutHintText}>
            New version available: {formatVersionWithPrefix(availableUpdate.latestVersion)}
          </Text>
        ) : null}
        {errorMessage ? <Text style={styles.aboutErrorText}>{errorMessage}</Text> : null}
      </View>
      <View style={styles.aboutUpdateActions}>
        <Button
          variant="secondary"
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

export default function SettingsScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ editHost?: string; serverId?: string }>();
  const routeServerId = typeof params.serverId === "string" ? params.serverId.trim() : "";
  const { settings, isLoading: settingsLoading, updateSettings } = useAppSettings();
  const {
    daemons,
    isLoading: daemonLoading,
    updateHost,
    removeHost,
    removeConnection,
  } = useDaemonRegistry();
  const [isAddHostMethodVisible, setIsAddHostMethodVisible] = useState(false);
  const [isDirectHostVisible, setIsDirectHostVisible] = useState(false);
  const [isPasteLinkVisible, setIsPasteLinkVisible] = useState(false);
  const [addConnectionTargetServerId, setAddConnectionTargetServerId] = useState<string | null>(null);
  const [pendingEditReopenServerId, setPendingEditReopenServerId] = useState<string | null>(null);
  const [pendingNameHost, setPendingNameHost] = useState<{ serverId: string; hostname: string | null } | null>(null);
  const [pendingRemoveHost, setPendingRemoveHost] = useState<HostProfile | null>(null);
  const [isRemovingHost, setIsRemovingHost] = useState(false);
  const [editingDaemon, setEditingDaemon] = useState<HostProfile | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const isLoading = settingsLoading || daemonLoading;
  const isMountedRef = useRef(true);
  const lastHandledEditHostRef = useRef<string | null>(null);
  const isDesktop = Platform.OS === "web";
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionForDisplay(appVersion);
  const editingServerId = editingDaemon?.serverId ?? null;
  const editingDaemonLive = editingServerId
    ? daemons.find((daemon) => daemon.serverId === editingServerId) ?? null
    : null;
  const pendingNameHostname = useSessionStore(
    useCallback(
      (state) => {
        if (!pendingNameHost) return null;
        return state.sessions[pendingNameHost.serverId]?.serverInfo?.hostname ?? pendingNameHost.hostname ?? null;
      },
      [pendingNameHost]
    )
  );

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
    []
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
    setAddConnectionTargetServerId(null);
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

  useEffect(() => {
    if (!pendingEditReopenServerId) return;
    if (isAddHostMethodVisible || isDirectHostVisible || isPasteLinkVisible) return;
    const profile = daemons.find((daemon) => daemon.serverId === pendingEditReopenServerId) ?? null;
    setPendingEditReopenServerId(null);
    setAddConnectionTargetServerId(null);
    if (profile) {
      handleEditDaemon(profile);
    }
  }, [
    daemons,
    handleEditDaemon,
    isAddHostMethodVisible,
    isDirectHostVisible,
    isPasteLinkVisible,
    pendingEditReopenServerId,
  ]);

  const handleSaveEditDaemon = useCallback(async (nextLabelRaw: string) => {
    if (!editingServerId) return;
    if (isSavingEdit) return;

    const nextLabel = nextLabelRaw.trim();
    if (!nextLabel) {
      Alert.alert("Label required", "Enter a label for this host.");
      return;
    }

    try {
      setIsSavingEdit(true);
      await updateHost(editingServerId, { label: nextLabel });
      handleCloseEditDaemon();
    } catch (error) {
      console.error("[Settings] Failed to rename host", error);
      Alert.alert("Error", "Unable to save host");
    } finally {
      setIsSavingEdit(false);
    }
  }, [editingServerId, handleCloseEditDaemon, isSavingEdit, updateHost]);

  const handleRemoveConnection = useCallback(
    async (serverId: string, connectionId: string) => {
      await removeConnection(serverId, connectionId);
    },
    [removeConnection]
  );

  const handleRemoveDaemon = useCallback((profile: HostProfile) => {
    setEditingDaemon(null);
    setPendingRemoveHost(profile);
  }, []);

  const handleAddConnectionFromModal = useCallback(() => {
    if (!editingServerId) return;
    const serverId = editingServerId;
    setEditingDaemon(null);
    setAddConnectionTargetServerId(serverId);
    setPendingEditReopenServerId(serverId);
    setIsAddHostMethodVisible(true);
  }, [editingServerId]);

  const handleThemeChange = useCallback(
    (newTheme: AppSettings["theme"]) => {
      void updateSettings({ theme: newTheme });
      if (newTheme === "auto") {
        UnistylesRuntime.setAdaptiveThemes(true);
      } else {
        UnistylesRuntime.setAdaptiveThemes(false);
        UnistylesRuntime.setTheme(newTheme);
      }
    },
    [updateSettings]
  );

  const restartConfirmationMessage =
    "This will immediately stop the Paseo daemon process. The app will disconnect until it restarts.";

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

      <ScrollView style={styles.scrollView} contentContainerStyle={{ paddingBottom: insets.bottom }}>
        <View style={styles.content}>
          {/* Host Management */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Hosts</Text>

            {daemons.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>No hosts configured</Text>
              </View>
            ) : (
              daemons.map((daemon) => {
                return (
                  <DaemonCard
                    key={daemon.serverId}
                    daemon={daemon}
                    onOpenSettings={handleEditDaemon}
                  />
                );
              })
            )}

            <Pressable
              style={styles.addButton}
              onPress={() => {
                setAddConnectionTargetServerId(null);
                setPendingEditReopenServerId(null);
                setIsAddHostMethodVisible(true);
              }}
            >
              <Text style={styles.addButtonText}>+ Add connection</Text>
            </Pressable>
          </View>

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
            onScanQr={() => {
              const targetServerId = addConnectionTargetServerId;
              const source = targetServerId ? "editHost" : "settings";
              const sourceServerId = routeServerId || targetServerId || undefined;
              closeAddConnectionFlow();
              router.push({
                pathname: "/pair-scan",
                params: targetServerId
                    ? { source, targetServerId, sourceServerId }
                    : { source, sourceServerId },
              });
            }}
          />

          <AddHostModal
            visible={isDirectHostVisible}
            targetServerId={addConnectionTargetServerId ?? undefined}
            onClose={closeAddConnectionFlow}
            onCancel={goBackToAddConnectionMethods}
            onSaved={({ serverId, hostname, isNewHost }) => {
              if (isNewHost) {
                setPendingNameHost({ serverId, hostname });
              }
            }}
          />

          <PairLinkModal
            visible={isPasteLinkVisible}
            targetServerId={addConnectionTargetServerId ?? undefined}
            onClose={closeAddConnectionFlow}
            onCancel={goBackToAddConnectionMethods}
            onSaved={({ serverId, hostname, isNewHost }) => {
              if (isNewHost) {
                setPendingNameHost({ serverId, hostname });
              }
            }}
          />

          {pendingNameHost ? (
            <NameHostModal
              visible
              serverId={pendingNameHost.serverId}
              hostname={pendingNameHostname}
              onSkip={() => setPendingNameHost(null)}
              onSave={(label) => {
                void updateHost(pendingNameHost.serverId, { label }).finally(() => {
                  setPendingNameHost(null);
                });
              }}
            />
          ) : null}

          {pendingRemoveHost ? (
            <AdaptiveModalSheet
              title="Remove host"
              visible
              onClose={() => {
                if (isRemovingHost) return;
                setPendingRemoveHost(null);
              }}
              testID="remove-host-confirm-modal"
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
                Remove {pendingRemoveHost.label}? This will delete its saved connections.
              </Text>
              <View style={[styles.formActionsRow, { marginTop: theme.spacing[4] }]}>
                <Button
                  variant="secondary"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => setPendingRemoveHost(null)}
                  disabled={isRemovingHost}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => {
                    const serverId = pendingRemoveHost.serverId;
                    setIsRemovingHost(true);
                    void removeHost(serverId)
                      .then(() => setPendingRemoveHost(null))
                      .catch((error) => {
                        console.error("[Settings] Failed to remove host", error);
                        Alert.alert("Error", "Unable to remove host");
                      })
                      .finally(() => setIsRemovingHost(false));
                  }}
                  disabled={isRemovingHost}
                  testID="remove-host-confirm"
                >
                  Remove
                </Button>
              </View>
            </AdaptiveModalSheet>
          ) : null}

          <HostDetailModal
            visible={Boolean(editingDaemonLive)}
            host={editingDaemonLive}
            isSaving={isSavingEdit}
            onClose={handleCloseEditDaemon}
            onSave={(label) => void handleSaveEditDaemon(label)}
            onRemoveConnection={handleRemoveConnection}
            onRemoveHost={handleRemoveDaemon}
            onAddConnection={handleAddConnectionFromModal}
            restartConfirmationMessage={restartConfirmationMessage}
            waitForCondition={waitForCondition}
            isScreenMountedRef={isMountedRef}
          />

          {/* Appearance */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Appearance</Text>
            <View style={styles.audioCard}>
              <View style={styles.audioRow}>
                <View style={styles.audioRowContent}>
                  <Text style={styles.audioRowTitle}>Theme</Text>
                </View>
                <SegmentedControl
                  size="sm"
                  value={settings.theme}
                  onValueChange={handleThemeChange}
                  options={[
                    {
                      value: "light",
                      label: "Light",
                      icon: ({ color, size }) => <Sun size={size} color={color} />,
                    },
                    {
                      value: "dark",
                      label: "Dark",
                      icon: ({ color, size }) => <Moon size={size} color={color} />,
                    },
                    {
                      value: "auto",
                      label: "System",
                      icon: ({ color, size }) => <Monitor size={size} color={color} />,
                    },
                  ]}
                />
              </View>
            </View>
          </View>

          {isDesktop ? <DesktopPermissionsSection /> : null}
          {isDesktop ? <LocalDaemonSection appVersion={appVersion} /> : null}

          {/* About */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>About</Text>
            <View style={styles.audioCard}>
              <View style={styles.audioRow}>
                <View style={styles.audioRowContent}>
                  <Text style={styles.audioRowTitle}>Version</Text>
                </View>
                <Text style={styles.aboutValue}>{appVersionText}</Text>
              </View>
              {isDesktop ? <DesktopAppUpdateRow /> : null}
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

interface HostDetailModalProps {
  visible: boolean;
  host: HostProfile | null;
  isSaving: boolean;
  onClose: () => void;
  onSave: (label: string) => void;
  onRemoveConnection: (serverId: string, connectionId: string) => Promise<void>;
  onRemoveHost: (host: HostProfile) => void;
  onAddConnection: () => void;
  restartConfirmationMessage: string;
  waitForCondition: (predicate: () => boolean, timeoutMs: number, intervalMs?: number) => Promise<boolean>;
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
  onAddConnection,
  restartConfirmationMessage,
  waitForCondition,
  isScreenMountedRef,
}: HostDetailModalProps) {
  const { theme } = useUnistyles();
  const [draftLabel, setDraftLabel] = useState("");
  const [pendingRemoveConnection, setPendingRemoveConnection] = useState<{ serverId: string; connectionId: string; title: string } | null>(null);
  const [isRemovingConnection, setIsRemovingConnection] = useState(false);

  // Read per-connection probes from host runtime snapshots.
  const connections = host?.connections ?? [];

  // Restart logic (moved from DaemonCard)
  const { snapshot: runtimeSnapshot, client: runtimeClient, isConnected } = useHostRuntimeSession(
    host?.serverId ?? ""
  );
  const runtime = getHostRuntimeStore();
  const daemonClient = runtimeClient;
  const daemonVersion = useSessionStore((state) => host ? (state.sessions[host.serverId]?.serverInfo?.version ?? null) : null);
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
          `${host.label} did not come back online. Please verify it restarted.`
        );
      }
    }
  }, [host, isHostConnected, isScreenMountedRef, waitForCondition]);

  const beginServerRestart = useCallback(() => {
    if (!daemonClient || !host) return;

    if (!isHostConnected()) {
      Alert.alert(
        "Host offline",
        "This host is offline. Paseo reconnects automatically—wait until it's back online before restarting."
      );
      return;
    }

    setIsRestarting(true);
    void daemonClient
      .restartServer(`settings_daemon_restart_${host.serverId}`)
      .catch((error) => {
        console.error(`[Settings] Failed to restart daemon ${host.label}`, error);
        if (!isScreenMountedRef.current) return;
        setIsRestarting(false);
        Alert.alert(
          "Error",
          "Failed to send the restart request. Paseo reconnects automatically—try again once the host shows as online."
        );
      });

    void waitForDaemonRestart();
  }, [daemonClient, host, isHostConnected, isScreenMountedRef, waitForDaemonRestart]);

  const handleRestartPress = useCallback(() => {
    if (!daemonClient || !host) {
      Alert.alert(
        "Host unavailable",
        "This host is not connected. Wait for it to come online before restarting."
      );
      return;
    }

    void confirmDialog({
      title: `Restart ${host.label}`,
      message: restartConfirmationMessage,
      confirmLabel: "Restart",
      cancelLabel: "Cancel",
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) {
        return;
      }
      beginServerRestart();
    }).catch((error) => {
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
    if (!activeConnection) return null;
    if (activeConnection.type === "relay") {
      return { icon: <Globe size={theme.iconSize.xs} color={theme.colors.foregroundMuted} />, text: "Relay" };
    }
    return {
      icon: <Monitor size={theme.iconSize.xs} color={theme.colors.foregroundMuted} />,
      text: activeConnection.display,
    };
  })();
  const versionBadgeText = formatDaemonVersionBadge(daemonVersion);
  const connectionError = typeof lastError === "string" && lastError.trim().length > 0 ? lastError.trim() : null;

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
                      const title =
                        conn.type === "relay"
                          ? `Relay (${conn.relayEndpoint})`
                          : `Direct (${conn.endpoint})`;
                      setPendingRemoveConnection({ serverId: host.serverId, connectionId: conn.id, title });
                    }}
                  />
                );
              })}
              <Pressable
                style={styles.addButton}
                onPress={onAddConnection}
              >
                <Text style={styles.addButtonText}>+ Add connection</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* Save/Cancel + Advanced */}
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, marginTop: theme.spacing[2], paddingTop: theme.spacing[4] }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <DropdownMenu>
              <DropdownMenuTrigger
                style={({ pressed }) => [
                  styles.advancedTrigger,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Settings size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                <Text style={styles.advancedTriggerText}>Advanced</Text>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" width={220}>
                <DropdownMenuItem
                  onSelect={handleRestartPress}
                  leading={<RotateCw size={theme.iconSize.md} color={theme.colors.foregroundMuted} />}
                  status={isRestarting ? "pending" : "idle"}
                  pendingLabel="Restarting..."
                  disabled={!daemonClient || !isConnected}
                >
                  Restart daemon
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => { if (host) onRemoveHost(host); }}
                  leading={<Trash2 size={theme.iconSize.md} color={theme.colors.destructive} />}
                >
                  Remove host
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <View style={styles.formActionsRow}>
              <Button
                variant="secondary"
                size="sm"
                onPress={onClose}
                disabled={isSaving}
              >
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
  const title =
    connection.type === "relay"
      ? `Relay (${connection.relayEndpoint})`
      : `Direct (${connection.endpoint})`;

  const latencyText = (() => {
    if (latencyLoading) return "...";
    if (latencyError) return "Timeout";
    if (latencyMs != null) return `${latencyMs}ms`;
    return "\u2014";
  })();

  const latencyColor =
    latencyError
      ? theme.colors.palette.red[300]
      : theme.colors.foregroundMuted;

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
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }}>
        {title}
      </Text>
      <Text style={{ color: latencyColor, fontSize: 11 }}>
        {latencyText}
      </Text>
      <Pressable onPress={onRemove}>
        <Text style={{ color: theme.colors.destructive, fontSize: 12, fontWeight: "500" }}>
          Remove
        </Text>
      </Pressable>
    </View>
  );
}

interface DaemonCardProps {
  daemon: HostProfile;
  onOpenSettings: (daemon: HostProfile) => void;
}

function DaemonCard({
  daemon,
  onOpenSettings,
}: DaemonCardProps) {
  const { theme } = useUnistyles();
  const { snapshot } = useHostRuntimeSession(daemon.serverId);
  const connectionStatus = snapshot?.connectionStatus ?? "connecting";
  const activeConnection = snapshot?.activeConnection ?? null;
  const lastError = snapshot?.lastError ?? null;
  const daemonVersion = useSessionStore(
    useCallback(
      (state) => state.sessions[daemon.serverId]?.serverInfo?.version ?? null,
      [daemon.serverId]
    )
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
  const connectionError = typeof lastError === "string" && lastError.trim().length > 0 ? lastError.trim() : null;
  const statusPillBg =
    statusTone === "success"
      ? "rgba(74, 222, 128, 0.1)"
      : statusTone === "warning"
        ? "rgba(245, 158, 11, 0.1)"
        : statusTone === "error"
          ? "rgba(248, 113, 113, 0.1)"
          : "rgba(161, 161, 170, 0.1)";
  const connectionBadge = (() => {
    if (!activeConnection) return null;
    if (activeConnection.type === "relay") {
      return { icon: <Globe size={theme.iconSize.xs} color={theme.colors.foregroundMuted} />, text: "Relay" };
    }
    return {
      icon: <Monitor size={theme.iconSize.xs} color={theme.colors.foregroundMuted} />,
      text: activeConnection.display,
    };
  })();
  const versionBadgeText = formatDaemonVersionBadge(daemonVersion);

  return (
    <View
      style={styles.hostCard}
      testID={`daemon-card-${daemon.serverId}`}
    >
      <View style={styles.hostCardContent}>
        <View style={styles.hostHeaderRow}>
          <Text style={styles.hostLabel} numberOfLines={1}>{daemon.label}</Text>
          <View style={styles.hostHeaderRight}>
            <View style={[Platform.OS === "web" ? styles.statusPill : styles.statusPillMobile, { backgroundColor: statusPillBg }]}>
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              {Platform.OS === "web" ? (
                <Text style={[styles.statusText, { color: statusColor }]}>{badgeText}</Text>
              ) : null}
            </View>

            {connectionBadge ? (
              <View style={Platform.OS === "web" ? styles.connectionPill : styles.connectionPillMobile}>
                {connectionBadge.icon}
                {Platform.OS === "web" ? (
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
              style={({ pressed, hovered }) => [
                styles.hostSettingsButton,
                (pressed || hovered) && styles.hostSettingsButtonActive,
              ]}
              onPress={() => onOpenSettings(daemon)}
              testID={`daemon-card-settings-${daemon.serverId}`}
              accessibilityRole="button"
              accessibilityLabel={`Open settings for ${daemon.label}`}
            >
              {({ pressed, hovered }) => (
                <Settings
                  size={theme.iconSize.md}
                  color={pressed || hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
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
