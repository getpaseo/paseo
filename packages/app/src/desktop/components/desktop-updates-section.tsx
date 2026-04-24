import { useCallback, useMemo, useState } from "react";
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
import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { resolveAppVersion } from "@/utils/app-version";

function getDaemonManagementButtonLabel(isUpdating: boolean, isPaused: boolean): string {
  if (isUpdating) return isPaused ? "Resuming..." : "Pausing...";
  return isPaused ? "Resume" : "Pause";
}

function getDaemonRestartButtonLabel(
  isRestarting: boolean,
  daemonStatus: string | undefined,
  actionLabel: string,
): string {
  if (!isRestarting) return actionLabel;
  return daemonStatus === "running" ? "Restarting..." : "Starting...";
}

function useDaemonRestartAction(args: {
  showSection: boolean;
  daemonStatus: DesktopDaemonStatus | null;
  daemonActionLabel: string;
  setStatus: (status: DesktopDaemonStatus) => void;
  refetch: () => void;
}) {
  const { showSection, daemonStatus, daemonActionLabel, setStatus, refetch } = args;
  const [isRestartingDaemon, setIsRestartingDaemon] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

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
            return;
          })
          .catch((error) => {
            console.error("[Settings] Failed to change desktop daemon state", error);
            const message = error instanceof Error ? error.message : String(error);
            setStatusMessage(`${daemonActionLabel} failed: ${message}`);
          })
          .finally(() => {
            setIsRestartingDaemon(false);
          });
        return;
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

  return { isRestartingDaemon, statusMessage, setStatusMessage, handleUpdateLocalDaemon };
}

function useDaemonManagementToggle(args: {
  daemonStatus: DesktopDaemonStatus | null;
  settings: { manageBuiltInDaemon: boolean };
  updateSettings: (next: { manageBuiltInDaemon: boolean }) => Promise<unknown>;
  setStatus: (status: DesktopDaemonStatus) => void;
  setStatusMessage: (message: string | null) => void;
  refetch: () => void;
}) {
  const { daemonStatus, settings, updateSettings, setStatus, setStatusMessage, refetch } = args;
  const [isUpdatingDaemonManagement, setIsUpdatingDaemonManagement] = useState(false);

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
          return;
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
            return;
          })
          .catch((error) => {
            console.error("[Settings] Failed to pause built-in daemon management", error);
            Alert.alert("Error", "Unable to pause built-in daemon management.");
          })
          .finally(() => {
            setIsUpdatingDaemonManagement(false);
          });
        return;
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
    setStatusMessage,
    settings.manageBuiltInDaemon,
    updateSettings,
  ]);

  return { isUpdatingDaemonManagement, handleToggleDaemonManagement };
}

function useDaemonCliStatusModal() {
  const [cliStatusOutput, setCliStatusOutput] = useState<string | null>(null);
  const [isCliStatusModalOpen, setIsCliStatusModalOpen] = useState(false);
  const [isLoadingCliStatus, setIsLoadingCliStatus] = useState(false);

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
        return;
      })
      .catch((error) => {
        console.error("[Settings] Failed to copy daemon status", error);
      });
  }, [cliStatusOutput]);

  const handleRunCliStatus = useCallback(() => {
    void handleOpenCliStatus();
  }, [handleOpenCliStatus]);

  const handleCloseCliStatusModal = useCallback(() => setIsCliStatusModalOpen(false), []);

  return {
    cliStatusOutput,
    isCliStatusModalOpen,
    isLoadingCliStatus,
    handleCopyCliStatus,
    handleRunCliStatus,
    handleCloseCliStatusModal,
  };
}

