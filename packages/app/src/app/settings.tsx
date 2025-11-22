import { useState, useEffect, useRef, useCallback } from "react";
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
import { StyleSheet } from "react-native-unistyles";
import { useSettings } from "@/hooks/use-settings";
import { useSession } from "@/contexts/session-context";
import { theme as defaultTheme } from "@/styles/theme";
import { BackHeader } from "@/components/headers/back-header";

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
  settingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
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
  restartButton: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    marginTop: theme.spacing[3],
    backgroundColor: theme.colors.destructive,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  restartButtonDisabled: {
    opacity: theme.opacity[50],
  },
  restartButtonText: {
    color: theme.colors.destructiveForeground,
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

export default function SettingsScreen() {
  const { settings, isLoading, updateSettings, resetSettings } = useSettings();
  const { restartServer, ws } = useSession();

  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [useSpeaker, setUseSpeaker] = useState(settings.useSpeaker);
  const [keepScreenOn, setKeepScreenOn] = useState(settings.keepScreenOn);
  const [theme, setTheme] = useState<"dark" | "light" | "auto">(settings.theme);
  const [hasChanges, setHasChanges] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const isMountedRef = useRef(true);
  const wsIsConnectedRef = useRef(ws.isConnected);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    wsIsConnectedRef.current = ws.isConnected;
  }, [ws.isConnected]);

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

  const waitForServerRestart = useCallback(async () => {
    const maxAttempts = 12;
    const retryDelayMs = 2500;
    const disconnectTimeoutMs = 7000;
    const reconnectTimeoutMs = 10000;

    if (wsIsConnectedRef.current) {
      await waitForCondition(() => !wsIsConnectedRef.current, disconnectTimeoutMs);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await testServerConnection(settings.serverUrl);
        const reconnected = await waitForCondition(
          () => wsIsConnectedRef.current,
          reconnectTimeoutMs
        );

        if (isMountedRef.current) {
          setIsRestarting(false);
          if (!reconnected) {
            Alert.alert(
              "Server reachable",
              "The server came back online but the app has not reconnected yet."
            );
          }
        }
        return;
      } catch (error) {
        console.warn(
          `[Settings] Restart poll attempt ${attempt}/${maxAttempts} failed`,
          error
        );
        if (attempt === maxAttempts) {
          if (isMountedRef.current) {
            setIsRestarting(false);
            Alert.alert(
              "Unable to reconnect",
              "The server did not come back online. Please verify the daemon restarted."
            );
          }
          return;
        }
        await delay(retryDelayMs);
      }
    }
  }, [settings.serverUrl, testServerConnection, waitForCondition]);

  // Update local state when settings load
  useEffect(() => {
    setServerUrl(settings.serverUrl);
    setUseSpeaker(settings.useSpeaker);
    setKeepScreenOn(settings.keepScreenOn);
    setTheme(settings.theme);
  }, [settings]);

  // Track changes
  useEffect(() => {
    const changed =
      serverUrl !== settings.serverUrl ||
      useSpeaker !== settings.useSpeaker ||
      keepScreenOn !== settings.keepScreenOn ||
      theme !== settings.theme;
    setHasChanges(changed);
  }, [serverUrl, useSpeaker, keepScreenOn, theme, settings]);

  function validateServerUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === "ws:" || urlObj.protocol === "wss:";
    } catch {
      return false;
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
      await updateSettings({
        serverUrl,
        useSpeaker,
        keepScreenOn,
        theme,
      });

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

  const beginServerRestart = useCallback(() => {
    if (!wsIsConnectedRef.current) {
      Alert.alert(
        "Not Connected",
        "Connect to the server before attempting a restart."
      );
      return;
    }

    setIsRestarting(true);
    try {
      restartServer("settings_screen_restart");
    } catch (error) {
      setIsRestarting(false);
      Alert.alert(
        "Error",
        "Failed to send restart request. Please ensure you are connected to the server."
      );
      return;
    }

    void waitForServerRestart();
  }, [restartServer, waitForServerRestart]);

  function handleRestartServer() {
    if (Platform.OS === "web") {
      const hasBrowserConfirm =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as any).confirm === "function";

      const confirmed = hasBrowserConfirm
        ? (globalThis as any).confirm(restartConfirmationMessage)
        : true;

      if (confirmed) {
        beginServerRestart();
      }
      return;
    }

    Alert.alert("Restart Server", restartConfirmationMessage, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Restart",
        style: "destructive",
        onPress: beginServerRestart,
      },
    ]);
  }


  async function handleTestConnection() {
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

            <Text style={styles.label}>WebSocket URL</Text>
            <TextInput
              style={styles.input}
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
            />
            <Text style={styles.helperText}>
              Must be a valid WebSocket URL (ws:// or wss://)
            </Text>

            {/* Test Connection Button */}
            <Pressable
              onPress={handleTestConnection}
              disabled={isTesting || !validateServerUrl(serverUrl)}
              style={[
                styles.testButton,
                (isTesting || !validateServerUrl(serverUrl)) &&
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

            <Pressable
              style={[
                styles.restartButton,
                isRestarting && styles.restartButtonDisabled,
              ]}
              onPress={handleRestartServer}
              disabled={isRestarting}
            >
              {isRestarting && (
                <ActivityIndicator
                  size="small"
                  color={defaultTheme.colors.destructiveForeground}
                  style={{ marginRight: defaultTheme.spacing[2] }}
                />
              )}
              <Text style={styles.restartButtonText}>
                {isRestarting ? "Restarting..." : "Restart Server"}
              </Text>
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
