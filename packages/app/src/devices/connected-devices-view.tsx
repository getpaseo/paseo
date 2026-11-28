import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TFunction } from "i18next";
import type {
  ConnectedClientKind,
  ConnectedClientSummary,
  ConnectedClientTransport,
  DaemonClientsSnapshot,
  InboundDaemonSummary,
} from "@getpaseo/protocol/daemon-clients";
import type { DaemonPermission } from "@getpaseo/protocol/messages";
import type { HostDirectory, HostSummary } from "@getpaseo/protocol/hosts";
import {
  SettingsCard,
  SettingsCollapsibleRow,
  SettingsRow,
  SettingsSection,
} from "@/components/settings";
import { StatusBadge } from "@/components/ui/status-badge";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { formatConnectedDuration, summarizePermissions } from "./scope-summary";

const UPDATES_DOCS_URL = "https://paseo.sh/docs/updates";

type StatusDotTone = "online" | "warning" | "error" | "offline";

function StatusDot({ tone }: { tone: StatusDotTone }) {
  return (
    <View style={styles.dotSlot}>
      <View
        style={[
          styles.dot,
          tone === "online" && styles.dotOnline,
          tone === "warning" && styles.dotWarning,
          tone === "error" && styles.dotError,
          tone === "offline" && styles.dotOffline,
        ]}
      />
    </View>
  );
}

const STATUS_DOTS: Record<StatusDotTone, React.ReactNode> = {
  online: <StatusDot tone="online" />,
  warning: <StatusDot tone="warning" />,
  error: <StatusDot tone="error" />,
  offline: <StatusDot tone="offline" />,
};

function ScopePill({ permissions, t }: { permissions: readonly DaemonPermission[]; t: TFunction }) {
  const summary = summarizePermissions(permissions);
  let label: string;
  if (summary.kind === "full") {
    label = t("devices.scopes.fullAccess");
  } else if (summary.kind === "read_only") {
    label = t("devices.scopes.readOnly");
  } else if (summary.count === 1) {
    label = t("devices.scopes.countOne");
  } else {
    label = t("devices.scopes.countOther", { count: summary.count });
  }
  return <StatusBadge label={label} variant="muted" size="xs" />;
}

function PermissionPillsRow({
  permissions,
  t,
}: {
  permissions: readonly DaemonPermission[];
  t: TFunction;
}) {
  return (
    <SettingsRow label={t("devices.details.permissions")}>
      <View style={styles.scopePills}>
        {permissions.length > 0 ? (
          permissions.map((permission) => (
            <StatusBadge key={permission} label={permission} variant="muted" size="xs" />
          ))
        ) : (
          <Text style={styles.nestedValue}>{t("devices.scopes.none")}</Text>
        )}
      </View>
    </SettingsRow>
  );
}

function formatDurationLabel(isoTimestamp: string | null | undefined, t: TFunction): string | null {
  if (!isoTimestamp) return null;
  const duration = formatConnectedDuration(isoTimestamp);
  if (!duration) return null;
  if (duration.kind === "just_now") return t("devices.time.justNow");
  if (duration.kind === "minutes") return t("devices.time.minutesAgo", { count: duration.count });
  if (duration.kind === "hours") return t("devices.time.hoursAgo", { count: duration.count });
  return t("devices.time.daysAgo", { count: duration.count });
}

function formatTransportLabel(transport: ConnectedClientTransport, t: TFunction): string {
  switch (transport) {
    case "local_ipc":
    case "local":
      return t("devices.transport.local");
    case "tailscale":
      return t("devices.transport.tailscale");
    case "relay":
      return t("devices.transport.relay");
    case "hub":
      return t("devices.transport.hub");
    case "direct":
      return t("devices.transport.direct");
  }
}

function formatClientPlatformLabel(
  kind: ConnectedClientKind,
  platform: string | null,
  t: TFunction,
): string {
  if (platform === "ios") return "iOS";
  if (platform === "android") return "Android";
  if (kind === "desktop") return t("devices.kind.desktop");
  if (kind === "web") return t("devices.kind.web");
  if (kind === "mobile") return t("devices.kind.mobile");
  if (kind === "hub") return t("devices.kind.hub");
  if (kind === "cli") return "CLI";
  if (kind === "mcp") return "MCP";
  if (kind === "plugin") return t("devices.kind.plugin");
  return t("devices.kind.client");
}

