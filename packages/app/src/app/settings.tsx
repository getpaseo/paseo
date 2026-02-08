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
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { useQueries } from "@tanstack/react-query";
import { Sun, Moon, Monitor, Globe, Settings, RotateCw, Trash2 } from "lucide-react-native";
import { useAppSettings, type AppSettings } from "@/hooks/use-settings";
import { useDaemonRegistry, type HostProfile, type HostConnection } from "@/contexts/daemon-registry-context";
import { useDaemonConnections, type ActiveConnection, type ConnectionStatus } from "@/contexts/daemon-connections-context";
import { formatConnectionStatus, getConnectionStatusTone } from "@/utils/daemons";
import { measureConnectionLatency } from "@/utils/test-daemon-connection";
import { theme as defaultTheme } from "@/styles/theme";
import { MenuHeader } from "@/components/headers/menu-header";
import { useSessionStore } from "@/stores/session-store";
import { AddHostMethodModal } from "@/components/add-host-method-modal";
import { AddHostModal } from "@/components/add-host-modal";
import { PairLinkModal } from "@/components/pair-link-modal";
import { NameHostModal } from "@/components/name-host-modal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";

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
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    letterSpacing: 0.4,
    textTransform: "uppercase",
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
  hostCardPressed: {
    opacity: 0.85,
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
  audioRowDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  // Footer
  footer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[3],
  },
  footerAppInfo: {
    alignItems: "center",
    gap: theme.spacing[1],
  },
  footerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footerVersion: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  resetButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  resetButtonText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
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
  // Theme toggle
  themeToggleContainer: {
    flexDirection: "row",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: 4,
    gap: 4,
  },
  themeToggleButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  themeToggleButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  themeToggleText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  themeToggleTextActive: {
    color: theme.colors.foreground,
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


export default function SettingsScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ editHost?: string }>();
  const { settings, isLoading: settingsLoading, updateSettings, resetSettings } = useAppSettings();
  const {
    daemons,
    isLoading: daemonLoading,
    updateHost,
    removeHost,
    removeConnection,
  } = useDaemonRegistry();
  const { connectionStates } = useDaemonConnections();
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
  const appVersion = Constants.expoConfig?.version ?? (Constants as any).manifest?.version ?? "0.1.0";
  const editingDaemonLive = editingDaemon
    ? daemons.find((daemon) => daemon.serverId === editingDaemon.serverId) ?? null
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
    if (!editingDaemon) return;
    if (isSavingEdit) return;

    const nextLabel = nextLabelRaw.trim();
    if (!nextLabel) {
      Alert.alert("Label required", "Enter a label for this host.");
      return;
    }

    try {
      setIsSavingEdit(true);
      await updateHost(editingDaemon.serverId, { label: nextLabel });
      handleCloseEditDaemon();
    } catch (error) {
      console.error("[Settings] Failed to rename host", error);
      Alert.alert("Error", "Unable to save host");
    } finally {
      setIsSavingEdit(false);
    }
  }, [editingDaemon, handleCloseEditDaemon, isSavingEdit, updateHost]);

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
    if (!editingDaemon) return;
    const serverId = editingDaemon.serverId;
    setEditingDaemon(null);
    setAddConnectionTargetServerId(serverId);
    setPendingEditReopenServerId(serverId);
    setIsAddHostMethodVisible(true);
  }, [editingDaemon]);

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

  function handleReset() {
    Alert.alert(
      "Reset settings",
      "Are you sure you want to reset all settings to defaults?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            try {
              await resetSettings();
              Alert.alert(
                "Settings reset",
                "All settings have been reset to defaults."
              );
            } catch (error) {
              Alert.alert(
                "Error",
                "Failed to reset settings. Please try again."
              );
            }
          },
        },
      ]
    );
  }

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
                const connection = connectionStates.get(daemon.serverId);
                const connectionStatus = connection?.status ?? "idle";
                const activeConnection = connection?.activeConnection ?? null;
                const lastConnectionError = connection?.lastError ?? null;
                return (
                  <DaemonCard
                    key={daemon.serverId}
                    daemon={daemon}
                    connectionStatus={connectionStatus}
                    activeConnection={activeConnection}
                    lastError={lastConnectionError}
                    onPress={handleEditDaemon}
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
	              closeAddConnectionFlow();
	              router.push({
	                pathname: "/pair-scan",
	                params: targetServerId ? { source, targetServerId } : { source },
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
            visible={Boolean(editingDaemon)}
            host={editingDaemonLive ?? editingDaemon}
            connectionStatus={editingDaemon ? (connectionStates.get(editingDaemon.serverId)?.status ?? "idle") : "idle"}
            activeConnection={editingDaemon ? (connectionStates.get(editingDaemon.serverId)?.activeConnection ?? null) : null}
            lastError={editingDaemon ? (connectionStates.get(editingDaemon.serverId)?.lastError ?? null) : null}
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
            <View style={styles.themeToggleContainer}>
              <Pressable
                style={[
                  styles.themeToggleButton,
                  settings.theme === "light" && styles.themeToggleButtonActive,
                ]}
                onPress={() => handleThemeChange("light")}
              >
                <Sun size={16} color={settings.theme === "light" ? defaultTheme.colors.foreground : defaultTheme.colors.mutedForeground} />
                <Text style={[styles.themeToggleText, settings.theme === "light" && styles.themeToggleTextActive]}>
                  Light
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.themeToggleButton,
                  settings.theme === "dark" && styles.themeToggleButtonActive,
                ]}
                onPress={() => handleThemeChange("dark")}
              >
                <Moon size={16} color={settings.theme === "dark" ? defaultTheme.colors.foreground : defaultTheme.colors.mutedForeground} />
                <Text style={[styles.themeToggleText, settings.theme === "dark" && styles.themeToggleTextActive]}>
                  Dark
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.themeToggleButton,
                  settings.theme === "auto" && styles.themeToggleButtonActive,
                ]}
                onPress={() => handleThemeChange("auto")}
              >
                <Monitor size={16} color={settings.theme === "auto" ? defaultTheme.colors.foreground : defaultTheme.colors.mutedForeground} />
                <Text style={[styles.themeToggleText, settings.theme === "auto" && styles.themeToggleTextActive]}>
                  System
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Footer */}
          <View style={styles.footer}>
            <View style={styles.footerAppInfo}>
              <Text style={styles.footerText}>Paseo</Text>
              <Text style={styles.footerVersion}>Version {appVersion}</Text>
            </View>
            <Pressable style={styles.resetButton} onPress={handleReset}>
              <Text style={styles.resetButtonText}>Reset to defaults</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

