import { useCallback, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet } from "react-native-unistyles";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useSessionStore } from "@/stores/session-store";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import {
  buildDaemonUpdateDiagnostics,
  findLikelyLocalDaemonHost,
  formatVersionWithPrefix,
  isVersionMismatch,
  runLocalDaemonUpdate,
  shouldShowDesktopUpdateSection,
} from "@/desktop/updates/desktop-updates";

export interface DesktopUpdatesSectionProps {
  appVersion: string | null;
}

export function DesktopUpdatesSection({ appVersion }: DesktopUpdatesSectionProps) {
  const showDesktopUpdatesSection = shouldShowDesktopUpdateSection();
  const { daemons } = useDaemonRegistry();
  const [isUpdatingLocalDaemon, setIsUpdatingLocalDaemon] = useState(false);
  const [localDaemonUpdateMessage, setLocalDaemonUpdateMessage] = useState<string | null>(null);
  const [localDaemonUpdateDiagnostics, setLocalDaemonUpdateDiagnostics] = useState<string | null>(
    null
  );

  const appVersionText = formatVersionWithPrefix(appVersion);
  const localDaemonHost = useMemo(() => findLikelyLocalDaemonHost(daemons), [daemons]);
  const localDaemonServerId = localDaemonHost?.serverId ?? null;
  const localDaemonVersion = useSessionStore(
    useCallback(
      (state) =>
        localDaemonServerId
          ? (state.sessions[localDaemonServerId]?.serverInfo?.version ?? null)
          : null,
      [localDaemonServerId]
    )
  );
  const localDaemonVersionText = formatVersionWithPrefix(localDaemonVersion);
  const daemonVersionMismatch = isVersionMismatch(appVersion, localDaemonVersion);

  const {
    isDesktop: isDesktopUpdaterAvailable,
    statusText: appUpdateStatusText,
    availableUpdate,
    errorMessage: appUpdateError,
    isChecking: isCheckingAppUpdate,
    isInstalling: isInstallingAppUpdate,
    checkForUpdates,
    installUpdate,
  } = useDesktopAppUpdater();

  useFocusEffect(
    useCallback(() => {
      if (!showDesktopUpdatesSection || !isDesktopUpdaterAvailable) {
        return undefined;
      }

      void checkForUpdates({ silent: true });
      return undefined;
    }, [checkForUpdates, isDesktopUpdaterAvailable, showDesktopUpdatesSection])
  );

  const handleCheckForAppUpdates = useCallback(() => {
    if (!showDesktopUpdatesSection || !isDesktopUpdaterAvailable) {
      return;
    }
    void checkForUpdates();
  }, [checkForUpdates, isDesktopUpdaterAvailable, showDesktopUpdatesSection]);

  const handleInstallAppUpdate = useCallback(() => {
    if (!showDesktopUpdatesSection || !isDesktopUpdaterAvailable) {
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
  }, [installUpdate, isDesktopUpdaterAvailable, showDesktopUpdatesSection]);

  const handleUpdateLocalDaemon = useCallback(() => {
    if (!showDesktopUpdatesSection || !isDesktopUpdaterAvailable) {
      return;
    }
    if (isUpdatingLocalDaemon) {
      return;
    }

    void confirmDialog({
      title: "Update local daemon",
      message:
        "This updates the Paseo daemon on this computer. A restart is required afterwards.",
      confirmLabel: "Update daemon",
      cancelLabel: "Cancel",
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }

        setIsUpdatingLocalDaemon(true);
        setLocalDaemonUpdateMessage(null);
        setLocalDaemonUpdateDiagnostics(null);

        void runLocalDaemonUpdate()
          .then((result) => {
            const diagnostics = buildDaemonUpdateDiagnostics(result);
            if (result.exitCode !== 0) {
              setLocalDaemonUpdateMessage(
                `Local daemon update failed (exit code ${result.exitCode}). Copy diagnostics below to troubleshoot.`
              );
              setLocalDaemonUpdateDiagnostics(diagnostics);
              return;
            }

            setLocalDaemonUpdateMessage(
              "Local daemon update finished. Restart is required: run `paseo daemon restart` on this computer."
            );
            if (result.stdout.trim().length > 0 || result.stderr.trim().length > 0) {
              setLocalDaemonUpdateDiagnostics(diagnostics);
            }
          })
          .catch((error) => {
            console.error("[Settings] Failed to update local daemon", error);
            const message = error instanceof Error ? error.message : String(error);
            setLocalDaemonUpdateMessage(
              "Local daemon update failed before completion. Copy diagnostics below to troubleshoot."
            );
            setLocalDaemonUpdateDiagnostics(
              buildDaemonUpdateDiagnostics({
                exitCode: -1,
                stdout: "",
                stderr: message,
              })
            );
          })
          .finally(() => {
            setIsUpdatingLocalDaemon(false);
          });
      })
      .catch((error) => {
        console.error("[Settings] Failed to open daemon update confirmation", error);
        Alert.alert("Error", "Unable to open the daemon update confirmation dialog.");
      });
  }, [isDesktopUpdaterAvailable, isUpdatingLocalDaemon, showDesktopUpdatesSection]);

  const handleCopyDaemonDiagnostics = useCallback(() => {
    if (!localDaemonUpdateDiagnostics) {
      return;
    }

    void Clipboard.setStringAsync(localDaemonUpdateDiagnostics)
      .then(() => {
        Alert.alert("Copied", "Daemon update diagnostics copied.");
      })
      .catch((error) => {
        console.error("[Settings] Failed to copy daemon update diagnostics", error);
        Alert.alert("Error", "Unable to copy diagnostics.");
      });
  }, [localDaemonUpdateDiagnostics]);

  if (!showDesktopUpdatesSection) {
    return null;
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Updates</Text>
      <View style={styles.audioCard}>
        <View style={styles.audioRow}>
          <View style={styles.audioRowContent}>
            <Text style={styles.audioRowTitle}>Desktop app version</Text>
            <Text style={styles.updateHintText}>Paseo installed on this computer.</Text>
          </View>
          <Text style={styles.aboutValue}>{appVersionText}</Text>
        </View>
        <View style={[styles.audioRow, styles.audioRowBorder]}>
          <View style={styles.audioRowContent}>
            <Text style={styles.audioRowTitle}>Local daemon version</Text>
            <Text style={styles.updateHintText}>
              {localDaemonHost
                ? `Connected host: ${localDaemonHost.label}`
                : "No local daemon detected yet."}
            </Text>
          </View>
          <Text style={styles.aboutValue}>{localDaemonVersionText}</Text>
        </View>
        <View style={[styles.audioRow, styles.audioRowBorder]}>
          <View style={styles.audioRowContent}>
            <Text style={styles.audioRowTitle}>App update status</Text>
            <Text style={styles.updateStatusText}>{appUpdateStatusText}</Text>
            {availableUpdate?.latestVersion ? (
              <Text style={styles.updateHintText}>
                New version available: {formatVersionWithPrefix(availableUpdate.latestVersion)}
              </Text>
            ) : null}
            {appUpdateError ? <Text style={styles.updateErrorText}>{appUpdateError}</Text> : null}
          </View>
          <View style={styles.updateActions}>
            <Button
              variant="secondary"
              size="sm"
              onPress={handleCheckForAppUpdates}
              disabled={!isDesktopUpdaterAvailable || isCheckingAppUpdate || isInstallingAppUpdate}
            >
              {isCheckingAppUpdate ? "Checking..." : "Check for updates"}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleInstallAppUpdate}
              disabled={
                !isDesktopUpdaterAvailable ||
                isCheckingAppUpdate ||
                isInstallingAppUpdate ||
                !availableUpdate
              }
            >
              {isInstallingAppUpdate
                ? "Installing..."
                : availableUpdate?.latestVersion
                  ? `Update to ${formatVersionWithPrefix(availableUpdate.latestVersion)}`
                  : "Update app"}
            </Button>
          </View>
        </View>
        <View style={[styles.audioRow, styles.audioRowBorder]}>
          <View style={styles.audioRowContent}>
            <Text style={styles.audioRowTitle}>Update local daemon</Text>
            <Text style={styles.updateHintText}>
              Updates the daemon on this computer only. Requires a restart.
            </Text>
            {localDaemonUpdateMessage ? (
              <Text style={styles.updateStatusText}>{localDaemonUpdateMessage}</Text>
            ) : null}
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={handleUpdateLocalDaemon}
            disabled={!isDesktopUpdaterAvailable || isUpdatingLocalDaemon}
          >
            {isUpdatingLocalDaemon ? "Updating..." : "Update daemon"}
          </Button>
        </View>
      </View>

      {daemonVersionMismatch ? (
        <View style={styles.updateWarningCard}>
          <Text style={styles.updateWarningText}>
            Desktop app and local daemon versions differ. Keep both on the same version to avoid
            stability issues or breaking changes.
          </Text>
        </View>
      ) : null}

      {localDaemonUpdateDiagnostics ? (
        <View style={styles.updateDiagnosticsCard}>
          <View style={styles.updateDiagnosticsHeader}>
            <Text style={styles.updateDiagnosticsTitle}>Daemon update diagnostics</Text>
            <Button variant="secondary" size="sm" onPress={handleCopyDaemonDiagnostics}>
              Copy output
            </Button>
          </View>
          <Text style={styles.updateDiagnosticsText} selectable>
            {localDaemonUpdateDiagnostics}
          </Text>
        </View>
      ) : null}
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
  updateHintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: 2,
  },
  updateStatusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  updateActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  updateErrorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  updateWarningCard: {
    marginTop: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.palette.amber[500],
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  updateWarningText: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.xs,
  },
  updateDiagnosticsCard: {
    marginTop: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  updateDiagnosticsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  updateDiagnosticsTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  updateDiagnosticsText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
}));