function formatClientTitle(client: ConnectedClientSummary, t: TFunction): string {
  if (client.isCurrentSession) return t("devices.connected.thisDevice");
  if (client.name) return client.name;
  return formatClientPlatformLabel(client.kind, client.platform, t);
}

function formatHubHost(hubOrigin: string | null | undefined): string | null {
  if (!hubOrigin) return null;
  try {
    return new URL(hubOrigin).host;
  } catch {
    return hubOrigin;
  }
}

function formatClientHint(client: ConnectedClientSummary, t: TFunction): string {
  const parts: string[] = [formatTransportLabel(client.transport, t)];
  if (client.kind === "hub") {
    const host = formatHubHost(client.hubOrigin);
    if (host) parts.push(host);
  } else {
    const platform = formatClientPlatformLabel(client.kind, client.platform, t);
    parts.push(client.appVersion ? `${platform} ${client.appVersion}` : platform);
  }
  return parts.join(" · ");
}

function ConnectedClientRow({ client }: { client: ConnectedClientSummary }) {
  const { t } = useTranslation();
  const tone: StatusDotTone = client.socketCount > 0 ? "online" : "warning";
  const connectedLabel = formatDurationLabel(client.connectedAt, t);
  const trailing = useMemo(
    () => <ScopePill permissions={client.permissions} t={t} />,
    [client.permissions, t],
  );

  return (
    <SettingsCollapsibleRow
      label={formatClientTitle(client, t)}
      leading={STATUS_DOTS[tone]}
      hint={formatClientHint(client, t)}
      trailing={trailing}
      testID={`devices-client-${client.sessionId}`}
    >
      <PermissionPillsRow permissions={client.permissions} t={t} />
      {connectedLabel ? (
        <SettingsRow label={t("devices.details.connected")}>
          <Text style={styles.nestedValue}>{connectedLabel}</Text>
        </SettingsRow>
      ) : null}
      {client.socketCount === 0 ? (
        <SettingsRow label={t("devices.details.status")}>
          <Text style={styles.nestedValue}>{t("devices.status.reconnecting")}</Text>
        </SettingsRow>
      ) : null}
    </SettingsCollapsibleRow>
  );
}

function InboundDaemonRow({ daemon }: { daemon: InboundDaemonSummary }) {
  const { t } = useTranslation();
  const tone: StatusDotTone = daemon.socketCount > 0 ? "online" : "warning";
  const label = daemon.name ?? daemon.peerServerId ?? t("devices.hosts.unnamed");
  const transport = formatTransportLabel(daemon.transport, t);
  const hintParts = [t("devices.hosts.inbound"), transport];
  if (daemon.routedSessions.length > 0) {
    hintParts.push(t("devices.hosts.routedCount", { count: daemon.routedSessions.length }));
  }
  const connectedLabel = formatDurationLabel(daemon.connectedAt, t);
  const trailing = useMemo(
    () => <ScopePill permissions={daemon.permissions} t={t} />,
    [daemon.permissions, t],
  );

  return (
    <SettingsCollapsibleRow
      label={label}
      leading={STATUS_DOTS[tone]}
      hint={hintParts.join(" · ")}
      trailing={trailing}
      testID={`devices-inbound-host-${daemon.sessionId}`}
    >
      <PermissionPillsRow permissions={daemon.permissions} t={t} />
      {daemon.routedSessions.map((routed) => (
        <SettingsRow
          key={routed.sessionId}
          label={routed.name ?? formatClientPlatformLabel(routed.kind, null, t)}
          hint={t("devices.hosts.routedSession")}
        >
          <ScopePill permissions={routed.permissions} t={t} />
        </SettingsRow>
      ))}
      {daemon.appVersion ? (
        <SettingsRow label={t("devices.details.version")}>
          <Text style={styles.nestedValue}>{daemon.appVersion}</Text>
        </SettingsRow>
      ) : null}
      {connectedLabel ? (
        <SettingsRow label={t("devices.details.connected")}>
          <Text style={styles.nestedValue}>{connectedLabel}</Text>
        </SettingsRow>
      ) : null}
    </SettingsCollapsibleRow>
  );
}

