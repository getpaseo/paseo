import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Image, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as QRCode from "qrcode";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
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
  uninstallManagedCliShim,
  updateManagedDaemonTcpSettings,
  type ManagedDaemonLogs,
  type ManagedPairingOffer,
  type ManagedDaemonStatus,
  type CliManualInstructions,
} from "@/desktop/managed-runtime/managed-runtime";

export interface LocalDaemonSectionProps {
  appVersion: string | null;
}

export function LocalDaemonSection({ appVersion }: LocalDaemonSectionProps) {
  const showSection = shouldUseManagedDesktopDaemon();
  const [managedStatus, setManagedStatus] = useState<ManagedDaemonStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isRestartingDaemon, setIsRestartingDaemon] = useState(false);
  const [isInstallingCli, setIsInstallingCli] = useState(false);
  const [isSavingTcpSettings, setIsSavingTcpSettings] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [cliStatusMessage, setCliStatusMessage] = useState<string | null>(null);
  const [managedLogs, setManagedLogs] = useState<ManagedDaemonLogs | null>(null);
  const [isTcpModalOpen, setIsTcpModalOpen] = useState(false);
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);
  const [isPairingModalOpen, setIsPairingModalOpen] = useState(false);
  const [isCliInstallModalOpen, setIsCliInstallModalOpen] = useState(false);
  const [isLoadingPairing, setIsLoadingPairing] = useState(false);
  const [pairingOffer, setPairingOffer] = useState<ManagedPairingOffer | null>(null);
  const [cliInstallInstructions, setCliInstallInstructions] = useState<CliManualInstructions | null>(
    null
  );
  const [pairingStatusMessage, setPairingStatusMessage] = useState<string | null>(null);
  const [tcpHostInput, setTcpHostInput] = useState(DEFAULT_TCP_HOST);
  const [tcpPortInput, setTcpPortInput] = useState(String(DEFAULT_TCP_PORT));

  const loadManagedStatus = useCallback(() => {
    if (!showSection) {
      return Promise.resolve();
    }
    return Promise.all([getManagedDaemonStatus(), getManagedDaemonLogs()])
      .then(([status, logs]) => {
        setManagedStatus(status);
        setManagedLogs(logs);
        setStatusError(null);
        const [tcpHost, tcpPort] = splitTcpListen(status.tcpListen);
        setTcpHostInput(tcpHost);
        setTcpPortInput(tcpPort);
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
  const daemonVersionHint =
    statusError ??
    (managedStatus?.daemonRunning
      ? managedStatus.transportType === "tcp"
        ? `Managed daemon running on explicit TCP ${managedStatus.transportPath}.`
        : `Managed daemon running on private ${managedStatus.transportType}.`
      : "Managed daemon is currently stopped.");

  const handleUpdateLocalDaemon = useCallback(() => {
    if (!showSection) {
      return;
    }
    if (isRestartingDaemon) {
      return;
    }

    void confirmDialog({
      title: "Restart managed daemon",
      message:
        "This restarts the desktop-managed daemon using its private managed home and socket.",
      confirmLabel: "Restart daemon",
      cancelLabel: "Cancel",
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }

        setIsRestartingDaemon(true);
        setStatusMessage(null);

        void restartManagedDaemon()
          .then((status) => {
            setManagedStatus(status);
            setStatusMessage("Managed daemon restarted.");
            return loadManagedStatus();
          })
          .catch((error) => {
            console.error("[Settings] Failed to restart managed daemon", error);
            const message = error instanceof Error ? error.message : String(error);
            setStatusMessage(`Managed daemon restart failed: ${message}`);
          })
          .finally(() => {
            setIsRestartingDaemon(false);
          });
      })
      .catch((error) => {
        console.error("[Settings] Failed to open managed daemon restart confirmation", error);
        Alert.alert("Error", "Unable to open the managed daemon restart confirmation dialog.");
      });
  }, [isRestartingDaemon, loadManagedStatus, showSection]);

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
        setCliStatusMessage(`CLI shim action failed: ${message}`);
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
        Alert.alert("Copied", "Managed daemon log path copied.");
      })
      .catch((error) => {
        console.error("[Settings] Failed to copy managed daemon log path", error);
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
          setPairingStatusMessage("Relay pairing is disabled for this managed daemon.");
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

  const handleOpenTcpModal = useCallback(() => {
    if (!managedStatus) {
      return;
    }
    const [tcpHost, tcpPort] = splitTcpListen(managedStatus.tcpListen);
    setTcpHostInput(tcpHost);
    setTcpPortInput(tcpPort);
    setIsTcpModalOpen(true);
  }, [managedStatus]);

  const handleDisableTcp = useCallback(() => {
    if (isSavingTcpSettings) {
      return;
    }
    setIsSavingTcpSettings(true);
    setStatusMessage(null);
    void updateManagedDaemonTcpSettings({
      enabled: false,
      host: tcpHostInput.trim() || DEFAULT_TCP_HOST,
      port: parseTcpPort(tcpPortInput) ?? DEFAULT_TCP_PORT,
    })
      .then((status) => {
        setManagedStatus(status);
        setStatusMessage("Managed TCP exposure disabled.");
        return loadManagedStatus();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatusMessage(`Managed TCP update failed: ${message}`);
      })
      .finally(() => {
        setIsSavingTcpSettings(false);
      });
  }, [isSavingTcpSettings, loadManagedStatus, tcpHostInput, tcpPortInput]);

  const handleSaveTcp = useCallback(() => {
    if (isSavingTcpSettings) {
      return;
    }
    const host = tcpHostInput.trim();
    const port = parseTcpPort(tcpPortInput);
    if (!host) {
      Alert.alert("Host required", "Enter a TCP bind host.");
      return;
    }
    if (port == null || port <= 0) {
      Alert.alert("Port required", "Enter a valid TCP port.");
      return;
    }
    if (port === 6767) {
      Alert.alert("Port unavailable", "Managed TCP mode must not claim 127.0.0.1:6767.");
      return;
    }

    void confirmDialog({
      title: "Enable managed TCP",
      message:
        "This exposes the managed daemon on a TCP listener. Relay remains available, but network exposure is no longer private to the desktop app.",
      confirmLabel: "Enable TCP",
      cancelLabel: "Cancel",
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        setIsSavingTcpSettings(true);
        setStatusMessage(null);
        void updateManagedDaemonTcpSettings({ enabled: true, host, port })
          .then((status) => {
            setManagedStatus(status);
            setIsTcpModalOpen(false);
            setStatusMessage(`Managed TCP exposure enabled on ${host}:${port}.`);
            return loadManagedStatus();
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setStatusMessage(`Managed TCP update failed: ${message}`);
          })
          .finally(() => {
            setIsSavingTcpSettings(false);
          });
      })
      .catch((error) => {
        console.error("[Settings] Failed to open managed TCP confirmation", error);
        Alert.alert("Error", "Unable to open the managed TCP confirmation dialog.");
      });
  }, [isSavingTcpSettings, loadManagedStatus, tcpHostInput, tcpPortInput]);

  if (!showSection) {
    return null;
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Managed daemon</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>Version</Text>
            <Text style={styles.hintText}>{daemonVersionHint}</Text>
          </View>
          <Text style={styles.valueText}>{localDaemonVersionText}</Text>
        </View>
        <View style={[styles.row, styles.rowBorder]}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>Restart daemon</Text>
            <Text style={styles.hintText}>
              Restarts the desktop-managed daemon without touching `~/.paseo` or `127.0.0.1:6767`.
            </Text>
            {statusMessage ? (
              <Text style={styles.statusText}>{statusMessage}</Text>
            ) : null}
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={handleUpdateLocalDaemon}
            disabled={isRestartingDaemon}
          >
            {isRestartingDaemon ? "Restarting..." : "Restart daemon"}
          </Button>
        </View>
        <View style={[styles.row, styles.rowBorder]}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>CLI shim</Text>
            <Text style={styles.hintText}>
              Installs a global `paseo` launcher that forwards into the desktop-managed runtime.
            </Text>
            {cliStatusMessage ? <Text style={styles.statusText}>{cliStatusMessage}</Text> : null}
          </View>
          <Button
            variant="secondary"
            size="sm"
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
                "Managed daemon log path unavailable."}
            </Text>
          </View>
          <View style={styles.actionGroup}>
            {(managedLogs?.logPath ?? managedStatus?.logPath) ? (
              <Button variant="secondary" size="sm" onPress={handleCopyLogPath}>
                Copy path
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
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
              Show the managed daemon QR code and a copyable pairing link for the mobile app.
            </Text>
          </View>
          <Button variant="secondary" size="sm" onPress={handleOpenPairingModal}>
            Pair device
          </Button>
        </View>
        <View style={[styles.row, styles.rowBorder]}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>Advanced TCP</Text>
            <Text style={styles.hintText}>
              Default off. Use only if you explicitly want a network listener instead of the
              private managed transport.
            </Text>
            <Text style={styles.statusText}>
              {managedStatus?.tcpEnabled
                ? `Enabled on ${managedStatus.tcpListen ?? managedStatus.transportPath}`
                : "Disabled"}
            </Text>
          </View>
          <View style={styles.actionGroup}>
            {managedStatus?.tcpEnabled ? (
              <Button
                variant="secondary"
                size="sm"
                onPress={handleDisableTcp}
                disabled={isSavingTcpSettings}
              >
                {isSavingTcpSettings ? "Working..." : "Disable TCP"}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onPress={handleOpenTcpModal}
              disabled={isSavingTcpSettings}
            >
              {managedStatus?.tcpEnabled ? "Edit TCP" : "Enable TCP"}
            </Button>
          </View>
        </View>
      </View>

      {daemonVersionMismatch ? (
        <View style={styles.warningCard}>
          <Text style={styles.warningText}>
            Desktop app and managed daemon versions differ. Keep both on the same version to avoid
            stability issues or breaking changes.
          </Text>
        </View>
      ) : null}

      <AdaptiveModalSheet
        visible={isTcpModalOpen}
        onClose={() => setIsTcpModalOpen(false)}
        title="Managed TCP settings"
      >
        <View style={styles.modalBody}>
          <Text style={styles.hintText}>
            TCP is advanced opt-in only. It must stay off unless you explicitly need direct network
            access, and it must never use port 6767.
          </Text>
          <AdaptiveTextInput
            value={tcpHostInput}
            onChangeText={setTcpHostInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="127.0.0.1"
            style={styles.input}
          />
          <AdaptiveTextInput
            value={tcpPortInput}
            onChangeText={setTcpPortInput}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            placeholder={String(DEFAULT_TCP_PORT)}
            style={styles.input}
          />
          <View style={styles.modalActions}>
            <Button variant="secondary" size="sm" onPress={() => setIsTcpModalOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onPress={handleSaveTcp} disabled={isSavingTcpSettings}>
              {isSavingTcpSettings ? "Saving..." : "Save"}
            </Button>
          </View>
        </View>
      </AdaptiveModalSheet>

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
            <Button variant="secondary" size="sm" onPress={() => setIsCliInstallModalOpen(false)}>
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
        title="Managed daemon logs"
        testID="managed-daemon-logs-dialog"
        snapPoints={["70%", "92%"]}
      >
        <View style={styles.modalBody}>
          <Text style={styles.hintText}>
            {managedLogs?.logPath ??
              managedStatus?.logPath ??
              "Managed daemon log path unavailable."}
          </Text>
          <Text style={styles.logOutput} selectable>
            {managedLogs?.contents.length ? managedLogs.contents : "(log file is empty)"}
          </Text>
        </View>
      </AdaptiveModalSheet>
    </View>
  );
}

const DEFAULT_TCP_HOST = "127.0.0.1";
const DEFAULT_TCP_PORT = 7771;

function splitTcpListen(value: string | null): [string, string] {
  if (!value) {
    return [DEFAULT_TCP_HOST, String(DEFAULT_TCP_PORT)];
  }
  const [host, port] = value.split(":");
  return [host || DEFAULT_TCP_HOST, port || String(DEFAULT_TCP_PORT)];
}

function parseTcpPort(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

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
        <Button variant="secondary" size="sm" onPress={onCopyLink}>
          Copy link
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  card: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
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
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