function useDaemonLogsModal(daemonLogs: { logPath?: string } | null) {
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);

  const handleCopyLogPath = useCallback(() => {
    const logPath = daemonLogs?.logPath;
    if (!logPath) {
      return;
    }

    void Clipboard.setStringAsync(logPath)
      .then(() => {
        Alert.alert("Copied", "Log path copied.");
        return;
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

  const handleCloseLogsModal = useCallback(() => setIsLogsModalOpen(false), []);

  return { isLogsModalOpen, handleCopyLogPath, handleOpenLogs, handleCloseLogsModal };
}

interface DaemonLogsModalProps {
  visible: boolean;
  onClose: () => void;
  daemonLogs: { logPath?: string; contents?: string } | null;
}

function DaemonLogsModal({ visible, onClose, daemonLogs }: DaemonLogsModalProps) {
  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      title="Daemon logs"
      testID="managed-daemon-logs-dialog"
      snapPoints={LOGS_MODAL_SNAP_POINTS}
    >
      <View style={styles.modalBody}>
        <Text style={settingsStyles.rowHint}>{daemonLogs?.logPath ?? "Log path unavailable."}</Text>
        <Text style={styles.logOutput} selectable>
          {daemonLogs?.contents?.length ? daemonLogs.contents : "(log file is empty)"}
        </Text>
      </View>
    </AdaptiveModalSheet>
  );
}

interface DaemonCliStatusModalProps {
  visible: boolean;
  onClose: () => void;
  cliStatusOutput: string | null;
  onCopy: () => void;
}

function DaemonCliStatusModal({
  visible,
  onClose,
  cliStatusOutput,
  onCopy,
}: DaemonCliStatusModalProps) {
  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      title="Daemon status"
      testID="daemon-cli-status-dialog"
      snapPoints={CLI_STATUS_MODAL_SNAP_POINTS}
    >
      <View style={styles.modalBody}>
        <Text style={styles.logOutput} selectable>
          {cliStatusOutput ?? ""}
        </Text>
        <View style={styles.modalActions}>
          <Button variant="outline" size="sm" onPress={onClose}>
            Close
          </Button>
          <Button size="sm" onPress={onCopy}>
            Copy
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

interface DaemonInfoCardProps {
  daemonStatusStateText: string;
  daemonStatusDetailText: string;
  isDaemonManagementPaused: boolean;
  playIcon: React.ReactElement;
  pauseIcon: React.ReactElement;
  rotateIcon: React.ReactElement;
  copyIcon: React.ReactElement;
  fileTextIcon: React.ReactElement;
  activityIcon: React.ReactElement;
  handleToggleDaemonManagement: () => void;
  isUpdatingDaemonManagement: boolean;
  daemonActionLabel: string;
  daemonActionMessage: string;
  statusMessage: string | null;
  handleUpdateLocalDaemon: () => void;
  isRestartingDaemon: boolean;
  daemonStatus: DesktopDaemonStatus | null;
  daemonLogs: { logPath?: string } | null;
  handleCopyLogPath: () => void;
  handleOpenLogs: () => void;
  handleRunCliStatus: () => void;
  isLoadingCliStatus: boolean;
}

function DaemonInfoCard(props: DaemonInfoCardProps) {
  const {
    daemonStatusStateText,
    daemonStatusDetailText,
    isDaemonManagementPaused,
    playIcon,
    pauseIcon,
    rotateIcon,
    copyIcon,
    fileTextIcon,
    activityIcon,
    handleToggleDaemonManagement,
    isUpdatingDaemonManagement,
    daemonActionLabel,
    daemonActionMessage,
    statusMessage,
    handleUpdateLocalDaemon,
    isRestartingDaemon,
    daemonStatus,
    daemonLogs,
    handleCopyLogPath,
    handleOpenLogs,
    handleRunCliStatus,
    isLoadingCliStatus,
  } = props;

  return (
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
      <View style={ROW_WITH_BORDER_STYLE}>
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
          leftIcon={isDaemonManagementPaused ? playIcon : pauseIcon}
          onPress={handleToggleDaemonManagement}
          disabled={isUpdatingDaemonManagement}
        >
          {getDaemonManagementButtonLabel(isUpdatingDaemonManagement, isDaemonManagementPaused)}
        </Button>
      </View>
      <View style={ROW_WITH_BORDER_STYLE}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{daemonActionLabel}</Text>
          <Text style={settingsStyles.rowHint}>{daemonActionMessage}</Text>
          {statusMessage ? <Text style={styles.statusText}>{statusMessage}</Text> : null}
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={rotateIcon}
          onPress={handleUpdateLocalDaemon}
          disabled={isRestartingDaemon}
        >
          {getDaemonRestartButtonLabel(isRestartingDaemon, daemonStatus?.status, daemonActionLabel)}
        </Button>
      </View>
      <View style={ROW_WITH_BORDER_STYLE}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Log file</Text>
          <Text style={settingsStyles.rowHint}>
            {daemonLogs?.logPath ?? "Log path unavailable."}
          </Text>
        </View>
        <View style={styles.actionGroup}>
          {daemonLogs?.logPath ? (
            <Button variant="outline" size="sm" leftIcon={copyIcon} onPress={handleCopyLogPath}>
              Copy path
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            leftIcon={fileTextIcon}
            onPress={handleOpenLogs}
            disabled={!daemonLogs}
          >
            Open logs
          </Button>
        </View>
      </View>
      <View style={ROW_WITH_BORDER_STYLE}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Full status</Text>
          <Text style={settingsStyles.rowHint}>
            Runs `paseo daemon status` and shows the output.
          </Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={activityIcon}
          onPress={handleRunCliStatus}
          disabled={isLoadingCliStatus}
        >
          {isLoadingCliStatus ? "Loading..." : "View status"}
        </Button>
      </View>
    </View>
  );
}

export function LocalDaemonSection() {
  const { theme } = useUnistyles();
  const showSection = shouldUseDesktopDaemon();
  const appVersion = resolveAppVersion();
  const { settings, updateSettings } = useAppSettings();
  const { data, isLoading, error: statusError, setStatus, refetch } = useDaemonStatus();

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

  const { isRestartingDaemon, statusMessage, setStatusMessage, handleUpdateLocalDaemon } =
    useDaemonRestartAction({
      showSection,
      daemonStatus,
      daemonActionLabel,
      setStatus,
      refetch,
    });

  const { isUpdatingDaemonManagement, handleToggleDaemonManagement } = useDaemonManagementToggle({
    daemonStatus,
    settings,
    updateSettings,
    setStatus,
    setStatusMessage,
    refetch,
  });

  const { isLogsModalOpen, handleCopyLogPath, handleOpenLogs, handleCloseLogsModal } =
    useDaemonLogsModal(daemonLogs);

  const {
    cliStatusOutput,
    isCliStatusModalOpen,
    isLoadingCliStatus,
    handleCopyCliStatus,
    handleRunCliStatus,
    handleCloseCliStatusModal,
  } = useDaemonCliStatusModal();

  const handleOpenAdvancedSettings = useCallback(
    () => void openExternalUrl(ADVANCED_DAEMON_SETTINGS_URL),
    [],
  );

  const advancedSettingsIcon = useMemo(
    () => <ArrowUpRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [theme.iconSize.sm, theme.colors.foregroundMuted],
  );
  const playIcon = useMemo(
    () => <Play size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );
  const pauseIcon = useMemo(
    () => <Pause size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );
  const rotateIcon = useMemo(
    () => <RotateCw size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );
  const copyIcon = useMemo(
    () => <Copy size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );
  const fileTextIcon = useMemo(
    () => <FileText size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );
  const activityIcon = useMemo(
    () => <Activity size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );

  const advancedSettingsButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={advancedSettingsIcon}
        textStyle={settingsStyles.sectionHeaderLinkText}
        style={settingsStyles.sectionHeaderLink}
        onPress={handleOpenAdvancedSettings}
        accessibilityLabel="Open advanced daemon settings"
      >
        Advanced settings
      </Button>
    ),
    [advancedSettingsIcon, handleOpenAdvancedSettings],
  );

  if (!showSection) {
    return null;
  }

  return (
    <SettingsSection
      title="Daemon"
      trailing={advancedSettingsButton}
      testID="host-page-daemon-lifecycle-card"
    >
      {isLoading ? (
        <View style={LOADING_CARD_STYLE}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
        </View>
      ) : (
        <>
          <DaemonInfoCard
            daemonStatusStateText={daemonStatusStateText}
            daemonStatusDetailText={daemonStatusDetailText}
            isDaemonManagementPaused={isDaemonManagementPaused}
            playIcon={playIcon}
            pauseIcon={pauseIcon}
            rotateIcon={rotateIcon}
            copyIcon={copyIcon}
            fileTextIcon={fileTextIcon}
            activityIcon={activityIcon}
            handleToggleDaemonManagement={handleToggleDaemonManagement}
            isUpdatingDaemonManagement={isUpdatingDaemonManagement}
            daemonActionLabel={daemonActionLabel}
            daemonActionMessage={daemonActionMessage}
            statusMessage={statusMessage}
            handleUpdateLocalDaemon={handleUpdateLocalDaemon}
            isRestartingDaemon={isRestartingDaemon}
            daemonStatus={daemonStatus}
            daemonLogs={daemonLogs}
            handleCopyLogPath={handleCopyLogPath}
            handleOpenLogs={handleOpenLogs}
            handleRunCliStatus={handleRunCliStatus}
            isLoadingCliStatus={isLoadingCliStatus}
          />

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

      <DaemonLogsModal
        visible={isLogsModalOpen}
        onClose={handleCloseLogsModal}
        daemonLogs={daemonLogs}
      />

      <DaemonCliStatusModal
        visible={isCliStatusModalOpen}
        onClose={handleCloseCliStatusModal}
        cliStatusOutput={cliStatusOutput}
        onCopy={handleCopyCliStatus}
      />
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

const LOADING_CARD_STYLE = [settingsStyles.card, styles.loadingCard];
const ROW_WITH_BORDER_STYLE = [settingsStyles.row, settingsStyles.rowBorder];
const LOGS_MODAL_SNAP_POINTS = ["70%", "92%"];
const CLI_STATUS_MODAL_SNAP_POINTS = ["60%", "85%"];
