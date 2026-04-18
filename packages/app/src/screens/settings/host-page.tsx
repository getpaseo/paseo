import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight, Globe, Monitor, Pencil, RotateCw, Trash2 } from "lucide-react-native";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
  useHostMutations,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { formatConnectionStatus, getConnectionStatusTone } from "@/utils/daemons";
import { confirmDialog } from "@/utils/confirm-dialog";
import { settingsStyles } from "@/styles/settings";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { SettingsSection } from "@/screens/settings/settings-section";
import { ProvidersSection } from "@/screens/settings/providers-section";
import { PairDeviceModal } from "@/desktop/components/pair-device-modal";
import { LocalDaemonSection } from "@/desktop/components/desktop-updates-section";

const RESTART_CONFIRMATION_MESSAGE =
  "This will restart the daemon. Agents running on it will keep going; the app will reconnect automatically.";

function formatHostConnectionLabel(connection: HostConnection): string {
  if (connection.type === "relay") {
    return `Relay (${connection.relayEndpoint})`;
  }
  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return `Local (${connection.path})`;
  }
  return `TCP (${connection.endpoint})`;
}

function formatActiveConnectionBadge(
  activeConnection: { type: HostConnection["type"]; display: string } | null,
  theme: ReturnType<typeof useUnistyles>["theme"],
): { icon: React.ReactNode; text: string } | null {
  if (!activeConnection) return null;
  if (activeConnection.type === "relay") {
    return {
      icon: <Globe size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      text: "Relay",
    };
  }
  if (activeConnection.type === "directSocket" || activeConnection.type === "directPipe") {
    return {
      icon: <Monitor size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      text: "Local",
    };
  }
  return {
    icon: <Monitor size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    text: activeConnection.display,
  };
}

function formatDaemonVersionBadge(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export interface HostPageProps {
  serverId: string;
  onHostRemoved?: () => void;
}

export function HostPage({ serverId, onHostRemoved }: HostPageProps) {
  const daemons = useHosts();
  const host = daemons.find((entry) => entry.serverId === serverId) ?? null;
  const { theme } = useUnistyles();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);

  const daemonVersion = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.version ?? null,
  );

  const connectionStatus = snapshot?.connectionStatus ?? "connecting";
  const activeConnection = snapshot?.activeConnection ?? null;
  const lastError = snapshot?.lastError ?? null;
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
  const connectionBadge = formatActiveConnectionBadge(activeConnection, theme);
  const versionBadgeText = formatDaemonVersionBadge(daemonVersion);
  const connectionError =
    typeof lastError === "string" && lastError.trim().length > 0 ? lastError.trim() : null;

  if (!host) {
    return (
      <View testID={`settings-host-page-${serverId}`}>
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>Host not found.</Text>
        </View>
      </View>
    );
  }

  return (
    <View testID={`settings-host-page-${serverId}`}>
      <View style={styles.identityBadges} testID="host-page-identity">
        <View style={[styles.statusPill, { backgroundColor: statusPillBg }]}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
        {connectionBadge ? (
          <View style={styles.badgePill}>
            {connectionBadge.icon}
            <Text style={styles.badgeText} numberOfLines={1}>
              {connectionBadge.text}
            </Text>
          </View>
        ) : null}
        {versionBadgeText ? (
          <View style={styles.badgePill}>
            <Text style={styles.badgeText} numberOfLines={1}>
              {versionBadgeText}
            </Text>
          </View>
        ) : null}
      </View>
      {connectionError ? <Text style={styles.errorText}>{connectionError}</Text> : null}

      <ConnectionsSection host={host} />

      <DaemonSection host={host} isLocalDaemon={isLocalDaemon} />

      <ProvidersSection serverId={serverId} />

      <RemoveHostSection host={host} onRemoved={onHostRemoved} />
    </View>
  );
}