interface HostDetailModalProps {
  visible: boolean;
  host: HostProfile | null;
  connectionStatus: ConnectionStatus;
  activeConnection: ActiveConnection | null;
  lastError: string | null;
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
  connectionStatus,
  activeConnection,
  lastError,
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
  const activeServerIdRef = useRef<string | null>(null);
  const [pendingRemoveConnection, setPendingRemoveConnection] = useState<{ serverId: string; connectionId: string; title: string } | null>(null);
  const [isRemovingConnection, setIsRemovingConnection] = useState(false);

  // Latency probes for each connection
  const connections = host?.connections ?? [];
  const latencyQueries = useQueries({
    queries: connections.map((conn) => ({
      queryKey: ["connection-latency", conn.id],
      queryFn: () => measureConnectionLatency(conn, { serverId: host?.serverId }),
      enabled: visible,
      refetchInterval: 5_000,
      staleTime: 4_000,
      gcTime: 60_000,
      retry: 1,
    })),
  });
  const latencyByConnectionId = new Map(
    connections.map((conn, i) => [conn.id, latencyQueries[i]] as const)
  );

  // Restart logic (moved from DaemonCard)
  const daemonClient = useSessionStore((state) => host ? (state.sessions[host.serverId]?.client ?? null) : null);
  const daemonConnection = useSessionStore((state) => host ? (state.sessions[host.serverId]?.connection ?? null) : null);
  const isConnected = daemonConnection?.isConnected ?? false;
  const isConnectedRef = useRef(isConnected);
  const [isRestarting, setIsRestarting] = useState(false);

  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  const waitForDaemonRestart = useCallback(async () => {
    const disconnectTimeoutMs = 7000;
    const reconnectTimeoutMs = 30000;

    if (isConnectedRef.current) {
      await waitForCondition(() => !isConnectedRef.current, disconnectTimeoutMs);
    }

    const reconnected = await waitForCondition(() => isConnectedRef.current, reconnectTimeoutMs);

    if (isScreenMountedRef.current) {
      setIsRestarting(false);
      if (!reconnected && host) {
        Alert.alert(
          "Unable to reconnect",
          `${host.label} did not come back online. Please verify it restarted.`
        );
      }
    }
  }, [host, isScreenMountedRef, waitForCondition]);

