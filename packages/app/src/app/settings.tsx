import { useState, useEffect, useRef, useCallback } from "react";
import type { MutableRefObject } from "react";
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Switch,
  Pressable,
  Alert,
  ActivityIndicator,
  Platform,
} from "react-native";
import { router } from "expo-router";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { Sun, Moon, Monitor } from "lucide-react-native";
import { Fonts } from "@/constants/theme";
import { useAppSettings, type AppSettings } from "@/hooks/use-settings";
import { useDaemonRegistry, type DaemonProfile } from "@/contexts/daemon-registry-context";
import { useDaemonConnections, type ConnectionStatus } from "@/contexts/daemon-connections-context";
import { formatConnectionStatus, getConnectionStatusTone } from "@/utils/daemons";
import { theme as defaultTheme } from "@/styles/theme";
import { MenuHeader } from "@/components/headers/menu-header";
import { useSessionStore } from "@/stores/session-store";
import { AddHostMethodModal } from "@/components/add-host-method-modal";
import { AddHostModal } from "@/components/add-host-modal";
import { PairLinkModal } from "@/components/pair-link-modal";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";

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
  },
  section: {
    marginBottom: theme.spacing[6],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
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
  inputUrl: {
    fontFamily: Fonts.mono,
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
    justifyContent: "space-between",
  },
  hostLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  hostUrl: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: Fonts.mono,
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
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  // Host actions
  hostActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[1],
  },
  hostActionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  hostActionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  hostActionPrimary: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  hostActionPrimaryText: {
    color: theme.colors.palette.white,
  },
  hostActionDestructiveText: {
    color: theme.colors.palette.red[500],
  },
  hostActionDisabled: {
    opacity: theme.opacity[50],
  },
  hostActionSeparator: {
    width: 1,
    height: 16,
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing[1],
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
    fontWeight: theme.fontWeight.semibold,
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
    fontWeight: theme.fontWeight.semibold,
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
    fontWeight: theme.fontWeight.semibold,
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
    fontWeight: theme.fontWeight.medium,
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
  const { settings, isLoading: settingsLoading, updateSettings, resetSettings } = useAppSettings();
  const {
    daemons,
    isLoading: daemonLoading,
    updateDaemon,
    removeDaemon,
  } = useDaemonRegistry();
  const { connectionStates, updateConnectionStatus } = useDaemonConnections();
  const [isAddHostMethodVisible, setIsAddHostMethodVisible] = useState(false);
  const [isDirectHostVisible, setIsDirectHostVisible] = useState(false);
  const [isPasteLinkVisible, setIsPasteLinkVisible] = useState(false);
  const [editingDaemon, setEditingDaemon] = useState<DaemonProfile | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const isLoading = settingsLoading || daemonLoading;
  const isMountedRef = useRef(true);

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

  const handleEditDaemon = useCallback((profile: DaemonProfile) => {
    setEditingDaemon(profile);
    setEditLabel(profile.label ?? "");
  }, []);

  const handleCloseEditDaemon = useCallback(() => {
    if (isSavingEdit) return;
    setEditingDaemon(null);
    setEditLabel("");
  }, [isSavingEdit]);

  const handleSaveEditDaemon = useCallback(async () => {
    if (!editingDaemon) return;
    if (isSavingEdit) return;

    const nextLabel = editLabel.trim();
    if (!nextLabel) {
      Alert.alert("Label required", "Enter a label for this host.");
      return;
    }

    try {
      setIsSavingEdit(true);
      await updateDaemon(editingDaemon.id, { label: nextLabel });
      handleCloseEditDaemon();
    } catch (error) {
      console.error("[Settings] Failed to rename host", error);
      Alert.alert("Error", "Unable to save host");
    } finally {
      setIsSavingEdit(false);
    }
  }, [editLabel, editingDaemon, handleCloseEditDaemon, isSavingEdit, updateDaemon]);

  const handleRemoveDaemon = useCallback(
    (profile: DaemonProfile) => {
      if (Platform.OS === "web") {
        const hasBrowserConfirm =
          typeof globalThis !== "undefined" &&
          typeof (globalThis as any).confirm === "function";

        const confirmed = hasBrowserConfirm ? (globalThis as any).confirm(`Remove ${profile.label}?`) : true;
        if (!confirmed) return;

        void removeDaemon(profile.id).catch((error) => {
          console.error("[Settings] Failed to remove daemon", error);
          Alert.alert("Error", "Unable to remove host");
        });
        return;
      }

      Alert.alert(
        "Remove host",
        `Remove ${profile.label}?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: async () => {
              try {
                await removeDaemon(profile.id);
              } catch (error) {
                console.error("[Settings] Failed to remove daemon", error);
                Alert.alert("Error", "Unable to remove host");
              }
            },
          },
        ]
      );
    },
    [removeDaemon]
  );

  const handleToggleUseSpeaker = useCallback(
    (value: boolean) => {
      void updateSettings({ ...settings, useSpeaker: value });
    },
    [settings, updateSettings]
  );

  const handleToggleKeepScreenOn = useCallback(
    (value: boolean) => {
      void updateSettings({ ...settings, keepScreenOn: value });
    },
    [settings, updateSettings]
  );

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
    "This will immediately stop the Voice Dev backend process. The app will disconnect until it restarts.";

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

      <ScrollView style={styles.scrollView}>
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
                const connection = connectionStates.get(daemon.id);
                const connectionStatus = connection?.status ?? "idle";
                const lastConnectionError = connection?.lastError ?? null;
                return (
                  <DaemonCard
                    key={daemon.id}
                    daemon={daemon}
                    connectionStatus={connectionStatus}
                    lastError={lastConnectionError}
                    onEdit={handleEditDaemon}
                    onRemove={handleRemoveDaemon}
                    restartConfirmationMessage={restartConfirmationMessage}
                    waitForCondition={waitForCondition}
                    isScreenMountedRef={isMountedRef}
                  />
                );
              })
            )}

            <Pressable
              style={styles.addButton}
              onPress={() => setIsAddHostMethodVisible(true)}
            >
              <Text style={styles.addButtonText}>+ Add host</Text>
            </Pressable>
          </View>

          <AddHostMethodModal
            visible={isAddHostMethodVisible}
            onClose={() => setIsAddHostMethodVisible(false)}
            onDirectConnection={() => setIsDirectHostVisible(true)}
            onPasteLink={() => setIsPasteLinkVisible(true)}
            onScanQr={() => router.push("/pair-scan")}
          />

          <AddHostModal
            visible={isDirectHostVisible}
            onClose={() => setIsDirectHostVisible(false)}
            onSaved={(profile) => {
              router.replace({ pathname: "/", params: { serverId: profile.id } });
            }}
          />

          <PairLinkModal
            visible={isPasteLinkVisible}
            onClose={() => setIsPasteLinkVisible(false)}
            onSaved={(profile) => {
              router.replace({ pathname: "/", params: { serverId: profile.id } });
            }}
          />

          <AdaptiveModalSheet
            title="Edit host"
            visible={Boolean(editingDaemon)}
            onClose={handleCloseEditDaemon}
            testID="edit-host-modal"
          >
            <View style={styles.formField}>
              <Text style={styles.label}>Label</Text>
              <TextInput
                style={styles.input}
                value={editLabel}
                onChangeText={setEditLabel}
                placeholder="My Host"
                placeholderTextColor={defaultTheme.colors.mutedForeground}
              />
            </View>

            <View style={styles.formActionsRow}>
              <Pressable
                style={[styles.formButton, isSavingEdit && styles.hostActionDisabled]}
                onPress={handleCloseEditDaemon}
                disabled={isSavingEdit}
              >
                <Text style={styles.formButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.formButton, styles.formButtonPrimary, isSavingEdit && styles.hostActionDisabled]}
                onPress={() => void handleSaveEditDaemon()}
                disabled={isSavingEdit}
              >
                <Text style={[styles.formButtonText, styles.formButtonPrimaryText]}>
                  {isSavingEdit ? "Saving..." : "Save"}
                </Text>
              </Pressable>
            </View>
          </AdaptiveModalSheet>

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

          {/* Audio Settings */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Audio</Text>

            <View style={styles.audioCard}>
              <View style={styles.audioRow}>
                <View style={styles.audioRowContent}>
                  <Text style={styles.audioRowTitle}>Use speaker</Text>
                  <Text style={styles.audioRowDescription}>
                    Play audio through speaker instead of earpiece
                  </Text>
                </View>
                <Switch
                  value={settings.useSpeaker}
                  onValueChange={handleToggleUseSpeaker}
                  trackColor={{ false: defaultTheme.colors.palette.gray[700], true: defaultTheme.colors.palette.blue[500] }}
                  thumbColor={settings.useSpeaker ? defaultTheme.colors.palette.white : defaultTheme.colors.palette.gray[300]}
                />
              </View>

              <View style={[styles.audioRow, styles.audioRowBorder]}>
                <View style={styles.audioRowContent}>
                  <Text style={styles.audioRowTitle}>Keep screen on</Text>
                  <Text style={styles.audioRowDescription}>
                    Prevent screen from sleeping during voice sessions
                  </Text>
                </View>
                <Switch
                  value={settings.keepScreenOn}
                  onValueChange={handleToggleKeepScreenOn}
                  trackColor={{ false: defaultTheme.colors.palette.gray[700], true: defaultTheme.colors.palette.blue[500] }}
                  thumbColor={settings.keepScreenOn ? defaultTheme.colors.palette.white : defaultTheme.colors.palette.gray[300]}
                />
              </View>
            </View>
          </View>

          {/* Developer */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Developer</Text>
            <View style={styles.devCard}>
              <Pressable
                style={styles.devButton}
                onPress={() => router.push("/audio-test")}
              >
                <View style={styles.devButtonContent}>
                  <Text style={styles.devButtonTitle}>Audio test</Text>
                  <Text style={styles.devButtonDescription}>
                    Test audio recording and playback
                  </Text>
                </View>
              </Pressable>
            </View>
          </View>

          {/* Footer */}
          <View style={styles.footer}>
            <View style={styles.footerAppInfo}>
              <Text style={styles.footerText}>Voice Dev Mobile</Text>
              <Text style={styles.footerVersion}>Version 1.0.0</Text>
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

interface DaemonCardProps {
  daemon: DaemonProfile;
  connectionStatus: ConnectionStatus;
  lastError: string | null;
  onEdit: (daemon: DaemonProfile) => void;
  onRemove: (daemon: DaemonProfile) => void;
  restartConfirmationMessage: string;
  waitForCondition: (predicate: () => boolean, timeoutMs: number, intervalMs?: number) => Promise<boolean>;
  isScreenMountedRef: MutableRefObject<boolean>;
}

function DaemonCard({
  daemon,
  connectionStatus,
  lastError,
  onEdit,
  onRemove,
  restartConfirmationMessage,
  waitForCondition,
  isScreenMountedRef,
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
  const daemonConnection = useSessionStore(
    (state) => state.sessions[daemon.id]?.connection ?? null
  );
  const restartServerFn = useSessionStore((state) => state.sessions[daemon.id]?.methods?.restartServer);
  const [isRestarting, setIsRestarting] = useState(false);
  const isConnected = daemonConnection?.isConnected ?? false;
  const isConnectedRef = useRef(isConnected);

  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  const waitForDaemonRestart = useCallback(async () => {
    const disconnectTimeoutMs = 7000;
    const reconnectTimeoutMs = 30000;

    // Wait for disconnect first
    if (isConnectedRef.current) {
      await waitForCondition(() => !isConnectedRef.current, disconnectTimeoutMs);
    }

    // Wait for auto-reconnect
    const reconnected = await waitForCondition(() => isConnectedRef.current, reconnectTimeoutMs);

    if (isScreenMountedRef.current) {
      setIsRestarting(false);
      if (!reconnected) {
        Alert.alert(
          "Unable to reconnect",
          `${daemon.label} did not come back online. Please verify it restarted.`
        );
      }
    }
  }, [daemon.label, isScreenMountedRef, waitForCondition]);

  const beginServerRestart = useCallback(() => {
    if (!restartServerFn) {
      Alert.alert(
        "Host unavailable",
        `${daemon.label} is not connected. Wait for it to come online before restarting.`
      );
      return;
    }

    if (!isConnectedRef.current) {
      Alert.alert(
        "Host offline",
        "This host is offline. Paseo reconnects automatically—wait until it's back online before restarting."
      );
      return;
    }

    setIsRestarting(true);
    try {
      restartServerFn(`settings_daemon_restart_${daemon.id}`);
    } catch (error) {
      console.error(`[Settings] Failed to restart daemon ${daemon.label}`, error);
      setIsRestarting(false);
      Alert.alert(
        "Error",
        "Failed to send the restart request. Paseo reconnects automatically—try again once the host shows as online."
      );
      return;
    }

    void waitForDaemonRestart();
  }, [daemon.id, daemon.label, restartServerFn, waitForDaemonRestart]);

  const handleRestartPress = useCallback(() => {
    if (!restartServerFn) {
      Alert.alert(
        "Host unavailable",
        `${daemon.label} is not connected. Wait for it to come online before restarting.`
      );
      return;
    }

    if (Platform.OS === "web") {
      const hasBrowserConfirm =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as any).confirm === "function";

      const confirmed = hasBrowserConfirm
        ? (globalThis as any).confirm(`Restart ${daemon.label}? ${restartConfirmationMessage}`)
        : true;

      if (confirmed) {
        beginServerRestart();
      }
      return;
    }

    Alert.alert(`Restart ${daemon.label}`, restartConfirmationMessage, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Restart",
        style: "destructive",
        onPress: beginServerRestart,
      },
    ]);
  }, [beginServerRestart, daemon.label, restartConfirmationMessage, restartServerFn]);

  // Status pill background with 10% opacity
  const statusPillBg =
    statusTone === "success"
      ? "rgba(74, 222, 128, 0.1)"
      : statusTone === "warning"
        ? "rgba(245, 158, 11, 0.1)"
        : statusTone === "error"
          ? "rgba(248, 113, 113, 0.1)"
          : "rgba(161, 161, 170, 0.1)";

  return (
    <View style={styles.hostCard} testID={`daemon-card-${daemon.id}`}>
      <View style={styles.hostCardContent}>
        <View style={styles.hostHeaderRow}>
          <Text style={styles.hostLabel}>{daemon.label}</Text>
          <View style={[styles.statusPill, { backgroundColor: statusPillBg }]}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>{badgeText}</Text>
          </View>
        </View>
        <Text style={styles.hostUrl}>{daemon.endpoints?.[0] ?? ""}</Text>
        {connectionError ? <Text style={styles.hostError}>{connectionError}</Text> : null}
      </View>
      <View style={styles.hostActionsRow}>
        <Pressable
          style={[styles.hostActionButton, isRestarting && styles.hostActionDisabled]}
          onPress={handleRestartPress}
          disabled={isRestarting}
        >
          {isRestarting ? (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <Text style={styles.hostActionText}>Restart</Text>
          )}
        </Pressable>
        <Pressable style={styles.hostActionButton} onPress={() => onEdit(daemon)}>
          <Text style={styles.hostActionText}>Edit</Text>
        </Pressable>
        <View style={styles.hostActionSeparator} />
        <Pressable style={styles.hostActionButton} onPress={() => onRemove(daemon)}>
          <Text style={[styles.hostActionText, styles.hostActionDestructiveText]}>Remove</Text>
        </Pressable>
      </View>
    </View>
  );
}
