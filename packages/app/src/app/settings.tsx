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
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useAppSettings } from "@/hooks/use-settings";
import { useDaemonRegistry, type DaemonProfile } from "@/contexts/daemon-registry-context";
import { useDaemonConnections, type ConnectionStatus } from "@/contexts/daemon-connections-context";
import { formatConnectionStatus, getConnectionStatusTone } from "@/utils/daemons";
import { theme as defaultTheme } from "@/styles/theme";
import { BackHeader } from "@/components/headers/back-header";
import { useSessionForServer } from "@/hooks/use-session-directory";

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
    backgroundColor: theme.colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: theme.spacing[6],
  },
  section: {
    marginBottom: theme.spacing[8],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[4],
  },
  label: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
  input: {
    backgroundColor: theme.colors.card,
    color: theme.colors.foreground,
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
  },
  inputDisabled: {
    opacity: theme.opacity[50],
  },
  helperText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[3],
  },
  testButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.blue[600],
  },
  testButtonDisabled: {
    backgroundColor: theme.colors.muted,
  },
  testButtonText: {
    color: theme.colors.palette.white,
    fontWeight: theme.fontWeight.semibold,
    marginLeft: theme.spacing[2],
  },
  testResultSuccess: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.green[900],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.green[600],
  },
  testResultError: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.red[900],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.red[600],
  },
  testResultTextSuccess: {
    color: theme.colors.palette.green[200],
  },
  testResultTextError: {
    color: theme.colors.palette.red[200],
  },
  settingCard: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    marginBottom: theme.spacing[3],
  },
  daemonCard: {
    gap: theme.spacing[2],
  },
  daemonCardActive: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.blue[500],
  },
  settingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  daemonHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  settingContent: {
    flex: 1,
  },
  settingTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    marginBottom: theme.spacing[1],
  },
  settingDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  connectionStatusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  connectionStatusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  connectionStatusText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  connectionErrorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  daemonActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  daemonActionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  daemonActionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  daemonActionDestructive: {
    borderColor: theme.colors.destructive,
  },
  daemonActionDestructiveText: {
    color: theme.colors.destructive,
  },
  daemonFormActionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
  daemonActionPrimary: {
    backgroundColor: theme.colors.palette.blue[500],
    borderColor: theme.colors.palette.blue[500],
  },
  daemonActionPrimaryText: {
    color: theme.colors.palette.white,
  },
  daemonActionDisabled: {
    opacity: theme.opacity[50],
  },
  testResultSuccessText: {
    color: theme.colors.palette.green[400],
    fontSize: theme.fontSize.xs,
  },
  testResultErrorText: {
    color: theme.colors.palette.red[200],
    fontSize: theme.fontSize.xs,
  },
  testResultInfoText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  addButton: {
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
  },
  addButtonText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  themeCardDisabled: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    opacity: theme.opacity[50],
  },
  themeHelpText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[3],
  },
  themeOption: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[2],
    marginRight: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterSelected: {
    borderColor: theme.colors.palette.blue[500],
  },
  radioOuterUnselected: {
    borderColor: theme.colors.border,
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
  themeOptionText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.base,
    textTransform: "capitalize",
  },
  saveButton: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[3],
    backgroundColor: theme.colors.palette.blue[500],
  },
  saveButtonDisabled: {
    backgroundColor: theme.colors.palette.blue[900],
    opacity: theme.opacity[50],
  },
  saveButtonText: {
    color: theme.colors.palette.white,
    textAlign: "center",
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  resetButton: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.destructive,
  },
  resetButtonText: {
    color: theme.colors.destructive,
    textAlign: "center",
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  footer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[6],
  },
  footerText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  footerVersion: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    marginTop: theme.spacing[1],
  },
}));

type DaemonTestState = {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
};

