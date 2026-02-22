import { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  buildDaemonUpdateDiagnostics,
  formatVersionWithPrefix,
  getLocalDaemonVersion,
  isVersionMismatch,
  runLocalDaemonUpdate,
  shouldShowDesktopUpdateSection,
} from "@/desktop/updates/desktop-updates";

export interface LocalDaemonSectionProps {
  appVersion: string | null;
}

export function LocalDaemonSection({ appVersion }: LocalDaemonSectionProps) {
  const showSection = shouldShowDesktopUpdateSection();
  const [localDaemonVersion, setLocalDaemonVersion] = useState<string | null>(null);
  const [localDaemonVersionError, setLocalDaemonVersionError] = useState<string | null>(null);
  const [isUpdatingLocalDaemon, setIsUpdatingLocalDaemon] = useState(false);
  const [localDaemonUpdateMessage, setLocalDaemonUpdateMessage] = useState<string | null>(null);
  const [localDaemonUpdateDiagnostics, setLocalDaemonUpdateDiagnostics] = useState<string | null>(
    null
  );

  useFocusEffect(
    useCallback(() => {
      if (!showSection) {
        return undefined;
      }

      void getLocalDaemonVersion().then((result) => {
        setLocalDaemonVersion(result.version);
        setLocalDaemonVersionError(result.error);
      });
      return undefined;
    }, [showSection])
  );

  const localDaemonVersionText = formatVersionWithPrefix(localDaemonVersion);
  const daemonVersionMismatch = isVersionMismatch(appVersion, localDaemonVersion);
  const daemonVersionHint = localDaemonVersionError ?? "Daemon installed on this computer.";

  const handleUpdateLocalDaemon = useCallback(() => {
    if (!showSection) {
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

            void getLocalDaemonVersion().then((versionResult) => {
              setLocalDaemonVersion(versionResult.version);
              setLocalDaemonVersionError(versionResult.error);
            });
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
  }, [isUpdatingLocalDaemon, showSection]);

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

  if (!showSection) {
    return null;
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Local daemon</Text>
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
            <Text style={styles.rowTitle}>Update daemon</Text>
            <Text style={styles.hintText}>
              Updates the daemon on this computer only. Requires a restart.
            </Text>
            {localDaemonUpdateMessage ? (
              <Text style={styles.statusText}>{localDaemonUpdateMessage}</Text>
            ) : null}
          </View>
          <Button
            variant="secondary"
            size="sm"
            onPress={handleUpdateLocalDaemon}
            disabled={isUpdatingLocalDaemon}
          >
            {isUpdatingLocalDaemon ? "Updating..." : "Update daemon"}
          </Button>
        </View>
      </View>

      {daemonVersionMismatch ? (
        <View style={styles.warningCard}>
          <Text style={styles.warningText}>
            Desktop app and local daemon versions differ. Keep both on the same version to avoid
            stability issues or breaking changes.
          </Text>
        </View>
      ) : null}

      {localDaemonUpdateDiagnostics ? (
        <View style={styles.diagnosticsCard}>
          <View style={styles.diagnosticsHeader}>
            <Text style={styles.diagnosticsTitle}>Daemon update diagnostics</Text>
            <Button variant="secondary" size="sm" onPress={handleCopyDaemonDiagnostics}>
              Copy output
            </Button>
          </View>
          <Text style={styles.diagnosticsText} selectable>
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
  diagnosticsCard: {
    marginTop: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  diagnosticsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  diagnosticsTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  diagnosticsText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
}));