export function HostRenameButton({ host }: { host: HostProfile }) {
  const { theme } = useUnistyles();
  const { renameHost } = useHostMutations();
  const [isEditing, setIsEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(host.label ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    setDraftLabel(host.label ?? "");
  }, [host.serverId, host.label]);

  useEffect(() => {
    if (isEditing) {
      const timeout = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [isEditing]);

  const handleSave = useCallback(async () => {
    const nextLabel = draftLabel.trim();
    if (!nextLabel) {
      Alert.alert("Label required", "Enter a label for this host.");
      return;
    }
    if (isSaving) return;
    if (nextLabel === host.label.trim()) {
      setIsEditing(false);
      return;
    }
    try {
      setIsSaving(true);
      await renameHost(host.serverId, nextLabel);
      setIsEditing(false);
    } catch (error) {
      console.error("[HostPage] Failed to rename host", error);
      Alert.alert("Error", "Unable to save host");
    } finally {
      setIsSaving(false);
    }
  }, [draftLabel, host.label, host.serverId, isSaving, renameHost]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    setDraftLabel(host.label ?? "");
    setIsEditing(false);
  }, [host.label, isSaving]);

  return (
    <>
      <Pressable
        onPress={() => {
          setDraftLabel(host.label ?? "");
          setIsEditing(true);
        }}
        hitSlop={8}
        style={styles.identityEditButton}
        accessibilityRole="button"
        accessibilityLabel="Edit label"
        testID="host-page-label-edit-button"
      >
        <Pencil size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </Pressable>

      <AdaptiveModalSheet
        visible={isEditing}
        onClose={handleCancel}
        title="Rename host"
        testID="host-page-rename-modal"
      >
        <View style={styles.renameBody}>
          <TextInput
            ref={inputRef}
            value={draftLabel}
            onChangeText={setDraftLabel}
            placeholder="My Host"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isSaving}
            onSubmitEditing={() => void handleSave()}
            style={styles.renameInput}
            testID="host-page-label-input"
          />
          <View style={styles.renameActions}>
            <Button
              variant="secondary"
              size="sm"
              style={{ flex: 1 }}
              onPress={handleCancel}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              style={{ flex: 1 }}
              onPress={() => void handleSave()}
              disabled={isSaving}
              testID="host-page-label-save"
            >
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </View>
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

function ConnectionsSection({ host }: { host: HostProfile }) {
  const { removeConnection } = useHostMutations();
  const snapshot = useHostRuntimeSnapshot(host.serverId);
  const probeByConnectionId = snapshot?.probeByConnectionId ?? new Map();
  const [pendingRemoveConnection, setPendingRemoveConnection] = useState<{
    connectionId: string;
    title: string;
  } | null>(null);
  const [isRemovingConnection, setIsRemovingConnection] = useState(false);

  return (
    <SettingsSection title="Connections">
      <View style={settingsStyles.card} testID="host-page-connections-card">
        {host.connections.map((conn, index) => {
          const probe = probeByConnectionId.get(conn.id);
          return (
            <ConnectionRow
              key={conn.id}
              connection={conn}
              showBorder={index > 0}
              latencyMs={probe?.status === "available" ? probe.latencyMs : undefined}
              latencyLoading={!probe || probe.status === "pending"}
              latencyError={probe?.status === "unavailable"}
              onRemove={() => {
                setPendingRemoveConnection({
                  connectionId: conn.id,
                  title: formatHostConnectionLabel(conn),
                });
              }}
            />
          );
        })}
      </View>

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
          <Text style={styles.confirmText}>
            Remove {pendingRemoveConnection.title}? This cannot be undone.
          </Text>
          <View style={styles.confirmActions}>
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
                const { connectionId } = pendingRemoveConnection;
                setIsRemovingConnection(true);
                void removeConnection(host.serverId, connectionId)
                  .then(() => setPendingRemoveConnection(null))
                  .catch((error) => {
                    console.error("[HostPage] Failed to remove connection", error);
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
    </SettingsSection>
  );
}

function ConnectionRow({
  connection,
  showBorder,
  latencyMs,
  latencyLoading,
  latencyError,
  onRemove,
}: {
  connection: HostConnection;
  showBorder: boolean;
  latencyMs: number | null | undefined;
  latencyLoading: boolean;
  latencyError: boolean;
  onRemove: () => void;
}) {
  const { theme } = useUnistyles();
  const title = formatHostConnectionLabel(connection);

  const latencyText = (() => {
    if (latencyLoading) return "...";
    if (latencyError) return "Timeout";
    if (latencyMs != null) return `${latencyMs}ms`;
    return "\u2014";
  })();
  const latencyColor = latencyError ? theme.colors.palette.red[300] : theme.colors.foregroundMuted;

  return (
    <View style={[settingsStyles.row, showBorder && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Text style={[styles.connectionLatency, { color: latencyColor }]}>{latencyText}</Text>
      <Button
        variant="ghost"
        size="sm"
        textStyle={{ color: theme.colors.destructive }}
        onPress={onRemove}
      >
        Remove
      </Button>
    </View>
  );
}

function DaemonSection({ host, isLocalDaemon }: { host: HostProfile; isLocalDaemon: boolean }) {
  return (
    <>
      <SettingsSection title="Operations">
        <RestartDaemonCard host={host} />
        <InjectPaseoToolsCard serverId={host.serverId} />
      </SettingsSection>
      {isLocalDaemon ? (
        <SettingsSection title="Pair devices">
          <PairDeviceRow />
        </SettingsSection>
      ) : null}
      {isLocalDaemon ? <LocalDaemonSection /> : null}
    </>
  );
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      clearTimeout(timeout);
      resolve();
    }, ms);
  });

function RestartDaemonCard({ host }: { host: HostProfile }) {
  const { theme } = useUnistyles();
  const daemonClient = useHostRuntimeClient(host.serverId);
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const runtime = getHostRuntimeStore();
  const [isRestarting, setIsRestarting] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isHostConnected = useCallback(
    () => isHostRuntimeConnected(runtime.getSnapshot(host.serverId)),
    [host.serverId, runtime],
  );

  const waitForCondition = useCallback(
    async (predicate: () => boolean, timeoutMs: number, intervalMs = 250) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isMountedRef.current) return false;
        if (predicate()) return true;
        await delay(intervalMs);
      }
      return predicate();
    },
    [],
  );

  const waitForDaemonRestart = useCallback(async () => {
    const disconnectTimeoutMs = 7000;
    const reconnectTimeoutMs = 30000;
    if (isHostConnected()) {
      await waitForCondition(() => !isHostConnected(), disconnectTimeoutMs);
    }
    const reconnected = await waitForCondition(() => isHostConnected(), reconnectTimeoutMs);
    if (isMountedRef.current) {
      setIsRestarting(false);
      if (!reconnected) {
        Alert.alert(
          "Unable to reconnect",
          `${host.label} did not come back online. Please verify it restarted.`,
        );
      }
    }
  }, [host.label, isHostConnected, waitForCondition]);

  const handleRestart = useCallback(() => {
    if (!daemonClient) {
      Alert.alert(
        "Host unavailable",
        "This host is not connected. Wait for it to come online before restarting.",
      );
      return;
    }
    if (!isHostConnected()) {
      Alert.alert(
        "Host offline",
        "This host is offline. Paseo reconnects automatically—wait until it's back online before restarting.",
      );
      return;
    }

    void confirmDialog({
      title: `Restart ${host.label}`,
      message: RESTART_CONFIRMATION_MESSAGE,
      confirmLabel: "Restart",
      cancelLabel: "Cancel",
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed) return;
        setIsRestarting(true);
        void daemonClient
          .restartServer(`settings_daemon_restart_${host.serverId}`)
          .catch((error) => {
            console.error(`[HostPage] Failed to restart daemon ${host.label}`, error);
            if (!isMountedRef.current) return;
            setIsRestarting(false);
            Alert.alert(
              "Error",
              "Failed to send the restart request. Paseo reconnects automatically—try again once the host shows as online.",
            );
          });
        void waitForDaemonRestart();
      })
      .catch((error) => {
        console.error(`[HostPage] Failed to open restart confirmation for ${host.label}`, error);
        Alert.alert("Error", "Unable to open the restart confirmation dialog.");
      });
  }, [daemonClient, host.label, host.serverId, isHostConnected, waitForDaemonRestart]);

  return (
    <View style={settingsStyles.card} testID="host-page-restart-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Restart daemon</Text>
          <Text style={settingsStyles.rowHint}>
            Restarts the daemon process. The app will reconnect automatically.
          </Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={<RotateCw size={theme.iconSize.sm} color={theme.colors.foreground} />}
          onPress={handleRestart}
          disabled={isRestarting || !daemonClient || !isConnected}
          testID="host-page-restart-button"
        >
          {isRestarting ? "Restarting..." : "Restart"}
        </Button>
      </View>
    </View>
  );
}

function InjectPaseoToolsCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);

  if (!isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-inject-mcp-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Inject Paseo tools</Text>
          <Text style={settingsStyles.rowHint}>
            Automatically inject Paseo MCP tools into new agents
          </Text>
        </View>
        <SegmentedControl
          size="sm"
          value={config?.mcp.injectIntoAgents === false ? "off" : "on"}
          onValueChange={(value) => {
            void patchConfig({
              mcp: {
                injectIntoAgents: value === "on",
              },
            });
          }}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </View>
    </View>
  );
}

function PairDeviceRow() {
  const { theme } = useUnistyles();
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <View style={settingsStyles.card}>
      <Pressable
        style={settingsStyles.row}
        onPress={() => setIsModalOpen(true)}
        accessibilityRole="button"
        testID="host-page-pair-device-row"
      >
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Pair a device</Text>
          <Text style={settingsStyles.rowHint}>
            Scan a QR code or copy a link to connect your phone to this host.
          </Text>
        </View>
        <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </Pressable>

      <PairDeviceModal
        visible={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        testID="host-page-pair-device-card"
      />
    </View>
  );
}

function RemoveHostSection({ host, onRemoved }: { host: HostProfile; onRemoved?: () => void }) {
  const { theme } = useUnistyles();
  const { removeHost } = useHostMutations();
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  return (
    <SettingsSection title="Danger zone" testID="host-page-remove-host-card">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Remove host</Text>
            <Text style={settingsStyles.rowHint}>
              Removes this host and its saved connections from this device.
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />}
            textStyle={{ color: theme.colors.destructive }}
            onPress={() => setIsConfirming(true)}
            testID="host-page-remove-host-button"
          >
            Remove
          </Button>
        </View>
      </View>

      {isConfirming ? (
        <AdaptiveModalSheet
          title="Remove host"
          visible
          onClose={() => {
            if (isRemoving) return;
            setIsConfirming(false);
          }}
          testID="remove-host-confirm-modal"
        >
          <Text style={styles.confirmText}>
            Remove {host.label}? This will delete its saved connections.
          </Text>
          <View style={styles.confirmActions}>
            <Button
              variant="secondary"
              size="sm"
              style={{ flex: 1 }}
              onPress={() => setIsConfirming(false)}
              disabled={isRemoving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              style={{ flex: 1 }}
              onPress={() => {
                setIsRemoving(true);
                void removeHost(host.serverId)
                  .then(() => {
                    setIsConfirming(false);
                    onRemoved?.();
                  })
                  .catch((error) => {
                    console.error("[HostPage] Failed to remove host", error);
                    Alert.alert("Error", "Unable to remove host");
                  })
                  .finally(() => setIsRemoving(false));
              }}
              disabled={isRemoving}
              testID="remove-host-confirm"
            >
              Remove
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  identityEditButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  identityBadges: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
    marginBottom: theme.spacing[6],
  },
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
    fontWeight: theme.fontWeight.normal,
  },
  badgePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    maxWidth: 200,
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[2],
  },
  connectionLatency: {
    fontSize: theme.fontSize.sm,
    marginRight: theme.spacing[2],
  },
  confirmText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  confirmActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  renameBody: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  renameInput: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  renameActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