export default function SettingsScreen() {
  const { settings, isLoading: settingsLoading, updateSettings, resetSettings } = useAppSettings();
  const { daemons, isLoading: daemonLoading, addDaemon, updateDaemon, removeDaemon, setDefaultDaemon } = useDaemonRegistry();
  const { activeDaemon, activeDaemonId, setActiveDaemonId, connectionStates, updateConnectionStatus } = useDaemonConnections();
  const activeDaemonSession = useSessionForServer(activeDaemonId ?? null);
  const activeDaemonConnection = activeDaemonId ? connectionStates.get(activeDaemonId) : null;
  const activeDaemonStatusLabel = activeDaemonConnection ? formatConnectionStatus(activeDaemonConnection.status) : null;

  const [serverUrl, setServerUrl] = useState(activeDaemon?.wsUrl ?? "");
  const [useSpeaker, setUseSpeaker] = useState(settings.useSpeaker);
  const [keepScreenOn, setKeepScreenOn] = useState(settings.keepScreenOn);
  const [theme, setTheme] = useState<"dark" | "light" | "auto">(settings.theme);
  const [hasChanges, setHasChanges] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [isDaemonFormVisible, setIsDaemonFormVisible] = useState(false);
  const [daemonForm, setDaemonForm] = useState<{ id: string | null; label: string; wsUrl: string; autoConnect: boolean }>(
    { id: null, label: "", wsUrl: "", autoConnect: true }
  );
  const [isSavingDaemon, setIsSavingDaemon] = useState(false);
  const [daemonTestStates, setDaemonTestStates] = useState<Map<string, DaemonTestState>>(() => new Map());
  const isLoading = settingsLoading || daemonLoading;
  const baselineServerUrl = activeDaemon?.wsUrl ?? "";
  const isMountedRef = useRef(true);
  const isServerConfigLocked = Boolean(activeDaemon && !activeDaemonSession);
  const serverDescriptionText = activeDaemon
    ? `${activeDaemon.label}${activeDaemonStatusLabel ? ` - ${activeDaemonStatusLabel}` : ""}${
        isServerConfigLocked ? " - Session unavailable" : ""
      }`
    : "No active daemon selected.";
  const serverHelperText = isServerConfigLocked
    ? `Connect to ${activeDaemon?.label ?? "this daemon"} to edit its server URL.`
    : "Must be a valid WebSocket URL (ws:// or wss://)";

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

  const testServerConnection = useCallback((url: string, timeoutMs = 5000) => {
    return new Promise<void>((resolve, reject) => {
      let wsConnection: WebSocket | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        if (wsConnection) {
          wsConnection.onopen = null;
          wsConnection.onerror = null;
          wsConnection.onclose = null;
          try {
            wsConnection.close();
          } catch {
            // no-op
          }
        }
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(message));
      };

      try {
        wsConnection = new WebSocket(url);
      } catch {
        fail("Failed to create connection");
        return;
      }

      timeoutId = setTimeout(() => {
        fail("Connection timeout - server did not respond");
      }, timeoutMs);

      wsConnection.onopen = () => succeed();
      wsConnection.onerror = () => fail("Connection failed - check URL and network");
      wsConnection.onclose = () => fail("Connection failed - check URL and network");
    });
  }, []);

  const handleOpenDaemonForm = useCallback((profile?: DaemonProfile) => {
    if (profile) {
      setDaemonForm({
        id: profile.id,
        label: profile.label,
        wsUrl: profile.wsUrl,
        autoConnect: profile.autoConnect,
      });
    } else {
      setDaemonForm({ id: null, label: "", wsUrl: "", autoConnect: true });
    }
    setIsDaemonFormVisible(true);
  }, []);

  const handleCloseDaemonForm = useCallback(() => {
    setIsDaemonFormVisible(false);
    setDaemonForm({ id: null, label: "", wsUrl: "", autoConnect: true });
  }, []);

  const handleSubmitDaemonForm = useCallback(async () => {
    if (!daemonForm.label.trim()) {
      Alert.alert("Label required", "Please enter a label for the daemon.");
      return;
    }
    if (!validateServerUrl(daemonForm.wsUrl)) {
      Alert.alert("Invalid URL", "Daemon URL must be ws:// or wss://");
      return;
    }

    try {
      setIsSavingDaemon(true);
      const payload = {
        label: daemonForm.label.trim(),
        wsUrl: daemonForm.wsUrl.trim(),
        autoConnect: daemonForm.autoConnect,
      };
      if (daemonForm.id) {
        await updateDaemon(daemonForm.id, payload);
        setActiveDaemonId(daemonForm.id, { source: "settings_save_daemon" });
      } else {
        const created = await addDaemon(payload);
        setActiveDaemonId(created.id, { source: "settings_save_daemon" });
      }
      handleCloseDaemonForm();
    } catch (error) {
      console.error("[Settings] Failed to save daemon", error);
      Alert.alert("Error", "Unable to save daemon");
    } finally {
      setIsSavingDaemon(false);
    }
  }, [daemonForm, addDaemon, updateDaemon, handleCloseDaemonForm, setActiveDaemonId]);

  const handleRemoveDaemon = useCallback(
    (profile: DaemonProfile) => {
      Alert.alert(
        "Remove Daemon",
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
                Alert.alert("Error", "Unable to remove daemon");
              }
            },
          },
        ]
      );
    },
    [removeDaemon]
  );

  const handleSetDefaultDaemon = useCallback(
    (profile: DaemonProfile) => {
      void setDefaultDaemon(profile.id);
    },
    [setDefaultDaemon]
  );

  const handleSetActiveDaemon = useCallback(
    (profile: DaemonProfile) => {
      setActiveDaemonId(profile.id, { source: "settings_switch" });
    },
    [setActiveDaemonId]
  );

  const updateDaemonTestState = useCallback((daemonId: string, state: { status: "idle" | "testing" | "success" | "error"; message?: string }) => {
    setDaemonTestStates((prev) => {
      const next = new Map(prev);
      next.set(daemonId, state);
      return next;
    });
  }, []);

  const handleTestDaemonConnection = useCallback(
    async (profile: DaemonProfile) => {
      const url = profile.wsUrl;
      if (!validateServerUrl(url)) {
        Alert.alert("Invalid URL", "Daemon URL must be ws:// or wss://");
        return;
      }
      updateDaemonTestState(profile.id, { status: "testing" });
      updateConnectionStatus(profile.id, { status: "connecting" });
      try {
        await testServerConnection(url, 4000);
        updateDaemonTestState(profile.id, { status: "success", message: "Reachable" });
        updateConnectionStatus(profile.id, { status: "online", lastOnlineAt: new Date().toISOString() });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Connection failed";
        updateDaemonTestState(profile.id, { status: "error", message });
        updateConnectionStatus(profile.id, { status: "offline", lastError: message });
      }
    },
    [testServerConnection, updateConnectionStatus, updateDaemonTestState]
  );

  // Update local state when settings load
  useEffect(() => {
    setUseSpeaker(settings.useSpeaker);
    setKeepScreenOn(settings.keepScreenOn);
    setTheme(settings.theme);
  }, [settings]);

  useEffect(() => {
    setServerUrl(activeDaemon?.wsUrl ?? "");
  }, [activeDaemon?.wsUrl]);

  // Track changes
  useEffect(() => {
    const changed =
      serverUrl !== baselineServerUrl ||
      useSpeaker !== settings.useSpeaker ||
      keepScreenOn !== settings.keepScreenOn ||
      theme !== settings.theme;
    setHasChanges(changed);
  }, [serverUrl, baselineServerUrl, useSpeaker, keepScreenOn, theme, settings]);

  function validateServerUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === "ws:" || urlObj.protocol === "wss:";
    } catch {
      return false;
    }
  }

  function deriveDaemonLabel(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname || "Daemon";
    } catch {
      return "Daemon";
    }
  }

  async function handleSave() {
    // Validate server URL
    if (!validateServerUrl(serverUrl)) {
      Alert.alert(
        "Invalid URL",
        "Server URL must be a valid WebSocket URL (ws:// or wss://)",
        [{ text: "OK" }]
      );
      return;
    }

    try {
      const trimmedUrl = serverUrl.trim();

      await updateSettings({
        useSpeaker,
        keepScreenOn,
        theme,
      });

      if (activeDaemon) {
        await updateDaemon(activeDaemon.id, {
          wsUrl: trimmedUrl,
          label: activeDaemon.label || deriveDaemonLabel(trimmedUrl),
        });
      } else {
        await addDaemon({
          label: deriveDaemonLabel(trimmedUrl),
          wsUrl: trimmedUrl,
          autoConnect: true,
          isDefault: true,
        });
      }

      Alert.alert(
        "Settings Saved",
        "Your settings have been saved successfully.",
        [
          {
            text: "OK",
            onPress: () => router.back(),
          },
        ]
      );
    } catch (error) {
      Alert.alert("Error", "Failed to save settings. Please try again.", [
        { text: "OK" },
      ]);
    }
  }

  async function handleReset() {
    Alert.alert(
      "Reset Settings",
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
                "Settings Reset",
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


  async function handleTestConnection() {
    if (isServerConfigLocked) {
      Alert.alert(
        "Session unavailable",
        `${activeDaemon?.label ?? "This daemon"} is not connected. Connect to it before testing the URL.`
      );
      return;
    }

    if (!validateServerUrl(serverUrl)) {
      Alert.alert(
        "Invalid URL",
        "Server URL must be a valid WebSocket URL (ws:// or wss://)",
        [{ text: "OK" }]
      );
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      await testServerConnection(serverUrl);
      setTestResult({
        success: true,
        message: "Connection successful",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Connection failed - check URL and network";
      setTestResult({
        success: false,
        message,
      });
    } finally {
      setIsTesting(false);
    }
  }

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading settings...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <BackHeader title="Settings" />

      <ScrollView style={styles.scrollView}>
        <View style={styles.content}>
          {/* Server Configuration */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Server Configuration</Text>
            <Text style={styles.helperText}>{serverDescriptionText}</Text>

            <Text style={styles.label}>WebSocket URL</Text>
            <TextInput
              style={[styles.input, isServerConfigLocked && styles.inputDisabled]}
              placeholder="wss://example.com/ws"
              placeholderTextColor={defaultTheme.colors.mutedForeground}
              value={serverUrl}
              onChangeText={(text) => {
                setServerUrl(text);
                setTestResult(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!isServerConfigLocked}
              selectTextOnFocus={!isServerConfigLocked}
            />
            <Text style={styles.helperText}>
              {serverHelperText}
            </Text>

            {/* Test Connection Button */}
            <Pressable
              onPress={handleTestConnection}
              disabled={isTesting || !validateServerUrl(serverUrl)}
              style={[
                styles.testButton,
                (isTesting || !validateServerUrl(serverUrl) || isServerConfigLocked) &&
                  styles.testButtonDisabled,
              ]}
            >
              {isTesting ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.testButtonText}>Testing...</Text>
                </>
              ) : (
                <Text style={styles.testButtonText}>Test Connection</Text>
              )}
            </Pressable>

            {/* Test Result */}
            {testResult && (
              <View
                style={
                  testResult.success
                    ? styles.testResultSuccess
                    : styles.testResultError
                }
              >
                <Text
                  style={
                    testResult.success
                      ? styles.testResultTextSuccess
                      : styles.testResultTextError
                  }
                >
                  {testResult.message}
                </Text>
              </View>
            )}
          </View>

          {/* Daemon Management */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Daemons</Text>

            {daemons.length === 0 ? (
              <View style={styles.settingCard}>
                <Text style={styles.settingDescription}>No daemons configured.</Text>
              </View>
            ) : (
              daemons.map((daemon) => {
                const connection = connectionStates.get(daemon.id);
                const connectionStatus = connection?.status ?? "idle";
                const lastConnectionError = connection?.lastError ?? null;
                const testState = daemonTestStates.get(daemon.id);
                return (
                  <DaemonCard
                    key={daemon.id}
                    daemon={daemon}
                    isActive={daemon.id === activeDaemonId}
                    connectionStatus={connectionStatus}
                    lastError={lastConnectionError}
                    testState={testState}
                    onSetActive={handleSetActiveDaemon}
                    onSetDefault={handleSetDefaultDaemon}
                    onTestConnection={handleTestDaemonConnection}
                    onEdit={handleOpenDaemonForm}
                    onRemove={handleRemoveDaemon}
                    restartConfirmationMessage={restartConfirmationMessage}
                    waitForCondition={waitForCondition}
                    testServerConnection={testServerConnection}
                    isScreenMountedRef={isMountedRef}
                  />
                );
              })
            )}

            {isDaemonFormVisible ? (
              <View style={styles.settingCard}>
                <Text style={styles.settingTitle}>{daemonForm.id ? "Edit Daemon" : "Add Daemon"}</Text>
                <Text style={styles.label}>Label</Text>
                <TextInput
                  style={styles.input}
                  value={daemonForm.label}
                  onChangeText={(text) => setDaemonForm((prev) => ({ ...prev, label: text }))}
                  placeholder="My Server"
                  placeholderTextColor={defaultTheme.colors.mutedForeground}
                />

                <Text style={styles.label}>WebSocket URL</Text>
                <TextInput
                  style={styles.input}
                  value={daemonForm.wsUrl}
                  onChangeText={(text) => setDaemonForm((prev) => ({ ...prev, wsUrl: text }))}
                  placeholder="wss://example.com/ws"
                  placeholderTextColor={defaultTheme.colors.mutedForeground}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />

                <View style={styles.settingRow}>
                  <View style={styles.settingContent}>
                    <Text style={styles.settingTitle}>Auto-connect</Text>
                    <Text style={styles.settingDescription}>Connect automatically when Paseo launches.</Text>
                  </View>
                  <Switch
                    value={daemonForm.autoConnect}
                    onValueChange={(value) => setDaemonForm((prev) => ({ ...prev, autoConnect: value }))}
                    trackColor={{ false: defaultTheme.colors.palette.gray[700], true: defaultTheme.colors.palette.blue[500] }}
                    thumbColor={daemonForm.autoConnect ? defaultTheme.colors.palette.blue[400] : defaultTheme.colors.palette.gray[300]}
                  />
                </View>

                <View style={styles.daemonFormActionsRow}>
                  <Pressable style={[styles.daemonActionButton, styles.daemonActionDestructive]} onPress={handleCloseDaemonForm}>
                    <Text style={[styles.daemonActionText, styles.daemonActionDestructiveText]}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.daemonActionButton, styles.daemonActionPrimary, isSavingDaemon && styles.daemonActionDisabled]}
                    onPress={handleSubmitDaemonForm}
                    disabled={isSavingDaemon}
                  >
                    <Text style={[styles.daemonActionText, styles.daemonActionPrimaryText]}>
                      {isSavingDaemon ? "Saving..." : daemonForm.id ? "Save Daemon" : "Add Daemon"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable style={styles.addButton} onPress={() => handleOpenDaemonForm()}>
                <Text style={styles.addButtonText}>Add Daemon</Text>
              </Pressable>
            )}
          </View>

          {/* Audio Settings */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Audio</Text>

            <View style={styles.settingCard}>
              <View style={styles.settingRow}>
                <View style={styles.settingContent}>
                  <Text style={styles.settingTitle}>Use Speaker</Text>
                  <Text style={styles.settingDescription}>
                    Play audio through speaker instead of earpiece
                  </Text>
                </View>
                <Switch
                  value={useSpeaker}
                  onValueChange={setUseSpeaker}
                  trackColor={{ false: defaultTheme.colors.palette.gray[700], true: defaultTheme.colors.palette.blue[500] }}
                  thumbColor={useSpeaker ? defaultTheme.colors.palette.blue[400] : defaultTheme.colors.palette.gray[300]}
                />
              </View>
            </View>

            <View style={styles.settingCard}>
              <View style={styles.settingRow}>
                <View style={styles.settingContent}>
                  <Text style={styles.settingTitle}>Keep Screen On</Text>
                  <Text style={styles.settingDescription}>
                    Prevent screen from sleeping during voice sessions
                  </Text>
                </View>
                <Switch
                  value={keepScreenOn}
                  onValueChange={setKeepScreenOn}
                  trackColor={{ false: defaultTheme.colors.palette.gray[700], true: defaultTheme.colors.palette.blue[500] }}
                  thumbColor={keepScreenOn ? defaultTheme.colors.palette.blue[400] : defaultTheme.colors.palette.gray[300]}
                />
              </View>
            </View>
          </View>

          {/* Theme Settings */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Theme</Text>

            <View style={styles.themeCardDisabled}>
              <Text style={styles.themeHelpText}>
                Theme selection (coming soon)
              </Text>

              {(["dark", "light", "auto"] as const).map((themeOption) => (
                <Pressable
                  key={themeOption}
                  disabled
                  style={styles.themeOption}
                >
                  <View
                    style={[
                      styles.radioOuter,
                      theme === themeOption
                        ? styles.radioOuterSelected
                        : styles.radioOuterUnselected,
                    ]}
                  >
                    {theme === themeOption && (
                      <View style={styles.radioInner} />
                    )}
                  </View>
                  <Text style={styles.themeOptionText}>{themeOption}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Action Buttons */}
          <View style={styles.section}>
            <Pressable
              style={[
                styles.saveButton,
                !hasChanges && styles.saveButtonDisabled,
              ]}
              onPress={handleSave}
              disabled={!hasChanges}
            >
              <Text style={styles.saveButtonText}>Save Settings</Text>
            </Pressable>

            <Pressable style={styles.resetButton} onPress={handleReset}>
              <Text style={styles.resetButtonText}>Reset to Defaults</Text>
            </Pressable>
          </View>

          {/* App Info */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>Voice Assistant Mobile</Text>
            <Text style={styles.footerVersion}>Version 1.0.0</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

interface DaemonCardProps {
  daemon: DaemonProfile;
  isActive: boolean;
  connectionStatus: ConnectionStatus;
  lastError: string | null;
  testState?: DaemonTestState;
  onSetActive: (daemon: DaemonProfile) => void;
  onSetDefault: (daemon: DaemonProfile) => void;
  onTestConnection: (daemon: DaemonProfile) => void;
  onEdit: (daemon: DaemonProfile) => void;
  onRemove: (daemon: DaemonProfile) => void;
  restartConfirmationMessage: string;
  waitForCondition: (predicate: () => boolean, timeoutMs: number, intervalMs?: number) => Promise<boolean>;
  testServerConnection: (url: string, timeoutMs?: number) => Promise<void>;
  isScreenMountedRef: MutableRefObject<boolean>;
}

function DaemonCard({
  daemon,
  isActive,
  connectionStatus,
  lastError,
  testState,
  onSetActive,
  onSetDefault,
  onTestConnection,
  onEdit,
  onRemove,
  restartConfirmationMessage,
  waitForCondition,
  testServerConnection,
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
          : theme.colors.mutedForeground;
  const badgeText = isActive ? `Active · ${statusLabel}` : statusLabel;
  const connectionError = typeof lastError === "string" && lastError.trim().length > 0 ? lastError.trim() : null;
  const daemonSession = useSessionForServer(daemon.id);
  const [isRestarting, setIsRestarting] = useState(false);
  const wsIsConnectedRef = useRef(daemonSession?.ws.isConnected ?? false);
  const isTesting = testState?.status === "testing";
  const sessionIsConnected = daemonSession?.ws.isConnected ?? false;

  useEffect(() => {
    wsIsConnectedRef.current = sessionIsConnected;
  }, [sessionIsConnected]);

  const waitForDaemonRestart = useCallback(async () => {
    const maxAttempts = 12;
    const retryDelayMs = 2500;
    const disconnectTimeoutMs = 7000;
    const reconnectTimeoutMs = 10000;

    if (wsIsConnectedRef.current) {
      await waitForCondition(() => !wsIsConnectedRef.current, disconnectTimeoutMs);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await testServerConnection(daemon.wsUrl);
        const reconnected = await waitForCondition(() => wsIsConnectedRef.current, reconnectTimeoutMs);

        if (isScreenMountedRef.current) {
          setIsRestarting(false);
          if (!reconnected) {
            Alert.alert(
              "Server reachable",
              `${daemon.label} came back online but Paseo has not reconnected yet.`
            );
          }
        }
        return;
      } catch (error) {
        console.warn(
          `[Settings] Restart poll attempt ${attempt}/${maxAttempts} failed for ${daemon.label}`,
          error
        );
        if (attempt === maxAttempts) {
          if (isScreenMountedRef.current) {
            setIsRestarting(false);
            Alert.alert(
              "Unable to reconnect",
              `${daemon.label} did not come back online. Please verify it restarted.`
            );
          }
          return;
        }
        await delay(retryDelayMs);
      }
    }
  }, [daemon.label, daemon.wsUrl, isScreenMountedRef, testServerConnection, waitForCondition]);

  const beginServerRestart = useCallback(() => {
    if (!daemonSession) {
      Alert.alert(
        "Daemon unavailable",
        `${daemon.label} is not connected. Select it to connect before restarting.`
      );
      return;
    }

    if (!wsIsConnectedRef.current) {
      Alert.alert("Not Connected", "Connect to the server before attempting a restart.");
      return;
    }

    setIsRestarting(true);
    try {
      daemonSession.restartServer(`settings_daemon_restart_${daemon.id}`);
    } catch (error) {
      console.error(`[Settings] Failed to restart daemon ${daemon.label}`, error);
      setIsRestarting(false);
      Alert.alert(
        "Error",
        "Failed to send restart request. Please ensure you are connected to the server."
      );
      return;
    }

    void waitForDaemonRestart();
  }, [daemon.id, daemon.label, daemonSession, waitForDaemonRestart]);

  const handleRestartPress = useCallback(() => {
    if (!daemonSession) {
      Alert.alert(
        "Daemon unavailable",
        `${daemon.label} is not connected. Select it to connect before restarting.`
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
  }, [beginServerRestart, daemon.label, daemonSession, restartConfirmationMessage]);

  return (
    <View style={[styles.settingCard, styles.daemonCard, isActive && styles.daemonCardActive]}>
      <View style={styles.daemonHeaderRow}>
        <Text style={styles.settingTitle}>{daemon.label}</Text>
        <View style={styles.connectionStatusBadge}>
          <View style={[styles.connectionStatusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.connectionStatusText, { color: statusColor }]}>{badgeText}</Text>
        </View>
      </View>
      <Text style={styles.settingDescription}>{daemon.wsUrl}</Text>
      {connectionError ? <Text style={styles.connectionErrorText}>{connectionError}</Text> : null}
      {testState && testState.status !== "idle" ? (
        <Text
          style={
            testState.status === "success"
              ? styles.testResultSuccessText
              : testState.status === "error"
                ? styles.testResultErrorText
                : styles.testResultInfoText
          }
        >
          {testState.message ?? (testState.status === "success" ? "Reachable" : "Testing...")}
        </Text>
      ) : null}
      <View style={styles.daemonActionsRow}>
        {!isActive ? (
          <Pressable style={styles.daemonActionButton} onPress={() => onSetActive(daemon)}>
            <Text style={styles.daemonActionText}>Set Active</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.daemonActionButton} onPress={() => onSetDefault(daemon)}>
          <Text style={styles.daemonActionText}>{daemon.isDefault ? "Default" : "Make Default"}</Text>
        </Pressable>
        <Pressable
          style={[
            styles.daemonActionButton,
            styles.daemonActionPrimary,
            isTesting && styles.daemonActionDisabled,
          ]}
          onPress={() => onTestConnection(daemon)}
          disabled={isTesting}
        >
          <Text style={[styles.daemonActionText, styles.daemonActionPrimaryText]}>
            {isTesting ? "Testing..." : "Test"}
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.daemonActionButton,
            styles.daemonActionDestructive,
            isRestarting && styles.daemonActionDisabled,
          ]}
          onPress={handleRestartPress}
          disabled={isRestarting}
        >
          {isRestarting ? (
            <ActivityIndicator size="small" color={defaultTheme.colors.destructive} />
          ) : (
            <Text style={[styles.daemonActionText, styles.daemonActionDestructiveText]}>Restart</Text>
          )}
        </Pressable>
        <Pressable style={styles.daemonActionButton} onPress={() => onEdit(daemon)}>
          <Text style={styles.daemonActionText}>Edit</Text>
        </Pressable>
        <Pressable
          style={[styles.daemonActionButton, styles.daemonActionDestructive]}
          onPress={() => onRemove(daemon)}
        >
          <Text style={[styles.daemonActionText, styles.daemonActionDestructiveText]}>Remove</Text>
        </Pressable>
      </View>
    </View>
  );
}