function outboundHostTone(status: HostSummary["status"]): StatusDotTone {
  switch (status) {
    case "online":
      return "online";
    case "connecting":
      return "warning";
    case "error":
      return "error";
    case "offline":
    case "disabled":
      return "offline";
  }
}

function outboundHostStatusLabel(status: HostSummary["status"], t: TFunction): string | undefined {
  switch (status) {
    case "connecting":
      return t("devices.status.connecting");
    case "error":
      return t("devices.status.error");
    case "disabled":
      return t("devices.status.disabled");
    case "offline":
      return t("devices.status.offline");
    case "online":
      return undefined;
  }
}

function OutboundHostRow({ host }: { host: HostSummary }) {
  const { t } = useTranslation();
  const tone = outboundHostTone(host.status);
  const label = host.label ?? host.serverId ?? host.targetDescription;
  const hintParts = [t("devices.hosts.outbound"), host.targetDescription];
  const statusSummary = outboundHostStatusLabel(host.status, t);
  const connectedLabel = formatDurationLabel(host.connectedAt ?? host.lastOnlineAt, t);
  const trailing = useMemo(
    () =>
      host.status === "online" && host.permissions ? (
        <ScopePill permissions={host.permissions} t={t} />
      ) : undefined,
    [host.permissions, host.status, t],
  );

  return (
    <SettingsCollapsibleRow
      label={label}
      leading={STATUS_DOTS[tone]}
      hint={hintParts.join(" · ")}
      hintStatus={host.status === "error" ? "error" : undefined}
      summary={statusSummary}
      trailing={trailing}
      testID={`devices-outbound-host-${host.registrationId}`}
    >
      {host.permissions ? <PermissionPillsRow permissions={host.permissions} t={t} /> : null}
      {host.error ? (
        <SettingsRow label={t("devices.details.error")}>
          <Text style={styles.nestedError}>{host.error.message}</Text>
        </SettingsRow>
      ) : null}
      {host.version ? (
        <SettingsRow label={t("devices.details.version")}>
          <Text style={styles.nestedValue}>{host.version}</Text>
        </SettingsRow>
      ) : null}
      {connectedLabel ? (
        <SettingsRow
          label={
            host.status === "online"
              ? t("devices.details.connected")
              : t("devices.details.lastSeen")
          }
        >
          <Text style={styles.nestedValue}>{connectedLabel}</Text>
        </SettingsRow>
      ) : null}
    </SettingsCollapsibleRow>
  );
}

type ConnectedClientsLoadState =
  | { status: "loading" }
  | { status: "ready"; snapshot: DaemonClientsSnapshot }
  | { status: "error"; message: string };

function useConnectedClients(serverId: string, enabled: boolean): ConnectedClientsLoadState {
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<ConnectedClientsLoadState>({ status: "loading" });

  useEffect(() => {
    if (!enabled || !client) {
      setState({ status: "loading" });
      return;
    }
    let active = true;
    const observation = client.observeConnectedClients();
    const apply = (snapshot: DaemonClientsSnapshot) => {
      if (active) setState({ status: "ready", snapshot });
    };
    const unsubscribe = observation.subscribe({
      snapshot: apply,
      update: (message) => {
        if (message.type === "daemon.clients.changed") {
          apply({
            clients: message.payload.clients,
            inboundDaemons: message.payload.inboundDaemons,
          });
        }
      },
      error: (err) => {
        if (!active) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      },
    });
    void observation.ready.then(apply).catch((err: unknown) => {
      if (!active) return;
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });

    return () => {
      active = false;
      unsubscribe();
      void observation.release();
    };
  }, [client, enabled]);

  return state;
}

function useOutboundHosts(serverId: string, enabled: boolean): HostDirectory | null {
  const client = useHostRuntimeClient(serverId);
  const [directory, setDirectory] = useState<HostDirectory | null>(null);

  useEffect(() => {
    if (!enabled || !client) {
      setDirectory(null);
      return;
    }
    let active = true;
    const observation = client.observeHosts();
    const apply = (next: HostDirectory) => {
      if (active) setDirectory(next);
    };
    const unsubscribe = observation.subscribe({
      snapshot: apply,
      update: (message) => {
        if (message.type === "hosts.changed") apply(message.payload.directory);
      },
    });
    void observation.ready.then(apply).catch(() => undefined);

    return () => {
      active = false;
      unsubscribe();
      void observation.release();
    };
  }, [client, enabled]);

  return directory;
}

