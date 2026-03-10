import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as QRCode from "qrcode";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { ArrowUpRight, Play, Pause, RotateCw, Terminal, Copy, FileText, Smartphone } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  formatVersionWithPrefix,
  isVersionMismatch,
} from "@/desktop/updates/desktop-updates";
import {
  getManagedDaemonLogs,
  getManagedDaemonPairing,
  getManagedDaemonStatus,
  installManagedCliShim,
  restartManagedDaemon,
  shouldUseManagedDesktopDaemon,
  startManagedDaemon,
  stopManagedDaemon,
  uninstallManagedCliShim,
  type ManagedDaemonLogs,
  type ManagedPairingOffer,
  type ManagedDaemonStatus,
  type CliManualInstructions,
} from "@/desktop/managed-runtime/managed-runtime";

export interface LocalDaemonSectionProps {
  appVersion: string | null;
}

export function LocalDaemonSection({ appVersion }: LocalDaemonSectionProps) {
  const { theme } = useUnistyles();
  const showSection = shouldUseManagedDesktopDaemon();
  const { settings, updateSettings } = useAppSettings();
  const [managedStatus, setManagedStatus] = useState<ManagedDaemonStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isRestartingDaemon, setIsRestartingDaemon] = useState(false);
  const [isUpdatingDaemonManagement, setIsUpdatingDaemonManagement] = useState(false);
  const [isInstallingCli, setIsInstallingCli] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [cliStatusMessage, setCliStatusMessage] = useState<string | null>(null);
  const [managedLogs, setManagedLogs] = useState<ManagedDaemonLogs | null>(null);
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);
  const [isPairingModalOpen, setIsPairingModalOpen] = useState(false);
  const [isCliInstallModalOpen, setIsCliInstallModalOpen] = useState(false);
  const [isLoadingPairing, setIsLoadingPairing] = useState(false);
  const [pairingOffer, setPairingOffer] = useState<ManagedPairingOffer | null>(null);
  const [cliInstallInstructions, setCliInstallInstructions] = useState<CliManualInstructions | null>(
    null
  );
  const [pairingStatusMessage, setPairingStatusMessage] = useState<string | null>(null);

  const loadManagedStatus = useCallback(() => {
    if (!showSection) {
      return Promise.resolve();
    }
    return Promise.all([getManagedDaemonStatus(), getManagedDaemonLogs()])
      .then(([status, logs]) => {
        setManagedStatus(status);
        setManagedLogs(logs);
        setStatusError(null);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatusError(message);
      });
  }, [showSection]);

  useFocusEffect(
    useCallback(() => {
      if (!showSection) {
        return undefined;
      }
      void loadManagedStatus();
      return undefined;
    }, [loadManagedStatus, showSection])
  );

  const localDaemonVersionText = formatVersionWithPrefix(managedStatus?.runtimeVersion ?? null);
  const daemonVersionMismatch = isVersionMismatch(appVersion, managedStatus?.runtimeVersion ?? null);
  const daemonStatusStateText =
    statusError ??
    (managedStatus?.daemonRunning
      ? managedStatus?.daemonStatus ?? "running"
      : "not running");
  const daemonStatusDetailText = `PID ${managedStatus?.daemonPid ? managedStatus.daemonPid : "—"}`;
  const isDaemonManagementPaused = !settings.manageBuiltInDaemon;
  const daemonActionLabel = managedStatus?.daemonRunning ? "Restart daemon" : "Start daemon";
  const daemonActionMessage = managedStatus?.daemonRunning
    ? "Restarts the built-in daemon."
    : isDaemonManagementPaused
      ? "Starts the built-in daemon manually. Paseo will not auto-start it while paused."
      : "Starts the built-in daemon.";

  const handleUpdateLocalDaemon = useCallback(() => {
    if (!showSection) {
      return;
    }
    if (isRestartingDaemon) {
      return;
    }

    void confirmDialog({
      title: daemonActionLabel,
      message: managedStatus?.daemonRunning
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

        const action = managedStatus?.daemonRunning ? restartManagedDaemon : startManagedDaemon;

        void action()
          .then((status) => {
            setManagedStatus(status);
            setStatusMessage(
              managedStatus?.daemonRunning ? "Daemon restarted." : "Daemon started."
            );
            return loadManagedStatus();
          })
          .catch((error) => {
            console.error("[Settings] Failed to change managed daemon state", error);
            const message = error instanceof Error ? error.message : String(error);
            setStatusMessage(`${daemonActionLabel} failed: ${message}`);
          })
          .finally(() => {
            setIsRestartingDaemon(false);
          });
      })
      .catch((error) => {
        console.error("[Settings] Failed to open managed daemon action confirmation", error);
        Alert.alert("Error", "Unable to open the daemon confirmation dialog.");
      });
  }, [daemonActionLabel, isRestartingDaemon, loadManagedStatus, managedStatus?.daemonRunning, showSection]);

  const handleToggleDaemonManagement = useCallback(() => {
    if (isUpdatingDaemonManagement) {
      return;
    }

    if (!settings.manageBuiltInDaemon) {
      setIsUpdatingDaemonManagement(true);
      setStatusMessage(null);
      void updateSettings({ manageBuiltInDaemon: true })
        .then(() => {
          setStatusMessage("Paseo will resume managing the built-in daemon on startup.");
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
        "This will stop the built-in daemon immediately and prevent Paseo from auto-starting it on launch. Running agents and terminals connected to the built-in daemon will be stopped.",
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

        const stopPromise = managedStatus?.daemonRunning
          ? stopManagedDaemon()
          : Promise.resolve(managedStatus ?? null);

        void stopPromise
          .then(() => updateSettings({ manageBuiltInDaemon: false }))
          .then(() => loadManagedStatus())
          .then(() => {
            setStatusMessage(
              "Paseo paused the built-in daemon and will no longer auto-start it on launch."
            );
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
    isUpdatingDaemonManagement,
    loadManagedStatus,
    managedStatus,
    settings.manageBuiltInDaemon,
    updateSettings,
  ]);

  const handleToggleCliShim = useCallback(() => {
    if (!showSection || isInstallingCli) {
      return;
    }
    setIsInstallingCli(true);
    const isInstalling = !managedStatus?.cliShimPath;
    setCliStatusMessage(
      isInstalling
        ? "A permissions popup may appear while Paseo installs the CLI globally."
        : null
    );
    const action = managedStatus?.cliShimPath ? uninstallManagedCliShim : installManagedCliShim;
    void action()
      .then((result) => {
        setCliStatusMessage(result.message);
        if (result.manualInstructions) {
          setCliInstallInstructions(result.manualInstructions);
          setIsCliInstallModalOpen(true);
        } else {
          setCliInstallInstructions(null);
          setIsCliInstallModalOpen(false);
        }
        return loadManagedStatus();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setCliStatusMessage(`CLI install failed: ${message}`);
      })
      .finally(() => {
        setIsInstallingCli(false);
      });
  }, [isInstallingCli, loadManagedStatus, managedStatus?.cliShimPath, showSection]);

  const handleCopyCliInstallCommands = useCallback(() => {
    if (!cliInstallInstructions?.commands) {
      return;
    }
    void Clipboard.setStringAsync(cliInstallInstructions.commands)
      .then(() => {
        Alert.alert("Copied", "CLI install commands copied.");
      })
      .catch((error) => {
        console.error("[Settings] Failed to copy CLI install commands", error);
        Alert.alert("Error", "Unable to copy CLI install commands.");
      });
  }, [cliInstallInstructions?.commands]);

  const handleCopyLogPath = useCallback(() => {
    const logPath = managedLogs?.logPath ?? managedStatus?.logPath;
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
  }, [managedLogs?.logPath, managedStatus?.logPath]);

  const handleOpenLogs = useCallback(() => {
    if (!managedLogs) {
      return;
    }
    setIsLogsModalOpen(true);
  }, [managedLogs]);

  const handleOpenPairingModal = useCallback(() => {
    if (isLoadingPairing) {
      return;
    }

    setIsPairingModalOpen(true);
    setIsLoadingPairing(true);
    setPairingStatusMessage(null);

    void getManagedDaemonPairing()
      .then((pairing) => {
        setPairingOffer(pairing);
        if (!pairing.relayEnabled || !pairing.url) {
          setPairingStatusMessage("Relay pairing is not available.");
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setPairingOffer(null);
        setPairingStatusMessage(`Unable to load pairing offer: ${message}`);
      })
      .finally(() => {
        setIsLoadingPairing(false);
      });
  }, [isLoadingPairing]);

  const handleCopyPairingLink = useCallback(() => {
    if (!pairingOffer?.url) {
      return;
    }
    void Clipboard.setStringAsync(pairingOffer.url)
      .then(() => {
        Alert.alert("Copied", "Pairing link copied.");
      })
      .catch((error) => {
        console.error("[Settings] Failed to copy pairing link", error);
        Alert.alert("Error", "Unable to copy pairing link.");
      });
  }, [pairingOffer?.url]);

  if (!showSection) {
    return null;
  }

  return (
    <View style={settingsStyles.section}>
      <View style={styles.sectionHeader}>
        <Text style={settingsStyles.sectionTitle}>Built-in daemon</Text>
        <Pressable
          accessibilityRole="link"
          onPress={() => void openExternalUrl(ADVANCED_DAEMON_SETTINGS_URL)}
          style={styles.sectionLink}
        >
          <Text style={styles.sectionLinkText}>Advanced settings</Text>
          <ArrowUpRight size={14} color={styles.sectionLinkText.color} />
        </Pressable>
      </View>
      <View style={settingsStyles.card}>
        <View style={styles.row}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>Status</Text>
            <Text style={styles.hintText}>Only the built-in managed daemon is shown here.</Text>
          </View>
          <View style={styles.statusValueGroup}>
            <Text style={styles.valueText}>{daemonStatusStateText}</Text>
            <Text style={styles.valueSubtext}>{daemonStatusDetailText}</Text>
          </View>
        </View>
        <View style={[styles.row, styles.rowBorder]}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>Daemon management</Text>
            <Text style={styles.hintText}>
              {isDaemonManagementPaused
                ? "Paused. Paseo will not auto-start the built-in daemon on app launch."
                : "Enabled. Paseo will start the built-in daemon automatically when needed."}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            leftIcon={isDaemonManagementPaused
              ? <Play size={theme.iconSize.sm} color={theme.colors.foreground} />
              : <Pause size={theme.iconSize.sm} color={theme.colors.foreground} />}
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
        <View style={[styles.row, styles.rowBorder]}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>{daemonActionLabel}</Text>
            <Text style={styles.hintText}>{daemonActionMessage}</Text>
            {statusMessage ? (
              <Text style={styles.statusText}>{statusMessage}</Text>
            ) : null}
          </View>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<RotateCw size={theme.iconSize.sm} color={theme.colors.foreground} />}
            onPress={handleUpdateLocalDaemon}
            disabled={isRestartingDaemon}
          >
            {isRestartingDaemon
              ? managedStatus?.daemonRunning
                ? "Restarting..."
                : "Starting..."
              : daemonActionLabel}
          </Button>
        </View>
        <View style={[styles.row, styles.rowBorder]}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>Command line (CLI)</Text>
            <Text style={styles.hintText}>
              Adds the `paseo` command to your terminal.
            </Text>
            {cliStatusMessage ? <Text style={styles.statusText}>{cliStatusMessage}</Text> : null}
          </View>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Terminal size={theme.iconSize.sm} color={theme.colors.foreground} />}
            onPress={handleToggleCliShim}
            disabled={isInstallingCli}
          >
            {isInstallingCli
              ? "Working..."
              : managedStatus?.cliShimPath
                ? "Uninstall CLI"
                : "Install CLI"}
          </Button>
        </View>
        <View style={[styles.row, styles.rowBorder]}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>Log file</Text>
            <Text style={styles.hintText}>
              {managedLogs?.logPath ??
                managedStatus?.logPath ??
                "Log path unavailable."}
            </Text>
          </View>
          <View style={styles.actionGroup}>
            {(managedLogs?.logPath ?? managedStatus?.logPath) ? (
              <Button variant="outline" size="sm" leftIcon={<Copy size={theme.iconSize.sm} color={theme.colors.foreground} />} onPress={handleCopyLogPath}>
                Copy path
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              leftIcon={<FileText size={theme.iconSize.sm} color={theme.colors.foreground} />}
              onPress={handleOpenLogs}
              disabled={!managedLogs}
            >
              Open logs
            </Button>
          </View>
        </View>
        <View style={[styles.row, styles.rowBorder]}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>Pair device</Text>
            <Text style={styles.hintText}>
              Connect your phone to this computer.
            </Text>
          </View>
          <Button variant="outline" size="sm" leftIcon={<Smartphone size={theme.iconSize.sm} color={theme.colors.foreground} />} onPress={handleOpenPairingModal}>
            Pair device
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

      <AdaptiveModalSheet
        visible={isCliInstallModalOpen}
        onClose={() => setIsCliInstallModalOpen(false)}
        title="Install CLI manually"
        testID="managed-daemon-cli-install-dialog"
      >
        <View style={styles.modalBody}>
          <Text style={styles.hintText}>
            A permissions popup should appear when Paseo installs the CLI globally. If it does not
            complete, open a terminal and run the commands below.
          </Text>
          {cliInstallInstructions?.detail ? (
            <Text style={styles.hintText}>{cliInstallInstructions.detail}</Text>
          ) : null}
          <Text style={styles.codeBlock} selectable>
            {cliInstallInstructions?.commands ?? ""}
          </Text>
          <View style={styles.modalActions}>
            <Button variant="outline" size="sm" onPress={() => setIsCliInstallModalOpen(false)}>
              Close
            </Button>
            <Button size="sm" onPress={handleCopyCliInstallCommands}>
              Copy commands
            </Button>
          </View>
        </View>
      </AdaptiveModalSheet>

      <AdaptiveModalSheet
        visible={isPairingModalOpen}
        onClose={() => setIsPairingModalOpen(false)}
        title="Pair device"
        testID="managed-daemon-pairing-dialog"
      >
        <PairingOfferDialogContent
          isLoading={isLoadingPairing}
          pairingOffer={pairingOffer}
          statusMessage={pairingStatusMessage}
          onCopyLink={handleCopyPairingLink}
        />
      </AdaptiveModalSheet>

      <AdaptiveModalSheet
        visible={isLogsModalOpen}
        onClose={() => setIsLogsModalOpen(false)}
        title="Daemon logs"
        testID="managed-daemon-logs-dialog"
        snapPoints={["70%", "92%"]}
      >
        <View style={styles.modalBody}>
          <Text style={styles.hintText}>
            {managedLogs?.logPath ??
              managedStatus?.logPath ??
              "Log path unavailable."}
          </Text>
          <Text style={styles.logOutput} selectable>
            {managedLogs?.contents.length ? managedLogs.contents : "(log file is empty)"}
          </Text>
        </View>
      </AdaptiveModalSheet>
    </View>
  );
}

const ADVANCED_DAEMON_SETTINGS_URL = "https://paseo.sh/docs/configuration";

function PairingOfferDialogContent(input: {
  isLoading: boolean;
  pairingOffer: ManagedPairingOffer | null;
  statusMessage: string | null;
  onCopyLink: () => void;
}) {
  const { isLoading, pairingOffer, statusMessage, onCopyLink } = input;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!pairingOffer?.url) {
      setQrDataUrl(null);
      setQrError(null);
      return () => {
        cancelled = true;
      };
    }

    setQrError(null);
    setQrDataUrl(null);

    void QRCode.toDataURL(pairingOffer.url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
    })
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        setQrDataUrl(dataUrl);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setQrError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [pairingOffer?.url]);

  if (isLoading) {
    return (
      <View style={styles.pairingState}>
        <ActivityIndicator size="small" />
        <Text style={styles.hintText}>Loading pairing offer…</Text>
      </View>
    );
  }

  if (statusMessage) {
    return (
      <View style={styles.modalBody}>
        <Text style={styles.hintText}>{statusMessage}</Text>
      </View>
    );
  }

  if (!pairingOffer?.url) {
    return (
      <View style={styles.modalBody}>
        <Text style={styles.hintText}>Pairing offer unavailable.</Text>
      </View>
    );
  }

  return (
    <View style={styles.modalBody}>
      <Text style={styles.hintText}>
        Scan this QR code in Paseo, or copy the pairing link below.
      </Text>
      <View style={styles.qrCard}>
        {qrDataUrl ? (
          <Image source={{ uri: qrDataUrl }} style={styles.qrImage} />
        ) : qrError ? (
          <Text style={styles.hintText}>QR unavailable: {qrError}</Text>
        ) : (
          <ActivityIndicator size="small" />
        )}
      </View>
      <Text style={styles.linkLabel}>Pairing link</Text>
      <Text style={styles.linkText} selectable>
        {pairingOffer.url}
      </Text>
      <View style={styles.modalActions}>
        <Button variant="outline" size="sm" onPress={onCopyLink}>
          Copy link
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  sectionLink: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  sectionLinkText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  rowContent: {
    flex: 1,
    marginRight: theme.spacing[3],
  },
  actionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  statusValueGroup: {
    alignItems: "flex-end",
    gap: 2,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  valueText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  valueSubtext: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  hintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: 2,
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
  pairingState: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[6],
  },
  qrCard: {
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    minHeight: 220,
    minWidth: 220,
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  qrImage: {
    width: 220,
    height: 220,
  },
  linkLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  linkText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
  },
  logOutput: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: 18,
  },
  codeBlock: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[3],
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
