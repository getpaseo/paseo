import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { ArrowUpRight, Play, Pause, RotateCw, Copy, FileText, Activity } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import { isVersionMismatch } from "@/desktop/updates/desktop-updates";
import {
  getCliDaemonStatus,
  restartDesktopDaemon,
  shouldUseDesktopDaemon,
  startDesktopDaemon,
  stopDesktopDaemon,
} from "@/desktop/daemon/desktop-daemon";
import { useDaemonStatus } from "@/desktop/hooks/use-daemon-status";
import { resolveAppVersion } from "@/utils/app-version";

export function LocalDaemonSection() {
  const { theme } = useUnistyles();
  const showSection = shouldUseDesktopDaemon();
  const appVersion = resolveAppVersion();
  const { settings, updateSettings } = useAppSettings();
  const { data, isLoading, error: statusError, setStatus, refetch } = useDaemonStatus();
  const [isRestartingDaemon, setIsRestartingDaemon] = useState(false);
  const [isUpdatingDaemonManagement, setIsUpdatingDaemonManagement] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);
  const [cliStatusOutput, setCliStatusOutput] = useState<string | null>(null);
  const [isCliStatusModalOpen, setIsCliStatusModalOpen] = useState(false);
  const [isLoadingCliStatus, setIsLoadingCliStatus] = useState(false);

  const daemonStatus = data?.status ?? null;
  const daemonLogs = data?.logs ?? null;
  const daemonVersion = daemonStatus?.version ?? null;

  const daemonVersionMismatch = isVersionMismatch(appVersion, daemonVersion);
  const daemonStatusStateText =
    statusError ?? (daemonStatus?.status === "running" ? daemonStatus.status : "not running");
  const daemonStatusDetailText = `PID ${daemonStatus?.pid ? daemonStatus.pid : "—"}`;
  const isDaemonManagementPaused = !settings.manageBuiltInDaemon;
  const daemonActionLabel = daemonStatus?.status === "running" ? "Restart daemon" : "Start daemon";
  const daemonActionMessage =
    daemonStatus?.status === "running"
      ? "Restarts the built-in daemon."
      : "Starts the built-in daemon.";

  const handleUpdateLocalDaemon = useCallback(() => {
    if (!showSection || isRestartingDaemon) {
      return;
    }

    void confirmDialog({
      title: daemonActionLabel,
      message:
        daemonStatus?.status === "running"
          ? "This will restart the built-in daemon. The app will reconnect automatically."
          : "This will start the built-in daemon.",
      confirmLabel: daemonActionLabel,
      cancelLabel: "Cancel",
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }

        setIsRestartingDaemon(true);
        setStatusMessage(null);

        const action =
          daemonStatus?.status === "running" ? restartDesktopDaemon : startDesktopDaemon;

        void action()
          .then((newStatus) => {
            setStatus(newStatus);
            setStatusMessage(
              daemonStatus?.status === "running" ? "Daemon restarted." : "Daemon started.",
            );
            refetch();
          })
          .catch((error) => {
            console.error("[Settings] Failed to change desktop daemon state", error);
            const message = error instanceof Error ? error.message : String(error);
            setStatusMessage(`${daemonActionLabel} failed: ${message}`);
          })
          .finally(() => {
            setIsRestartingDaemon(false);
          });
      })
      .catch((error) => {
        console.error("[Settings] Failed to open desktop daemon action confirmation", error);
        Alert.alert("Error", "Unable to open the daemon confirmation dialog.");
      });
  }, [
    daemonActionLabel,
    daemonStatus?.status,
    isRestartingDaemon,
    refetch,
    setStatus,
    showSection,
  ]);

  const handleToggleDaemonManagement = useCallback(() => {
    if (isUpdatingDaemonManagement) {
      return;
    }

    if (!settings.manageBuiltInDaemon) {
      setIsUpdatingDaemonManagement(true);
      setStatusMessage(null);
      void updateSettings({ manageBuiltInDaemon: true })
        .then(() => {
          setStatusMessage("Built-in daemon management resumed.");
        })
        .catch((error) => {
          console.error("[Settings] Failed to update built-in daemon management", error);
          Alert.alert("Error", "Unable to update built-in daemon management.");
        })
        .finally(() => {
          setIsUpdatingDaemonManagement(false);
        });
      return;
    }

    void confirmDialog({
      title: "Pause built-in daemon",
      message:
        "This will stop the built-in daemon immediately. Running agents and terminals connected to the built-in daemon will be stopped.",
      confirmLabel: "Pause and stop",
      cancelLabel: "Cancel",
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }

        setIsUpdatingDaemonManagement(true);
        setStatusMessage(null);

        const stopPromise =
          daemonStatus?.status === "running"
            ? stopDesktopDaemon()
            : Promise.resolve(daemonStatus ?? null);

        void stopPromise
          .then((newStatus) => {
            if (newStatus) {
              setStatus(newStatus);
            }
            return updateSettings({ manageBuiltInDaemon: false });
          })
          .then(() => {
            refetch();
            setStatusMessage("Built-in daemon paused and stopped.");
          })
          .catch((error) => {
            console.error("[Settings] Failed to pause built-in daemon management", error);
            Alert.alert("Error", "Unable to pause built-in daemon management.");
          })
          .finally(() => {
            setIsUpdatingDaemonManagement(false);
          });
      })
      .catch((error) => {
        console.error("[Settings] Failed to open built-in daemon pause confirmation", error);
        Alert.alert("Error", "Unable to open the daemon confirmation dialog.");
      });
  }, [
    daemonStatus,
    isUpdatingDaemonManagement,
    refetch,
    setStatus,
    settings.manageBuiltInDaemon,
    updateSettings,
  ]);

  const handleCopyLogPath = useCallback(() => {
    const logPath = daemonLogs?.logPath;
    if (!logPath) {
      return;
    }

    void Clipboard.setStringAsync(logPath)
      .then(() => {
        Alert.alert("Copied", "Log path copied.");
      })
      .catch((error) => {
        console.error("[Settings] Failed to copy log path", error);
        Alert.alert("Error", "Unable to copy log path.");
      });
  }, [daemonLogs?.logPath]);

  const handleOpenLogs = useCallback(() => {
    if (!daemonLogs) {
      return;
    }
    setIsLogsModalOpen(true);
  }, [daemonLogs]);

  const handleOpenCliStatus = useCallback(async () => {
    setIsLoadingCliStatus(true);
    try {
      setCliStatusOutput(await getCliDaemonStatus());
      setIsCliStatusModalOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCliStatusOutput(`Failed to fetch daemon status: ${message}`);
      setIsCliStatusModalOpen(true);
    } finally {
      setIsLoadingCliStatus(false);
    }
  }, []);

  const handleCopyCliStatus = useCallback(() => {
    if (!cliStatusOutput) {
      return;
    }
    void Clipboard.setStringAsync(cliStatusOutput)
      .then(() => {
        Alert.alert("Copied", "Status copied to clipboard.");
      })
      .catch((error) => {
        console.error("[Settings] Failed to copy daemon status", error);
      });
  }, [cliStatusOutput]);

  if (!showSection) {
    return null;
  }

  const advancedSettingsButton = (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={<ArrowUpRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />}
      textStyle={settingsStyles.sectionHeaderLinkText}
      style={settingsStyles.sectionHeaderLink}
      onPress={() => void openExternalUrl(ADVANCED_DAEMON_SETTINGS_URL)}
      accessibilityLabel="Open advanced daemon settings"
    >
      Advanced settings
    </Button>
  );

  return (
    <SettingsSection
      title="Daemon"
      trailing={advancedSettingsButton}
      testID="host-page-daemon-lifecycle-card"
    >
      {isLoading ? (
        <View style={[settingsStyles.card, styles.loadingCard]}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
        </View>
      ) : (
        <>
          <View style={settingsStyles.card}>
            <View style={settingsStyles.row}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>Status</Text>
                <Text style={settingsStyles.rowHint}>
                  Only the built-in desktop daemon is shown here.
                </Text>
              </View>
              <View style={styles.statusValueGroup}>
                <Text style={styles.valueText}>{daemonStatusStateText}</Text>
                <Text style={styles.valueSubtext}>{daemonStatusDetailText}</Text>
              </View>
            </View>
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>Daemon management</Text>
                <Text style={settingsStyles.rowHint}>
                  {isDaemonManagementPaused
                    ? "Paused. The built-in daemon stays stopped until you start it again."
                    : "Enabled. Paseo can manage the built-in daemon from the desktop app."}
                </Text>
              </View>
              <Button
                variant="outline"
                size="sm"
                leftIcon={
                  isDaemonManagementPaused ? (
                    <Play size={theme.iconSize.sm} color={theme.colors.foreground} />
                  ) : (
                    <Pause size={theme.iconSize.sm} color={theme.colors.foreground} />
                  )
                }
                onPress={handleToggleDaemonManagement}
                disabled={isUpdatingDaemonManagement}
              >
                {isUpdatingDaemonManagement
                  ? isDaemonManagementPaused
                    ? "Resuming..."
                    : "Pausing..."
                  : isDaemonManagementPaused
                    ? "Resume"
                    : "Pause"}
              </Button>
            </View>
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>{daemonActionLabel}</Text>
                <Text style={settingsStyles.rowHint}>{daemonActionMessage}</Text>
                {statusMessage ? <Text style={styles.statusText}>{statusMessage}</Text> : null}
              </View>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<RotateCw size={theme.iconSize.sm} color={theme.colors.foreground} />}
                onPress={handleUpdateLocalDaemon}
                disabled={isRestartingDaemon}
              >
                {isRestartingDaemon
                  ? daemonStatus?.status === "running"
                    ? "Restarting..."
                    : "Starting..."
                  : daemonActionLabel}
              </Button>
            </View>
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>Log file</Text>
                <Text style={settingsStyles.rowHint}>
                  {daemonLogs?.logPath ?? "Log path unavailable."}
                </Text>
              </View>
              <View style={styles.actionGroup}>
                {daemonLogs?.logPath ? (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<Copy size={theme.iconSize.sm} color={theme.colors.foreground} />}
                    onPress={handleCopyLogPath}
                  >
                    Copy path
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<FileText size={theme.iconSize.sm} color={theme.colors.foreground} />}
                  onPress={handleOpenLogs}
                  disabled={!daemonLogs}
                >
                  Open logs
                </Button>
              </View>
            </View>
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>Full status</Text>
                <Text style={settingsStyles.rowHint}>
                  Runs `paseo daemon status` and shows the output.
                </Text>
              </View>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Activity size={theme.iconSize.sm} color={theme.colors.foreground} />}
                onPress={() => void handleOpenCliStatus()}
                disabled={isLoadingCliStatus}
              >
                {isLoadingCliStatus ? "Loading..." : "View status"}
              </Button>
            </View>
          </View>

          {daemonVersionMismatch ? (
            <View style={styles.warningCard}>
              <Text style={styles.warningText}>
                App and daemon versions don't match. Update both to the same version for the best
                experience.
              </Text>
            </View>
          ) : null}
        </>
      )}

      <AdaptiveModalSheet
        visible={isLogsModalOpen}
        onClose={() => setIsLogsModalOpen(false)}
        title="Daemon logs"
        testID="managed-daemon-logs-dialog"
        snapPoints={["70%", "92%"]}
      >
        <View style={styles.modalBody}>
          <Text style={settingsStyles.rowHint}>
            {daemonLogs?.logPath ?? "Log path unavailable."}
          </Text>
          <Text style={styles.logOutput} selectable>
            {daemonLogs?.contents.length ? daemonLogs.contents : "(log file is empty)"}
          </Text>
        </View>
      </AdaptiveModalSheet>

      <AdaptiveModalSheet
        visible={isCliStatusModalOpen}
        onClose={() => setIsCliStatusModalOpen(false)}
        title="Daemon status"
        testID="daemon-cli-status-dialog"
        snapPoints={["60%", "85%"]}
      >
        <View style={styles.modalBody}>
          <Text style={styles.logOutput} selectable>
            {cliStatusOutput ?? ""}
          </Text>
          <View style={styles.modalActions}>
            <Button variant="outline" size="sm" onPress={() => setIsCliStatusModalOpen(false)}>
              Close
            </Button>
            <Button size="sm" onPress={handleCopyCliStatus}>
              Copy
            </Button>
          </View>
        </View>
      </AdaptiveModalSheet>
    </SettingsSection>
  );
}

const ADVANCED_DAEMON_SETTINGS_URL = "https://paseo.sh/docs/configuration";

const styles = StyleSheet.create((theme) => ({
  actionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  loadingCard: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[6],
  },
  statusValueGroup: {
    alignItems: "flex-end",
    gap: 2,
  },
  valueText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  valueSubtext: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  warningCard: {
    marginTop: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.palette.amber[500],
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  warningText: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.xs,
  },
  modalBody: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  logOutput: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: 18,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