  const beginServerRestart = useCallback(() => {
    if (!daemonClient || !host) return;

    if (!isConnectedRef.current) {
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
  }, [daemonClient, host, isScreenMountedRef, waitForDaemonRestart]);

  const handleRestartPress = useCallback(() => {
    if (!daemonClient || !host) {
      Alert.alert(
        "Host unavailable",
        "This host is not connected. Wait for it to come online before restarting."
      );
      return;
    }

    if (Platform.OS === "web") {
      const hasBrowserConfirm =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as any).confirm === "function";

      const confirmed = hasBrowserConfirm
        ? (globalThis as any).confirm(`Restart ${host.label}? ${restartConfirmationMessage}`)
        : true;

      if (confirmed) {
        beginServerRestart();
      }
      return;
    }

    Alert.alert(`Restart ${host.label}`, restartConfirmationMessage, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Restart",
        style: "destructive",
        onPress: beginServerRestart,
      },
    ]);
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
      return { icon: <Globe size={12} color={theme.colors.foregroundMuted} />, text: "Relay" };
    }
    return {
      icon: <Monitor size={12} color={theme.colors.foregroundMuted} />,
      text: activeConnection.display,
    };
  })();
  const connectionError = typeof lastError === "string" && lastError.trim().length > 0 ? lastError.trim() : null;

  useEffect(() => {
    if (!visible || !host) return;
    if (activeServerIdRef.current !== host.serverId) {
      setDraftLabel(host.label ?? "");
      activeServerIdRef.current = host.serverId;
      return;
    }
    if (!draftLabel.trim()) {
      setDraftLabel(host.label ?? "");
    }
  }, [visible, host, draftLabel]);

  useEffect(() => {
    if (!visible) {
      activeServerIdRef.current = null;
      setIsRestarting(false);
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
            onChangeText={setDraftLabel}
            placeholder="My Host"
            placeholderTextColor={defaultTheme.colors.mutedForeground}
          />
        </View>

        {/* Connections */}
        {host ? (
          <View style={styles.formField}>
            <Text style={styles.label}>Connections</Text>
            <View style={{ gap: 8 }}>
              {host.connections.map((conn) => {
                const latency = latencyByConnectionId.get(conn.id);
                return (
                  <ConnectionRow
                    key={conn.id}
                    connection={conn}
                    latencyMs={latency?.data ?? undefined}
                    latencyLoading={latency?.isLoading ?? false}
                    latencyError={latency?.isError ?? false}
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
                <Settings size={14} color={theme.colors.foregroundMuted} />
                <Text style={styles.advancedTriggerText}>Advanced</Text>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" width={220}>
                <DropdownMenuItem
                  onSelect={handleRestartPress}
                  leading={<RotateCw size={16} color={theme.colors.foregroundMuted} />}
                  status={isRestarting ? "pending" : "idle"}
                  pendingLabel="Restarting..."
                  disabled={!daemonClient || !isConnectedRef.current}
                >
                  Restart daemon
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => { if (host) onRemoveHost(host); }}
                  leading={<Trash2 size={16} color={theme.colors.destructive} />}
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
  connectionStatus: ConnectionStatus;
  activeConnection: ActiveConnection | null;
  lastError: string | null;
  onPress: (daemon: HostProfile) => void;
}

function DaemonCard({
  daemon,
  connectionStatus,
  activeConnection,
  lastError,
  onPress,
}: DaemonCardProps) {
  const { theme } = useUnistyles();
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
      return { icon: <Globe size={12} color={theme.colors.foregroundMuted} />, text: "Relay" };
    }
    return {
      icon: <Monitor size={12} color={theme.colors.foregroundMuted} />,
      text: activeConnection.display,
    };
  })();

  return (
    <Pressable
      style={({ pressed }) => [styles.hostCard, pressed && styles.hostCardPressed]}
      onPress={() => onPress(daemon)}
      testID={`daemon-card-${daemon.serverId}`}
      accessibilityRole="button"
      accessibilityLabel={`${daemon.label}, ${statusLabel}`}
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
          </View>
        </View>
        {connectionError ? <Text style={styles.hostError}>{connectionError}</Text> : null}
      </View>
    </Pressable>
  );
}
