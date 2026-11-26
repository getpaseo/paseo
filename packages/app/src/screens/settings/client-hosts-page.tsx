import { Plus, Server, Trash2 } from "lucide-react-native";
import type { TFunction } from "i18next";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { HostStatusDot } from "@/components/host-status-dot";
import {
  SettingsAddRow,
  SettingsCard,
  SettingsDetailHeader,
  SettingsDetailRow,
  SettingsRow,
  SettingsSection,
} from "@/components/settings";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { startDesktopDaemon, stopDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import type { EnableBuiltInDaemonOption } from "@/desktop/hooks/use-enable-built-in-daemon-option";
import { useDaemonStatus } from "@/desktop/hooks/use-daemon-status";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useIsLocalDaemon, useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { resolveHostIcon } from "@/hosts/appearance";
import { describeActiveConnection, describeHostConnection } from "@/hosts/connection-display";
import { HostIconGlyph } from "@/hosts/host-icon-glyph";
import { useHostMutations, useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { HostAppearanceSection } from "@/screens/settings/host-appearance-section";
import { HostConnectionError } from "@/screens/settings/host-page";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  orderHostsLocalFirst,
  type HostConnection,
  type HostProfile,
} from "@/types/host-connection";
import { formatLatency } from "@/utils/latency";

const ThemedPlus = withUnistyles(Plus);
const ThemedServer = withUnistyles(Server);
const ThemedTrash2 = withUnistyles(Trash2);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const addRouteIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const enableDaemonIcon = <ThemedServer size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
const removeHostIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;

function formatConnectionTitle(
  connection: HostConnection,
  isLocalHost: boolean,
  t: TFunction,
): string {
  const described = describeHostConnection(connection, { isLocalHost });
  return t(`settings.host.connectionKinds.${described.kind}`);
}

function formatConnectionEndpoint(
  connection: HostConnection,
  isLocalHost: boolean,
  hosts: readonly HostProfile[],
): string | undefined {
  const described = describeHostConnection(connection, { isLocalHost });
  if (described.kind === "routed" && described.endpoint) {
    return hosts.find((host) => host.serverId === described.endpoint)?.label ?? described.endpoint;
  }
  return described.endpoint ?? undefined;
}

function formatDaemonVersion(version: string | null): string | undefined {
  const trimmed = version?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function ClientHostListRow({
  host,
  isLocalHost,
  hosts,
  onSelectHost,
}: {
  host: HostProfile;
  isLocalHost: boolean;
  hosts: readonly HostProfile[];
  onSelectHost: (serverId: string) => void;
}) {
  const { t } = useTranslation();
  const snapshot = useHostRuntimeSnapshot(host.serverId);
  const serverInfo = useSessionStore((state) => state.sessions[host.serverId]?.serverInfo);
  const detectedMachineKind = serverInfo?.machineKind ?? null;
  const resolvedIcon = resolveHostIcon({ appearance: host.appearance, detectedMachineKind });

  const handleOpen = useCallback(() => {
    onSelectHost(host.serverId);
  }, [host.serverId, onSelectHost]);

  const status = snapshot?.connectionStatus;
  const activeConnection = snapshot?.activeConnection ?? null;
  const activeConnectionId = snapshot?.activeConnectionId;
  const activeProbe = activeConnectionId
    ? snapshot?.probeByConnectionId.get(activeConnectionId)
    : undefined;
  const latencyMs =
    status === "online" && activeProbe?.status === "available" ? activeProbe.latencyMs : null;

  const fallbackConnection = useMemo(() => {
    if (activeConnection || host.connections.length === 0) return null;
    if (host.preferredConnectionId) {
      const preferred = host.connections.find((c) => c.id === host.preferredConnectionId);
      if (preferred) return preferred;
    }
    return host.connections[0] ?? null;
  }, [activeConnection, host.connections, host.preferredConnectionId]);

  const hint = useMemo(() => {
    let described: ReturnType<typeof describeHostConnection> | null = null;
    if (activeConnection) {
      described = describeActiveConnection(activeConnection, { isLocalHost });
    } else if (fallbackConnection) {
      described = describeHostConnection(fallbackConnection, { isLocalHost });
    }
    const parts: string[] = [];
    if (described) {
      parts.push(t(`settings.host.connectionKinds.${described.kind}`));
      if (described.endpoint) {
        const endpoint =
          described.kind === "routed"
            ? (hosts.find((candidate) => candidate.serverId === described.endpoint)?.label ??
              described.endpoint)
            : described.endpoint;
        parts.push(endpoint);
      }
    }
    if (latencyMs !== null) {
      parts.push(formatLatency(latencyMs));
    }
    return parts.join(" · ") || undefined;
  }, [activeConnection, fallbackConnection, hosts, isLocalHost, latencyMs, t]);

  let summary: string | undefined;
  if (status === "online") {
    summary = formatDaemonVersion(serverInfo?.version ?? null);
  } else if (status === "offline" || status === "error") {
    summary = t("settings.about.offline");
  }

  const leading = useMemo(
    () => (
      <View style={styles.listLeading}>
        <HostStatusDot serverId={host.serverId} />
        <HostIconGlyph icon={resolvedIcon} color={host.appearance.color} size={ICON_SIZE.md} />
      </View>
    ),
    [host.appearance.color, host.serverId, resolvedIcon],
  );

  return (
    <SettingsDetailRow
      label={host.label}
      leading={leading}
      hint={hint}
      summary={summary}
      onPress={handleOpen}
      testID={`client-host-row-${host.serverId}`}
    />
  );
}

export function ClientHostsSection({
  onSelectHost,
  onAddHost,
  enableBuiltInDaemonOption,
}: {
  onSelectHost: (serverId: string) => void;
  onAddHost: () => void;
  enableBuiltInDaemonOption: EnableBuiltInDaemonOption;
}) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );

  return (
    <SettingsSection
      title={t("settings.clientHosts.title")}
      info={t("settings.clientHosts.info")}
      testID="client-hosts-section"
    >
      <SettingsCard testID="client-hosts-card">
        {sortedHosts.map((host) => (
          <ClientHostListRow
            key={host.serverId}
            host={host}
            isLocalHost={host.serverId === localServerId}
            hosts={sortedHosts}
            onSelectHost={onSelectHost}
          />
        ))}
        <SettingsAddRow
          label={t("settings.addHost")}
          onPress={onAddHost}
          testID="client-hosts-add-row"
        />
        {enableBuiltInDaemonOption.visible ? (
          <SettingsDetailRow
            label={t("settings.enableBuiltInDaemon")}
            leading={enableDaemonIcon}
            onPress={enableBuiltInDaemonOption.onPress}
            testID="client-hosts-enable-built-in-daemon"
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function ClientHostRouteRow({
  connection,
  isActive,
  isLocalHost,
  hosts,
  latencyMs,
  latencyLoading,
  latencyError,
  onRemove,
}: {
  connection: HostConnection;
  isActive: boolean;
  isLocalHost: boolean;
  hosts: readonly HostProfile[];
  latencyMs: number | null | undefined;
  latencyLoading: boolean;
  latencyError: boolean;
  onRemove: (connection: HostConnection) => void;
}) {
  const { t } = useTranslation();
  const title = formatConnectionTitle(connection, isLocalHost, t);
  const endpoint = formatConnectionEndpoint(connection, isLocalHost, hosts);

  const latencyText = (() => {
    if (latencyLoading) return "...";
    if (latencyError) return t("settings.host.connections.timeout");
    if (latencyMs != null) return formatLatency(latencyMs);
    return "—";
  })();

  const handlePressRemove = useCallback(() => {
    onRemove(connection);
  }, [onRemove, connection]);

  const activeBadge = useMemo(
    () =>
      isActive ? (
        <StatusBadge label={t("settings.clientHosts.activeRoute")} variant="success" />
      ) : null,
    [isActive, t],
  );

  return (
    <SettingsRow label={title} labelAccessory={activeBadge} hint={endpoint}>
      <View style={styles.routeTrailing}>
        <Text style={latencyError ? styles.latencyError : styles.latencyText}>{latencyText}</Text>
        <Button variant="ghost" textStyle={styles.destructiveText} onPress={handlePressRemove}>
          {t("settings.host.connections.removeAction")}
        </Button>
      </View>
    </SettingsRow>
  );
}

function ClientHostRoutesSection({
  host,
  isLocalHost,
  onAddHost,
}: {
  host: HostProfile;
  isLocalHost: boolean;
  onAddHost: () => void;
}) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { removeConnection } = useHostMutations();
  const snapshot = useHostRuntimeSnapshot(host.serverId);
  const probeByConnectionId = snapshot?.probeByConnectionId ?? new Map();
  const activeConnectionId = snapshot?.activeConnectionId ?? null;
  const [pendingRemoveConnection, setPendingRemoveConnection] = useState<{
    connectionId: string;
    title: string;
  } | null>(null);
  const [isRemovingConnection, setIsRemovingConnection] = useState(false);

  const removeConnectionHeader = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.connections.removeTitle") }),
    [t],
  );

  const handleRequestRemove = useCallback(
    (connection: HostConnection) => {
      const kindLabel = formatConnectionTitle(connection, isLocalHost, t);
      const endpoint = formatConnectionEndpoint(connection, isLocalHost, hosts);
      setPendingRemoveConnection({
        connectionId: connection.id,
        title: endpoint ? `${kindLabel} (${endpoint})` : kindLabel,
      });
    },
    [hosts, isLocalHost, t],
  );

  const handleCloseConfirm = useCallback(() => {
    if (isRemovingConnection) return;
    setPendingRemoveConnection(null);
  }, [isRemovingConnection]);

  const handleCancelConfirm = useCallback(() => {
    setPendingRemoveConnection(null);
  }, []);

  const handleConfirmRemove = useCallback(() => {
    if (!pendingRemoveConnection) return;
    const { connectionId } = pendingRemoveConnection;
    setIsRemovingConnection(true);
    void removeConnection(host.serverId, connectionId)
      .then(() => setPendingRemoveConnection(null))
      .catch((error) => {
        console.error("[ClientHostDetail] Failed to remove connection", error);
        Alert.alert(
          t("settings.host.connections.removeErrorTitle"),
          t("settings.host.connections.removeErrorMessage"),
        );
      })
      .finally(() => setIsRemovingConnection(false));
  }, [pendingRemoveConnection, removeConnection, host.serverId, t]);

  const addRouteButton = useMemo(
    () => (
      <Button
        variant="ghost"
        leftIcon={addRouteIcon}
        onPress={onAddHost}
        testID="client-host-add-route"
      >
        {t("settings.clientHosts.addRoute")}
      </Button>
    ),
    [onAddHost, t],
  );

  return (
    <SettingsSection
      title={t("settings.clientHosts.routesTitle")}
      info={t("settings.clientHosts.routesInfo")}
      trailing={addRouteButton}
    >
      <SettingsCard testID="host-page-connections-card">
        {host.connections.map((conn) => {
          const probe = probeByConnectionId.get(conn.id);
          return (
            <ClientHostRouteRow
              key={conn.id}
              connection={conn}
              isActive={snapshot?.connectionStatus === "online" && activeConnectionId === conn.id}
              isLocalHost={isLocalHost}
              hosts={hosts}
              latencyMs={probe?.status === "available" ? probe.latencyMs : undefined}
              latencyLoading={!probe || probe.status === "pending"}
              latencyError={probe?.status === "unavailable"}
              onRemove={handleRequestRemove}
            />
          );
        })}
      </SettingsCard>

      {pendingRemoveConnection ? (
        <AdaptiveModalSheet
          header={removeConnectionHeader}
          visible
          onClose={handleCloseConfirm}
          testID="remove-connection-confirm-modal"
        >
          <Text style={styles.confirmText}>
            {t("settings.host.connections.removeMessage", {
              name: pendingRemoveConnection.title,
            })}
          </Text>
          <View style={styles.confirmActions}>
            <Button
              variant="secondary"
              style={FLEX_1_STYLE}
              onPress={handleCancelConfirm}
              disabled={isRemovingConnection}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              style={FLEX_1_STYLE}
              onPress={handleConfirmRemove}
              disabled={isRemovingConnection}
              testID="remove-connection-confirm"
            >
              {t("settings.host.connections.removeAction")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </SettingsSection>
  );
}

function RemoveClientHostSection({
  host,
  isLocalDaemon,
  onRemoved,
}: {
  host: HostProfile;
  isLocalDaemon: boolean;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const { removeHost } = useHostMutations();
  const { updateSettings } = useDesktopSettings();
  const { data: daemonStatusData, setStatus } = useDaemonStatus();
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const daemonStatus = daemonStatusData?.status ?? null;
  const stopsOwnedDaemon = isLocalDaemon && daemonStatus?.ownedByDesktop === true;

  const removeHostHeader = useMemo<SheetHeader>(
    () => ({
      title: stopsOwnedDaemon
        ? t("settings.host.daemon.remove.localConfirmTitle")
        : t("settings.host.daemon.remove.title"),
    }),
    [stopsOwnedDaemon, t],
  );

  const handleOpenConfirm = useCallback(() => setIsConfirming(true), []);
  const handleCloseConfirm = useCallback(() => {
    if (isRemoving) return;
    setIsConfirming(false);
  }, [isRemoving]);
  const handleCancel = useCallback(() => setIsConfirming(false), []);

  const rollbackLocalhostRemoval = useCallback(
    async (shouldRestartDaemon: boolean) => {
      await updateSettings({ daemon: { manageBuiltInDaemon: true } });
      if (!shouldRestartDaemon) return;
      setStatus(await startDesktopDaemon());
    },
    [setStatus, updateSettings],
  );

  const handleConfirmRemove = useCallback(() => {
    setIsRemoving(true);
    const remove = async () => {
      let didDisableDaemonManagement = false;
      let didStopDaemon = false;
      if (isLocalDaemon) {
        try {
          await updateSettings({ daemon: { manageBuiltInDaemon: false } });
          didDisableDaemonManagement = true;
          if (daemonStatus?.status === "running" && daemonStatus.ownedByDesktop) {
            setStatus(await stopDesktopDaemon("host_remove"));
            didStopDaemon = true;
          }
          await removeHost(host.serverId);
        } catch (error) {
          if (didDisableDaemonManagement) {
            try {
              await rollbackLocalhostRemoval(didStopDaemon);
            } catch (rollbackError) {
              console.error(
                "[ClientHostDetail] Failed to roll back localhost removal",
                rollbackError,
              );
            }
          }
          throw error;
        }
        return;
      }
      await removeHost(host.serverId);
    };
    void remove()
      .then(() => {
        setIsConfirming(false);
        onRemoved?.();
        return;
      })
      .catch((error) => {
        console.error("[ClientHostDetail] Failed to remove host", error);
        Alert.alert(
          t("settings.host.daemon.remove.errorTitle"),
          isLocalDaemon
            ? t("settings.host.daemon.remove.localErrorMessage")
            : t("settings.host.daemon.remove.errorMessage"),
        );
      })
      .finally(() => setIsRemoving(false));
  }, [
    daemonStatus,
    host.serverId,
    isLocalDaemon,
    onRemoved,
    removeHost,
    rollbackLocalhostRemoval,
    setStatus,
    t,
    updateSettings,
  ]);

  return (
    <SettingsSection
      title={t("settings.host.daemon.dangerZone")}
      testID="host-page-remove-host-card"
    >
      <SettingsCard>
        <SettingsRow
          label={
            isLocalDaemon
              ? t("settings.host.daemon.remove.localTitle")
              : t("settings.host.daemon.remove.title")
          }
          hint={
            stopsOwnedDaemon
              ? t("settings.host.daemon.remove.localHint")
              : t("settings.host.daemon.remove.hint")
          }
        >
          <Button
            variant="outline"
            leftIcon={removeHostIcon}
            textStyle={styles.destructiveText}
            onPress={handleOpenConfirm}
            testID="host-page-remove-host-button"
          >
            {t("settings.host.connections.removeAction")}
          </Button>
        </SettingsRow>
      </SettingsCard>

      {isConfirming ? (
        <AdaptiveModalSheet
          header={removeHostHeader}
          visible
          onClose={handleCloseConfirm}
          testID="remove-host-confirm-modal"
        >
          <Text style={styles.confirmText}>
            {stopsOwnedDaemon
              ? t("settings.host.daemon.remove.localConfirmMessage")
              : t("settings.host.daemon.remove.confirmMessage", { name: host.label })}
          </Text>
          <View style={styles.confirmActions}>
            <Button
              variant="secondary"
              style={FLEX_1_STYLE}
              onPress={handleCancel}
              disabled={isRemoving}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              style={FLEX_1_STYLE}
              onPress={handleConfirmRemove}
              disabled={isRemoving}
              testID="remove-host-confirm"
            >
              {t("settings.host.connections.removeAction")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </SettingsSection>
  );
}

export function ClientHostDetailPage({
  serverId,
  onBack,
  onAddHost,
  onHostRemoved,
}: {
  serverId: string;
  onBack: () => void;
  onAddHost: () => void;
  onHostRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const hosts = useHosts();
  const host = hosts.find((entry) => entry.serverId === serverId) ?? null;
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const detectedMachineKind = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.machineKind ?? null,
  );

  const parent = useMemo(
    () => ({
      label: t("settings.sections.hosts"),
      accessibilityLabel: t("settings.clientHosts.backToHosts"),
      onPress: onBack,
      testID: "client-host-detail-back",
    }),
    [onBack, t],
  );

  const resolvedIcon = host
    ? resolveHostIcon({ appearance: host.appearance, detectedMachineKind })
    : "server";

  const icon = useMemo(
    () =>
      host ? (
        <HostIconGlyph
          icon={resolvedIcon}
          color={host.appearance.color}
          size={isCompact ? ICON_SIZE.md : ICON_SIZE.lg}
        />
      ) : undefined,
    [host, isCompact, resolvedIcon],
  );

  if (!host) {
    return (
      <View testID="client-host-detail-page">
        <SettingsDetailHeader parent={parent} titleTestID="client-host-detail-title" />
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>{t("settings.host.notFound")}</Text>
        </View>
      </View>
    );
  }

  return (
    <View testID="client-host-detail-page">
      <SettingsDetailHeader
        parent={parent}
        icon={icon}
        title={host.label}
        titleTestID="client-host-detail-title"
      />
      <HostConnectionError serverId={serverId} />
      <ClientHostRoutesSection host={host} isLocalHost={isLocalDaemon} onAddHost={onAddHost} />
      <HostAppearanceSection host={host} />
      <RemoveClientHostSection
        host={host}
        isLocalDaemon={isLocalDaemon}
        onRemoved={onHostRemoved}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  listLeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  routeTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  latencyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  latencyError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  destructiveText: {
    color: theme.colors.destructive,
  },
  confirmText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
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
    fontSize: theme.fontSize.base,
  },
}));

const FLEX_1_STYLE = { flex: 1 };