function ConnectedClientsCardBody({
  isOnline,
  hasServerInfo,
  supportsConnectedClients,
  canViewClients,
  clientsState,
}: {
  isOnline: boolean;
  hasServerInfo: boolean;
  supportsConnectedClients: boolean;
  canViewClients: boolean;
  clientsState: ConnectedClientsLoadState;
}) {
  const { t } = useTranslation();
  const updateLink = useMemo(
    () => ({ href: UPDATES_DOCS_URL, label: t("devices.tailscale.updateDocs") }),
    [t],
  );

  if (!isOnline) {
    return (
      <SettingsRow
        label={t("devices.connected.unavailable")}
        hint={t("workspace.terminal.hostDisconnected")}
      />
    );
  }
  if (hasServerInfo && !supportsConnectedClients) {
    return (
      <SettingsRow
        label={t("devices.connected.updateTitle")}
        hint={t("devices.connected.updateHint")}
        link={updateLink}
      />
    );
  }
  if (!canViewClients) {
    return (
      <SettingsRow
        label={t("devices.connected.permissionTitle")}
        hint={t("devices.connected.permissionHint")}
      />
    );
  }
  if (clientsState.status === "loading") {
    return <SettingsRow label={t("devices.connected.loading")} />;
  }
  if (clientsState.status === "error") {
    return <SettingsRow label={t("devices.connected.errorTitle")} error={clientsState.message} />;
  }
  if (clientsState.snapshot.clients.length === 0) {
    return <SettingsRow label={t("devices.connected.empty")} />;
  }
  return (
    <>
      {clientsState.snapshot.clients.map((entry) => (
        <ConnectedClientRow key={entry.sessionId} client={entry} />
      ))}
    </>
  );
}

export function ConnectedDevicesView({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const connectionStatus = useHostRuntimeSnapshot(serverId)?.connectionStatus;
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);

  const isOnline = connectionStatus === "online";
  // COMPAT(connectedClients): added in v0.19.0, remove gate after 2027-06-01.
  const supportsConnectedClients = serverInfo?.features?.connectedClients === true;
  const supportsConnectedHosts = serverInfo?.features?.connectedHosts === true;
  const canViewClients =
    !serverInfo?.permissions || serverInfo.permissions.includes("access.manage");

  const clientsState = useConnectedClients(
    serverId,
    isOnline && supportsConnectedClients && canViewClients,
  );
  const outboundDirectory = useOutboundHosts(serverId, isOnline && supportsConnectedHosts);

  const inboundDaemons =
    clientsState.status === "ready" ? clientsState.snapshot.inboundDaemons : [];
  const outboundHosts = outboundDirectory?.hosts ?? [];
  const hasConnectedHosts = inboundDaemons.length > 0 || outboundHosts.length > 0;

  return (
    <View>
      <SettingsSection title={t("devices.connected.title")}>
        <SettingsCard testID="devices-connected-clients-card">
          <ConnectedClientsCardBody
            isOnline={isOnline}
            hasServerInfo={Boolean(serverInfo)}
            supportsConnectedClients={supportsConnectedClients}
            canViewClients={canViewClients}
            clientsState={clientsState}
          />
        </SettingsCard>
      </SettingsSection>

      {isOnline && hasConnectedHosts ? (
        <SettingsSection title={t("devices.hosts.title")}>
          <SettingsCard testID="devices-connected-hosts-card">
            {inboundDaemons.map((daemon) => (
              <InboundDaemonRow key={daemon.sessionId} daemon={daemon} />
            ))}
            {outboundHosts.map((host) => (
              <OutboundHostRow key={host.registrationId} host={host} />
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  dotSlot: {
    width: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
  },
  dotOnline: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
  dotWarning: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  dotError: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  dotOffline: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  scopePills: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[1.5],
  },
  nestedValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  nestedError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
}));
